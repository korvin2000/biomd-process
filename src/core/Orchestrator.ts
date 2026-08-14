import PQueue from 'p-queue';

import type { AppConfig } from '../config/schema.js';
import type { ContextStrategyRegistry } from '../documents/context/ContextStrategyRegistry.js';
import type { LlmGateway } from '../llm/LlmGateway.js';
import type { TokenEstimator } from '../llm/TokenEstimator.js';
import { EMPTY_USAGE } from '../llm/types.js';
import type { Artifact, ArtifactWriter, WrittenArtifact } from '../io/types.js';
import type { Logger } from '../observability/Logger.js';
import type { MetricsCollector } from '../observability/Metrics.js';
import type { ProgressReporter, ProgressTaskInfo } from '../observability/ProgressReporter.js';
import type { PromptRepository } from '../prompts/PromptRepository.js';
import type { RunStore } from '../state/RunStore.js';
import type { RunStatus, RunTotals, TaskRecord } from '../state/types.js';
import { AbortedError, BudgetExceededError, serializeError } from '../shared/errors.js';
import { isAbortError } from '../shared/async.js';
import type { JobPlan, SkippedTask } from './JobPlanner.js';
import type { PipelineRegistry } from './PipelineRegistry.js';
import type { PlannedTask } from './types.js';

export interface OrchestratorDeps {
  config: AppConfig;
  pipelines: PipelineRegistry;
  llm: LlmGateway;
  prompts: PromptRepository;
  contexts: ContextStrategyRegistry;
  estimator: TokenEstimator;
  writer: ArtifactWriter;
  store: RunStore;
  metrics: MetricsCollector;
  progress: ProgressReporter;
  logger: Logger;
}

export interface TaskFailure {
  taskId: string;
  label: string;
  pipeline: string;
  message: string;
  code: string;
}

export interface RunSummary {
  status: RunStatus;
  totals: RunTotals;
  failures: TaskFailure[];
}

/**
 * Runs a plan.
 *
 * Owns concurrency, the filesystem, the journal and the checkpoint — everything
 * that must behave identically no matter which pipeline is running. Pipelines
 * stay small because none of this is their problem.
 */
export class Orchestrator {
  private readonly failures: TaskFailure[] = [];
  /** Task ids that failed — the input to dependency pruning. */
  private readonly failedIds = new Set<string>();
  private aborted: 'budget' | 'fail-fast' | 'signal' | undefined;

  constructor(private readonly deps: OrchestratorDeps) {}

  async run(plan: JobPlan, externalSignal?: AbortSignal): Promise<RunSummary> {
    const { metrics, store, progress, config } = this.deps;
    const startedAt = Date.now();

    metrics.setPlanned(plan.workItems.length, plan.tasks.length);
    await store.append({
      type: 'plan.created',
      workItems: plan.workItems.length,
      tasks: plan.tasks.length,
      skipped: plan.skipped.length,
    });
    await this.recordSkipped(plan.skipped);

    progress.start(plan.tasks.length);

    const controller = new AbortController();
    const onExternalAbort = () => {
      this.aborted ??= 'signal';
      controller.abort();
    };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      await this.drain(plan.tasks, controller, config.run.concurrency);
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    const status = this.finalStatus();
    const totals = metrics.runTotals();
    await store.finish(status, totals, Date.now() - startedAt);
    progress.stop(metrics.snapshot());

    return { status, totals, failures: this.failures };
  }

