import { systemClock, type Clock } from '../shared/async.js';

export interface RateLimitOptions {
  /** 0 = unlimited. */
  requestsPerMinute: number;
  /** 0 = unlimited. */
  maxConcurrent: number;
}

/**
 * Client-side throttle for one endpoint: a request-per-minute token bucket plus
 * a concurrency semaphore. Being polite locally is cheaper than being rate
 * limited remotely — a 429 costs a full round-trip and a backoff sleep.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private active = 0;
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
