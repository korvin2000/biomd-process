import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../src/reliability/RateLimiter.js';
import type { Clock } from '../src/shared/async.js';

/**
 * The floor on the gap between two dispatches to one endpoint.
 *
 * `requestsPerMinute` cannot express it: a token bucket starts full, so 60/min
 * lets sixty requests leave together and then waits a minute. A gateway that
 * mishandles simultaneous arrivals — omniroute does not separate calls under
 * 100ms apart — needs the interval, and needs it to hold *across* concurrent
 * slots, which is the case a naive "sleep since the last dispatch" gets wrong:
 * two callers read the same last-dispatch stamp and leave together anyway.
 */

/**
 * Virtual time, so the test measures ordering rather than wall-clock luck.
 *
 * `sleep` only queues a wake-up; nothing advances until the pump runs, which is
 * what makes the readings exact — every acquirer that claims its slot in the
 * same tick reads the same `now`, exactly as it does against a real clock.
 */
function virtualClock() {
  let time = 0;
  let pending: Array<{ at: number; resolve: () => void }> = [];

  const clock: Clock = {
    now: () => time,
    sleep(ms: number): Promise<void> {
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending.push({ at: time + ms, resolve });
      });
    },
  };

  async function run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    void work.then(
      () => (settled = true),
      () => (settled = true),
    );

    for (let guard = 0; guard < 1000 && !settled; guard += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (settled || pending.length === 0) break;

      time = Math.min(...pending.map((w) => w.at));
      const due = pending.filter((w) => w.at <= time);
      pending = pending.filter((w) => w.at > time);
      for (const waiter of due) waiter.resolve();
    }
    return work;
  }

  return { clock, run, now: () => time };
}

/** The virtual instant at which each of `n` competing requests was dispatched. */
async function dispatchTimes(
  options: { maxConcurrent: number; minRequestSpacingMs?: number },
  n: number,
): Promise<number[]> {
  const { clock, run } = virtualClock();
  const limiter = new RateLimiter({ requestsPerMinute: 0, ...options }, clock);
  const stamps: number[] = [];

  await run(
    Promise.all(
      Array.from({ length: n }, async () => {
        const release = await limiter.acquire();
        stamps.push(clock.now());
        release();
      }),
    ),
  );

  return [...stamps].sort((a, b) => a - b);
}

describe('RateLimiter minimum request spacing', () => {
  it('spaces concurrent acquirers by the configured interval', async () => {
    const stamps = await dispatchTimes({ maxConcurrent: 2, minRequestSpacingMs: 150 }, 4);

    expect(stamps).toHaveLength(4);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(150);
    }
  });

  it('claims the slot before awaiting, so two callers never read the same gap', async () => {
    // Unlimited concurrency: nothing but the spacing separates these, which is
    // the arrangement that catches a spacing computed from a shared timestamp.
    const stamps = await dispatchTimes({ maxConcurrent: 0, minRequestSpacingMs: 100 }, 3);

    expect(stamps).toEqual([0, 100, 200]);
  });

  it('does nothing when unset, so every other endpoint is unaffected', async () => {
    const stamps = await dispatchTimes({ maxConcurrent: 0 }, 3);

    expect(stamps).toEqual([0, 0, 0]);
  });

  it('still enforces the concurrency ceiling alongside the spacing', async () => {
    const { clock, run } = virtualClock();
    const limiter = new RateLimiter(
      { requestsPerMinute: 0, maxConcurrent: 1, minRequestSpacingMs: 100 },
      clock,
    );

    let active = 0;
    let peak = 0;
    await run(
      Promise.all(
        Array.from({ length: 4 }, async () => {
          const release = await limiter.acquire();
          active += 1;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active -= 1;
          release();
        }),
      ),
    );

    expect(peak).toBe(1);
  });
});