  /**
   * Runs the plan in dependency waves: every task whose prerequisites are
   * satisfied goes into the queue together, at full concurrency, and the next
   * wave starts when they are done.
   *
   * Waves rather than a fully dynamic DAG because pipelines form two or three
   * stages, never a deep graph — and a wave boundary is exactly the guarantee an
   * aggregation like `catalog` needs: everything it indexes has already landed
   * on disk.
   */
  private async drain(tasks: readonly PlannedTask[], controller: AbortController, concurrency: number): Promise<void> {
    const pending = new Map(tasks.map((task) => [task.taskId, task]));
    const done = new Set<string>();
    const broken = new Set<string>();

    while (pending.size > 0 && !controller.signal.aborted) {
      // A task whose prerequisite failed can only fail too, and would do so
      // after paying for its own LLM calls. Retire it instead.
      const doomed = [...pending.values()].filter((task) => task.dependencies.some((id) => broken.has(id)));
      if (doomed.length > 0) {
        for (const task of doomed) {
          pending.delete(task.taskId);
          broken.add(task.taskId);
        }
        await this.abandon(doomed, 'dependency-failed');
        continue;
      }

      const wave = [...pending.values()].filter((task) => task.dependencies.every((id) => done.has(id)));
      if (wave.length === 0) {
        // Only reachable through a dependency cycle, which is a pipeline bug.
        await this.abandon([...pending.values()], 'unsatisfiable dependencies');
        return;
      }

      const queue = new PQueue({ concurrency });
      for (const task of wave) {
        pending.delete(task.taskId);
        void queue.add(() => this.runTask(task, controller));
      }
      await queue.onIdle();

      for (const task of wave) {
        (this.failedIds.has(task.taskId) ? broken : done).add(task.taskId);
      }
    }

    if (pending.size > 0) await this.abandon([...pending.values()], 'run stopped');
  }

  /** Marks never-started tasks as skipped so the checkpoint stays complete. */
  private async abandon(tasks: readonly PlannedTask[], reason: string): Promise<void> {
    for (const task of tasks) {
      await this.deps.store.append({ type: 'task.skipped', taskId: task.taskId, reason });
      this.deps.store.recordTask(this.record(task, 'skipped', { skipReason: reason }));
      this.deps.metrics.recordTask('skipped');
      this.deps.progress.taskFinished(this.progressInfo(task), 'skipped', reason);
    }
    await this.deps.store.flush();
  }

  private async runTask(task: PlannedTask, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return;

    const info = this.progressInfo(task);
    const { store, metrics, progress, logger } = this.deps;
    const startedAt = Date.now();

    progress.taskStarted(info);
    await store.append({
      type: 'task.started',
      taskId: task.taskId,
      pipeline: task.pipeline,
      variant: task.variant,
      workItemId: task.workItemId,
    });

    try {
      const pipeline = this.deps.pipelines.get(task.pipeline);
      const result = await pipeline.execute(task, {
        config: this.deps.config,
        llm: this.deps.llm,
        prompts: this.deps.prompts,
        contexts: this.deps.contexts,
        estimator: this.deps.estimator,
        writer: this.deps.writer,
        logger: logger.child({ taskId: task.taskId, pipeline: task.pipeline }),
        signal: controller.signal,
      });

      const written = await this.writeArtifacts(task, result.artifacts);

      await store.append({
        type: 'task.completed',
        taskId: task.taskId,
        durationMs: Date.now() - startedAt,
        outputs: written.map((artifact) => artifact.relativePath),
        usage: result.usage,
        costUsd: result.costUsd,
        contextAttempt: result.contextAttempt,
      });
      store.recordTask(this.record(task, 'completed', { outputs: written.map((a) => a.relativePath), result }));
      metrics.recordTask('completed');
      progress.taskFinished(info, 'completed', result.contextAttempt);
      for (const note of result.notes ?? []) logger.warn(note, { taskId: task.taskId });
    } catch (error: unknown) {
      await this.handleFailure(task, info, error, startedAt, controller);
    } finally {
      progress.update(metrics.snapshot());
      await store.flush().catch((error: unknown) => logger.warn('Checkpoint flush failed', serializeError(error)));
    }
  }

