import type { ReliabilityConfig } from '../config/schema.js';
import { systemClock, throwIfAborted, type Clock } from '../shared/async.js';
import { LlmCallError } from './errors.js';

export interface RetryAttemptInfo {
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: LlmCallError;
}

export interface RetryRunOptions {
  signal?: AbortSignal;
  onRetry?: (info: RetryAttemptInfo) => void;
  /** Overrides the default disposition, e.g. to stop retrying once a deadline is near. */
  isRetryable?: (error: LlmCallError, attempt: number) => boolean;
}

type RetryConfig = ReliabilityConfig['retry'];

/**
 * Bounded exponential backoff with jitter.
 *
 * Full jitter (`sleep(random(0, backoff))`) is the default because it is the
 * variant that actually de-synchronizes a fleet of concurrent workers hitting
 * the same rate limit; `equal` keeps half the delay deterministic; `none` is
 * for tests.
 */
export class RetryPolicy {
  constructor(
    private readonly config: RetryConfig,
    private readonly clock: Clock = systemClock,
    private readonly random: () => number = Math.random,
  ) {}

  get maxAttempts(): number {
    return this.config.maxAttempts;
  }

  async run<T>(operation: (attempt: number) => Promise<T>, options: RetryRunOptions = {}): Promise<T> {
    let lastError: LlmCallError | undefined;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      throwIfAborted(options.signal, 'Retry loop aborted');
      try {
        return await operation(attempt);
      } catch (error: unknown) {
        if (!(error instanceof LlmCallError)) throw error;
        lastError = error;

        const isLast = attempt >= this.config.maxAttempts;
        const allowed = options.isRetryable?.(error, attempt) ?? error.disposition.retryable;
        if (isLast || !allowed) break;

        const delayMs = this.delayFor(attempt, error);
        options.onRetry?.({ attempt, maxAttempts: this.config.maxAttempts, delayMs, error });
        await this.clock.sleep(delayMs, options.signal);
      }
    }

    throw lastError ?? new LlmCallError('unknown', 'Retry loop exited without a result');
  }

  /** Exposed for tests and for the journal, which records the planned delay. */
  delayFor(attempt: number, error?: LlmCallError): number {
    const { initialDelayMs, maxDelayMs, factor, jitter, respectRetryAfter } = this.config;

    if (respectRetryAfter && error?.retryAfterMs !== undefined) {
      return Math.min(maxDelayMs, Math.max(0, error.retryAfterMs));
    }

    const exponential = Math.min(maxDelayMs, initialDelayMs * factor ** (attempt - 1));
    switch (jitter) {
      case 'none':
        return exponential;
      case 'equal':
        return exponential / 2 + this.random() * (exponential / 2);
      case 'full':
      default:
        return this.random() * exponential;
    }
  }
}
