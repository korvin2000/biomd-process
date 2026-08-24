import type { AppConfig } from '../config/schema.js';
import type { ContextStrategyRegistry } from '../documents/context/ContextStrategyRegistry.js';
import type { SourceDocument } from '../documents/types.js';
import type { LlmPort } from '../llm/LlmGateway.js';
import type { TokenEstimator } from '../llm/TokenEstimator.js';
import type { TokenUsage } from '../llm/types.js';
import type { Artifact, ArtifactWriter } from '../io/types.js';
import type { PathVars } from '../io/PathTemplate.js';
import type { Logger } from '../observability/Logger.js';
import type { PromptRepository } from '../prompts/PromptRepository.js';
import type { TranslationMemoryRegistry } from '../pipelines/localization/TranslationMemoryRegistry.js';
import { PipelineError } from '../shared/errors.js';

/**
 * v0.1: one work item is one source document. The alias exists so that a future
 * source (a database row, an archive entry) can widen this without a rename
 * rippling through the orchestrator.
 */
export type WorkItem = SourceDocument;

/**
 * How often a pipeline is planned.
 *
 * `document` — once per work item; the normal case.
 * `corpus`   — once for the whole run, with every work item. For aggregations
 *              such as a catalogue index, which cannot be computed one document
 *              at a time.
 */
export type PipelineScope = 'document' | 'corpus';

/**
 * A prerequisite of a task, expressed in terms a pipeline can state without
 * knowing anything about ids or scheduling.
 */
export interface TaskDependency {
  pipeline: string;
  /** Restrict to one variant; omitted means "any variant of that pipeline". */
  variant?: string;
  /**
   * `item` (default) — the matching task(s) of the *same* work item.
   * `all` — every task of that pipeline across the corpus, which is what an
   * aggregation needs.
   */
  scope?: 'item' | 'all';
  /**
   * An ordering barrier rather than a prerequisite: wait for the other task,
   * then run whether it succeeded or not.
   *
   * The case that needs it is an aggregation over whatever reached the disk. One
   * document whose translation failed must not retire the index describing the
   * other two hundred — and it would, because a corpus-scope dependency resolves
   * to *every* task of that pipeline, so any single failure among them is a
   * failure of the whole barrier.
   *
   * Only correct where the dependent genuinely degrades rather than lies. A
   * pipeline that would silently publish a worse answer should stay required and
   * be retired instead.
   */
  optional?: boolean;
}

/** What a pipeline asks the planner to schedule. */
export interface TaskSeed {
  /** Distinguishes sibling tasks of one pipeline, e.g. the target language. */
  variant?: string;
  /** Short human label for the progress UI. */
  label: string;
  /**
   * Everything that changes what a correct output looks like. Folded into the
   * fingerprint, so changing it invalidates previously completed work.
   */
  contract: unknown;
  /** Hash of the prompt templates this task will use. */
  promptVersion: string;
  /** Lets the planner skip a task whose output already exists. */
  expectedOutputs: Array<{ channel: string; pathVars: PathVars }>;
  /**
   * True when this task **updates** its output rather than producing it.
   *
   * `run.skipExistingOutputs` reads a file's existence as "this work is
   * already done", which is right for a translation and exactly wrong for a
   * merge: `catalog` reads `index.json` and writes it back with this run's rows
   * in it, and `websearch` completes the dossier `extract` just wrote. Both
   * declare an output that is *always* there after the first run, so both were
   * skipped for ever — a catalogue that could never pick up a new article, and
   * a web search that never ran twice. Neither failed; they simply stopped
   * happening, which is the worst way for a batch tool to be wrong.
   */
  mergesOutput?: boolean;
  /** Tasks that must finish first. Unresolvable entries are dropped, not failed. */
  dependsOn?: TaskDependency[];
  /**
   * False for a task that will call no model — an aggregation, or a dossier
   * this run is reusing rather than extracting. Keeps it out of the cost
   * preview, which is only worth reading if it is accurate. Defaults to the
   * pipeline's own `usesLlm`.
   */
  usesLlm?: boolean;
}

