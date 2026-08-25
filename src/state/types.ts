import type { TokenUsage } from '../llm/types.js';
import type { JsonObject } from '../shared/json.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** Checkpoint entry for one task, keyed by fingerprint. */
export interface TaskRecord {
  taskId: string;
  /** Input + prompt + contract hash. A change here invalidates the record. */
  fingerprint: string;
  workItemId: string;
  pipeline: string;
  variant?: string;
  status: TaskStatus;
  attempts: number;
  updatedAt: string;
  /** Output paths relative to the output base dir. */
  outputs: string[];
  usage?: TokenUsage;
  costUsd?: number;
  error?: { code: string; kind?: string; message: string };
  /** Why a task was skipped: `resume` | `existing-output` | `disabled` | … */
  skipReason?: string;
}

export interface RunTotals {
  workItems: number;
  tasksPlanned: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksSkipped: number;
  llmRequests: number;
  retries: number;
  fallbacks: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cacheWritePromptTokens: number;
  /**
   * Part of `completionTokens`, not additional to it — but billed at the output
   * rate and routinely larger than the answer, so it is tracked separately. A run
   * whose reasoning share is high is one to point `llm.models[].reasoning` at.
   */
  reasoningTokens: number;
  costUsd: number;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface RunManifest {
  runId: string;
  appVersion: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  configFile: string;
  configHash: string;
  /** Enabled pipelines for this run. */
  pipelines: string[];
  dryRun: boolean;
  resumedFrom?: string;
  totals: RunTotals;
  /** Redacted effective config, for reproducing the run later. */
  config?: JsonObject;
}

/**
 * Append-only journal entries. This union *is* the machine-readable protocol:
 * anything a later analysis might want (why a task was retried, which model
 * finally answered, what it cost) has to be an event here, because nothing else
 * survives the process.
 */
export type JournalEvent =
  | { type: 'run.started'; manifest: RunManifest }
  | { type: 'run.finished'; status: RunStatus; totals: RunTotals; durationMs: number }
  | { type: 'plan.created'; workItems: number; tasks: number; skipped: number }
  | { type: 'task.started'; taskId: string; pipeline: string; variant?: string; workItemId: string }
  | {
      type: 'task.completed';
      taskId: string;
      durationMs: number;
      outputs: string[];
      usage: TokenUsage;
      costUsd: number;
      contextAttempt?: string;
      /**
       * What the pipeline decided along the way — a refused web answer, a
       * conflict recorded rather than published, an edition not declared.
       *
       * These used to exist only as `warn` lines on a terminal that had already
       * scrolled, which made the most interesting output of a run the only part
       * of it that was not durable: `born: "25.07.1949" contradicts "1950"` is
       * the answer to "why is this date still wrong", and it was gone by the
       * time anybody asked. `biomd report --notes` reads them back.
       */
      notes?: string[];
    }
  | {
      /** The task failed and is being run again on a different model. */
      type: 'task.retried';
      taskId: string;
      pipeline: string;
      /** The attempt about to start, from 2. */
      attempt: number;
      /** Targets that already failed this task and are demoted for the rest of it. */
      avoided: string[];
      reason: string;
    }
  | { type: 'task.failed'; taskId: string; durationMs: number; error: JsonObject }
  | { type: 'task.skipped'; taskId: string; reason: string }
  | {
      type: 'llm.attempt';
      taskId?: string;
      pipeline: string;
      target: string;
      attempt: number;
      outcome: 'success' | 'error';
      latencyMs: number;
      usage: TokenUsage;
      costUsd: number;
      errorKind?: string;
      message?: string;
    }
  | { type: 'llm.retry'; target: string; attempt: number; delayMs: number; kind: string; message: string }
  | { type: 'llm.fallback'; from: string; to: string; kind: string; message: string }
  /** A target this run stopped using entirely — a config problem, not a call problem. */
  | { type: 'llm.target_down'; target: string; pipeline: string; kind: string; message: string }
  | { type: 'artifact.written'; taskId: string; channel: string; path: string; bytes: number; skipped: boolean }
  | { type: 'budget.warning'; reason: string }
  | { type: 'log'; level: string; message: string; fields?: JsonObject };

export type JournalRecord = JournalEvent & { ts: string; runId: string; seq: number };

/**
 * The skip reasons that mean the work exists, as opposed to the work never
 * happened. Only the planner's two say anything about the output: a fingerprint
 * already completed in an earlier run, or a file already on disk.
 */
const SETTLED_SKIP_REASONS = new Set(['resume', 'existing-output']);

/**
 * Whether a checkpoint entry means "this fingerprint needs no further work".
 *
 * A task skipped *because it was already done* counts as done, so chained
 * resumes (run → resume → resume) do not slowly forget what was finished.
 *
 * Everything the orchestrator retires does **not** count, and the whitelist is
 * the point: `dependency-failed`, `run stopped` and `aborted` all describe a
 * task that never ran, and recording them as done made the next resume skip
 * them permanently. That turned one document's failed translation into a
 * catalogue that could never be built again — the run that would have fixed it
 * quietly declined to try.
 */
export function isTaskDone(record: TaskRecord | undefined): boolean {
  if (!record) return false;
  if (record.status === 'completed') return true;
  return record.status === 'skipped' && SETTLED_SKIP_REASONS.has(record.skipReason ?? '');
}

export function emptyTotals(): RunTotals {
  return {
    workItems: 0,
    tasksPlanned: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksSkipped: 0,
    llmRequests: 0,
    retries: 0,
    fallbacks: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    cacheWritePromptTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
}