  private async writeArtifacts(task: PlannedTask, artifacts: readonly Artifact[]): Promise<WrittenArtifact[]> {
    const written: WrittenArtifact[] = [];
    for (const artifact of artifacts) {
      const result = await this.deps.writer.write(artifact, {
        taskId: task.taskId,
        runId: this.deps.store.runId,
        pipeline: task.pipeline,
      });
      written.push(result);
      await this.deps.store.append({
        type: 'artifact.written',
        taskId: task.taskId,
        channel: result.channel,
        path: result.relativePath,
        bytes: result.bytes,
        skipped: result.skipped,
      });
    }
    return written;
  }

  private async handleFailure(
    task: PlannedTask,
    info: ProgressTaskInfo,
    error: unknown,
    startedAt: number,
    controller: AbortController,
  ): Promise<void> {
    const { store, metrics, progress, logger, config } = this.deps;

    if (error instanceof AbortedError || isAbortError(error)) {
      store.recordTask(this.record(task, 'skipped', { skipReason: 'aborted' }));
      metrics.recordTask('skipped');
      progress.taskFinished(info, 'skipped', 'aborted');
      return;
    }

    const serialized = serializeError(error);
    const failure: TaskFailure = {
      taskId: task.taskId,
      label: task.label,
      pipeline: task.pipeline,
      message: String(serialized['message'] ?? 'unknown error'),
      code: String(serialized['code'] ?? 'E_UNKNOWN'),
    };
    this.failures.push(failure);
    this.failedIds.add(task.taskId);

    await store.append({ type: 'task.failed', taskId: task.taskId, durationMs: Date.now() - startedAt, error: serialized });
    store.recordTask(
      this.record(task, 'failed', { error: { code: failure.code, message: failure.message, kind: String(serialized['kind'] ?? '') } }),
    );
    metrics.recordTask('failed');
    metrics.countError(failure.code);
    progress.taskFinished(info, 'failed', failure.message);
    logger.error(`Task failed: ${task.label}`, { taskId: task.taskId, ...serialized });

    if (error instanceof BudgetExceededError) {
      this.aborted = 'budget';
      progress.note('warn', `Budget exhausted — stopping the run: ${failure.message}`);
      controller.abort();
      return;
    }
    if (config.run.failFast) {
      this.aborted = 'fail-fast';
      progress.note('warn', 'failFast is on — stopping after the first failure.');
      controller.abort();
    }
  }

  private async recordSkipped(skipped: SkippedTask[]): Promise<void> {
    for (const task of skipped) {
      await this.deps.store.append({ type: 'task.skipped', taskId: task.taskId, reason: task.reason });
      this.deps.store.recordTask({
        taskId: task.taskId,
        fingerprint: task.fingerprint,
        workItemId: task.workItemId,
        pipeline: task.pipeline,
        variant: task.variant,
        status: 'skipped',
        attempts: 0,
        updatedAt: new Date().toISOString(),
        outputs: [],
        skipReason: task.reason,
      });
      this.deps.metrics.recordTask('skipped');
    }
    await this.deps.store.flush();
  }

  private record(
    task: PlannedTask,
    status: TaskRecord['status'],
    extra: {
      outputs?: string[];
      result?: { usage: TaskRecord['usage']; costUsd: number };
      error?: TaskRecord['error'];
      skipReason?: string;
    },
  ): TaskRecord {
    return {
      taskId: task.taskId,
      fingerprint: task.fingerprint,
      workItemId: task.workItemId,
      pipeline: task.pipeline,
      variant: task.variant,
      status,
      attempts: 1,
      updatedAt: new Date().toISOString(),
      outputs: extra.outputs ?? [],
      usage: extra.result?.usage ?? { ...EMPTY_USAGE },
      costUsd: extra.result?.costUsd ?? 0,
      error: extra.error,
      skipReason: extra.skipReason,
    };
  }

  private progressInfo(task: PlannedTask): ProgressTaskInfo {
    return { taskId: task.taskId, pipeline: task.pipeline, variant: task.variant, label: task.label };
  }

  private finalStatus(): RunStatus {
    if (this.aborted) return 'aborted';
    return this.failures.length > 0 ? 'failed' : 'completed';
  }
}
