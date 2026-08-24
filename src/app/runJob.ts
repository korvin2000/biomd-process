import { redactConfig } from '../config/loader.js';
import { JobPlanner, type JobPlan } from '../core/JobPlanner.js';
import { Orchestrator, type RunSummary } from '../core/Orchestrator.js';
import type { GatewayObserver } from '../llm/LlmGateway.js';
import { nullProgressReporter, type ProgressReporter } from '../observability/ProgressReporter.js';
import { RunStore, newRunId } from '../state/RunStore.js';
import { emptyTotals, type RunManifest, type TaskRecord } from '../state/types.js';
import type { JsonObject } from '../shared/json.js';
import type { App } from './container.js';
import { APP_VERSION } from './version.js';

export interface RunJobOptions {
  progress?: ProgressReporter;
  signal?: AbortSignal;
}

export interface RunOutcome {
  runId: string;
  runDir: string;
  plan: JobPlan;
  summary: RunSummary;
}

/**
 * One batch run, end to end: resolve resume state → plan → execute → summarize.
 *
 * Lives here rather than in the CLI so a host application (a scheduler, a test,
 * a future daemon) can drive a run without going through argument parsing.
 */
export async function runJob(app: App, options: RunJobOptions = {}): Promise<RunOutcome> {
  const stateDir = app.paths.resolve(app.config.run.stateDir);
  const resume = await resolveResume(app, stateDir);

  const manifest: RunManifest = {
    runId: newRunId(),
    appVersion: APP_VERSION,
    startedAt: new Date().toISOString(),
    status: 'running',
    configFile: app.configFile,
    configHash: app.configHash,
    pipelines: enabledPipelines(app),
    dryRun: app.config.run.dryRun,
    resumedFrom: resume.runId,
    totals: emptyTotals(),
    config: redactConfig(app.config) as unknown as JsonObject,
  };

  const startedAt = Date.now();
  const store = await RunStore.create(stateDir, manifest);
  const detach = app.observers.add(journalObserver(app, store));

  try {
    const plan = await new JobPlanner({
      config: app.config,
      source: app.source,
      pipelines: app.pipelines,
      prompts: app.prompts,
      writer: app.writer,
      logger: app.logger,
      resumeIndex: resume.index,
    }).plan();

    app.progressLog.runStarted({ runId: store.runId, tasks: plan.tasks.length, skipped: plan.skipped.length });

    const summary = await new Orchestrator({
      config: app.config,
      pipelines: app.pipelines,
      llm: app.gateway,
      prompts: app.prompts,
      contexts: app.contexts,
      estimator: app.estimator,
      writer: app.writer,
      memories: app.memories,
      store,
      metrics: app.metrics,
      progress: options.progress ?? nullProgressReporter,
      progressLog: app.progressLog,
      logger: app.logger,
    }).run(plan, options.signal);

    app.progressLog.runFinished({
      status: summary.status,
      durationMs: Date.now() - startedAt,
      completed: summary.totals.tasksCompleted,
      failed: summary.totals.tasksFailed,
      costUsd: summary.totals.costUsd,
    });

    return { runId: store.runId, runDir: store.dir, plan, summary };
  } finally {
    await app.memories.close();
    await app.progressLog.close();
    detach();
  }
}

/** Planning only — what `--dry-run` reports before anything is spent. */
export async function planJob(app: App): Promise<JobPlan> {
  const stateDir = app.paths.resolve(app.config.run.stateDir);
  const resume = await resolveResume(app, stateDir);

  return new JobPlanner({
    config: app.config,
    source: app.source,
    pipelines: app.pipelines,
    prompts: app.prompts,
    writer: app.writer,
    logger: app.logger,
    resumeIndex: resume.index,
  }).plan();
}

async function resolveResume(
  app: App,
  stateDir: string,
): Promise<{ runId?: string; index: Map<string, TaskRecord> }> {
  const setting = app.config.run.resume;
  if (setting === 'off') return { index: new Map() };

  const runId = setting === 'auto' ? await RunStore.latestRunId(stateDir) : setting;
  if (!runId) return { index: new Map() };

  const index = await RunStore.loadCheckpoint(stateDir, runId);
  if (index.size > 0) {
    app.logger.info(`Resuming from run ${runId}`, { completed: index.size });
  }
  return { runId, index };
}

function enabledPipelines(app: App): string[] {
  return Object.entries(app.config.tasks)
    .filter(([id, task]) => task.enabled && app.pipelines.has(id))
    .map(([id]) => id);
}

/**
 * Bridges gateway events into the journal and the live counters. Every LLM
 * request, retry and fallback lands in `events.jsonl`, which is what makes a
 * finished run auditable after the terminal is gone.
 */
function journalObserver(app: App, store: RunStore): GatewayObserver {
  return {
    onAttempt: (record, options) => {
      app.metrics.recordAttempt(record);
      app.progressLog.noteAttempt(record);
      void store.append({
        type: 'llm.attempt',
        pipeline: options.pipeline,
        target: record.target,
        attempt: record.attempt,
        outcome: record.outcome,
        latencyMs: record.latencyMs,
        usage: record.usage,
        costUsd: record.costUsd,
        errorKind: record.errorKind,
        message: record.message,
      });
    },
    onRetry: (info) => {
      app.metrics.recordRetry();
      app.progressLog.noteRetry(info);
      app.logger.warn(`Retrying ${info.target} in ${info.delayMs}ms (${info.kind})`, { message: info.message });
      void store.append({ type: 'llm.retry', ...info });
    },
    onFallback: (info) => {
      app.metrics.recordFallback();
      app.progressLog.noteFallback(info);
      app.logger.warn(`Falling back ${info.from} → ${info.to} (${info.kind})`, { detail: info.message });
      void store.append({ type: 'llm.fallback', ...info });
    },
    /**
     * The one gateway event that is about the *configuration* rather than about
     * a call: this target is not going to work, and everything it was supposed
     * to serve is being served by whatever stands behind it.
     */
    onTargetDown: (info) => {
      app.metrics.recordTargetDown(info.target, info.kind, info.message);
      app.progressLog.noteTargetDown(info);
      app.logger.error(
        `Model target "${info.target}" is being skipped for the rest of this run (${info.kind}). ` +
          'Everything routed to it will be served by the next target in its pool — which may cost more. ' +
          `Provider said: ${info.message}`,
        { target: info.target, pipeline: info.pipeline, kind: info.kind },
      );
      void store.append({ type: 'llm.target_down', ...info });
    },
  };
}
