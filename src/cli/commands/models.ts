import { Command } from 'commander';
import pc from 'picocolors';

import { createApp, type App } from '../../app/container.js';
import { loadConfig } from '../../config/loader.js';
import { usableInputTokens, type ModelTarget } from '../../llm/types.js';
import { formatDuration, formatTokens, renderTable, symbols, truncate } from '../ui/format.js';
import { heading } from '../ui/report.js';

interface ModelsOptions {
  config?: string;
  pool?: string;
  tokens?: string;
  probe?: boolean;
  /** Commander camel-cases `--probe-search`. */
  probeSearch?: boolean;
}

export function createModelsCommand(): Command {
  return new Command('models')
    .description('List the resolved model targets and preview routing decisions')
    .option('-c, --config <file>', 'path to the config file')
    .option('--pool <name>', 'preview the routing order for a pool')
    .option('--tokens <n>', 'assume this many input tokens when previewing', '4000')
    .option('--probe', 'send one tiny completion to every target and report which ones answer')
    .option('--probe-search', 'also verify live web search on paid targets — bills a per-request search fee')
    .action(async (options: ModelsOptions) => {
      const loaded = await loadConfig({ file: options.config });
      const app = createApp(loaded, { dryRun: false });

      heading('Targets');
      process.stdout.write(
        `${renderTable(app.models.all(), [
          { header: 'MODEL', value: (target) => target.modelId },
          { header: 'ENDPOINT', value: (target) => target.endpointId },
          { header: 'API', value: (target) => target.apiFormat === 'responses' ? 'responses' : 'chat' },
          { header: 'SEARCH', value: (target) => target.webSearchMode ?? pc.dim('—') },
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
        // Under `restrict` the list is the variant's whole chain, so a one-entry
        // list is a pool of one. Marking it here is the cheapest place to notice.
        const restricted = spec.preferMode === 'restrict';
        const prefer = Object.entries(spec.prefer).map(([variant, ids]) => {
          const chain = `${variant}→${ids.join('|')}`;
          return restricted && ids.length < 2 ? pc.yellow(`${chain} !`) : chain;
        });

        process.stdout.write(
          `${name.padEnd(12)} ${spec.models.join(' → ') || pc.dim('(every enabled model)')}\n` +
            `${' '.repeat(12)} ${pc.dim('strategy')} ${app.router.strategyIdFor(name)}${inherited}` +
            (lanes.length > 0 ? `  ${pc.dim('lanes')} ${lanes.join(', ')}` : '') +
            (prefer.length > 0
              ? `  ${pc.dim(restricted ? 'prefer (restrict)' : 'prefer')} ${prefer.join(', ')}`
              : '') +
            '\n' +
            (restricted && Object.values(spec.prefer).some((ids) => ids.length < 2)
              ? `${' '.repeat(12)} ${pc.yellow('!')} ${pc.dim('one-model chain: any failure there fails the document')}\n`
              : ''),
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

      if (options.probe) process.exitCode = (await probeTargets(app, options.probeSearch === true)) ? 0 : 1;
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
async function probeTargets(app: App, searchOnPaid: boolean): Promise<boolean> {
  heading('Probe');

  const targets = app.models.all();
  const unverified = targets.filter(
    (target) => target.capabilities.includes('web_search') && !isFree(target) && !searchOnPaid,
  );
  if (unverified.length > 0) {
    process.stdout.write(
      pc.dim(
        `Search is verified only on free targets. ${unverified.map((t) => t.modelId).join(', ')} ` +
          `will answer a plain completion instead — a live search there bills a per-request fee. ` +
          `Add --probe-search to include ${unverified.length === 1 ? 'it' : 'them'}.\n\n`,
      ),
    );
  }

  // Deliberately sequential: this is a health check, not a throughput test, and
  // bypassing the gateway's endpoint limiters must not create its own outage.
  const results = [];
  for (const target of targets) results.push(await probeOne(app, target, searchOnPaid));
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

/**
 * A target billed at zero on every rate it declares.
 *
 * `--probe` runs before every real job, so anything it adds is paid for on every
 * invocation. A completion of a few tokens is a fraction of a cent and stays;
 * a live search is a per-request fee on top, which is why it is free-only unless
 * asked for explicitly.
 */
function isFree(target: ModelTarget): boolean {
  const { inputPer1M, outputPer1M, cachedInputPer1M, cacheWriteInputPer1M, reasoningPer1M } = target.pricing;
  return [inputPer1M, outputPer1M, cachedInputPer1M ?? 0, cacheWriteInputPer1M ?? 0, reasoningPer1M ?? 0].every(
    (rate) => rate === 0,
  );
}

async function probeOne(app: App, target: ModelTarget, searchOnPaid: boolean): Promise<ProbeResult> {
  const startedAt = Date.now();
  const declaresSearch = target.capabilities.includes('web_search');
  const searches = declaresSearch && (isFree(target) || searchOnPaid);
  try {
    const nonce = `${Date.now().toString(36)}-${target.modelId}`;
    const response = await app.clients.for(target.endpointId).complete(
      target,
      {
        messages: [{
          role: 'user',
          content: searches
            ? `Open https://example.com/ using live web search and reply with its page title. Probe nonce ${nonce}.`
            : `Reply with the single word OK. Probe nonce ${nonce}.`,
        }],
        params: { ...target.params, maxOutputTokens: searches ? 512 : 16 },
        ...(searches ? { webSearch: { required: true as const, searchContextSize: 'low' as const } } : {}),
      },
      { timeoutMs: target.timeoutMs },
    );
    if (searches && (!response.webSearch?.performed || response.webSearch.sources.length === 0)) {
      throw new Error('completion answered but produced no provider web-search call with a consulted source');
    }
    const text = response.text.trim().replace(/\s+/g, ' ');
    return {
      target,
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: searches
        ? `searched ${response.webSearch?.sources.length ?? 0} source(s): ${truncate(text, 28)}`
        : declaresSearch
          ? 'answered; search NOT verified (paid — use --probe-search)'
          : (text ? truncate(text, 40) : `answered ${response.usage.completionTokens} token(s)`),
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
