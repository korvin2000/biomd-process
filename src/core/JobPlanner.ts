import type { AppConfig } from '../config/schema.js';
import type { ArtifactWriter, SourceProvider } from '../io/types.js';
import type { PathVars } from '../io/PathTemplate.js';
import type { Logger } from '../observability/Logger.js';
import type { PromptRepository } from '../prompts/PromptRepository.js';
import { fingerprintOf, taskIdOf } from '../state/Fingerprint.js';
import { isTaskDone, type TaskRecord } from '../state/types.js';
import { pathExists } from '../shared/fs.js';
import { hashStructure } from '../shared/hash.js';
import type { PipelineRegistry } from './PipelineRegistry.js';
import { isCorpusPipeline, type PlannedTask, type TaskSeed, type WorkItem } from './types.js';

export type SkipReason = 'resume' | 'existing-output';

export interface SkippedTask {
  taskId: string;
  fingerprint: string;
  pipeline: string;
  variant?: string;
  label: string;
  workItemId: string;
  reason: SkipReason;
}

export interface JobPlan {
  workItems: WorkItem[];
  tasks: PlannedTask[];
  skipped: SkippedTask[];
}

export interface JobPlannerDeps {
  config: AppConfig;
  source: SourceProvider;
  pipelines: PipelineRegistry;
  prompts: PromptRepository;
  writer: ArtifactWriter;
  logger: Logger;
  /** Completed tasks from a previous run, keyed by fingerprint. */
  resumeIndex: Map<string, TaskRecord>;
}

/** A seed with its identity computed, before skip and dependency resolution. */
interface Candidate {
  task: PlannedTask;
  seed: TaskSeed;
}

const CORPUS_ITEM_ID = '*';

/**
 * Turns a corpus into a scheduled list of tasks.
 *
 * Planning is separated from execution so `--dry-run` can show exactly what a
 * run would do before anything is spent, and so resume and dependency decisions
 * are made once, up front, rather than scattered through the workers.
 */
export class JobPlanner {
  constructor(private readonly deps: JobPlannerDeps) {}

  async plan(): Promise<JobPlan> {
    const workItems = await this.deps.source.discover();
    const candidates = [
      ...(await this.planDocumentTasks(workItems)),
      ...(await this.planCorpusTasks(workItems)),
    ];

    this.resolveDependencies(candidates);
    return this.applySkips(workItems, candidates);
  }

  private async planDocumentTasks(workItems: readonly WorkItem[]): Promise<Candidate[]> {
    const candidates: Candidate[] = [];

    for (const item of workItems) {
      for (const pipelineId of this.enabledPipelineIds()) {
        const pipeline = this.deps.pipelines.get(pipelineId);
        if (isCorpusPipeline(pipeline)) continue;

        for (const seed of await pipeline.plan(item, this.planContext())) {
          candidates.push(this.candidate(pipelineId, seed, [item], item.id, item.contentHash));
        }
      }
    }
    return candidates;
  }

  private async planCorpusTasks(workItems: readonly WorkItem[]): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    // One hash over the whole corpus: adding or editing any document must
    // invalidate an aggregate built from all of them.
    const corpusHash = hashStructure(workItems.map((item) => [item.id, item.contentHash]), 16);

