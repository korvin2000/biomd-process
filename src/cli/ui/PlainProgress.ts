import type { MetricsSnapshot } from '../../observability/Metrics.js';
import type { ProgressReporter, ProgressTaskInfo } from '../../observability/ProgressReporter.js';
import { estimateRemaining, formatCost, formatDuration, formatTokens, symbols } from './format.js';

/**
 * One line per finished task. Used when stdout is not a TTY — CI logs, pipes and
 * redirected output, where a repainting bar produces thousands of useless lines.
 */
export class PlainProgress implements ProgressReporter {
  private total = 0;
  private done = 0;
  private readonly startedAt = Date.now();
  private latest: MetricsSnapshot | undefined;

  start(totalTasks: number): void {
    this.total = totalTasks;
    process.stdout.write(`Running ${totalTasks} task(s)\n`);
  }

  taskStarted(): void {
    // Nothing: a start line per task doubles the log for no information.
  }

  taskFinished(task: ProgressTaskInfo, status: 'completed' | 'failed' | 'skipped', detail?: string): void {
    this.done += 1;
    const icon = status === 'completed' ? symbols.ok : status === 'failed' ? symbols.fail : symbols.skip;
    const suffix = detail ? ` — ${detail}` : '';
    process.stdout.write(`[${this.done}/${this.total}] ${icon} ${task.label}${suffix}\n`);

    // A progress line every task would double an already long log; one every
    // twenty is enough to tell a slow run from a stuck one, which is the only
    // thing this line is for when nobody is watching a terminal.
    if (this.done % 20 === 0) process.stdout.write(`${this.heartbeat()}\n`);
  }

  update(snapshot: MetricsSnapshot): void {
    this.latest = snapshot;
  }

  private heartbeat(): string {
    const elapsedMs = Date.now() - this.startedAt;
    const remaining = estimateRemaining(elapsedMs, this.done, this.total);
    const snapshot = this.latest;

    return (
      `… ${this.done}/${this.total} in ${formatDuration(elapsedMs)}` +
      (remaining === undefined ? '' : `, about ${formatDuration(remaining)} left`) +
      (snapshot
        ? `, ${snapshot.llmRequests} requests, ` +
          `${formatTokens(snapshot.promptTokens + snapshot.completionTokens)} tokens, ` +
          `${formatCost(snapshot.costUsd)}`
        : '')
    );
  }

  note(level: 'info' | 'warn' | 'error', message: string): void {
    process.stdout.write(`${level.toUpperCase()}: ${message}\n`);
  }

  stop(snapshot: MetricsSnapshot): void {
    process.stdout.write(
      `Finished in ${formatDuration(snapshot.elapsedMs)} — ` +
        `${snapshot.llmRequests} requests, ${formatCost(snapshot.costUsd)}\n`,
    );
    for (const down of snapshot.downTargets) {
      process.stdout.write(`WARN: model target "${down.target}" served nothing (${down.kind}): ${down.message}\n`);
    }
  }

  writeLine(line: string): void {
    process.stderr.write(`${line}\n`);
  }
}
