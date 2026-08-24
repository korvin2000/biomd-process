import PQueue from 'p-queue';

import type { AppConfig } from '../config/schema.js';
import type { ContextStrategyRegistry } from '../documents/context/ContextStrategyRegistry.js';
import type { LlmGateway } from '../llm/LlmGateway.js';
import type { TokenEstimator } from '../llm/TokenEstimator.js';
import { EMPTY_USAGE } from '../llm/types.js';
import type { Artifact, ArtifactWriter, WrittenArtifact } from '../io/types.js';
import type { Logger } from '../observability/Logger.js';
import type { MetricsCollector } from '../observability/Metrics.js';
import type { ProgressLog } from '../observability/ProgressLog.js';
import type { ProgressReporter, ProgressTaskInfo } from '../observability/ProgressReporter.js';
import type { TranslationMemoryRegistry } from '../pipelines/localization/TranslationMemoryRegistry.js';
import type { PromptRepository } from '../prompts/PromptRepository.js';
import type { RunStore } from '../state/RunStore.js';
import type { RunStatus, RunTotals, TaskRecord } from '../state/types.js';
import { AbortedError, BudgetExceededError, serializeError } from '../shared/errors.js';
import { AllTargetsFailedError } from '../reliability/index.js';
import { isAbortError } from '../shared/async.js';
import type { JobPlan, SkippedTask } from './JobPlanner.js';
import type { PipelineRegistry } from './PipelineRegistry.js';
import type { PlannedTask, TaskResult } from './types.js';
import { AttemptScope } from './AttemptScope.js';

export interface OrchestratorDeps {
  config: AppConfig;
  pipelines: PipelineRegistry;
  llm: LlmGateway;
  prompts: PromptRepository;
  contexts: ContextStrategyRegistry;
  estimator: TokenEstimator;
  writer: ArtifactWriter;
  memories: TranslationMemoryRegistry;
  store: RunStore;
  metrics: MetricsCollector;
  progress: ProgressReporter;
  /** The plain-text run log; the orchestrator is the only place that knows a task is done. */
  progressLog: ProgressLog;
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

    /**
     * A dependency is *settled* once it can no longer change — completed or
     * failed. Waves are gated on settlement rather than success, because an
     * optional dependency's failure must release its dependents instead of
     * stranding them behind a task that will never complete.
     */
    const settled = (id: string): boolean => done.has(id) || broken.has(id);

    while (pending.size > 0 && !controller.signal.aborted) {
      // A task whose *prerequisite* failed can only fail too, and would do so
      // after paying for its own LLM calls. Retire it instead. A failed optional
      // dependency is not a prerequisite: it was an ordering barrier, and the
      // dependent was written to degrade rather than to lie.
      const doomed = [...pending.values()].filter((task) => task.requiredDependencies.some((id) => broken.has(id)));
      if (doomed.length > 0) {
        for (const task of doomed) {
          pending.delete(task.taskId);
          broken.add(task.taskId);
        }
        await this.abandon(doomed, 'dependency-failed');
        continue;
      }

      const wave = [...pending.values()].filter((task) => task.dependencies.every(settled));
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
    // Named now rather than at the end, so an incident that happens *during*
    // the task can say which one it belongs to.
    this.deps.progressLog.taskStarted({ taskId: task.taskId, label: task.label });
    await store.append({
      type: 'task.started',
      taskId: task.taskId,
      pipeline: task.pipeline,
      variant: task.variant,
      workItemId: task.workItemId,
    });

    try {
      const result = await this.executeTask(task, controller);
      const written = await this.writeArtifacts(task, result.artifacts);

      await store.append({
        type: 'task.completed',
        taskId: task.taskId,
        durationMs: Date.now() - startedAt,
        outputs: written.map((artifact) => artifact.relativePath),
        usage: result.usage,
        costUsd: result.costUsd,
        contextAttempt: result.contextAttempt,
        ...(result.notes?.length ? { notes: result.notes } : {}),
      });
      store.recordTask(this.record(task, 'completed', { outputs: written.map((a) => a.relativePath), result }));
      metrics.recordTask('completed');
      progress.taskFinished(info, 'completed', result.contextAttempt);
      this.deps.progressLog.taskFinished({
        taskId: task.taskId,
        pipeline: task.pipeline,
        label: task.label,
        // Only what actually reached the disk: a line about a file that was
        // not written is the one kind of progress report worth nothing.
        outputs: written.filter((artifact) => !artifact.skipped).map((artifact) => artifact.relativePath),
        durationMs: Date.now() - startedAt,
        status: 'completed',
      });
      for (const note of result.notes ?? []) logger.warn(note, { taskId: task.taskId });
    } catch (error: unknown) {
      await this.handleFailure(task, info, error, startedAt, controller);
    } finally {
      progress.update(metrics.snapshot());
      await store.flush().catch((error: unknown) => logger.warn('Checkpoint flush failed', serializeError(error)));
    }
  }

