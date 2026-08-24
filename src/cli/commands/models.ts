import { Command } from 'commander';
import pc from 'picocolors';

import { createApp, type App } from '../../app/container.js';
import { loadConfig } from '../../config/loader.js';
import { usableInputTokens, type ModelTarget } from '../../llm/types.js';
import { formatDuration, formatTokens, renderTable, symbols, truncate } from '../ui/format.js';
import { heading } from '../ui/report.js';

export function createModelsCommand(): Command {
  return new Command('models')
    .description('List the resolved model targets and preview routing decisions')
    .option('-c, --config <file>', 'path to the config file')
    .option('--pool <name>', 'preview the routing order for a pool')
    .option('--tokens <n>', 'assume this many input tokens when previewing', '4000')
    .option('--probe', 'send one tiny completion to every target and report which ones answer')
    .action(async (options: { config?: string; pool?: string; tokens?: string; probe?: boolean }) => {
      const loaded = await loadConfig({ file: options.config });
      const app = createApp(loaded, { dryRun: false });

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
      for (const [name, spec] of Object.entries(loaded.config.llm.routing.pools)) {
        const inherited = spec.strategy ? '' : pc.dim(' (inherited)');
        const lanes = Object.entries(spec.maxConcurrent)
          .filter(([, limit]) => limit > 0)
          .map(([endpoint, limit]) => `${endpoint}×${limit}`);
        const prefer = Object.entries(spec.prefer).map(([variant, ids]) => `${variant}→${ids.join('|')}`);

        process.stdout.write(
          `${name.padEnd(12)} ${spec.models.join(' → ') || pc.dim('(every enabled model)')}\n` +
            `${' '.repeat(12)} ${pc.dim('strategy')} ${app.router.strategyIdFor(name)}${inherited}` +
            (lanes.length > 0 ? `  ${pc.dim('lanes')} ${lanes.join(', ')}` : '') +
            (prefer.length > 0 ? `  ${pc.dim('prefer')} ${prefer.join(', ')}` : '') +
            '\n',
        );
      }

      const estimatedInputTokens = Number.parseInt(options.tokens ?? '4000', 10) || 4000;
      heading(`Routing preview (${formatTokens(estimatedInputTokens)} input tokens)`);

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
        process.stdout.write(
          `${(pool ?? 'default').padEnd(12)} ${rendered || pc.red('(no targets)')} ` +
            pc.dim(`[${app.router.strategyIdFor(pool)}]`) +
            '\n',
        );
      }

      heading('Available strategies');
      for (const strategy of app.strategies.all()) {
        process.stdout.write(`${strategy.id.padEnd(20)} ${pc.dim(strategy.description)}\n`);
      }

      if (options.probe) process.exitCode = (await probeTargets(app)) ? 0 : 1;
    });
}

/**
 * Ask every configured target to say one word, and report who answered.
 *
 * Everything above this line reads the *config*, and a config is happy to
 * describe a model that does not exist: `llm.models` is a set of claims about
 * an endpoint, and nothing verifies them until a real run makes a real call and
 * quietly falls back. The endpoint's own `/v1/models` listing is not the check
 * either — a model can be listed and still reject every completion, which is
 * exactly what a router with an unconfigured upstream provider does.
 *
 * So the probe is a genuine completion, deliberately the smallest one that can
 * fail for the right reasons: a few tokens in, a few out, no JSON mode, no
 * tools. It costs a fraction of a cent across a whole config and it is the only
 * thing that distinguishes "declared" from "works".
 */
async function probeTargets(app: App): Promise<boolean> {
  heading('Probe');

  const targets = app.models.all();
  const results = await Promise.all(targets.map((target) => probeOne(app, target)));
  const failed = results.filter((result) => !result.ok);

  process.stdout.write(
    `${renderTable(results, [
      { header: '', value: (row) => (row.ok ? symbols.ok : symbols.fail) },
      { header: 'MODEL', value: (row) => row.target.modelId },
      { header: 'ENDPOINT', value: (row) => row.target.endpointId },
      { header: 'WIRE NAME', value: (row) => row.target.modelName },
      { header: 'LATENCY', value: (row) => (row.ok ? formatDuration(row.latencyMs) : pc.dim('—')), align: 'right' },
      { header: 'RESULT', value: (row) => (row.ok ? pc.dim(row.detail) : pc.red(truncate(row.detail, 80))) },
    ])}\n`,
  );

  if (failed.length === 0) {
    process.stdout.write(pc.green(`\nAll ${results.length} target(s) answered.\n`));
    return true;
  }

  process.stdout.write(
    pc.red(`\n${failed.length} of ${results.length} target(s) did not answer.\n`) +
      pc.dim(
        'A target that fails here fails silently during a run: its pool falls back to the next model, ' +
          'the run completes, and the only sign is the bill. Fix the model id or its credentials, ' +
          'or take it out of `llm.routing.pools`.\n',
      ),
  );
  return false;
}

interface ProbeResult {
  target: ModelTarget;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

async function probeOne(app: App, target: ModelTarget): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await app.clients.for(target.endpointId).complete(
      target,
      {
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        params: { ...target.params, maxOutputTokens: 16 },
      },
      { timeoutMs: target.timeoutMs },
    );
    const text = response.text.trim().replace(/\s+/g, ' ');
    return {
      target,
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: text ? truncate(text, 40) : `answered ${response.usage.completionTokens} token(s)`,
    };
  } catch (error: unknown) {
    return {
      target,
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
