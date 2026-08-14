#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';

import { APP_NAME, APP_VERSION } from '../app/version.js';
import { AppLogger } from '../observability/Logger.js';
import { AppError } from '../shared/errors.js';
import { createConfigCommand } from './commands/config.js';
import { createModelsCommand } from './commands/models.js';
import { createPromptsCommand } from './commands/prompts.js';
import { createReportCommand } from './commands/report.js';
import { createRunCommand } from './commands/run.js';

const program = new Command()
  .name(APP_NAME)
  .description('Batch-process bio.md documents with LLMs: metadata extraction and structure-preserving translation.')
  .version(APP_VERSION)
  .showHelpAfterError()
  .addCommand(createRunCommand(), { isDefault: true })
  .addCommand(createConfigCommand())
  .addCommand(createModelsCommand())
  .addCommand(createPromptsCommand())
  .addCommand(createReportCommand());

try {
  await program.parseAsync(process.argv);
} catch (error: unknown) {
  reportFatal(error);
  process.exitCode = 1;
} finally {
  await AppLogger.close();
}

/**
 * A config mistake is the most likely failure and deserves a readable message,
 * not a stack trace. Everything unexpected still prints its stack, because that
 * is what a bug report needs.
 */
function reportFatal(error: unknown): void {
  if (error instanceof AppError) {
    process.stderr.write(`\n${pc.red('error')} ${pc.dim(`[${error.code}]`)} ${error.message}\n`);
    if (process.env['BIOMD_DEBUG']) {
      process.stderr.write(`${pc.dim(JSON.stringify(error.toJSON(), null, 2))}\n`);
    }
    return;
  }
  if (error instanceof Error) {
    process.stderr.write(`\n${pc.red('error')} ${error.message}\n`);
    if (error.stack) process.stderr.write(`${pc.dim(error.stack)}\n`);
    return;
  }
  process.stderr.write(`\n${pc.red('error')} ${String(error)}\n`);
}
