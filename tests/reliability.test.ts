import { describe, expect, it, vi } from 'vitest';

import { ErrorClassifier } from '../src/reliability/ErrorClassifier.js';
import { CircuitBreakerRegistry } from '../src/reliability/CircuitBreaker.js';
import {
  AllTargetsFailedError,
  LlmCallError,
  countsTowardCircuit,
  disablesTarget,
  isOutputTruncated,
} from '../src/reliability/errors.js';
import type { LlmErrorKind } from '../src/reliability/errors.js';
import { RetryPolicy } from '../src/reliability/RetryPolicy.js';
import { TimeoutError } from '../src/shared/errors.js';
import type { Clock } from '../src/shared/async.js';

const retryConfig = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  factor: 2,
  jitter: 'none' as const,
  respectRetryAfter: true,
};

function fakeClock(): Clock & { slept: number[]; time: number } {
  const clock = {
    time: 0,
    slept: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

describe('ErrorClassifier', () => {
  const classifier = new ErrorClassifier();

  it.each([
    [429, 'rate_limit'],
    [401, 'auth'],
    [402, 'quota'],
    [404, 'model_unavailable'],
    [422, 'context_length'],
    [500, 'server'],
    [400, 'invalid_request'],
  ])('maps HTTP %i to %s', (status, kind) => {
    expect(classifier.classify({ status, message: 'boom' }).kind).toBe(kind);
  });

  it('detects context overflow from the message even on a 400', () => {
    const error = { status: 400, message: "This model's maximum context length is 8192 tokens" };
    expect(classifier.classify(error).kind).toBe('context_length');
  });

  it('maps transport failures to network', () => {
    expect(classifier.classify({ code: 'ECONNRESET', message: 'socket hang up' }).kind).toBe('network');
  });

  it('preserves a TimeoutError as a timeout', () => {
    expect(classifier.classify(new TimeoutError('too slow')).kind).toBe('timeout');
  });

  it('reads Retry-After seconds from the response headers', () => {
    const error = { status: 429, message: 'slow down', headers: { 'retry-after': '2' } };
    expect(classifier.classify(error).retryAfterMs).toBe(2000);
  });

  it('gives context_length a fallback-but-no-retry disposition', () => {
    const disposition = classifier.classify({ status: 413, message: 'too big' }).disposition;
    expect(disposition).toEqual({ retryable: false, fallbackable: true });
  });
});

describe('a cut-off answer', () => {
  const truncated = new LlmCallError('output_truncated', 'cut off at 8192 tokens');

  it('is worth another model but not another attempt at the same one', () => {
    // The two axes are separate on purpose: the payload was accepted and the
    // model ran out of room, so the same request produces the same cut. Only a
    // wider target — or a smaller request — changes the outcome.
    expect(truncated.disposition).toEqual({ retryable: false, fallbackable: true });
  });

  it('is distinguishable from an unparseable one, which is worth retrying', () => {
    expect(new LlmCallError('response_format', 'not JSON').disposition.retryable).toBe(true);
  });

  it('is recognizable through the exhausted-chain error a caller actually catches', () => {
    const exhausted = new AllTargetsFailedError('everything failed', [
      new LlmCallError('server', 'upstream exploded'),
      truncated,
    ]);

    expect(isOutputTruncated(exhausted)).toBe(true);
    expect(isOutputTruncated(new AllTargetsFailedError('down', [new LlmCallError('server', 'nope')]))).toBe(false);
    expect(isOutputTruncated(new Error('unrelated'))).toBe(false);
  });
});

describe('target health classification', () => {
  it('does not poison a circuit with request-specific failures', () => {
    for (const kind of ['context_length', 'content_filter', 'response_format', 'output_truncated'] as const) {
      expect(countsTowardCircuit(kind)).toBe(false);
      expect(disablesTarget(kind)).toBe(false);
    }
  });

  it('disables only conclusively unusable targets', () => {
    expect(disablesTarget('auth')).toBe(true);
    expect(disablesTarget('quota')).toBe(true);
    expect(disablesTarget('timeout')).toBe(false);
  });

  it('does not write a target off for the run on `model_unavailable`', () => {
    // It is the classification for a bare 404 and for `no healthy deployment`,
    // and `omniroute` produces both intermittently for a model listed in its own
    // `/v1/models`, working again minutes later. Permanently disabling the target
    // on one such window is how the rest of a corpus ends up on the paid
    // fallback. The breaker still counts it, so a genuinely dead target opens.
    expect(disablesTarget('model_unavailable')).toBe(false);
    expect(countsTowardCircuit('model_unavailable')).toBe(true);
  });
});

describe('the circuit breaker under mixed failure kinds', () => {
  const config = { enabled: true, failureThreshold: 3, resetAfterMs: 30_000, halfOpenMaxCalls: 1 };

  /** Exactly what `LlmGateway` does on a caught failure. */
  function onFailure(breakers: CircuitBreakerRegistry, key: string, kind: LlmErrorKind): void {
    if (countsTowardCircuit(kind)) breakers.recordFailure(key);
  }

  it('opens for a target that keeps failing on health grounds', () => {
    const breakers = new CircuitBreakerRegistry(config);
    for (let i = 0; i < 3; i++) onFailure(breakers, 'ep:model', 'server');
    expect(breakers.stateOf('ep:model')).toBe('open');
  });

  it('does not let a request-specific failure erase the failures counted so far', () => {
    // `recordSuccess` is `entries.delete(key)`. Calling it for a failure that
    // merely does not *count* is a full state wipe, and a target alternating
    // `server` with `response_format` would then never reach its threshold.
    const breakers = new CircuitBreakerRegistry(config);
    onFailure(breakers, 'ep:model', 'server');
    onFailure(breakers, 'ep:model', 'server');
    onFailure(breakers, 'ep:model', 'response_format');
    onFailure(breakers, 'ep:model', 'server');
    expect(breakers.stateOf('ep:model')).toBe('open');
  });

  it('keeps the breaker open when a half-open probe fails for a request-specific reason', () => {
    let now = 1_000_000;
    const breakers = new CircuitBreakerRegistry(config, { now: () => now, sleep: async () => {} });
    for (let i = 0; i < 3; i++) onFailure(breakers, 'ep:model', 'server');

    now += 40_000;
    expect(breakers.canAttempt('ep:model')).toBe(true); // the single probe
    onFailure(breakers, 'ep:model', 'response_format');
    expect(breakers.stateOf('ep:model')).not.toBe('closed');
  });

  it('clears the record only on a real success', () => {
    const breakers = new CircuitBreakerRegistry(config);
    onFailure(breakers, 'ep:model', 'server');
    onFailure(breakers, 'ep:model', 'server');
    breakers.recordSuccess('ep:model');
    onFailure(breakers, 'ep:model', 'server');
    onFailure(breakers, 'ep:model', 'server');
    expect(breakers.stateOf('ep:model')).toBe('closed');
  });
});

describe('RetryPolicy', () => {
  it('retries transient failures and returns the eventual success', async () => {
    const clock = fakeClock();
    const policy = new RetryPolicy(retryConfig, clock, () => 0.5);
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new LlmCallError('server', '500'))
      .mockResolvedValueOnce('ok');

    await expect(policy.run(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(clock.slept).toEqual([100]);
  });

  it('does not retry a non-retryable failure', async () => {
    const clock = fakeClock();
    const policy = new RetryPolicy(retryConfig, clock);
    const operation = vi.fn().mockRejectedValue(new LlmCallError('invalid_request', 'bad'));

    await expect(policy.run(operation)).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(clock.slept).toEqual([]);
  });

  it('stops at maxAttempts and rethrows the last failure', async () => {
    const clock = fakeClock();
    const policy = new RetryPolicy(retryConfig, clock);
    const operation = vi.fn().mockRejectedValue(new LlmCallError('server', 'still down'));

    await expect(policy.run(operation)).rejects.toMatchObject({ message: 'still down' });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('grows the delay exponentially and honours the cap', () => {
    const policy = new RetryPolicy({ ...retryConfig, maxDelayMs: 300 }, fakeClock());
    expect([1, 2, 3, 4].map((attempt) => policy.delayFor(attempt))).toEqual([100, 200, 300, 300]);
  });

  it('prefers a server-provided Retry-After over the computed backoff', () => {
    const policy = new RetryPolicy(retryConfig, fakeClock());
    const error = new LlmCallError('rate_limit', 'slow down', { retryAfterMs: 1500 });
    expect(policy.delayFor(1, error)).toBe(1500);
  });

  it('keeps full jitter inside [0, backoff]', () => {
    const policy = new RetryPolicy({ ...retryConfig, jitter: 'full' }, fakeClock(), () => 0.75);
    expect(policy.delayFor(2)).toBe(150);
  });
});

describe('CircuitBreakerRegistry', () => {
  const config = { enabled: true, failureThreshold: 2, resetAfterMs: 1000, halfOpenMaxCalls: 1 };

  it('opens after the threshold and blocks further attempts', () => {
    const clock = fakeClock();
    const breakers = new CircuitBreakerRegistry(config, clock);

    breakers.recordFailure('a');
    expect(breakers.canAttempt('a')).toBe(true);
    breakers.recordFailure('a');
    expect(breakers.canAttempt('a')).toBe(false);
    expect(breakers.stateOf('a')).toBe('open');
  });

  it('allows a single probe after the cool-down and closes on success', () => {
    const clock = fakeClock();
    const breakers = new CircuitBreakerRegistry(config, clock);
    breakers.recordFailure('a');
    breakers.recordFailure('a');

    clock.time += 1001;
    expect(breakers.canAttempt('a')).toBe(true);
    expect(breakers.canAttempt('a')).toBe(false); // only one probe in half-open

    breakers.recordSuccess('a');
    expect(breakers.stateOf('a')).toBe('closed');
  });

  it('reopens immediately when the probe fails', () => {
    const clock = fakeClock();
    const breakers = new CircuitBreakerRegistry(config, clock);
    breakers.recordFailure('a');
    breakers.recordFailure('a');
    clock.time += 1001;
    breakers.canAttempt('a');

    breakers.recordFailure('a');
    expect(breakers.stateOf('a')).toBe('open');
  });

  it('is inert when disabled', () => {
    const breakers = new CircuitBreakerRegistry({ ...config, enabled: false }, fakeClock());
    breakers.recordFailure('a');
    breakers.recordFailure('a');
    expect(breakers.canAttempt('a')).toBe(true);
  });
});
