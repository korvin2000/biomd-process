import pc from 'picocolors';

import type { App } from '../../app/container.js';
import type { JobPlan } from '../../core/JobPlanner.js';
import { estimateCost } from '../../llm/CostCalculator.js';
import type { MetricsSnapshot } from '../../observability/Metrics.js';
import type { RunSummary } from '../../core/Orchestrator.js';
import type { RunTotals } from '../../state/types.js';
import type { TargetStats } from '../../routing/types.js';
import { formatCost, formatDuration, formatTokens, renderTable, symbols, truncate } from './format.js';

const OUT = process.stdout;

export function heading(text: string): void {
  OUT.write(`\n${pc.bold(text)}\n`);
}

/**
 * What a run *would* do, before it does it.
 *
 * The estimate uses the first target of each pipeline's routing chain — the one
 * `cost-optimized` would actually pick — so the number is a realistic floor, not
 * a worst case. Retries, fallbacks and escalations can only push it up, which is
 * the honest direction for a budget figure.
 */
export function printPlan(app: App, plan: JobPlan): void {
  heading('Plan');
  OUT.write(
    `${plan.workItems.length} document(s) · ${plan.tasks.length} task(s) to run · ` +
      `${plan.skipped.length} skipped\n`,
  );

  const byPipeline = groupBy(plan.tasks, (task) => task.pipeline);
  const rows = [...byPipeline.entries()].map(([pipeline, all]) => {
    const dash = pc.dim('—');
    // A task may opt out individually — a dossier this run reuses rather than
    // extracts calls nothing, and counting it would inflate the estimate.
    const tasks = usesLlm(app, pipeline) ? all.filter((task) => task.usesLlm !== false) : [];
    const free = all.length - tasks.length;
    const label = free > 0 ? `${all.length}${pc.dim(` (${free} free)`)}` : String(all.length);

    if (tasks.length === 0) {
      return { pipeline, tasks: label, tokens: dash, chain: pc.dim('(no model calls)'), cost: dash };
    }

    const chain = app.gateway.plan({
      pipeline,
      pool: poolOf(app, pipeline),
      estimatedInputTokens: 0,
      expectedOutputTokens: 1024,
    });
    const target = chain[0];
    const inputTokens = tasks.reduce(
      (sum, task) => sum + task.items.reduce((itemSum, item) => itemSum + item.estimatedTokens, 0),
      0,
    );
    const cost = target
      ? estimateCost(
          {
            promptTokens: inputTokens,
            completionTokens: tasks.length * 1024,
            cachedPromptTokens: 0,
            cacheWritePromptTokens: 0,
            reasoningTokens: 0,
            totalTokens: inputTokens,
          },
          target.pricing,
        )
      : 0;

    return {
      pipeline,
      tasks: label,
      tokens: formatTokens(inputTokens),
      chain: chain.map((entry) => entry.modelId).join(' → ') || pc.red('(no targets)'),
      cost: formatCost(cost),
    };
  });

  if (rows.length > 0) {
    OUT.write(`\n${renderTable(rows, [
      { header: 'PIPELINE', value: (row) => row.pipeline },
      { header: 'TASKS', value: (row) => row.tasks, align: 'right' },
      { header: 'DOC TOKENS', value: (row) => row.tokens, align: 'right' },
      { header: 'MODEL CHAIN', value: (row) => row.chain },
      { header: 'EST. COST', value: (row) => row.cost, align: 'right' },
    ])}\n`);
    OUT.write(
      pc.dim(
        '\nEstimate assumes the whole document reaches the first-choice model. ' +
          'Segment mode, metadata localization and prompt caching send less; retries and fallbacks cost more. ' +
          'Web search is the largest overestimate here: it sends an identity card, not the article, ' +
          'and skips the call entirely for an entry with no gaps.\n',
      ),
    );
  }

  if (plan.skipped.length > 0) {
    const reasons = groupBy(plan.skipped, (task) => task.reason);
    const detail = [...reasons.entries()].map(([reason, items]) => `${items.length} ${reason}`).join(', ');
    OUT.write(pc.dim(`\nSkipped: ${detail}\n`));
  }
}

export interface SummaryExtras {
  /** Per-target counters, so a target that served nothing is visible by its zero. */
  targets?: readonly TargetStats[];
}

