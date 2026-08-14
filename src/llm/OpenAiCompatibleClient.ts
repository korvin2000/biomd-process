import OpenAI from 'openai';

import type { EndpointConfig } from '../config/schema.js';
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

  constructor(endpoint: EndpointConfig) {
    this.endpointId = endpoint.id;
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
    const body = this.buildBody(target, request);

    const completion = (await this.client.chat.completions.create(body as never, {
      signal: options.signal,
      timeout: options.timeoutMs,
    })) as ChatCompletionLike;

    return {
      text: extractText(completion),
      finishReason: mapFinishReason(completion.choices?.[0]?.finish_reason),
      usage: mapUsage(completion.usage),
      reportedModel: completion.model ?? target.modelName,
      latencyMs: Date.now() - startedAt,
      providerCostUsd: typeof completion.usage?.cost === 'number' ? completion.usage.cost : undefined,
    };
  }

  private buildBody(target: ModelTarget, request: CompletionRequest): Record<string, unknown> {
    const params = request.params ?? {};
    const body: Record<string, unknown> = {
      model: target.modelName,
      messages: request.messages.map(toWireMessage),
      stream: false,
    };

    const maxOutput = Math.min(params.maxOutputTokens ?? target.maxOutputTokens, target.maxOutputTokens);
    body[target.maxTokensParam] = maxOutput;

    assignDefined(body, {
      temperature: params.temperature,
      top_p: params.topP,
      frequency_penalty: params.frequencyPenalty,
      presence_penalty: params.presencePenalty,
      seed: params.seed,
      stop: params.stop,
      user: request.correlationId,
    });

    const responseFormat = toWireResponseFormat(request.responseFormat);
    if (responseFormat) body['response_format'] = responseFormat;

    Object.assign(body, reasoningFields(target), params.extra ?? {}, target.params.extra ?? {});
    return body;
  }
}

function toWireMessage(message: ChatMessage): { role: string; content: string } {
  return { role: message.role, content: message.content };
}

function toWireResponseFormat(format: ResponseFormat | undefined): Record<string, unknown> | undefined {
  if (!format) return undefined;
  if (format.type === 'text') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
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
