/**
 * Which model wins each **document**, with empty stats and nothing learning.
 *
 *   npx tsx tools/simulate-adaptive.ts out/ru [model-ids]
 *
 * Answers the two questions a scoring strategy cannot be trusted on until they
 * are asked of real documents: what the complexity scores actually look like
 * (a scorer that rates everything 0.5 is an expensive no-op), and which way the
 * preference runs across the complexity range.
 *
 * ## What it is not
 *
 * It is **not** the split a run produces, and it should never be used to fit a
 * constant against one. Two reasons, and the second is not obvious:
 *
 *  - nothing here learns. `Router.select` reads stats and never writes them, so
 *    every document below is scored against an empty registry: profile priors,
 *    a full exploration bonus for everybody, and no health drift. That is a
 *    useful thing to see on its own — it is the *preference*, stripped of
 *    dynamics — and it is not what a scheduler does.
 *  - it counts documents, and a run serves **calls**. Complexity is a density,
 *    so it is negatively correlated with length (r = -0.39 on `input/ru`); the
 *    short documents that score hardest are the ones carrying the least work.
 *    A per-document map therefore over-reports the high-tolerance model against
 *    a real run, by about two to one on this corpus.
 *
 * For a split, use `tools/split-adaptive.ts`, which runs the actual scheduler
 * repeatedly and reports a mean and a spread.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { routingSchema } from '../src/config/schema.js';
import type { ModelTarget } from '../src/llm/types.js';
import { Router } from '../src/routing/Router.js';
import { RoutingStrategyRegistry } from '../src/routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import { adaptive } from '../src/routing/strategies/adaptive/AdaptiveStrategy.js';
import { scoreComplexity } from '../src/routing/strategies/adaptive/ComplexityScorer.js';
import type { OccupancyView } from '../src/routing/types.js';

function target(modelId: string, endpointId: string, inputPer1M: number, outputPer1M: number): ModelTarget {
  return {
    key: `${endpointId}:${modelId}`,
    modelId,
    endpointId,
    modelName: modelId,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M, outputPer1M },
    capabilities: [],
    reasoning: { enabled: false, effort: 'medium', dialect: 'reasoning', exclude: true },
    tags: [],
    weight: 1,
    params: {},
    timeoutMs: 120_000,
    endpoint: {
      id: endpointId,
      baseUrl: 'http://localhost/v1',
      apiKey: '',
      headers: {},
      query: {},
      maxConcurrent: 0,
      requestsPerMinute: 0,
      minRequestSpacingMs: 0,
      stream: false,
      enabled: true,
    },
    // Neither reaches routing; they are here so this file compiles against the
    // real `ModelTarget` rather than a cast that hides a drifting shape. Which
    // is what it was: `tools/` sat outside `npm run typecheck` until this
    // needed it, and the cast had been wrong for two fields for some time.
  } as unknown as ModelTarget;
}

/** The `translate` pool as `biomd.config.yaml` currently declares it. */
const ALL_TARGETS = [
  target('gemma-local', 'local', 0, 0),
  target('gpt-luna', 'omniroute', 0, 0),
  target('deepseek', 'openrouter', 0.08, 0.18),
  target('minimax-m3', 'openrouter', 0.3, 1.2),
  target('minimax-m3-free', 'openrouter', 0, 0),
];

/** Everything idle: the question here is what the *scoring* does, not the queue. */
const IDLE: OccupancyView = { load: () => 0, freeSlots: () => Number.POSITIVE_INFINITY, inFlight: () => 0 };

/**
 * Tokens a translate prompt carries on top of the article itself — template,
 * instructions, article context, JSON scaffolding.
 *
 * Derived rather than guessed: the median document in `out/ru` is 4687 bytes
 * (~1465 tokens at the configured 3.2 chars/token) and the median recorded
 * `translate` prompt across 1177 real calls is 2347 tokens. Ignoring the
 * difference would understate every request by more than a third and hide any
 * effect that depends on request size, `maxComfortableTokens` among them.
 */
const PROMPT_OVERHEAD_TOKENS = 880;

/**
 * The free endpoints saturated, `openrouter` the emptiest — the state a real
 * run spends most of its time in, since `local` holds one slot and `omniroute`
 * three against a corpus of hundreds.
 *
 * It is also the only state in which the question this strategy was built for
 * gets asked at all: with everything idle the two free targets win on price and
 * the paid three are never compared to each other.
 */
const FREE_ENDPOINTS_BUSY: OccupancyView = {
  load: (_pool, t) => (t.endpointId === 'openrouter' ? 0.25 : 1),
  freeSlots: (_pool, t) => (t.endpointId === 'openrouter' ? 3 : 0),
  inFlight: () => 0,
};

