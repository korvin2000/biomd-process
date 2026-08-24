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

  constructor(endpoint: EndpointConfig) {
    this.endpointId = endpoint.id;
    this.stream = endpoint.stream;
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
    const startedAt = Date.now();
    const body = buildRequestBody(target, request, this.stream);

    const raw = await this.client.chat.completions.create(body as never, {
      signal: options.signal,
      timeout: options.timeoutMs,
    });
    const completion = this.stream
      ? await collectStream(raw as unknown as AsyncIterable<ChatCompletionChunkLike>)
      : (raw as ChatCompletionLike);

    return {
      text: extractText(completion),
      finishReason: mapFinishReason(completion.choices?.[0]?.finish_reason),
      usage: mapUsage(completion.usage),
      reportedModel: completion.model ?? target.modelName,
      latencyMs: Date.now() - startedAt,
      providerCostUsd: typeof completion.usage?.cost === 'number' ? completion.usage.cost : undefined,
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

  Object.assign(body, reasoningFields(target), params.extra ?? {}, target.params.extra ?? {});
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
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cache_read_input_tokens?: number;
}

interface ChatCompletionLike {
  model?: string;
  usage?: UsageLike;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | Array<{ type?: string; text?: string }> | null };
  }>;
}

interface ChatCompletionChunkLike {
  model?: string;
  usage?: UsageLike | null;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: { content?: string | null };
    /** Some gateways emit a whole message on the final chunk instead of a delta. */
    message?: { content?: string | null };
  }>;
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

  for await (const chunk of stream) {
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.content) delta += choice.delta.content;
    else if (choice.message?.content) whole += choice.message.content;
  }

  return {
    model,
    usage,
    choices: [{ finish_reason: finishReason ?? null, message: { content: delta || whole } }],
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

function mapUsage(usage: UsageLike | undefined): TokenUsage {
  if (!usage) return { ...EMPTY_USAGE };

  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    cachedPromptTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
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
