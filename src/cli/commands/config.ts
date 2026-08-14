import { Command } from 'commander';
import pc from 'picocolors';
import { stringify as toYaml } from 'yaml';

import { createApp } from '../../app/container.js';
import { loadConfig, redactConfig } from '../../config/loader.js';
import { heading } from '../ui/report.js';

export function createConfigCommand(): Command {
  const command = new Command('config').description('Inspect and validate the configuration');

  command
    .command('check', { isDefault: true })
    .description('Validate the config and report what it resolves to')
    .option('-c, --config <file>', 'path to the config file')
    .action(async (options: { config?: string }) => {
      const loaded = await loadConfig({ file: options.config });
      const app = createApp(loaded, { dryRun: true });

      process.stdout.write(`${pc.green('✔')} ${loaded.file}\n`);
      process.stdout.write(pc.dim(`  config hash ${loaded.hash}\n`));

      for (const warning of loaded.warnings) {
        process.stdout.write(`${pc.yellow('!')} ${warning}\n`);
      }

      heading('Resolved');
      const enabled = Object.entries(loaded.config.tasks)
        .filter(([, task]) => task.enabled)
        .map(([id]) => id);

      process.stdout.write(`Tasks        ${enabled.join(', ') || pc.yellow('(none enabled)')}\n`);
      process.stdout.write(`Input        ${app.paths.resolve(loaded.config.input.baseDir)}\n`);
      process.stdout.write(`Output       ${app.paths.resolve(loaded.config.output.baseDir)}\n`);
      process.stdout.write(`Models       ${app.models.all().map((target) => target.modelId).join(', ')}\n`);
      process.stdout.write(`Routing      ${loaded.config.llm.routing.strategy}\n`);
      process.stdout.write(`Context      ${loaded.config.context.strategy}\n`);
      process.stdout.write(`Prompts      ${app.prompts.taskIds().join(', ')}\n`);

      // Loading every template proves the files exist and render — cheaper to
      // discover here than three minutes into a run.
      for (const taskId of app.prompts.taskIds()) {
        const version = await app.prompts.versionOf(taskId);
        process.stdout.write(pc.dim(`  ${taskId} @ ${version}\n`));
      }
    });

  command
    .command('show')
    .description('Print the effective configuration with secrets redacted')
    .option('-c, --config <file>', 'path to the config file')
    .option('--json', 'print JSON instead of YAML')
    .action(async (options: { config?: string; json?: boolean }) => {
      const loaded = await loadConfig({ file: options.config });
      const redacted = redactConfig(loaded.config);
      process.stdout.write(options.json ? `${JSON.stringify(redacted, null, 2)}\n` : toYaml(redacted));
    });

  return command;
}
