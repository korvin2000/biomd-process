import type { MetricsSnapshot } from './Metrics.js';

export interface ProgressTaskInfo {
  taskId: string;
  pipeline: string;
  variant?: string;
  label: string;
}

/**
 * UI seam. The orchestrator reports progress through this interface and knows
 * nothing about terminals, so a TUI, a web dashboard or a CI-friendly line
 * printer are all drop-in replacements.
 */
export interface ProgressReporter {
  start(totalTasks: number): void;
  taskStarted(task: ProgressTaskInfo): void;
  taskFinished(task: ProgressTaskInfo, status: 'completed' | 'failed' | 'skipped', detail?: string): void;
  update(snapshot: MetricsSnapshot): void;
  /** Out-of-band message that must not be swallowed by the progress display. */
  note(level: 'info' | 'warn' | 'error', message: string): void;
  stop(snapshot: MetricsSnapshot): void;
}

export const nullProgressReporter: ProgressReporter = {
  start: () => undefined,
  taskStarted: () => undefined,
  taskFinished: () => undefined,
  update: () => undefined,
  note: () => undefined,
  stop: () => undefined,
};
