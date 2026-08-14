import type { MetricsSnapshot } from '../../observability/Metrics.js';
import type { ProgressReporter, ProgressTaskInfo } from '../../observability/ProgressReporter.js';
import { formatCost, formatDuration, symbols } from './format.js';

/**
 * One line per finished task. Used when stdout is not a TTY — CI logs, pipes and
 * redirected output, where a repainting bar produces thousands of useless lines.
 */
export class PlainProgress implements ProgressReporter {
  private total = 0;
  private done = 0;

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
  }

  update(): void {
    // Counters are printed once, at the end.
  }

  note(level: 'info' | 'warn' | 'error', message: string): void {
    process.stdout.write(`${level.toUpperCase()}: ${message}\n`);
  }

  stop(snapshot: MetricsSnapshot): void {
    process.stdout.write(
      `Finished in ${formatDuration(snapshot.elapsedMs)} — ` +
        `${snapshot.llmRequests} requests, ${formatCost(snapshot.costUsd)}\n`,
    );
  }

  writeLine(line: string): void {
    process.stderr.write(`${line}\n`);
  }
}
