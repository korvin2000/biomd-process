import { Command, Option } from 'commander';

import { createApp } from '../../app/container.js';
import { planJob, runJob } from '../../app/runJob.js';
import type { AppConfigInput, DeepPartial } from '../../config/index.js';
import { loadConfig } from '../../config/loader.js';
import { AppLogger } from '../../observability/Logger.js';
import type { ProgressReporter } from '../../observability/ProgressReporter.js';
import { ConsoleProgress } from '../ui/ConsoleProgress.js';
import { PlainProgress } from '../ui/PlainProgress.js';
import { printPlan, printSummary } from '../ui/report.js';

interface RunOptions {
  config?: string;
  dryRun?: boolean;
  concurrency?: string;
  only?: string;
  lang?: string;
  limit?: string;
  resume?: string;
  strategy?: string;
  out?: string;
  logLevel?: string;
  quiet?: boolean;
  failFast?: boolean;
  budgetUsd?: string;
  maxRequests?: string;
  skipExisting?: boolean;
}

export function createRunCommand(): Command {
  return (
    new Command('run')
      .description('Process the configured corpus (extraction and/or translation)')
      /**
       * `run` is the default command, so anything commander cannot place lands
       * here — and this command spends money. `biomd -c f config check` (options
       * before the subcommand) would otherwise be read as `run` with `config`
       * and `check` as ignorable extras, and would quietly process the corpus
       * instead of validating it. An unexpected argument must be an error.
       */
      .allowExcessArguments(false)
  )
    .option('-c, --config <file>', 'path to the config file')
    .option('-n, --dry-run', 'plan the run and print what it would do, without calling any model')
    .option('--concurrency <n>', 'parallel tasks')
    .option('--only <pipelines>', 'comma-separated pipelines to run, e.g. "extract" or "extract,translate"')
    .option('--lang <codes>', 'comma-separated target languages, overriding the config')
    .option('--limit <n>', 'process at most N documents')
    .addOption(new Option('--resume <mode>', 'resume behaviour').choices(['auto', 'off']).default(undefined))
    .option('--resume-run <runId>', 'resume a specific previous run')
    .option('--strategy <id>', 'routing strategy id')
    .option('-o, --out <dir>', 'output base directory')
    .option('--skip-existing', 'skip tasks whose output file already exists')
    .option('--fail-fast', 'stop the run on the first task failure')
    .option('--budget-usd <amount>', 'stop the run once this much has been spent')
    .option('--max-requests <n>', 'stop the run after this many LLM requests')
    .addOption(new Option('--log-level <level>', 'log verbosity').choices(['debug', 'info', 'warn', 'error', 'silent']))
    .option('-q, --quiet', 'suppress console logging (the JSONL log file is still written)')
    .action(runAction);
}

async function runAction(options: RunOptions & { resumeRun?: string }): Promise<void> {
  const loaded = await loadConfig({ file: options.config, overrides: buildOverrides(options) });
  for (const warning of loaded.warnings) process.stderr.write(`warning: ${warning}\n`);

  const dryRun = options.dryRun ?? loaded.config.run.dryRun;
  const app = createApp(loaded, { dryRun });

  if (dryRun) {
    const plan = await planJob(app);
    printPlan(app, plan);
    process.stdout.write('\nNothing was written. Drop --dry-run to execute.\n');
    await AppLogger.close();
    return;
  }

  const progress: ProgressReporter & { writeLine(line: string): void } = process.stdout.isTTY
    ? new ConsoleProgress()
    : new PlainProgress();
  AppLogger.setWriter((_level, line) => progress.writeLine(line));

  const controller = new AbortController();
  const onInterrupt = () => {
    progress.note('warn', 'Interrupted — finishing in-flight tasks, then stopping.');
    controller.abort();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  try {
    const outcome = await runJob(app, { progress, signal: controller.signal });
    printSummary(outcome.summary, app.metrics.snapshot(), outcome.runDir);
    process.exitCode = outcome.summary.status === 'completed' ? 0 : 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    await AppLogger.close();
  }
}

/**
 * CLI flags are the highest-priority config layer. Only the flags the user
 * actually passed become overrides — `pruneUndefined` in the loader drops the rest,
 * so an absent flag never silently replaces a configured value with a default.
 */
function buildOverrides(options: RunOptions & { resumeRun?: string }): DeepPartial<AppConfigInput> {
  const pipelines = options.only?.split(',').map((value) => value.trim()).filter(Boolean);
  const languages = options.lang?.split(',').map((value) => value.trim()).filter(Boolean);

  return {
    input: { limit: toInt(options.limit) },
    output: { baseDir: options.out },
    tasks: {
      extract: pipelines ? { enabled: pipelines.includes('extract') } : undefined,
      translate: {
        enabled: pipelines ? pipelines.includes('translate') : undefined,
        targetLanguages: languages,
      },
    },
    llm: { routing: { strategy: options.strategy } },
    cost: {
      budget: { maxCostUsd: toFloat(options.budgetUsd), maxRequests: toInt(options.maxRequests) },
    },
    run: {
      concurrency: toInt(options.concurrency),
      dryRun: options.dryRun,
      failFast: options.failFast,
      skipExistingOutputs: options.skipExisting,
      resume: options.resumeRun ?? options.resume,
    },
    logging: {
      level: options.logLevel as 'debug' | 'info' | 'warn' | 'error' | 'silent' | undefined,
      console: options.quiet ? 'off' : undefined,
    },
  };
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toFloat(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