function histogram(values: number[], buckets = 10): string {
  const counts = new Array<number>(buckets).fill(0);
  for (const value of values) {
    const index = Math.min(buckets - 1, Math.floor(value * buckets));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const widest = Math.max(...counts, 1);
  return counts
    .map((count, index) => {
      const lo = (index / buckets).toFixed(1);
      const hi = ((index + 1) / buckets).toFixed(1);
      const bar = '#'.repeat(Math.round((count / widest) * 44));
      return `  ${lo}–${hi}  ${String(count).padStart(4)}  ${bar}`;
    })
    .join('\n');
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? 'out/ru';
  const files = (await readdir(dir)).filter((f) => f.endsWith('.bio.md'));
  if (files.length === 0) throw new Error(`No .bio.md files in ${dir}`);

  // Second argument restricts the pool, so the same corpus can be replayed
  // against the pool a config actually declares rather than against every
  // model this file knows about.
  const only = process.argv[3]?.split(',').map((id) => id.trim());
  const POOL = only ? ALL_TARGETS.filter((t) => only.includes(t.modelId)) : ALL_TARGETS;
  if (POOL.length === 0) throw new Error(`No known models in "${process.argv[3]}"`);
  console.log(`pool: ${POOL.map((t) => t.modelId).join(', ')}`);

  const routerFor = (occupancy: OccupancyView): Router =>
    new Router(
      new RoutingStrategyRegistry().register(adaptive),
      routingSchema.parse({ strategy: 'adaptive', pools: { translate: { models: POOL.map((t) => t.modelId) } } }),
      new TargetStatsRegistry(),
      { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 },
      occupancy,
    );
  const idleRouter = routerFor(IDLE);
  const busyRouter = routerFor(FREE_ENDPOINTS_BUSY);

  const scores: number[] = [];
  const winners = new Map<string, number>();
  const seconds = new Map<string, number>();
  const contended = new Map<string, number>();
  const featureTotals = new Map<string, number>();
  const extremes: { slug: string; score: number; winner: string; under: string }[] = [];

  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const { score, parts } = scoreComplexity(text);
    scores.push(score);
    for (const [id, value] of Object.entries(parts)) {
      featureTotals.set(id, (featureTotals.get(id) ?? 0) + value);
    }

    const request = {
      pipeline: 'translate',
      pool: 'translate',
      estimatedInputTokens: Math.ceil(text.length / 3.2) + PROMPT_OVERHEAD_TOKENS,
      expectedOutputTokens: Math.ceil(text.length / 3.2),
      requiredCapabilities: [],
      signals: { complexity: score },
    };

    const chain = idleRouter.select(POOL, request);
    const winner = chain[0]?.modelId ?? '(none)';
    winners.set(winner, (winners.get(winner) ?? 0) + 1);
    const second = chain[1]?.modelId ?? '(none)';
    seconds.set(second, (seconds.get(second) ?? 0) + 1);

    const under = busyRouter.select(POOL, request)[0]?.modelId ?? '(none)';
    contended.set(under, (contended.get(under) ?? 0) + 1);

    extremes.push({ slug: file.replace('.bio.md', ''), score, winner, under });
  }

  const sorted = [...scores].sort((a, b) => a - b);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;

  console.log(`\ncorpus: ${dir} — ${files.length} documents\n`);
  console.log('COMPLEXITY DISTRIBUTION');
  console.log(histogram(scores));
  console.log(
    `\n  min ${quantile(sorted, 0).toFixed(3)}  p25 ${quantile(sorted, 0.25).toFixed(3)}` +
      `  median ${quantile(sorted, 0.5).toFixed(3)}  p75 ${quantile(sorted, 0.75).toFixed(3)}` +
      `  p95 ${quantile(sorted, 0.95).toFixed(3)}  max ${quantile(sorted, 1).toFixed(3)}  mean ${mean.toFixed(3)}`,
  );

  console.log('\nMEAN FEATURE CONTRIBUTION');
  for (const [id, total] of [...featureTotals].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(14)} ${(total / files.length).toFixed(3)}`);
  }

  console.log('\nFIRST CHOICE');
  for (const [id, count] of [...winners].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(18)} ${String(count).padStart(4)}  ${((100 * count) / files.length).toFixed(1)}%`);
  }
  console.log('\nSECOND IN CHAIN (the fallback that would actually catch a failure)');
  for (const [id, count] of [...seconds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(18)} ${String(count).padStart(4)}  ${((100 * count) / files.length).toFixed(1)}%`);
  }

  console.log('\nFIRST CHOICE when local + omniroute are saturated (the openrouter decision)');
  for (const [id, count] of [...contended].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(18)} ${String(count).padStart(4)}  ${((100 * count) / files.length).toFixed(1)}%`);
  }

  extremes.sort((a, b) => b.score - a.score);
  console.log('\nHARDEST 8                            idle → | contended →');
  for (const row of extremes.slice(0, 8)) {
    console.log(`  ${row.score.toFixed(3)}  ${row.slug.padEnd(22)} ${row.winner.padEnd(14)} ${row.under}`);
  }
  console.log('\nEASIEST 8');
  for (const row of extremes.slice(-8).reverse()) {
    console.log(`  ${row.score.toFixed(3)}  ${row.slug.padEnd(22)} ${row.winner.padEnd(14)} ${row.under}`);
  }
  console.log();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