export interface PlannedTask {
  taskId: string;
  fingerprint: string;
  pipeline: string;
  variant?: string;
  label: string;
  /** One item for a document task; every item for a corpus task. */
  items: readonly WorkItem[];
  /** The item id for a document task, `*` for a corpus task. Used in records. */
  workItemId: string;
  /** Task ids that must *finish* before this one may start, succeeded or not. */
  dependencies: readonly string[];
  /**
   * The subset of {@link dependencies} whose **failure** retires this task. An
   * optional dependency is waited for and then ignored, so the two lists differ
   * exactly where a pipeline declared `optional: true`.
   */
  requiredDependencies: readonly string[];
  /** False when this task will call no model. See {@link TaskSeed.usesLlm}. */
  usesLlm?: boolean;
}

/**
 * The single work item of a document-scope task.
 *
 * Throws rather than silently taking the first of many: a document pipeline
 * reading only `items[0]` of a corpus task would produce quietly wrong output.
 */
export function soleItem(task: PlannedTask): WorkItem {
  const item = task.items[0];
  if (!item || task.items.length !== 1) {
    throw new PipelineError(`Pipeline "${task.pipeline}" expects exactly one work item, got ${task.items.length}`, {
      details: { taskId: task.taskId, items: task.items.length },
    });
  }
  return item;
}

export interface TaskResult {
  artifacts: Artifact[];
  usage: TokenUsage;
  costUsd: number;
  /** Which rung of the context ladder produced the accepted answer. */
  contextAttempt?: string;
  /** Non-fatal observations worth surfacing (a partial extraction, a soft warning). */
  notes?: string[];
}

export interface PlanContext {
  config: AppConfig;
  prompts: PromptRepository;
  /** Resolves output paths, so a pipeline can fingerprint or read a sibling artifact. */
  writer: ArtifactWriter;
  logger: Logger;
}

export interface ExecutionContext {
  config: AppConfig;
  /**
   * The gateway, scoped to this attempt at this task.
   *
   * Not the gateway itself: the orchestrator wraps it so that a retried task
   * routes past the models that already failed it. See `AttemptScope`.
   */
  llm: LlmPort;
  prompts: PromptRepository;
  contexts: ContextStrategyRegistry;
  estimator: TokenEstimator;
  /** Read-only here: pipelines resolve paths but never write. */
  writer: ArtifactWriter;
  /** Shared translation caches; the registry owns their scope and lifetime. */
  memories: TranslationMemoryRegistry;
  logger: Logger;
  signal: AbortSignal;
  /**
   * Which attempt at this task this is, from 1.
   *
   * Only a pipeline holding a cache needs it: on a retry the previous attempt's
   * answers are precisely what failed, so they must not be served again.
   */
  attempt: number;
}

interface PipelineBase {
  readonly id: string;
  readonly description: string;
  /**
   * False for pipelines that call no model — an aggregation, a pure rewrite.
   * The planner uses it to keep them out of cost previews. Defaults to true.
   */
  readonly usesLlm?: boolean;
  /**
   * Produces artifacts but never writes them: the orchestrator owns the
   * filesystem, which is what makes `--dry-run` free and pipelines testable.
   */
  execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult>;
}

/** Planned once per work item — extraction, translation, localization. */
export interface DocumentPipeline extends PipelineBase {
  readonly scope?: 'document';
  plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]>;
}

/** Planned once for the whole run — aggregations such as a catalogue index. */
export interface CorpusPipeline extends PipelineBase {
  readonly scope: 'corpus';
  planCorpus(items: readonly WorkItem[], context: PlanContext): Promise<TaskSeed[]>;
}

export type Pipeline = DocumentPipeline | CorpusPipeline;

export function isCorpusPipeline(pipeline: Pipeline): pipeline is CorpusPipeline {
  return pipeline.scope === 'corpus';
}
