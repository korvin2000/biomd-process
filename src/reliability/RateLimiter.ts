import { systemClock, throwIfAborted, type Clock } from '../shared/async.js';
import { AbortedError } from '../shared/errors.js';

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

  /** True when a slot is available without waiting. Advisory: read, then race. */
  get hasFreeSlot(): boolean {
    const limit = this.options.maxConcurrent || Number.POSITIVE_INFINITY;
    return this.active < limit;
  }

  /**
   * Resolves to a release function; always call it in a `finally`.
   *
   * Rejects with {@link AbortedError} when `signal` fires first, and takes no
   * slot when it does. That is what makes "wait this long for a slot, then give
   * up" expressible: a caller that cannot tell being served from giving up has
   * to wait forever.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    await this.acquireSlot(signal);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };

    // The slot is held from here on, so anything that throws below must hand it
    // back. Token and spacing waits both sleep, and both reject when aborted.
    try {
      await this.acquireToken(signal);
      await this.acquireSpacing(signal);
    } catch (error: unknown) {
      release();
      throw error;
    }
    return release;
  }

  /**
   * Queues for a concurrency slot, or rejects if `signal` fires while queueing.
   *
   * An abandoned waiter takes itself out of the queue. Leaving it there costs
   * more than the memory: `release` hands the freed slot to `waiters.shift()`,
   * so a dead waiter swallows a wakeup that a live one was owed, and the queue
   * stalls behind it until the next release.
   */
  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    const limit = this.options.maxConcurrent || Number.POSITIVE_INFINITY;
    throwIfAborted(signal, 'Aborted before acquiring a concurrency slot');

    while (this.active >= limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => {
          signal?.removeEventListener('abort', onAbort);
          // Woken and abandoned in the same turn: pass the slot on rather than
          // taking it, or the wakeup is lost with nobody holding anything.
          if (signal?.aborted) {
            this.waiters.shift()?.();
            reject(new AbortedError('Aborted while waiting for a concurrency slot'));
            return;
          }
          resolve();
        };
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new AbortedError('Aborted while waiting for a concurrency slot'));
        };
        this.waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
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
