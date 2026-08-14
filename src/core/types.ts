import type { AppConfig } from '../config/schema.js';
import type { ContextStrategyRegistry } from '../documents/context/ContextStrategyRegistry.js';
import type { SourceDocument } from '../documents/types.js';
import type { LlmGateway } from '../llm/LlmGateway.js';
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
  /** Tasks that must finish first. Unresolvable entries are dropped, not failed. */
  dependsOn?: TaskDependency[];
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
  /** Task ids that must complete before this one may start. */
  dependencies: readonly string[];
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
  llm: LlmGateway;
  prompts: PromptRepository;
  contexts: ContextStrategyRegistry;
  estimator: TokenEstimator;
  /** Read-only here: pipelines resolve paths but never write. */
  writer: ArtifactWriter;
  /** Shared translation caches; the registry owns their scope and lifetime. */
  memories: TranslationMemoryRegistry;
  logger: Logger;
  signal: AbortSignal;
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
