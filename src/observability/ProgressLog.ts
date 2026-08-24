import { sep } from 'node:path';

import type { AttemptRecord, FallbackInfo, RetryInfo, TargetDownInfo } from '../llm/LlmGateway.js';
import { LineAppender } from '../shared/fs.js';

export interface ProgressLogOptions {
  /** Absolute path to write to; `null` disables the log entirely. */
  file: string | null;
  /** Never write more often than this, however many tasks finish. */
  intervalMs: number;
}

export interface ProgressLogTask {
  taskId: string;
  pipeline: string;
  /** Human identity of the task, used when it produced no file. */
  label: string;
  /** Written artifacts, as paths relative to `output.baseDir`. */
  outputs: readonly string[];
  durationMs: number;
  status: 'completed' | 'failed';
  /** Why it failed, for the one line that says so. */
  detail?: string;
}

/** A provider's message is a paragraph; the log is a column. */
const DETAIL_CHARS = 180;
/** `[websearch]` is the longest token, so every quote starts in the same column. */
const PIPELINE_WIDTH = 11;

/**
 * A plain-text account of what happened, in the project root, readable by a
 * person watching a long run.
 *
 * Everything else this tool records is written for a machine to read back:
 * `events.jsonl` is an audit trail, `state.json` a checkpoint, and both are
 * complete and both are unreadable while you are waiting. This answers the one
 * question a batch run actually prompts — *what is it doing, and who is doing
 * it* — in one line per finished task:
 *
 * ```
 * [22:40:01] [extract]   'ru\abiton.bio.json' : local-small:gemma4-31b-local (35.0s)
 * [22:40:36] [translate] 'en\abiton.bio.md' : or-cheap:deepseek/deepseek-v4-flash-0731 (1m 2s)
 * ```
 *
 * Two things make it cheap enough to leave on. Lines are **buffered and
 * flushed at most once per `intervalMs`**, so a corpus finishing tasks in
 * bursts costs a handful of writes rather than one per task; and the model is
 * *remembered* rather than looked up, because the only place that knows which
 * target answered is the gateway and the only place that knows a task is
 * finished is the orchestrator. The join key is the task id, which every
 * completion request already carries as its `correlationId`.
 *
 * It appends. A run that follows another is separated by a header rather than
 * erasing it — the question "which model did this file last time?" is worth
 * as much as "what is it doing now".
 */
