import OpenAI from 'openai';

import type { EndpointConfig, ProviderRouting } from '../config/schema.js';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  FinishReason,
  LlmClient,
  ModelTarget,
  ResponseFormat,
  TokenUsage,
  WebSearchSource,
} from './types.js';
import { EMPTY_USAGE } from './types.js';

/**
 * The only transport in v0.1.
 *
 * "OpenAI-compatible" is the lingua franca of every gateway we care about —
 * LiteLLM, OmniRoute, 9router, vLLM, Ollama's shim, OpenRouter, OpenAI itself.
 * The differences between them are per-endpoint headers, the reasoning dialect
 * and the max-tokens parameter name, all of which are config, not code.
 *
 * SDK-level retries are disabled: retry policy belongs to the gateway, which
 * can also decide to fall back to a different model instead.
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly endpointId: string;
  private readonly client: OpenAI;
  private readonly stream: boolean;
  private readonly chatCachedTokens: EndpointConfig['usage']['chatCachedTokens'];

  constructor(endpoint: EndpointConfig) {
    this.endpointId = endpoint.id;
    this.stream = endpoint.stream;
    this.chatCachedTokens = endpoint.usage.chatCachedTokens;
    this.client = new OpenAI({
      baseURL: endpoint.baseUrl,
      // Local gateways often accept any non-empty key; the SDK requires one.
      apiKey: endpoint.apiKey || 'not-required',
      organization: endpoint.organization,
      defaultHeaders: endpoint.headers,
      defaultQuery: endpoint.query,
      maxRetries: 0,
    });
  }

  async complete(
    target: ModelTarget,
    request: CompletionRequest,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CompletionResponse> {
    return target.apiFormat === 'responses'
      ? this.completeResponses(target, request, options)
      : this.completeChat(target, request, options);
  }

  private async completeChat(
    target: ModelTarget,
    request: CompletionRequest,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CompletionResponse> {
    const startedAt = Date.now();
    const body = buildRequestBody(target, request, this.stream);

    const raw = await this.client.chat.completions.create(body as never, {
      signal: options.signal,
      timeout: options.timeoutMs,
    });
    const completion = this.stream
      ? await collectStream(raw as unknown as AsyncIterable<ChatCompletionChunkLike>)
      : (raw as ChatCompletionLike);
    const evidence = chatWebSearchEvidence(completion);

    return {
      text: extractText(completion),
      finishReason: mapFinishReason(completion.choices?.[0]?.finish_reason),
      usage: mapChatUsage(completion.usage, this.chatCachedTokens),
      reportedModel: completion.model ?? target.modelName,
      latencyMs: Date.now() - startedAt,
      providerCostUsd: typeof completion.usage?.cost === 'number' ? completion.usage.cost : undefined,
      ...(evidence ? { webSearch: evidence } : {}),
    };
  }

  private async completeResponses(
    target: ModelTarget,
    request: CompletionRequest,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CompletionResponse> {
    const startedAt = Date.now();
    const body = buildResponsesRequestBody(target, request, this.stream);
    const raw = await this.client.responses.create(body as never, {
      signal: options.signal,
      timeout: options.timeoutMs,
    });
    const response = this.stream
      ? await collectResponsesStream(raw as unknown as AsyncIterable<ResponseStreamEventLike>)
      : (raw as unknown as ResponseLike);
    if (response.status === 'failed') {
      throw new Error(response.error?.message ?? 'Responses API request failed');
    }
    const evidence = responsesWebSearchEvidence(response);

    return {
      text: extractResponsesText(response),
      finishReason: mapResponsesFinishReason(response),
      usage: mapResponsesUsage(response.usage),
      reportedModel: response.model ?? target.modelName,
      latencyMs: Date.now() - startedAt,
      providerCostUsd: typeof response.usage?.cost === 'number' ? response.usage.cost : undefined,
      ...(evidence ? { webSearch: evidence } : {}),
    };
  }
}


/**
 * The request body, as a pure function of the target and the request.
 *
 * Module-level rather than a method so a test can assert what goes on the wire
 * without a socket — which is the only way to tell a parameter that was
 * *configured* from one that was *sent*.
 */