export function printSummary(
  summary: RunSummary,
  snapshot: MetricsSnapshot,
  runDir: string,
  extras: SummaryExtras = {},
): void {
  heading('Summary');

  const status =
    summary.status === 'completed'
      ? pc.green('completed')
      : summary.status === 'aborted'
        ? pc.yellow('aborted')
        : pc.red('failed');

  OUT.write(`Status      ${status} in ${formatDuration(snapshot.elapsedMs)}\n`);
  OUT.write(
    `Tasks       ${symbols.ok} ${snapshot.tasksCompleted} completed · ` +
      `${symbols.fail} ${snapshot.tasksFailed} failed · ` +
      `${symbols.skip} ${snapshot.tasksSkipped} skipped\n`,
  );
  OUT.write(
    `LLM         ${snapshot.llmRequests} requests · ${snapshot.retries} retries · ` +
      `${snapshot.fallbacks} fallbacks\n`,
  );
  // Reasoning is a share of the output tokens, and often the majority of them.
  // Naming it here is what turns "why did that cost so much" into a config change.
  const reasoning =
    snapshot.reasoningTokens > 0
      ? pc.dim(
          `, ${formatTokens(snapshot.reasoningTokens)} of it reasoning` +
            ` (${Math.round((snapshot.reasoningTokens / Math.max(1, snapshot.completionTokens)) * 100)}%)`,
        )
      : '';
  OUT.write(
    `Tokens      ${formatTokens(snapshot.promptTokens)} in ` +
      `(${formatTokens(snapshot.cachedPromptTokens)} cached` +
      (snapshot.cacheWritePromptTokens > 0
        ? `, ${formatTokens(snapshot.cacheWritePromptTokens)} cache-write`
        : '') +
      ') · ' +
      `${formatTokens(snapshot.completionTokens)} out${reasoning}\n`,
  );
  OUT.write(`Cost        ${formatCost(snapshot.costUsd)}\n`);
  OUT.write(`Journal     ${runDir}\n`);

  const errorKinds = Object.entries(snapshot.errorsByKind);
  if (errorKinds.length > 0) {
    OUT.write(pc.dim(`Errors      ${errorKinds.map(([kind, count]) => `${kind}×${count}`).join(', ')}\n`));
  }

  printTargets(snapshot, extras.targets ?? []);

  if (summary.failures.length > 0) {
    heading(`Failures (${summary.failures.length})`);
    for (const failure of summary.failures.slice(0, 20)) {
      OUT.write(`${symbols.fail} ${pc.bold(failure.label)} ${pc.dim(`[${failure.code}]`)}\n`);
      OUT.write(`  ${truncate(failure.message, 200)}\n`);
    }
    if (summary.failures.length > 20) {
      OUT.write(pc.dim(`  … and ${summary.failures.length - 20} more (see the journal)\n`));
    }
  }
}

export function printTotals(totals: RunTotals): void {
  OUT.write(
    `${totals.tasksCompleted} completed · ${totals.tasksFailed} failed · ${totals.tasksSkipped} skipped · ` +
      `${totals.llmRequests} requests · ${formatCost(totals.costUsd)}\n`,
  );
}

function usesLlm(app: App, pipeline: string): boolean {
  return app.pipelines.has(pipeline) ? app.pipelines.get(pipeline).usesLlm !== false : true;
}

function poolOf(app: App, pipeline: string): string | undefined {
  const task = app.config.tasks[pipeline as keyof typeof app.config.tasks];
  return task && 'pool' in task ? task.pool : undefined;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}


/**
 * Which model actually did the work.
 *
 * A pool is a fallback chain, and its whole point is that a failure is
 * survivable — which also means a first choice that never works is *invisible*:
 * the run completes, every document is produced, and the only trace is a bill
 * from the model that was supposed to be the backup. This table is the trace.
 * A target with zero successes is called out by name, because "or-search served
 * 0 of 45 requests" is a config bug and no other line in the summary says so.
 */
function printTargets(snapshot: MetricsSnapshot, targets: readonly TargetStats[]): void {
  const used = targets.filter((target) => target.requests > 0);
  const down = new Map(snapshot.downTargets.map((entry) => [entry.target, entry]));
  if (used.length === 0 && down.size === 0) return;

  heading('Model targets');
  if (used.length > 0) {
    OUT.write(
      `${renderTable(used, [
        { header: 'TARGET', value: (row) => (down.has(row.key) ? pc.red(row.key) : row.key) },
        { header: 'REQ', value: (row) => String(row.requests), align: 'right' },
        { header: 'OK', value: (row) => String(row.successes), align: 'right' },
        {
          header: 'FAILED',
          value: (row) => (row.failures > 0 ? pc.yellow(String(row.failures)) : pc.dim('0')),
          align: 'right',
        },
        {
          header: 'AVG',
          value: (row) => (row.successes > 0 ? formatDuration(row.totalLatencyMs / row.successes) : pc.dim('—')),
          align: 'right',
        },
        { header: 'COST', value: (row) => formatCost(row.costUsd), align: 'right' },
      ])}\n`,
    );
  }

  for (const target of used) {
    if (target.successes > 0) continue;
    const reason = down.get(target.key);
    OUT.write(
      `${symbols.fail} ${pc.bold(target.key)} served ${pc.bold('0')} of its ${target.requests} request(s)` +
        (reason ? ` ${pc.dim(`(${reason.kind}: ${truncate(reason.message, 90)})`)}` : '') +
        `\n  ${pc.dim('Everything it was routed cost whatever the next target in its pool costs. ')}` +
        `${pc.dim('Check the model id and its credentials with `biomd models --probe`.')}\n`,
    );
  }

  // A target written off before it ever got a request of its own — the breaker
  // opened on an earlier pipeline and every later call skipped it in silence.
  for (const [key, reason] of down) {
    if (used.some((target) => target.key === key)) continue;
    OUT.write(`${symbols.fail} ${pc.bold(key)} was skipped for the whole run ${pc.dim(`(${reason.kind})`)}\n`);
  }
}