export class ProgressLog {
  private readonly sink: LineAppender | undefined;
  /** taskId → `modelId:modelName` of the target that last answered for it. */
  private readonly models = new Map<string, string>();
  /** taskId → human label, so an incident mid-task can say which one. */
  private readonly labels = new Map<string, string>();
  private readonly pending: string[] = [];
  private lastFlushAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: ProgressLogOptions) {
    this.sink = options.file ? new LineAppender(options.file) : undefined;
  }

  get enabled(): boolean {
    return this.sink !== undefined;
  }

  /**
   * Remembers which target answered for a task.
   *
   * Last success wins: a task that fell back from a dead model to a working one
   * was served by the working one, and that is what the line should say. Failed
   * attempts are ignored for the same reason — naming the model that refused
   * would credit it with work it did not do.
   */
  noteAttempt(record: AttemptRecord): void {
    if (!this.sink || record.outcome !== 'success' || !record.correlationId) return;
    this.models.set(record.correlationId, `${record.modelId}:${record.modelName}`);
  }

  runStarted(info: { runId: string; tasks: number; skipped: number }): void {
    if (!this.sink) return;
    const already = info.skipped > 0 ? `, ${info.skipped} already done` : '';
    this.pending.push('');
    this.pending.push(`=== ${stamp(new Date())} · run ${info.runId} · ${info.tasks} task(s)${already} ===`);
    // Immediately, not on the interval: a monitor should see the run start.
    void this.flush();
  }

  /**
   * Remembers what a task is called, so an incident that happens while it runs
   * can name it. A retry knows the task id and nothing else; the file it is
   * producing does not exist yet, and may never.
   */
  taskStarted(task: { taskId: string; label: string }): void {
    if (!this.sink) return;
    this.labels.set(task.taskId, task.label);
  }

  /** One line per file the task produced, or one naming the task when it produced none. */
  taskFinished(task: ProgressLogTask): void {
    if (!this.sink) return;

    const model = this.models.get(task.taskId) ?? '—';
    this.models.delete(task.taskId);
    this.labels.delete(task.taskId);
    const duration = formatSpan(task.durationMs);
    const failure = task.status === 'failed' ? ` FAILED — ${truncate(task.detail ?? 'unknown error')}` : '';

    for (const subject of subjectsOf(task)) {
      this.pending.push(
        `[${clock(new Date())}] ${`[${task.pipeline}]`.padEnd(PIPELINE_WIDTH)} '${subject}' : ` +
          `${model} (${duration})${failure}`,
      );
    }
    this.schedule();
  }

  /**
   * A model failed and is being asked again.
   *
   * Recovered incidents are the ones nothing else shows. The run summary counts
   * retries and the journal records them, but neither says *which document* was
   * being processed when a target started timing out — and a target that is
   * quietly costing every document two extra minutes looks, from the summary,
   * exactly like one that is working.
   */
  noteRetry(info: RetryInfo): void {
    this.incident(
      info,
      `retry ${info.attempt}/${info.maxAttempts} on ${info.target} — ${info.kind}: ${info.message}` +
        ` (next attempt in ${formatSpan(info.delayMs)})`,
    );
  }

  /**
   * A model gave up and the next one in the pool took over.
   *
   * This is the line that explains a surprise in the task lines above and below
   * it: the file that says `or-cheap` was meant to be served by `local-small`,
   * and here is why it was not.
   */
  noteFallback(info: FallbackInfo): void {
    this.incident(info, `fallback ${info.from} → ${info.to} — ${info.kind}: ${info.message}`);
  }

  /**
   * A target this run has written off entirely — reported once, the first time.
   *
   * The one incident that is about the configuration rather than about a call.
   * A pool is a fallback chain, so a first choice that never works is survivable
   * and therefore invisible: every document is produced, and the only trace is
   * the bill from the model that was supposed to be the backup.
   */
  noteTargetDown(info: TargetDownInfo): void {
    this.incident(info, `TARGET DOWN ${info.target} — ${info.kind}: ${info.message}`, false);
  }

  /**
   * The whole task is being run again, on a different model.
   *
   * Distinct from `noteRetry`, which is one call being repeated on the same
   * target: this one says the task's *answer* was rejected after every call in
   * it had succeeded, so the line names who is now being avoided and why.
   */
  noteTaskRetry(info: {
    taskId: string;
    pipeline: string;
    attempt: number;
    maxAttempts: number;
    avoided: readonly string[];
    message: string;
  }): void {
    this.incident(
      { pipeline: info.pipeline, correlationId: info.taskId },
      `task attempt ${info.attempt}/${info.maxAttempts}, now avoiding ${info.avoided.join(', ')} — ${info.message}`,
    );
  }

  /**
   * The incident line. `!` in the column where a task line has a quote, so both
   * kinds read as one column of events and `grep ' ! '` separates them.
   *
   * Targets are named by their **key** here (`endpoint:model-id`) rather than
   * as `model-id:wire-name`, because an incident is something to go and fix in
   * `llm.endpoints` / `llm.models`, and the key is the address of the entry to
   * fix. The shared model id joins the two kinds of line.
   */
  private incident(info: { pipeline: string; correlationId?: string }, text: string, named = true): void {
    if (!this.sink) return;
    const label = named ? this.labels.get(info.correlationId ?? '') : undefined;
    this.pending.push(
      `[${clock(new Date())}] ${`[${info.pipeline}]`.padEnd(PIPELINE_WIDTH)} ! ` +
        (label ? `'${label}' ` : '') +
        truncate(text),
    );
    this.schedule();
  }

  runFinished(info: { status: string; durationMs: number; completed: number; failed: number; costUsd: number }): void {
    if (!this.sink) return;
    this.pending.push(
      `=== ${info.status} in ${formatSpan(info.durationMs)} · ${info.completed} ok · ` +
        `${info.failed} failed · $${info.costUsd.toFixed(5)} ===`,
    );
    void this.flush();
  }

  async close(): Promise<void> {
    this.clearTimer();
    await this.flush();
    await this.sink?.close();
  }

  /**
   * Writes now if the interval has elapsed, and otherwise arranges to write
   * when it has.
   *
   * The timer is what makes "at most every 30 seconds" also mean "at least
   * every 30 seconds": without it a line arriving just after a flush would sit
   * in memory until the next task finished, which on a slow document is
   * minutes of a log file that says nothing is happening. It is unref'd, so it
   * never keeps the process alive on its own.
   */
  private schedule(): void {
    if (this.timer || this.pending.length === 0) return;

    const due = this.lastFlushAt + this.options.intervalMs - Date.now();
    if (due <= 0) {
      void this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, due);
    this.timer.unref?.();
  }

  /**
   * Serialized against itself, so two flushes cannot interleave their lines.
   *
   * It awaits the in-flight write even when there is nothing new to add, which
   * is what makes it safe for `close()` to call: opening the file is itself
   * asynchronous, so a `flush()` that returned early would let the stream be
   * ended before the append that created it had run, and the last lines of the
   * run would never reach the disk.
   */
  private async flush(): Promise<void> {
    this.clearTimer();

    if (this.sink && this.pending.length > 0) {
      const batch = this.pending.splice(0, this.pending.length);
      this.lastFlushAt = Date.now();
      this.writing = this.writing
        .then(() => this.sink?.append(batch.join('\n')))
        .then(() => undefined)
        // A progress log that cannot be written must never take a run down with
        // it: the artifacts are the product, this is the commentary.
        .catch(() => undefined);
    }
    await this.writing;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * What the line is about: the files the task published, or the task itself.
 *
 * `extract` writes a dossier *and* an internal `.hints/` hand-off, and only the
 * first is worth a line — but `portrait`'s whole product **is** a hint file, so
 * "drop the dot-prefixed ones" cannot be the rule on its own. Prefer the
 * published outputs, fall back to whatever was written, and fall back again to
 * the task's own label for a task that produced nothing at all (a web search
 * with no gaps to fill, or a failure).
 */
function subjectsOf(task: ProgressLogTask): string[] {
  const published = task.outputs.filter((path) => !path.split('/').some((part) => part.startsWith('.')));
  const chosen = published.length > 0 ? published : task.outputs;
  if (chosen.length === 0) return [task.label];
  // Native separators with a leading one: the path as it reads under out/.
  return chosen.map((path) => sep + path.split('/').join(sep));
}

function clock(at: Date): string {
  return at.toTimeString().slice(0, 8);
}

function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 10)} ${clock(at)}`;
}

/** The same shape the run summary prints, so two surfaces never disagree. */
function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat;
}
