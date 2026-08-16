import { Command } from 'commander';
import pc from 'picocolors';

import { createApp } from '../../app/container.js';
import { loadConfig } from '../../config/loader.js';
import { fieldsFor } from '../../pipelines/extraction/FlatFields.js';
import { MessageBuilder } from '../../prompts/MessageBuilder.js';
import { heading } from '../ui/report.js';

/** Stand-in values so a template can be rendered without touching a document. */
const SAMPLE_VARIABLES: Record<string, Record<string, unknown>> = {
  extract: {
    language: 'ru',
    fields: fieldsFor({ catalogHints: true }).map((field) => ({ key: field.key, hint: field.hint })),
    requiredFields: ['forename', 'surname'],
    partial: false,
    partLabel: 'full',
  },
  translate: {
    sourceLanguage: 'ru',
    targetLanguage: 'en',
    glossary: {},
    partial: false,
    partLabel: 'full',
  },
  translateSegments: { sourceLanguage: 'ru', targetLanguage: 'en', count: 12 },
  localize: { sourceLanguage: 'ru', targetLanguage: 'en', count: 12 },
};

export function createPromptsCommand(): Command {
  const command = new Command('prompts').description('Inspect the prompt templates');

  command
    .command('list', { isDefault: true })
    .description('List the configured templates and their version hashes')
    .option('-c, --config <file>', 'path to the config file')
    .action(async (options: { config?: string }) => {
      const app = createApp(await loadConfig({ file: options.config }), { dryRun: true });

      for (const taskId of app.prompts.taskIds()) {
        const files = await app.prompts.filesOf(taskId);
        const version = await app.prompts.versionOf(taskId);
        process.stdout.write(`${pc.bold(taskId)} ${pc.dim(`@ ${version}`)}\n`);
        process.stdout.write(pc.dim(`  system  ${files.system}\n`));
        process.stdout.write(pc.dim(`  user    ${files.user}\n`));
      }
    });

  command
    .command('show <task>')
    .description('Render a template with sample variables — no tokens are spent')
    .option('-c, --config <file>', 'path to the config file')
    .option('--messages', 'show the assembled wire messages instead of the raw render')
    .action(async (task: string, options: { config?: string; messages?: boolean }) => {
      const app = createApp(await loadConfig({ file: options.config }), { dryRun: true });
      const prompt = await app.prompts.render(task, SAMPLE_VARIABLES[task] ?? {});

      if (options.messages) {
        const messages = MessageBuilder.build(prompt, [
          { title: 'Document', body: '<document body goes here>', volatile: true, fence: 'markdown' },
        ]);
        for (const message of messages) {
          heading(`${message.role}${message.cacheBreakpoint ? pc.dim('  (cache prefix ends here)') : ''}`);
          process.stdout.write(`${message.content}\n`);
        }
        process.stdout.write(
          pc.dim(`\n≈ ${app.estimator.estimateMessages(messages)} tokens (heuristic estimate)\n`),
        );
        return;
      }

      heading(`system  ${pc.dim(`@ ${prompt.version}`)}`);
      process.stdout.write(`${prompt.system}\n`);
      heading('user (instructions)');
      process.stdout.write(`${prompt.instructions}\n`);
    });

  return command;
}
