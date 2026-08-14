import { setTimeout as delay } from 'node:timers/promises';

import { AbortedError, TimeoutError } from './errors.js';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch((error: unknown) => {
    if (isAbortError(error)) throw new AbortedError('Sleep aborted');
    throw error;
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof AbortedError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  );
}

export function throwIfAborted(signal: AbortSignal | undefined, reason: string): void {
  if (signal?.aborted) throw new AbortedError(reason);
}

/**
 * Runs `fn` with a deadline. The inner operation receives a signal that is
 * aborted when either the deadline passes or the outer signal aborts, so
 * well-behaved clients (the OpenAI SDK included) cancel their sockets.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; label?: string } = {},
): Promise<T> {
  if (timeoutMs <= 0) return fn(options.signal ?? new AbortController().signal);

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timedOut = false;
  const onSelfAbort = () => {
    timedOut = !options.signal?.aborted;
  };
  controller.signal.addEventListener('abort', onSelfAbort, { once: true });

  try {
    return await fn(controller.signal);
  } catch (error: unknown) {
    if (timedOut || (isAbortError(error) && !options.signal?.aborted)) {
      throw new TimeoutError(`${options.label ?? 'Operation'} timed out after ${timeoutMs}ms`, {
        details: { timeoutMs, label: options.label },
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Deterministic clock seam — tests inject a fake. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep,
};
