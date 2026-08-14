import { emptyStats, type TargetStats } from './types.js';

/** Live per-target counters, read by strategies and reported in the run summary. */
export class TargetStatsRegistry {
  private readonly stats = new Map<string, TargetStats>();

  get(key: string): TargetStats {
    let entry = this.stats.get(key);
    if (!entry) {
      entry = emptyStats(key);
      this.stats.set(key, entry);
    }
    return entry;
  }

  recordSuccess(key: string, latencyMs: number, costUsd: number): void {
    const entry = this.get(key);
    entry.requests += 1;
    entry.successes += 1;
    entry.consecutiveFailures = 0;
    entry.totalLatencyMs += latencyMs;
    entry.costUsd += costUsd;
    entry.lastUsedAt = Date.now();
  }

  recordFailure(key: string): void {
    const entry = this.get(key);
    entry.requests += 1;
    entry.failures += 1;
    entry.consecutiveFailures += 1;
    entry.lastUsedAt = Date.now();
  }

  snapshot(): TargetStats[] {
    return [...this.stats.values()].map((entry) => ({ ...entry }));
  }
}