export function buildRequestBody(
  target: ModelTarget,
  request: CompletionRequest,
  stream: boolean,
): Record<string, unknown> {
  const params = request.params ?? {};
  const body: Record<string, unknown> = {
    model: target.modelName,
    messages: request.messages.map(toWireMessage),
    stream,
    // Streaming otherwise drops the usage block, and with it every token
    // count, the cost of the run and the budget guard. Overridable through
    // `params.extra` for a gateway that rejects the field.
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };

  const maxOutput = Math.min(params.maxOutputTokens ?? target.maxOutputTokens, target.maxOutputTokens);
  body[target.maxTokensParam] = maxOutput;

  assignDefined(body, {
    temperature: params.temperature,
    top_p: params.topP,
    // Not OpenAI fields, and every gateway in this repo's world takes them
    // anyway. They are first-class rather than `extra` because they are the
    // two most often accepted-and-ignored, which is what `provider` is for.
    top_k: params.topK,
    min_p: params.minP,
    frequency_penalty: params.frequencyPenalty,
    presence_penalty: params.presencePenalty,
    seed: params.seed,
    stop: params.stop,
    user: request.correlationId,
  });

  const responseFormat = toWireResponseFormat(request.responseFormat, target);
  if (responseFormat) body['response_format'] = responseFormat;

  const provider = toWireProvider(target.provider);
  if (provider) body['provider'] = provider;

  if (request.webSearch && target.webSearchMode === 'online') {
    body['web_search_options'] = {
      ...(request.webSearch.searchContextSize ? { search_context_size: request.webSearch.searchContextSize } : {}),
    };
  }

  Object.assign(body, reasoningFields(target), target.params.extra ?? {}, params.extra ?? {});
  return body;
}

/** Responses API body. Search tools and explicit prompt-cache breakpoints live here. */
export function buildResponsesRequestBody(
  target: ModelTarget,
  request: CompletionRequest,
  stream: boolean,
): Record<string, unknown> {
  const params = request.params ?? {};
  const body: Record<string, unknown> = {
    model: target.modelName,
    input: request.messages.map((message) => toResponsesMessage(message, target.endpoint.responsesPromptCache)),
    stream,
    store: false,
    max_output_tokens: Math.min(params.maxOutputTokens ?? target.maxOutputTokens, target.maxOutputTokens),
  };

  assignDefined(body, {
    temperature: params.temperature,
    top_p: params.topP,
    frequency_penalty: params.frequencyPenalty,
    presence_penalty: params.presencePenalty,
  });

  const format = toResponsesTextFormat(request.responseFormat, target);
  if (format) body['text'] = { format };

  const reasoning = responsesReasoning(target);
  if (reasoning) body['reasoning'] = reasoning;

  if (request.webSearch && target.webSearchMode === 'responses_tool') {
    body['tools'] = [
      {
        type: 'web_search',
        ...(request.webSearch.searchContextSize ? { search_context_size: request.webSearch.searchContextSize } : {}),
      },
    ];
    body['tool_choice'] = request.webSearch.required ? 'required' : 'auto';
    body['include'] = ['web_search_call.action.sources'];
  }

  if (target.endpoint.responsesPromptCache) {
    if (request.promptCache?.key) body['prompt_cache_key'] = request.promptCache.key;
    if (request.promptCache?.mode) body['prompt_cache_options'] = { mode: request.promptCache.mode };
  }
  const provider = toWireProvider(target.provider);
  if (provider) body['provider'] = provider;
  Object.assign(body, target.params.extra ?? {}, params.extra ?? {});
  return body;
}

/**
 * The gateway's provider-preference block, or nothing at all.
 *
 * Nothing at all is the important half: an endpoint that has never heard of
 * `provider` must not be sent an empty object, so every field is dropped when
 * it is empty and the whole block disappears when they all are. Config stays
 * camelCase like the rest of the file; the wire is snake_case because that is
 * what OpenRouter reads.
 */
export function toWireProvider(provider: ProviderRouting | undefined): Record<string, unknown> | undefined {
  if (!provider) return undefined;
  const wire: Record<string, unknown> = {};
  if (provider.order.length) wire['order'] = [...provider.order];
  if (provider.only.length) wire['only'] = [...provider.only];
  if (provider.ignore.length) wire['ignore'] = [...provider.ignore];
  if (provider.quantizations.length) wire['quantizations'] = [...provider.quantizations];
  if (provider.allowFallbacks !== undefined) wire['allow_fallbacks'] = provider.allowFallbacks;
  if (provider.requireParameters !== undefined) wire['require_parameters'] = provider.requireParameters;
  if (provider.sort !== undefined) wire['sort'] = provider.sort;
  return Object.keys(wire).length ? wire : undefined;
}

