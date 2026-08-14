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
    .action(async (runIdArg: string | undefined, options: { config?: string; failed?: boolean }) => {
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
        `Tokens      ${formatTokens(totals.promptTokens)} in (${formatTokens(totals.cachedPromptTokens)} cached) · ` +
          `${formatTokens(totals.completionTokens)} out\n`,
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
    });
}

function statusColor(status: string): string {
  if (status === 'completed') return pc.green(status);
  if (status === 'failed') return pc.red(status);
  return pc.yellow(status);
}
