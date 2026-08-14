import type { ReliabilityConfig } from '../config/schema.js';
import { systemClock, type Clock } from '../shared/async.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

type BreakerConfig = ReliabilityConfig['circuitBreaker'];

interface BreakerEntry {
  state: BreakerState;
  failures: number;
  openedAt: number;
  halfOpenCalls: number;
}

/**
 * One breaker per key (endpoint or model target). Keeps a run from hammering a
 * dead endpoint for every one of a thousand documents: after N consecutive
 * failures the key is skipped outright and routing moves on to the next target,
 * until a cool-down lets a single probe through.
 */
export class CircuitBreakerRegistry {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(
    private readonly config: BreakerConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  /** False when the key is open and still cooling down. */
  canAttempt(key: string): boolean {
    if (!this.config.enabled) return true;

    const entry = this.entries.get(key);
    if (!entry || entry.state === 'closed') return true;

    if (entry.state === 'open') {
      if (this.clock.now() - entry.openedAt < this.config.resetAfterMs) return false;
      entry.state = 'half-open';
      entry.halfOpenCalls = 0;
    }
    if (entry.halfOpenCalls >= this.config.halfOpenMaxCalls) return false;
    entry.halfOpenCalls += 1;
    return true;
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  recordFailure(key: string): void {
    if (!this.config.enabled) return;

    const entry = this.entries.get(key) ?? { state: 'closed', failures: 0, openedAt: 0, halfOpenCalls: 0 };
    entry.failures += 1;

    if (entry.state === 'half-open' || entry.failures >= this.config.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = this.clock.now();
      entry.halfOpenCalls = 0;
    }
    this.entries.set(key, entry);
  }

  stateOf(key: string): BreakerState {
    return this.entries.get(key)?.state ?? 'closed';
  }

  snapshot(): Record<string, BreakerState> {
    return Object.fromEntries([...this.entries].map(([key, entry]) => [key, entry.state]));
  }
}