function toWireMessage(message: ChatMessage): { role: string; content: string } {
  return { role: message.role, content: message.content };
}

function toResponsesMessage(message: ChatMessage, explicitCacheControls: boolean): Record<string, unknown> {
  return {
    role: message.role === 'system' ? 'developer' : message.role,
    content: [
      {
        type: 'input_text',
        text: message.content,
        ...(explicitCacheControls && message.cacheBreakpoint
          ? { prompt_cache_breakpoint: { mode: 'explicit' } }
          : {}),
      },
    ],
  };
}

/**
 * `response_format`, but only for a target that says it understands one.
 *
 * The capability list used to be advisory here: every request carried its
 * `response_format` to every target, whatever the target declared. A provider
 * that merely ignores an unknown field survives that; one that rejects it does
 * not, and `openai/gpt-5.6-luna:online` answers **"Web Search cannot be used
 * with JSON mode"** — a 400 on every call. That target is the paid fallback of
 * the `websearch` pool, and `websearch` sends `json_object` on every request,
 * so it failed 100% of the time while looking like an ordinary provider error.
 *
 * Dropping the field is the right degradation rather than a workaround: JSON
 * mode is a belt on top of a prompt that already says "JSON only", and every
 * parser in this repo strips a code fence before reading. A model that cannot
 * be *told* to answer JSON still answers JSON when asked; a model that 400s is
 * simply not in the pool.
 */
export function toWireResponseFormat(format: ResponseFormat | undefined, target: ModelTarget): Record<string, unknown> | undefined {
  if (!format) return undefined;
  if (format.type === 'text') return undefined;
  if (format.type === 'json_object') {
    return target.capabilities.includes('json_object') ? { type: 'json_object' } : undefined;
  }
  if (!target.capabilities.includes('json_schema')) return undefined;
  return {
    type: 'json_schema',
    json_schema: { name: format.name, schema: format.schema, strict: format.strict ?? true },
  };
}

export function toResponsesTextFormat(
  format: ResponseFormat | undefined,
  target: ModelTarget,
): Record<string, unknown> | undefined {
  if (!format || format.type === 'text') return undefined;
  if (format.type === 'json_object') {
    return target.capabilities.includes('json_object') ? { type: 'json_object' } : undefined;
  }
  if (!target.capabilities.includes('json_schema')) return undefined;
  return {
    type: 'json_schema',
    name: format.name,
    schema: format.schema,
    strict: format.strict ?? true,
  };
}

/**
 * Each gateway family spells "think harder" differently; the model config says
 * which dialect to use — and, crucially, whether to say anything at all.
 *
 * `dialect: none` sends nothing, which leaves the model's own default in place.
 * Any other dialect states the intent explicitly in both directions, because a
 * model that reasons unless told otherwise bills those tokens at the output rate
 * and there is no other way to stop it.
 */
export function reasoningFields(target: Pick<ModelTarget, 'reasoning'>): Record<string, unknown> {
  const { reasoning } = target;
  if (reasoning.dialect === 'none') return {};

  switch (reasoning.dialect) {
    case 'reasoning_effort':
      return { reasoning_effort: reasoning.enabled ? reasoning.effort : 'none' };
    case 'reasoning':
      return reasoning.enabled
        ? {
            reasoning: {
              effort: reasoning.effort,
              ...(reasoning.maxTokens ? { max_tokens: reasoning.maxTokens } : {}),
              exclude: reasoning.exclude,
            },
          }
        : { reasoning: { enabled: false } };
    case 'thinking':
      return reasoning.enabled
        ? {
            thinking: {
              type: 'enabled',
              budget_tokens: reasoning.maxTokens ?? effortToBudget(reasoning.effort),
            },
          }
        : { thinking: { type: 'disabled' } };
    default:
      return {};
  }
}

/**
 * The Responses spelling of the same intent — but only for the dialects that
 * have one.
 *
 * `reasoning_effort` and `reasoning` are both effort-based and map onto the
 * Responses `reasoning` object directly. `thinking` does not: Anthropic's
 * `{ type, budget_tokens }` has no analogue here, and emitting `{ effort }` in
 * its place would look like it worked while asking for something else. A target
 * that needs it says so through `params.extra`, where what goes on the wire is
 * visible in the config.
 */