  /**
   * Runs the task, and runs it again on a different model if it failed.
   *
   * This is the fallback the gateway cannot do. Its chain answers "this call
   * failed" and moves on; it has no way to answer "every call returned 200 and
   * the document they add up to is broken", because only the task that
   * assembled the document knows that. Those failures arrive here as a pipeline
   * error long after the last successful response — and used to end the task on
   * the spot, with two untried models sitting in the pool.
   *
   * What varies between attempts is deliberately small: the targets that
   * already failed this task are demoted, so a fresh one leads the chain, and
   * the last attempt — which by then has no fresh model left — may change how
   * it asks instead of whom. Everything else is the same request through the
   * same machinery.
   */
  private async executeTask(task: PlannedTask, controller: AbortController): Promise<TaskResult> {
    const { config, logger } = this.deps;
    const policy = config.reliability.taskFallback;
    const pipeline = this.deps.pipelines.get(task.pipeline);
    const avoid = new Set<string>();

    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= policy.maxAttempts;
      const scope = new AttemptScope(this.deps.llm, {
        ...(avoid.size > 0 ? { avoid: new Set(avoid) } : {}),
        // Only once there is nobody new left to ask: until then, a different
        // model is a better answer than the same model asked differently.
        ...(last && attempt > 1 ? policy.lastAttempt : {}),
      });

      try {
        return await pipeline.execute(task, {
          config,
          llm: scope,
          prompts: this.deps.prompts,
          contexts: this.deps.contexts,
          estimator: this.deps.estimator,
          writer: this.deps.writer,
          memories: this.deps.memories,
          logger: logger.child({ taskId: task.taskId, pipeline: task.pipeline }),
          signal: controller.signal,
          attempt,
        });
      } catch (error: unknown) {
        if (last || !this.worthRetrying(error, scope, controller)) throw error;
        for (const target of scope.used) avoid.add(target);
        await this.noteTaskRetry(task, attempt + 1, policy.maxAttempts, error, avoid);
      }
    }
  }

  /**
   * Whether another attempt could plausibly go differently.
   *
   * Three things say no. A run that is stopping — aborted, or out of budget —
   * must not spend more of either. A task that never reached a model failed for
   * a local, deterministic reason: an unreadable source, a bad path template.
   * Re-running that is three times the wall-clock for the same error.
   *
   * And a call that exhausted its chain has *already* had this treatment one
   * level down — the gateway tried every target in the pool, so re-running the
   * task meets the same chain in a worse state, and the run's report ends up
   * naming an open circuit instead of the failure that opened it.
   *
   * The exception is the whole reason this mechanism exists. When those targets
   * failed by **answering badly** rather than by failing, the models are alive
   * and the answers were wrong, and asking again — more literally, on whichever
   * has been steadiest — is a genuinely different question. That is the
   * difference between a technical error and an unusable result, and it is the
   * only place the two need telling apart.
   */
  private worthRetrying(error: unknown, scope: AttemptScope, controller: AbortController): boolean {
    if (controller.signal.aborted || isAbortError(error)) return false;
    if (error instanceof AbortedError || error instanceof BudgetExceededError) return false;
    if (!scope.calledModel) return false;
    if (error instanceof AllTargetsFailedError) {
      return error.failures.some((failure) => failure.kind === 'response_format');
    }
    return true;
  }

  private async noteTaskRetry(
    task: PlannedTask,
    attempt: number,
    maxAttempts: number,
    error: unknown,
    avoided: ReadonlySet<string>,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.logger.warn(`Retrying ${task.label} on another model (attempt ${attempt}/${maxAttempts})`, {
      taskId: task.taskId,
      pipeline: task.pipeline,
      avoided: [...avoided],
      reason: message,
    });
    this.deps.progressLog.noteTaskRetry({
      taskId: task.taskId,
      pipeline: task.pipeline,
      attempt,
      maxAttempts,
      avoided: [...avoided],
      message,
    });
    await this.deps.store.append({
      type: 'task.retried',
      taskId: task.taskId,
      pipeline: task.pipeline,
      attempt,
      avoided: [...avoided],
      reason: message,
    });
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

      /**
       * The expensive silence: the model was called and billed, and then
       * `output.onExisting: skip` threw the answer away because a file was
       * already there.
       *
       * The planner now makes that decision for free — `onExisting: skip`
       * retires the task before anything is spent, exactly as
       * `run.skipExistingOutputs` does. What is left here is the case the
       * planner deliberately cannot pre-empt: a task that **merges** into its
       * output (`catalog`, `websearch`) and so must run every time, writing an
       * artifact that did not ask to overwrite. `tasks.catalog.merge: false` is
       * the way to get there, and it means the index this run built was
       * computed and then dropped.
       */
      if (result.skipped && !this.deps.config.run.dryRun) {
        this.deps.logger.warn(
          `Discarded a result: ${result.relativePath} already exists and output.onExisting is "skip". ` +
            'This task updates its output rather than creating it, so it cannot be skipped in advance — ' +
            'set output.onExisting: overwrite to keep what this run produced.',
          { taskId: task.taskId, channel: result.channel },
        );
      }
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
    this.deps.progressLog.taskFinished({
      taskId: task.taskId,
      pipeline: task.pipeline,
      label: task.label,
      outputs: [],
      durationMs: Date.now() - startedAt,
      status: 'failed',
      detail: failure.message,
    });
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
