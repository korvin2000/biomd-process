import { Command } from 'commander';
import pc from 'picocolors';

import { loadConfig } from '../../config/loader.js';
import { RunStore } from '../../state/RunStore.js';
import { formatCost, formatDuration, formatTokens, renderTable, symbols } from '../ui/format.js';
import { heading } from '../ui/report.js';

export function createReportCommand(): Command {
  return new Command('report')
    .description('Summarize a previous run from its state directory')
    .argument('[runId]', 'run id; defaults to the most recent run')
    .option('-c, --config <file>', 'path to the config file')
    .option('--failed', 'list only the tasks that failed')
    .option('--notes [pattern]', 'print what the pipelines reported, optionally filtered by a regex')
    .action(
      async (
        runIdArg: string | undefined,
        options: { config?: string; failed?: boolean; notes?: string | boolean },
      ) => {
      const loaded = await loadConfig({ file: options.config });
      const stateDir = loaded.paths.resolve(loaded.config.run.stateDir);

      const runId = runIdArg ?? (await RunStore.latestRunId(stateDir));
      if (!runId) {
        process.stdout.write(`No runs found under ${stateDir}\n`);
        return;
      }

      const manifest = await RunStore.loadManifest(stateDir, runId);
      if (!manifest) {
        process.stdout.write(`Run ${runId} has no manifest under ${stateDir}\n`);
        process.exitCode = 1;
        return;
      }

      const started = Date.parse(manifest.startedAt);
      const finished = manifest.finishedAt ? Date.parse(manifest.finishedAt) : Date.now();

      heading(`Run ${runId}`);
      process.stdout.write(`Status      ${statusColor(manifest.status)}\n`);
      process.stdout.write(`Started     ${manifest.startedAt}\n`);
      process.stdout.write(`Duration    ${formatDuration(finished - started)}\n`);
      process.stdout.write(`Pipelines   ${manifest.pipelines.join(', ')}\n`);
      process.stdout.write(`Config      ${manifest.configFile} ${pc.dim(`(${manifest.configHash})`)}\n`);
      if (manifest.resumedFrom) process.stdout.write(`Resumed     ${manifest.resumedFrom}\n`);

      const totals = manifest.totals;
      process.stdout.write(
        `\nTasks       ${symbols.ok} ${totals.tasksCompleted} · ${symbols.fail} ${totals.tasksFailed} · ` +
          `${symbols.skip} ${totals.tasksSkipped} of ${totals.tasksPlanned} planned\n`,
      );
      process.stdout.write(
        `LLM         ${totals.llmRequests} requests · ${totals.retries} retries · ${totals.fallbacks} fallbacks\n`,
      );
      process.stdout.write(
        `Tokens      ${formatTokens(totals.promptTokens)} in (${formatTokens(totals.cachedPromptTokens)} cached` +
          ((totals.cacheWritePromptTokens ?? 0) > 0
            ? `, ${formatTokens(totals.cacheWritePromptTokens ?? 0)} cache-write`
            : '') +
          ') · ' +
          `${formatTokens(totals.completionTokens)} out` +
          (totals.reasoningTokens ? pc.dim(`, ${formatTokens(totals.reasoningTokens)} of it reasoning`) : '') +
          '\n',
      );
      process.stdout.write(`Cost        ${formatCost(totals.costUsd)}\n`);

      const checkpoint = await RunStore.loadCheckpoint(stateDir, runId);
      const records = [...checkpoint.values()].filter((record) => !options.failed || record.status === 'failed');
      if (records.length === 0) return;

      heading(options.failed ? 'Failed tasks' : 'Tasks');
      process.stdout.write(
        `${renderTable(records.slice(0, 100), [
          { header: 'STATUS', value: (record) => record.status },
          { header: 'PIPELINE', value: (record) => record.pipeline },
          { header: 'ITEM', value: (record) => `${record.workItemId}${record.variant ? ` → ${record.variant}` : ''}` },
          { header: 'COST', value: (record) => formatCost(record.costUsd ?? 0), align: 'right' },
          { header: 'DETAIL', value: (record) => record.error?.message ?? record.skipReason ?? record.outputs.join(', ') },
        ])}\n`,
      );
      if (records.length > 100) {
        process.stdout.write(pc.dim(`… and ${records.length - 100} more; read ${stateDir}/${runId}/events.jsonl\n`));
      }

      if (options.notes) await printNotes(stateDir, runId, options.notes);
    },
  );
}

/**
 * What the pipelines said, read back out of the journal.
 *
 * A note is the only account of a decision that produced *no* artifact: a web
 * answer refused for want of a source, a date conflict recorded instead of
 * published, an edition left undeclared because its dossier never landed. On a
 * live terminal they scroll past behind a progress bar; here they can be
 * grepped after the fact, which is when the question is actually asked.
 */
async function printNotes(stateDir: string, runId: string, filter: string | boolean): Promise<void> {
  const pattern = typeof filter === 'string' ? new RegExp(filter, 'i') : undefined;
  const byTask = new Map<string, { label: string; notes: string[] }>();
  const labels = new Map<string, string>();

  for await (const record of RunStore.readEvents(stateDir, runId)) {
    if (record.type === 'task.started') {
      labels.set(record.taskId, `${record.pipeline}${record.variant ? `:${record.variant}` : ''} ${record.workItemId}`);
      continue;
    }
    if (record.type !== 'task.completed' || !record.notes?.length) continue;

    const notes = pattern ? record.notes.filter((note) => pattern.test(note)) : record.notes;
    if (notes.length > 0) byTask.set(record.taskId, { label: labels.get(record.taskId) ?? record.taskId, notes });
  }

  heading(pattern ? `Notes matching /${pattern.source}/` : 'Notes');
  if (byTask.size === 0) {
    process.stdout.write(pc.dim('Nothing was reported.\n'));
    return;
  }

  for (const { label, notes } of byTask.values()) {
    process.stdout.write(`${pc.bold(label)}\n`);
    for (const note of notes) process.stdout.write(`  ${pc.dim('·')} ${note}\n`);
  }
}

function statusColor(status: string): string {
  if (status === 'completed') return pc.green(status);
  if (status === 'failed') return pc.red(status);
  return pc.yellow(status);
}
