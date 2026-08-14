import cliProgress from 'cli-progress';
import pc from 'picocolors';

import type { MetricsSnapshot } from '../../observability/Metrics.js';
import type { ProgressReporter, ProgressTaskInfo } from '../../observability/ProgressReporter.js';
import { formatCost, formatDuration, formatTokens, symbols, truncate } from './format.js';

/**
 * Live single-bar progress for a TTY.
 *
 * All output goes through the bar's own `log()` so nothing is written over a
 * repainting line — that is also why the logger's writer is redirected here for
 * the duration of the run.
 */
export class ConsoleProgress implements ProgressReporter {
  private container: cliProgress.MultiBar | undefined;
  private bar: cliProgress.SingleBar | undefined;
  private active = 0;

  start(totalTasks: number): void {
    this.container = new cliProgress.MultiBar(
      {
        format: `${pc.cyan('{bar}')} {percentage}% │ {value}/{total} tasks │ ${pc.dim('{stats}')}`,
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        clearOnComplete: false,
        stopOnComplete: false,
        forceRedraw: true,
      },
      cliProgress.Presets.shades_grey,
    );
    this.bar = this.container.create(Math.max(totalTasks, 1), 0, { stats: 'starting…' });
  }

  taskStarted(_task: ProgressTaskInfo): void {
    this.active += 1;
  }

  taskFinished(task: ProgressTaskInfo, status: 'completed' | 'failed' | 'skipped', detail?: string): void {
    this.active = Math.max(0, this.active - 1);
    this.bar?.increment();

    // Successes are summarized by the bar; only the exceptions deserve a line.
    if (status === 'completed') return;
    const icon = status === 'failed' ? symbols.fail : symbols.skip;
    const suffix = detail ? pc.dim(` — ${truncate(detail, 100)}`) : '';
    this.writeLine(`${icon} ${pc.bold(task.label)}${suffix}`);
  }

  update(snapshot: MetricsSnapshot): void {
    this.bar?.update({ stats: this.statsLine(snapshot) });
  }

  note(level: 'info' | 'warn' | 'error', message: string): void {
    const paint = level === 'error' ? pc.red : level === 'warn' ? pc.yellow : pc.blue;
    this.writeLine(paint(message));
  }

  stop(snapshot: MetricsSnapshot): void {
    this.bar?.update({ stats: this.statsLine(snapshot) });
    this.container?.stop();
    this.container = undefined;
    this.bar = undefined;
  }

  /** Log sink that survives a repainting bar. */
  writeLine(line: string): void {
    if (this.container) this.container.log(`${line}\n`);
    else process.stderr.write(`${line}\n`);
  }

  private statsLine(snapshot: MetricsSnapshot): string {
    const parts = [
      `${snapshot.llmRequests} req`,
      `${formatTokens(snapshot.promptTokens + snapshot.completionTokens)} tok`,
      formatCost(snapshot.costUsd),
      `${formatDuration(snapshot.elapsedMs)}`,
    ];
    if (this.active > 0) parts.unshift(`${this.active} running`);
    if (snapshot.retries > 0) parts.push(`${snapshot.retries} retry`);
    if (snapshot.fallbacks > 0) parts.push(`${snapshot.fallbacks} fallback`);
    if (snapshot.tasksFailed > 0) parts.push(pc.red(`${snapshot.tasksFailed} failed`));
    return parts.join(' │ ');
  }
}
