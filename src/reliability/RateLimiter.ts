import { systemClock, type Clock } from '../shared/async.js';

export interface RateLimitOptions {
  /** 0 = unlimited. */
  requestsPerMinute: number;
  /** 0 = unlimited. */
  maxConcurrent: number;
  /**
   * Floor on the gap between two *dispatches* to this endpoint; 0 = none.
   *
   * Not the same guarantee as `requestsPerMinute`, and it is the difference
   * that matters here: a token bucket starts full, so 60/min happily lets
   * sixty requests leave in the same millisecond and then waits a minute.
   * A gateway that mishandles simultaneous arrivals needs the requests spread
   * out, which is a statement about the interval between them.
   */
  minRequestSpacingMs?: number;
}

/**
 * Client-side throttle for one endpoint: a request-per-minute token bucket, a
 * concurrency semaphore, and a floor on the gap between dispatches. Being
 * polite locally is cheaper than being rate limited remotely — a 429 costs a
 * full round-trip and a backoff sleep.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private active = 0;
  private nextDispatchAt = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly options: RateLimitOptions,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = options.requestsPerMinute || Number.POSITIVE_INFINITY;
    this.lastRefill = clock.now();
  }

  /** Resolves to a release function; always call it in a `finally`. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    await this.acquireSlot(signal);
    await this.acquireToken(signal);
    await this.acquireSpacing(signal);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }

  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    const limit = this.options.maxConcurrent || Number.POSITIVE_INFINITY;
    while (this.active >= limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (signal?.aborted) break;
    }
    this.active += 1;
  }

  private async acquireToken(signal?: AbortSignal): Promise<void> {
    const rpm = this.options.requestsPerMinute;
    if (!rpm) return;

    for (;;) {
      this.refill(rpm);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) * (60_000 / rpm));
      await this.clock.sleep(waitMs, signal);
    }
  }

  /**
   * Reserves this request's place in the dispatch sequence, then sleeps until
   * it comes round.
   *
   * The slot is claimed **synchronously**, before the `await` — which is the
   * whole mechanism. Two callers that read a shared "last dispatch" timestamp
   * and then each decide to wait both compute the same answer and both leave
   * together; claiming the slot first means the second caller queues behind
   * the first's reservation rather than behind its own reading of the clock.
   * Last in `acquire`, so the gap is between dispatches rather than between
   * decisions to dispatch.
   */
  private async acquireSpacing(signal?: AbortSignal): Promise<void> {
    const spacing = this.options.minRequestSpacingMs ?? 0;
    if (spacing <= 0) return;

    const now = this.clock.now();
    const slot = Math.max(now, this.nextDispatchAt);
    this.nextDispatchAt = slot + spacing;

    const waitMs = slot - now;
    if (waitMs > 0) await this.clock.sleep(waitMs, signal);
  }

  private refill(rpm: number): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(rpm, this.tokens + (elapsed * rpm) / 60_000);
  }
}

/** One limiter per endpoint id, created lazily from endpoint config. */
export class RateLimiterRegistry {
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(private readonly clock: Clock = systemClock) {}

  for(key: string, options: RateLimitOptions): RateLimiter {
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(options, this.clock);
      this.limiters.set(key, limiter);
    }
    return limiter;
  }
}
