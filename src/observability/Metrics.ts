import type { AttemptRecord } from '../llm/LlmGateway.js';
import { emptyTotals, type RunTotals, type TaskStatus } from '../state/types.js';

/** A target this run gave up on, and what the provider said about it. */
export interface DownTarget {
  target: string;
  kind: string;
  message: string;
}

export interface MetricsSnapshot extends RunTotals {
  errorsByKind: Record<string, number>;
  elapsedMs: number;
  /** Successfully completed + failed + skipped. */
  tasksDone: number;
  /**
   * Targets written off during the run.
   *
   * Kept out of `errorsByKind` on purpose: an error count says how often
   * something went wrong, and this says that a model named in the config never
   * worked at all — a different question, with a different fix.
   */
  downTargets: DownTarget[];
}

/**
 * Live counters for the progress UI and the run manifest.
 *
 * Everything the user asked to see — files, tasks, requests, retries, fallbacks,
 * errors, tokens, cost — is aggregated in one place, fed by the gateway
 * observer and the orchestrator, so the terminal, the manifest and the journal
 * never disagree.
 */
export class MetricsCollector {
  private readonly totals: RunTotals = emptyTotals();
  private readonly errorsByKind = new Map<string, number>();
  private readonly downTargets = new Map<string, DownTarget>();
  private readonly startedAt = Date.now();

  setPlanned(workItems: number, tasksPlanned: number): void {
    this.totals.workItems = workItems;
    this.totals.tasksPlanned = tasksPlanned;
  }

  recordAttempt(record: AttemptRecord): void {
    this.totals.llmRequests += 1;
    this.totals.promptTokens += record.usage.promptTokens;
    this.totals.completionTokens += record.usage.completionTokens;
    this.totals.cachedPromptTokens += record.usage.cachedPromptTokens;
    this.totals.reasoningTokens += record.usage.reasoningTokens;
    this.totals.costUsd += record.costUsd;
    if (record.outcome === 'error' && record.errorKind) this.countError(record.errorKind);
  }

  recordRetry(): void {
    this.totals.retries += 1;
  }

  recordFallback(): void {
    this.totals.fallbacks += 1;
  }

  recordTask(status: TaskStatus): void {
    if (status === 'completed') this.totals.tasksCompleted += 1;
    else if (status === 'failed') this.totals.tasksFailed += 1;
    else if (status === 'skipped') this.totals.tasksSkipped += 1;
  }

  /** First failure of a target this run has stopped using. Idempotent per target. */
  recordTargetDown(target: string, kind: string, message: string): void {
    if (!this.downTargets.has(target)) this.downTargets.set(target, { target, kind, message });
  }

  countError(kind: string): void {
    this.errorsByKind.set(kind, (this.errorsByKind.get(kind) ?? 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    return {
      ...this.totals,
      costUsd: Number(this.totals.costUsd.toFixed(6)),
      errorsByKind: Object.fromEntries([...this.errorsByKind].sort((a, b) => b[1] - a[1])),
      elapsedMs: Date.now() - this.startedAt,
      tasksDone: this.totals.tasksCompleted + this.totals.tasksFailed + this.totals.tasksSkipped,
      downTargets: [...this.downTargets.values()],
    };
  }

  runTotals(): RunTotals {
    return { ...this.totals, costUsd: Number(this.totals.costUsd.toFixed(6)) };
  }
}
