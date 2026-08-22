import cliProgress from 'cli-progress';
import pc from 'picocolors';

import type { MetricsSnapshot } from '../../observability/Metrics.js';
import type { ProgressReporter, ProgressTaskInfo } from '../../observability/ProgressReporter.js';
import { estimateRemaining, formatCost, formatDuration, formatEta, formatTokens, symbols, truncate } from './format.js';

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
  private total = 0;
  /**
   * Repaint on a timer as well as on every task.
   *
   * A corpus of a thousand documents spends minutes inside one wave of long
   * translations, and a bar that only moves when a task *finishes* looks like a
   * hung process for all of it. The clock and the estimate are the parts that
   * have something new to say every second.
   */
  private ticker: NodeJS.Timeout | undefined;
  private latest: MetricsSnapshot | undefined;

  start(totalTasks: number): void {
    this.total = Math.max(totalTasks, 1);
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
    this.bar = this.container.create(this.total, 0, { stats: 'starting…' });

    this.ticker = setInterval(() => {
      if (this.latest) this.bar?.update({ stats: this.statsLine(this.latest) });
    }, 1000);
    this.ticker.unref?.();
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
    this.latest = snapshot;
    this.bar?.update({ stats: this.statsLine(snapshot) });
  }

  note(level: 'info' | 'warn' | 'error', message: string): void {
    const paint = level === 'error' ? pc.red : level === 'warn' ? pc.yellow : pc.blue;
    this.writeLine(paint(message));
  }

  stop(snapshot: MetricsSnapshot): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.latest = undefined;
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

  /**
   * Time first, then throughput, then money.
   *
   * A batch run over a real corpus is measured in tens of minutes, and the
   * question the terminal is being asked is "how long", not "how many tokens".
   * The remaining estimate carries the time of day it implies, because
   * `~34m left` and `done by 19:07` answer different halves of that question and
   * only one of them survives being read half an hour later.
   */
  private statsLine(snapshot: MetricsSnapshot): string {
    const parts: string[] = [];
    if (this.active > 0) parts.push(`${this.active} running`);

    parts.push(formatDuration(snapshot.elapsedMs));

    const remaining = estimateRemaining(snapshot.elapsedMs, snapshot.tasksDone, this.total);
    if (remaining !== undefined) parts.push(`~${formatDuration(remaining)} left (${formatEta(remaining)})`);

    const perMinute = snapshot.tasksDone / Math.max(snapshot.elapsedMs / 60_000, 1 / 60);
    if (snapshot.tasksDone > 0) parts.push(`${perMinute.toFixed(1)}/min`);

    parts.push(
      `${snapshot.llmRequests} req`,
      `${formatTokens(snapshot.promptTokens + snapshot.completionTokens)} tok`,
      formatCost(snapshot.costUsd),
    );

    if (snapshot.retries > 0) parts.push(`${snapshot.retries} retry`);
    if (snapshot.fallbacks > 0) parts.push(`${snapshot.fallbacks} fallback`);
    if (snapshot.downTargets.length > 0) {
      parts.push(pc.red(`${snapshot.downTargets.length} target(s) down`));
    }
    if (snapshot.tasksFailed > 0) parts.push(pc.red(`${snapshot.tasksFailed} failed`));
    return parts.join(' │ ');
  }
}