function responsesReasoning(target: Pick<ModelTarget, 'reasoning'>): Record<string, unknown> | undefined {
  const { reasoning } = target;
  if (reasoning.dialect !== 'reasoning_effort' && reasoning.dialect !== 'reasoning') return undefined;
  if (!reasoning.enabled) return { effort: 'none' };
  return {
    effort: reasoning.effort,
    ...(reasoning.dialect === 'reasoning' && reasoning.maxTokens ? { max_tokens: reasoning.maxTokens } : {}),
    ...(reasoning.dialect === 'reasoning' ? { exclude: reasoning.exclude } : {}),
  };
}

function effortToBudget(effort: string): number {
  return { minimal: 1024, low: 2048, medium: 8192, high: 16384 }[effort] ?? 8192;
}

function assignDefined(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value;
  }
}

// --- Response shapes -------------------------------------------------------
// Typed structurally: gateways add fields (and occasionally omit `usage`), so we
// read defensively rather than trusting the SDK's nominal types.

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface CitationLike {
  type?: string;
  url?: string;
  title?: string;
  url_citation?: { url?: string; title?: string };
}

interface ChatCompletionLike {
  model?: string;
  usage?: UsageLike;
  citations?: Array<string | CitationLike>;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      annotations?: CitationLike[];
    };
  }>;
}

interface ChatCompletionChunkLike {
  model?: string;
  usage?: UsageLike | null;
  citations?: Array<string | CitationLike>;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: { content?: string | null; annotations?: CitationLike[] };
    /** Some gateways emit a whole message on the final chunk instead of a delta. */
    message?: { content?: string | null; annotations?: CitationLike[] };
  }>;
}

interface ResponsesUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ResponseOutputItemLike {
  type?: string;
  status?: string;
  action?: {
    type?: string;
    url?: string;
    sources?: Array<string | CitationLike>;
  };
  content?: Array<{
    type?: string;
    text?: string;
    annotations?: CitationLike[];
  }>;
}

interface ResponseLike {
  model?: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: ResponsesUsageLike;
  output?: ResponseOutputItemLike[];
}

interface ResponseStreamEventLike {
  type?: string;
  delta?: string;
  response?: ResponseLike;
}

/**
 * Reassembles a streamed completion into the shape the non-streamed path
 * returns, so everything downstream — text extraction, usage, finish reason,
 * cost — stays identical whichever transport the endpoint asked for.
 *
 * Deltas win over a whole `message` when both appear: a gateway that emits the
 * accumulated message on its final chunk would otherwise have every token
 * counted twice.
 */
export async function collectStream(
  stream: AsyncIterable<ChatCompletionChunkLike>,
): Promise<ChatCompletionLike> {
  let delta = '';
  let whole = '';
  let finishReason: string | null | undefined;
  let usage: UsageLike | undefined;
  let model: string | undefined;
  let citations: Array<string | CitationLike> | undefined;
  let annotations: CitationLike[] | undefined;

  for await (const chunk of stream) {
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.citations?.length) citations = chunk.citations;

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.annotations?.length) annotations = choice.delta.annotations;
    if (choice.message?.annotations?.length) annotations = choice.message.annotations;
    if (choice.delta?.content) delta += choice.delta.content;
    else if (choice.message?.content) whole += choice.message.content;
  }

  return {
    model,
    usage,
    ...(citations ? { citations } : {}),
    choices: [{
      finish_reason: finishReason ?? null,
      message: { content: delta || whole, ...(annotations ? { annotations } : {}) },
    }],
  };
}

/**
 * Reassembles a streamed Responses call into the non-streamed shape.
 *
 * Every terminal event carries the whole response object, so the work is to
 * catch all three of them. `response.incomplete` is the one that matters most
 * and is the easiest to forget: it is what a call that hits `max_output_tokens`
 * ends with, and it carries both the `usage` block and the
 * `incomplete_details.reason` that becomes `finishReason: 'length'`. Dropping it
 * bills a 30k-token answer as zero, hides it from the budget guard, and
 * classifies the truncation as `response_format` — which is retryable, so the
 * identical cut is bought again on every attempt.
 *
 * The synthesized fallback is for a stream that ends with no terminal event at
 * all; it can only carry the text, so it says `incomplete` rather than claiming
 * a clean stop.
 */
