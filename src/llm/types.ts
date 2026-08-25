import type {
  Capability,
  EndpointConfig,
  ModelConfig,
  Pricing,
  ProviderRouting,
  Reasoning,
} from '../config/schema.js';
import type { JsonObject } from '../shared/json.js';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /**
   * Marks the end of the intended prompt-cache prefix. Providers that support
   * explicit cache breakpoints get one here; the rest simply benefit from the
   * stable ordering the builder guarantees.
   */
  cacheBreakpoint?: boolean;
}

export interface WebSearchRequest {
  /** A response without provider evidence of a completed search is rejected. */
  required: boolean;
  searchContextSize?: 'low' | 'medium' | 'high';
}

export interface PromptCacheRequest {
  /** Stable routing key for requests that reuse the same prompt prefix. */
  key?: string;
  /** Responses API cache placement. Explicit mode uses ChatMessage.cacheBreakpoint. */
  mode?: 'implicit' | 'explicit';
}

export interface WebSearchSource {
  url: string;
  title?: string;
}

export interface WebSearchEvidence {
  performed: boolean;
  sources: WebSearchSource[];
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: JsonObject; strict?: boolean };

export interface CompletionParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
  maxOutputTokens?: number;
  /** Raw passthrough for endpoint-specific fields. */
  extra?: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  responseFormat?: ResponseFormat;
  params?: CompletionParams;
  webSearch?: WebSearchRequest;
  promptCache?: PromptCacheRequest;
  /** Opaque correlation data forwarded to providers that accept a `user`/`metadata` field. */
  correlationId?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Subset of `promptTokens` served from the provider's prompt cache. */
  cachedPromptTokens: number;
  /** Subset of `promptTokens` written to the provider's prompt cache. */
  cacheWritePromptTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export const EMPTY_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedPromptTokens: 0,
  cacheWritePromptTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'unknown';

export interface CompletionResponse {
  text: string;
  finishReason: FinishReason;
  usage: TokenUsage;
  /** Model name as reported by the provider, which may differ from what we asked for. */
  reportedModel: string;
  latencyMs: number;
  /** Cost reported by the gateway itself (OpenRouter does this); trusted over our estimate. */
  providerCostUsd?: number;
  /** Provider-generated evidence, never inferred from URLs written in model prose. */
  webSearch?: WebSearchEvidence;
}

/**
 * A fully resolved (endpoint × model) pair — everything a call needs, with the
 * config lookups already done. Routing strategies rank these.
 */
export interface ModelTarget {
  /** `<endpointId>:<modelId>`; used as the key for breakers, stats and logs. */
  readonly key: string;
  readonly modelId: string;
  readonly endpointId: string;
  /** Model name to send on the wire. */
  readonly modelName: string;
  readonly apiFormat: ModelConfig['apiFormat'];
  readonly webSearchMode?: ModelConfig['webSearchMode'];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  readonly pricing: Pricing;
  readonly capabilities: readonly Capability[];
  readonly reasoning: Reasoning;
  readonly tags: readonly string[];
  readonly weight: number;
  readonly params: ModelConfig['params'];
  /** Which of the endpoint's providers may serve this model, and on what terms. */
  readonly provider: ProviderRouting;
  readonly timeoutMs: number;
  readonly endpoint: EndpointConfig;
}

export interface LlmClient {
  readonly endpointId: string;
  complete(
    target: ModelTarget,
    request: CompletionRequest,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CompletionResponse>;
}

/** Usable input budget for a target once output tokens and safety margin are reserved. */
export function usableInputTokens(
  target: ModelTarget,
  options: { reserveOutputTokens: number; safetyMarginRatio: number },
): number {
  const reserve = Math.min(options.reserveOutputTokens, target.maxOutputTokens);
  return Math.max(0, Math.floor(target.contextWindow * options.safetyMarginRatio) - reserve);
}

export function hasCapabilities(target: ModelTarget, required: readonly Capability[]): boolean {
  return required.every((capability) => target.capabilities.includes(capability));
}