    for (const pipelineId of this.enabledPipelineIds()) {
      const pipeline = this.deps.pipelines.get(pipelineId);
      if (!isCorpusPipeline(pipeline)) continue;

      for (const seed of await pipeline.planCorpus(workItems, this.planContext())) {
        candidates.push(this.candidate(pipelineId, seed, workItems, CORPUS_ITEM_ID, corpusHash));
      }
    }
    return candidates;
  }

  private candidate(
    pipelineId: string,
    seed: TaskSeed,
    items: readonly WorkItem[],
    workItemId: string,
    sourceHash: string,
  ): Candidate {
    const identity = { workItemId, pipeline: pipelineId, variant: seed.variant };
    return {
      seed,
      task: {
        taskId: taskIdOf(identity),
        fingerprint: fingerprintOf({
          ...identity,
          sourceHash,
          promptVersion: seed.promptVersion,
          contract: seed.contract,
        }),
        pipeline: pipelineId,
        variant: seed.variant,
        label: seed.label,
        items,
        workItemId,
        dependencies: [],
        requiredDependencies: [],
        ...(seed.usesLlm === undefined ? {} : { usesLlm: seed.usesLlm }),
      },
    };
  }

  /**
   * Turns declared dependencies into task ids.
   *
   * A dependency that matches nothing is dropped rather than failed: disabling
   * `extract` should not make `localize` unschedulable, because it can still
   * read a dossier that already exists on disk.
   *
   * Ordering and prerequisite are resolved as two separate lists, because
   * `optional: true` means "wait for it, then run anyway". A task id reached
   * through both a required and an optional declaration is required — the
   * stricter reading wins.
   */
  private resolveDependencies(candidates: readonly Candidate[]): void {
    for (const candidate of candidates) {
      const resolved = new Set<string>();
      const required = new Set<string>();

      for (const dependency of candidate.seed.dependsOn ?? []) {
        const sameItem = (dependency.scope ?? 'item') === 'item';
        for (const other of candidates) {
          if (other.task.taskId === candidate.task.taskId) continue;
          if (other.task.pipeline !== dependency.pipeline) continue;
          if (dependency.variant !== undefined && other.task.variant !== dependency.variant) continue;
          if (sameItem && other.task.workItemId !== candidate.task.workItemId) continue;
          resolved.add(other.task.taskId);
          if (!dependency.optional) required.add(other.task.taskId);
        }
      }
      candidate.task.dependencies = [...resolved];
      candidate.task.requiredDependencies = [...required];
    }
  }

  private async applySkips(workItems: WorkItem[], candidates: readonly Candidate[]): Promise<JobPlan> {
    const tasks: PlannedTask[] = [];
    const skipped: SkippedTask[] = [];
    const skippedIds = new Set<string>();

    for (const { task, seed } of candidates) {
      const reason = await this.skipReason(task.fingerprint, seed.expectedOutputs, seed.mergesOutput);
      if (!reason) {
        tasks.push(task);
        continue;
      }
      skippedIds.add(task.taskId);
      skipped.push({
        taskId: task.taskId,
        fingerprint: task.fingerprint,
        pipeline: task.pipeline,
        variant: task.variant,
        label: task.label,
        workItemId: task.workItemId,
        reason,
      });
    }

    // A dependency that was skipped is a dependency already satisfied — keeping
    // it would stall its dependents behind a task that will never run.
    for (const task of tasks) {
      task.dependencies = task.dependencies.filter((id) => !skippedIds.has(id));
      task.requiredDependencies = task.requiredDependencies.filter((id) => !skippedIds.has(id));
    }

    return { workItems, tasks, skipped };
  }

  private enabledPipelineIds(): string[] {
    return Object.entries(this.deps.config.tasks)
      .filter(([id, task]) => task.enabled && this.deps.pipelines.has(id))
      .map(([id]) => id);
  }

  private planContext() {
    return {
      config: this.deps.config,
      prompts: this.deps.prompts,
      writer: this.deps.writer,
      logger: this.deps.logger,
    };
  }

  private async skipReason(
    fingerprint: string,
    expectedOutputs: Array<{ channel: string; pathVars: PathVars }>,
    mergesOutput = false,
  ): Promise<SkipReason | undefined> {
    if (isTaskDone(this.deps.resumeIndex.get(fingerprint))) return 'resume';

    // A merge's output file exists from the moment the first run ends, and says
    // nothing about whether *this* run's work is in it. Resume still applies:
    // that compares fingerprints, which is a claim about the work rather than
    // about a filename.
    if (mergesOutput) return undefined;

    if (this.deps.config.run.skipExistingOutputs && expectedOutputs.length > 0) {
      const paths = expectedOutputs.map((output) =>
        this.deps.writer.resolvePath({ channel: output.channel, format: 'text', body: '', pathVars: output.pathVars }),
      );
      const existence = await Promise.all(paths.map((path) => pathExists(path)));
      if (existence.every(Boolean)) return 'existing-output';
    }
    return undefined;
  }
}
