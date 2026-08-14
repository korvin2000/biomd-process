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
  | { type: 'artifact.written'; taskId: string; channel: string; path: string; bytes: number; skipped: boolean }
  | { type: 'budget.warning'; reason: string }
  | { type: 'log'; level: string; message: string; fields?: JsonObject };

export type JournalRecord = JournalEvent & { ts: string; runId: string; seq: number };

/**
 * Whether a checkpoint entry means "this fingerprint needs no further work".
 *
 * A task skipped *because it was already done* counts as done, so chained
 * resumes (run → resume → resume) do not slowly forget what was finished.
 */
export function isTaskDone(record: TaskRecord | undefined): boolean {
  if (!record) return false;
  if (record.status === 'completed') return true;
  return record.status === 'skipped' && record.skipReason !== 'aborted';
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
    reasoningTokens: 0,
    costUsd: 0,
  };
}
