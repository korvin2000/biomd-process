import { emptyStats, RECENT_WINDOW, type TargetStats } from './types.js';

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

  /**
   * `completionTokens` — what the model generated, never the prompt; see
   * {@link RecentCall}. Optional so a caller that does not know the usage still
   * records the success. A window entry without tokens would be worse than no
   * entry: it would drag the measured throughput of a healthy target towards
   * zero, so those calls update the counters and leave the window alone.
   */
  recordSuccess(key: string, latencyMs: number, costUsd: number, completionTokens = 0): void {
    const entry = this.get(key);
    entry.requests += 1;
    entry.successes += 1;
    entry.consecutiveFailures = 0;
    entry.totalLatencyMs += latencyMs;
    entry.costUsd += costUsd;
    entry.lastUsedAt = Date.now();
    if (completionTokens > 0 && latencyMs > 0) {
      entry.recent.push({ latencyMs, completionTokens });
      if (entry.recent.length > RECENT_WINDOW) entry.recent.splice(0, entry.recent.length - RECENT_WINDOW);
    }
  }

  recordFailure(key: string): void {
    const entry = this.get(key);
    entry.requests += 1;
    entry.failures += 1;
    entry.consecutiveFailures += 1;
    entry.lastUsedAt = Date.now();
  }

  snapshot(): TargetStats[] {
    return [...this.stats.values()].map((entry) => ({ ...entry, recent: [...entry.recent] }));
  }
}
