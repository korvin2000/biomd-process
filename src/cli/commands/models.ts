import { Command } from 'commander';
import pc from 'picocolors';

import { createApp } from '../../app/container.js';
import { loadConfig } from '../../config/loader.js';
import { usableInputTokens } from '../../llm/types.js';
import { formatTokens, renderTable } from '../ui/format.js';
import { heading } from '../ui/report.js';

export function createModelsCommand(): Command {
  return new Command('models')
    .description('List the resolved model targets and preview routing decisions')
    .option('-c, --config <file>', 'path to the config file')
    .option('--pool <name>', 'preview the routing order for a pool')
    .option('--tokens <n>', 'assume this many input tokens when previewing', '4000')
    .action(async (options: { config?: string; pool?: string; tokens?: string }) => {
      const loaded = await loadConfig({ file: options.config });
      const app = createApp(loaded, { dryRun: true });

      heading('Targets');
      process.stdout.write(
        `${renderTable(app.models.all(), [
          { header: 'MODEL', value: (target) => target.modelId },
          { header: 'ENDPOINT', value: (target) => target.endpointId },
          { header: 'WIRE NAME', value: (target) => target.modelName },
          { header: 'CONTEXT', value: (target) => formatTokens(target.contextWindow), align: 'right' },
          { header: 'MAX OUT', value: (target) => formatTokens(target.maxOutputTokens), align: 'right' },
          { header: '$/1M IN', value: (target) => target.pricing.inputPer1M.toFixed(2), align: 'right' },
          { header: '$/1M OUT', value: (target) => target.pricing.outputPer1M.toFixed(2), align: 'right' },
          { header: 'REASONING', value: (target) => (target.reasoning.enabled ? target.reasoning.effort : pc.dim('off')) },
          { header: 'CAPABILITIES', value: (target) => target.capabilities.join(',') || pc.dim('—') },
        ])}\n`,
      );

      heading('Pools');
      for (const [name, members] of Object.entries(loaded.config.llm.routing.pools)) {
        process.stdout.write(`${name.padEnd(12)} ${members.join(' → ')}\n`);
      }

      const estimatedInputTokens = Number.parseInt(options.tokens ?? '4000', 10) || 4000;
      heading(`Routing preview (${loaded.config.llm.routing.strategy}, ${formatTokens(estimatedInputTokens)} input tokens)`);

      const pools = options.pool ? [options.pool] : Object.keys(loaded.config.llm.routing.pools);
      for (const pool of pools.length > 0 ? pools : [undefined]) {
        const chain = app.gateway.plan({
          pipeline: 'preview',
          pool,
          estimatedInputTokens,
          expectedOutputTokens: 1024,
        });
        const rendered = chain
          .map((target) => {
            const headroom = usableInputTokens(target, {
              reserveOutputTokens: loaded.config.context.reserveOutputTokens,
              safetyMarginRatio: loaded.config.context.safetyMarginRatio,
            });
            return headroom >= estimatedInputTokens ? target.modelId : pc.dim(`${target.modelId} (overflows)`);
          })
          .join(' → ');
        process.stdout.write(`${(pool ?? 'default').padEnd(12)} ${rendered || pc.red('(no targets)')}\n`);
      }

      heading('Available strategies');
      for (const strategy of app.strategies.all()) {
        process.stdout.write(`${strategy.id.padEnd(20)} ${pc.dim(strategy.description)}\n`);
      }
    });
}
