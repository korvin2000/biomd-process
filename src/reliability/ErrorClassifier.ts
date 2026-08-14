import { AbortedError, BudgetExceededError, TimeoutError } from '../shared/errors.js';
import { LlmCallError, type LlmErrorKind } from './errors.js';

/**
 * Maps anything thrown by a transport into a typed {@link LlmCallError}.
 *
 * Deliberately duck-typed rather than `instanceof APIError`: OpenAI-compatible
 * gateways (LiteLLM, OmniRoute, OpenRouter, vLLM) all shape their errors a
 * little differently, and we must not depend on a single SDK version's classes.
 */
export class ErrorClassifier {
  classify(error: unknown, target?: string): LlmCallError {
    if (error instanceof LlmCallError) return error;

    if (error instanceof TimeoutError) {
      return new LlmCallError('timeout', error.message, { cause: error, target });
    }
    // Cancellation and budget exhaustion are run-level decisions, not call
    // failures: classifying them would hand them to retry and fallback, which is
    // exactly the machinery they exist to stop.
    if (error instanceof AbortedError || error instanceof BudgetExceededError) throw error;

    const status = numberProp(error, 'status') ?? numberProp(error, 'statusCode');
    const providerCode = stringProp(error, 'code') ?? stringProp(error, 'type');
    const message = messageOf(error);
    const kind = this.kindOf({ status, providerCode, message });

    return new LlmCallError(kind, message, {
      cause: error,
      status,
      target,
      retryAfterMs: retryAfterMs(error),
      details: { providerCode },
    });
  }

  private kindOf(input: { status?: number; providerCode?: string; message: string }): LlmErrorKind {
    const { status, providerCode, message } = input;
    const text = `${providerCode ?? ''} ${message}`.toLowerCase();

    // Message-level signals first: a gateway may report context overflow as 400,
    // 413 or 422 depending on which upstream it proxies.
    if (/context length|context_length|maximum context|too many tokens|prompt is too long|reduce the length/.test(text)) {
      return 'context_length';
    }
    if (/content filter|content_policy|safety|flagged/.test(text)) return 'content_filter';
    if (/insufficient|quota|billing|credit|payment required/.test(text)) return 'quota';
    if (/model .*(not found|unavailable|does not exist)|unknown model|no healthy deployment/.test(text)) {
      return 'model_unavailable';
    }

    if (status !== undefined) {
      if (status === 429) return 'rate_limit';
      if (status === 401 || status === 403) return 'auth';
      if (status === 402) return 'quota';
      if (status === 404) return 'model_unavailable';
      if (status === 408 || status === 409) return 'timeout';
      if (status === 413 || status === 422) return 'context_length';
      if (status >= 500) return 'server';
      if (status >= 400) return 'invalid_request';
    }

    if (isNetworkCode(providerCode) || /fetch failed|socket hang up|network|econn|enotfound|eai_again/.test(text)) {
      return 'network';
    }
    if (/timed? ?out/.test(text)) return 'timeout';

    return 'unknown';
  }
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isNetworkCode(code: string | undefined): boolean {
  return code !== undefined && NETWORK_CODES.has(code.toUpperCase());
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const nested = stringProp(error, 'message');
  return nested ?? String(error);
}

/** `Retry-After` in seconds or as an HTTP date; also the `x-ratelimit-reset-*` family. */
function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { headers?: unknown } | null)?.headers;
  const get = headerReader(headers);
  if (!get) return undefined;

  const retryAfter = get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  const reset = get('x-ratelimit-reset-requests') ?? get('x-ratelimit-reset-tokens');
  if (reset) {
    const parsed = parseDuration(reset);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function headerReader(headers: unknown): ((name: string) => string | undefined) | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (name) => (headers as Headers).get(name) ?? undefined;
  }
  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    return (name) => {
      const value = record[name] ?? record[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    };
  }
  return undefined;
}

/** Parses `6ms`, `1.5s`, `2m` as used by OpenAI rate-limit headers. */
function parseDuration(value: string): number | undefined {
  const match = /^([\d.]+)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? 's';
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit] ?? 1000;
  return amount * factor;
}

function numberProp(value: unknown, key: string): number | undefined {
  const prop = (value as Record<string, unknown> | null)?.[key];
  return typeof prop === 'number' && Number.isFinite(prop) ? prop : undefined;
}

function stringProp(value: unknown, key: string): string | undefined {
  const prop = (value as Record<string, unknown> | null)?.[key];
  return typeof prop === 'string' && prop.length > 0 ? prop : undefined;
}