const RESPONSES_TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

export async function collectResponsesStream(stream: AsyncIterable<ResponseStreamEventLike>): Promise<ResponseLike> {
  let terminal: ResponseLike | undefined;
  let text = '';

  for await (const event of stream) {
    if (event.type === 'response.output_text.delta' && event.delta) text += event.delta;
    if (event.type && RESPONSES_TERMINAL_EVENTS.has(event.type) && event.response) terminal = event.response;
  }
  if (terminal) return terminal;
  return {
    status: 'incomplete',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  };
}

function extractText(completion: ChatCompletionLike): string {
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === undefined || part.type === 'text' ? (part.text ?? '') : ''))
      .join('');
  }
  return '';
}

export function mapChatUsage(
  usage: UsageLike | undefined,
  cachedMode: EndpointConfig['usage']['chatCachedTokens'],
): TokenUsage {
  if (!usage) return { ...EMPTY_USAGE };

  const reportedPromptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const cacheWritePromptTokens =
    usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0;
  const promptTokens =
    cachedMode === 'additional'
      ? Math.max(0, reportedPromptTokens - cachedPromptTokens)
      : reportedPromptTokens;
  return {
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    cacheWritePromptTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens:
      cachedMode === 'additional'
        ? promptTokens + completionTokens
        : (usage.total_tokens ?? promptTokens + completionTokens),
  };
}

export function mapResponsesUsage(usage: ResponsesUsageLike | undefined): TokenUsage {
  if (!usage) return { ...EMPTY_USAGE };
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    cachedPromptTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWritePromptTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}

function extractResponsesText(response: ResponseLike): string {
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === undefined || content.type === 'output_text')
    .map((content) => content.text ?? '')
    .join('');
}

function mapResponsesFinishReason(response: ResponseLike): FinishReason {
  if (response.status === 'completed') return 'stop';
  const reason = response.incomplete_details?.reason ?? '';
  if (/max_output_tokens|length/i.test(reason)) return 'length';
  if (/content_filter|safety/i.test(reason)) return 'content_filter';
  return 'unknown';
}

function chatWebSearchEvidence(completion: ChatCompletionLike): { performed: boolean; sources: WebSearchSource[] } | undefined {
  const sources = [
    ...(completion.citations ?? []).map(sourceOf),
    ...(completion.choices?.[0]?.message?.annotations ?? []).map(sourceOf),
  ].filter((source): source is WebSearchSource => source !== undefined);
  const unique = dedupeSources(sources);
  return unique.length > 0 ? { performed: true, sources: unique } : undefined;
}

function responsesWebSearchEvidence(
  response: ResponseLike,
): { performed: boolean; sources: WebSearchSource[] } | undefined {
  const calls = (response.output ?? []).filter((item) => item.type === 'web_search_call');
  if (calls.length === 0) return undefined;

  const sources: WebSearchSource[] = [];
  for (const call of calls) {
    const direct = sourceOf(call.action?.url);
    if (direct) sources.push(direct);
    for (const source of call.action?.sources ?? []) {
      const parsed = sourceOf(source);
      if (parsed) sources.push(parsed);
    }
  }
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        const source = sourceOf(annotation);
        if (source) sources.push(source);
      }
    }
  }
  return {
    performed: calls.some((call) => call.status === undefined || call.status === 'completed'),
    sources: dedupeSources(sources),
  };
}

function sourceOf(value: string | CitationLike | undefined): WebSearchSource | undefined {
  if (typeof value === 'string') return value ? { url: value } : undefined;
  if (!value) return undefined;
  const url = value.url_citation?.url ?? value.url;
  if (!url) return undefined;
  const title = value.url_citation?.title ?? value.title;
  return { url, ...(title ? { title } : {}) };
}

function dedupeSources(sources: readonly WebSearchSource[]): WebSearchSource[] {
  const unique = new Map<string, WebSearchSource>();
  for (const source of sources) if (!unique.has(source.url)) unique.set(source.url, source);
  return [...unique.values()];
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content_filter':
    case 'tool_calls':
      return reason;
    default:
      return 'unknown';
  }
}
