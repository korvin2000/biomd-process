/**
 * Grid search over the `adaptive` constants, against a target split **and** a
 * required response to speed.
 *
 *   npx tsx tools/matrix-adaptive.ts --corpus=out/ru --docs=196
 *   npx tsx tools/matrix-adaptive.ts --top=12 --target=deepseek=60,minimax-m3=25,minimax-m3-free=15
 *
 * `calibrate-adaptive.ts` sweeps one constant at a time over real runs, which is
 * the honest instrument and far too slow for a grid: a point costs ~200 seconds
 * on the full corpus, so a thousand of them is a week. This does the coarse
 * search instead, and hands its shortlist back for confirmation there.
 *
 * ## How it stays honest
 *
 * It **records** one real run's routing decisions — every `complexity`,
 * `estimatedInputTokens` and `expectedOutputTokens` the pipelines actually
 * posed — and then replays those against the real `scoreTargets` under each
 * candidate tuning. Nothing here reimplements the arithmetic and nothing here
 * invents a payload. What replay drops is the feedback loop: exploration
 * decaying, health drifting, endpoints reordering under load. Those are
 * second-order once the throughput measurement is honest, and the first thing
 * this prints is how far replay is from the harness at the current constants,
 * so the reader can see whether that is still true.
 *
 * ## Three scenarios, not one
 *
 * A split is only half the requirement. The other half is how the ranking
 * *responds* when speeds move, and a tuning that hits the target split by making
 * the speed term inert would satisfy the first half perfectly:
 *
 *  - **nominal** — minimax-m3 at its usual ~1.3x deepseek. Hit the target split.
 *  - **slow** — deepseek 2.5x slower than minimax, which on openrouter is still
 *    inside the provider lottery. deepseek must keep the plurality: a reading
 *    that may not survive the next four calls must not hand over the corpus.
 *  - **very slow** — deepseek 3.5x slower, past the noise floor. Now the split
 *    *must* move, and visibly.
 *
 * A candidate that fails either speed requirement is disqualified outright
 * rather than penalised, because they are not preferences.
 */
import {
  DEFAULT_TUNING,
  scoreTargets,
  type AdaptiveTuning,
} from '../src/routing/strategies/adaptive/AdaptiveStrategy.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import type { ModelTarget } from '../src/llm/types.js';
import type { RoutingContext } from '../src/routing/types.js';
import {
  ENDPOINT_OF,
  loadCorpus,
  runOnce,
  SPEED,
  type RoutedRequest,
} from '../tests/helpers/adaptiveHarness.js';

const CONTENDERS = ['deepseek', 'minimax-m3', 'minimax-m3-free'] as const;

function target(modelId: string, inputPer1M: number, outputPer1M: number): ModelTarget {
  return {
    key: `openrouter:${modelId}`,
    modelId,
    endpointId: 'openrouter',
    modelName: modelId,
    contextWindow: 262_144,
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
      id: 'openrouter',
      baseUrl: 'http://localhost:9/v1',
      apiKey: '',
      headers: {},
      query: {},
      maxConcurrent: 4,
      requestsPerMinute: 0,
      minRequestSpacingMs: 0,
      stream: false,
      enabled: true,
    },
  } as unknown as ModelTarget;
}

/** The three that compete once the two free endpoints are saturated. */
const POOL = [
  target('deepseek', 0.08, 0.18),
  target('minimax-m3', 0.3, 1.2),
  target('minimax-m3-free', 0, 0),
];

/**
 * A scenario is what each target's rolling window is reporting.
 *
 * Stated in tokens/sec rather than as a multiplier, because that is what the
 * window holds. Health is clean everywhere: the question here is what speed
 * does, and mixing a failure into it would answer a different one.
 */
interface Scenario {
  readonly id: string;
  readonly speed: Record<string, number>;
}

const SCENARIOS: readonly Scenario[] = [
  { id: 'nominal', speed: { ...SPEED } },
  {
    id: 'slow',
    speed: { ...SPEED, deepseek: (SPEED['minimax-m3'] ?? 105) / 2.5 },
  },
  {
    id: 'very slow',
    speed: { ...SPEED, deepseek: (SPEED['minimax-m3'] ?? 105) / 3.5 },
  },
];

/**
 * How many decisions are in the air before any of their outcomes land.
 *
 * A run scores under concurrency: `run.concurrency` is 8 and this pool's
 * openrouter lane holds 4, so roughly four calls are outstanding at any moment
 * and the target that won decision *n* has not yet recorded a success when
 * decision *n+1* is scored. Replaying with an immediate update is the same
 * strategy played by one caller, and it concentrates: the exploration bonus
 * decays faster than it really does, so whoever leads early keeps leading.
 * Measured, immediate updates predicted 95.0 / 3.6 / 1.4 against 86.3 / 7.9 /
 * 5.8 — the whole residual error was this.
 */
const IN_FLIGHT = 4;

function contextFor(request: RoutedRequest, stats: TargetStatsRegistry): RoutingContext {
  const { estimatedInputTokens, expectedOutputTokens } = request;
  return {
    candidates: POOL,
    request: {
      pipeline: 'translate',
      pool: 'translate',
      estimatedInputTokens,
      expectedOutputTokens,
      requiredCapabilities: [],
      signals: { complexity: request.complexity },
    },
    stats: (key) => stats.get(key),
    fits: () => true,
    headroom: () => 100_000,
    outputHeadroom: () => 10_000,
    estimatedCost: (t) =>
      (t.pricing.inputPer1M * estimatedInputTokens + t.pricing.outputPer1M * expectedOutputTokens) / 1e6,
    freeSlots: () => Number.POSITIVE_INFINITY,
    inFlight: () => 0,
    load: () => 0,
    sequence: 0,
    options: {},
  } as RoutingContext;
}

/** Openrouter share, %, under one tuning and one scenario. */
function shareOf(
  requests: readonly RoutedRequest[],
  tuning: AdaptiveTuning,
  scenario: Scenario,
): Record<string, number> {
  // Cold, like a real run: the priors carry the first decisions and the
  // scenario's speed arrives only as calls are recorded, which is what actually
  // happens to a target that has become slow.
  const stats = new TargetStatsRegistry();
  const won: Record<string, number> = { deepseek: 0, 'minimax-m3': 0, 'minimax-m3-free': 0 };
  const pending: ModelTarget[] = [];

  for (const request of requests) {
    const winner = scoreTargets(POOL, contextFor(request, stats), tuning)[0]!.target;
    won[winner.modelId] = (won[winner.modelId] ?? 0) + 1;
    // Sequential, and that is the trick — the registry evolves as the replay
    // runs, so exploration decays, health drifts and the throughput window fills
    // as they do in a run. Lagged by {@link IN_FLIGHT}, because they do not do
    // so instantly.
    pending.push(winner);
    if (pending.length > IN_FLIGHT) {
      const landed = pending.shift()!;
      stats.recordSuccess(landed.key, 1000, 0.001, scenario.speed[landed.modelId] ?? 60);
    }
  }
  const total = Math.max(requests.length, 1);
  return Object.fromEntries(Object.entries(won).map(([id, n]) => [id, (100 * n) / total]));
}

interface Candidate {
  tuning: AdaptiveTuning;
  nominal: Record<string, number>;
  slow: Record<string, number>;
  verySlow: Record<string, number>;
  /** Sum of absolute deviations from the target split, percentage points. */
  error: number;
  /** How far the split moves between `slow` and `very slow`, percentage points. */
  responsiveness: number;
  /** Worst share swing under a 15% nudge to any one weight, percentage points. */
  fragility: number;
}

/**
 * How far the split moves when one weight is nudged by 15%.
 *
 * A share is only worth quoting if it is a property of the constants rather than
 * of where they happen to sit relative to a cliff, and this pool can produce
 * cliffs: two targets separated by a *constant* offset — price, say — are either
 * always above or always below one another, so when that offset approaches zero
 * every document flips at once. Measured on a candidate that scored well on
 * every other criterion, moving `prose` from 0.8 to 0.7 moved **seventeen
 * points** of traffic from deepseek to the free tier.
 *
 * The contrast worth keeping in mind: deepseek against minimax-m3 is separated
 * by a *payload-dependent* term, so nudging a weight slides a threshold through
 * document space and the share moves in proportion to how many documents sit
 * near it. That is a stable split. A split held up by a hairline tie is not, and
 * nothing that fitted it will survive the first hour of provider drift.
 */
function fragilityOf(
  requests: readonly RoutedRequest[],
  tuning: AdaptiveTuning,
  baseline: Record<string, number>,
): number {
  let worst = 0;
  for (const knob of ['throughput', 'health', 'cost', 'prose', 'complexityPull'] as const) {
    for (const factor of [0.85, 1.15]) {
      const nudged = shareOf(requests, { ...tuning, [knob]: tuning[knob] * factor }, SCENARIOS[0]!);
      for (const model of CONTENDERS) {
        worst = Math.max(worst, Math.abs((nudged[model] ?? 0) - (baseline[model] ?? 0)));
      }
    }
  }
  return worst;
}

function parseTarget(argv: readonly string[]): Record<string, number> {
  const flag = argv.find((a) => a.startsWith('--target='));
  if (!flag) return { deepseek: 60, 'minimax-m3': 25, 'minimax-m3-free': 15 };
  const wanted: Record<string, number> = {};
  for (const pair of flag.slice('--target='.length).split(',')) {
    const [id, value] = pair.split('=');
    if (id && value) wanted[id.trim()] = Number(value);
  }
  return wanted;
}

function numberFlag(argv: readonly string[], name: string, fallback: number): number {
  const flag = argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? Number(flag.slice(name.length + 3)) : fallback;
}

/**
 * The grid.
 *
 * Deliberately coarse and deliberately bounded. Every axis has a floor that
 * keeps the term meaning something: a `complexityPull` free to reach zero will
 * always be chosen, because flattening the score lets exploration and task order
 * produce any split you like — and that is not routing.
 */
const GRID = {
  throughput: [0.6, 0.8, 1.0],
  health: [1.2, 1.5, 1.8],
  cost: [0.8, 1.1, 1.4, 1.8, 2.2],
  prose: [0.2, 0.35, 0.5, 0.65, 0.8],
  complexityPull: [0.4, 0.55, 0.7, 0.9],
  // Held tight around the honest, corpus-measured value (0.23 — the median of
  // `manual/`) rather than left free the way `prose` and `cost` are. Widening
  // this to hit a share is the exact mistake `COMPLEXITY_MIDPOINT`'s own comment
  // documents against: it stops being a description of the corpus and becomes
  // a share fitted through the back door. The narrow band here is a robustness
  // check, not a search.
  complexityMidpoint: [0.21, 0.23, 0.25],
  speedTolerance: [2.75, 3.0, 3.25],
  speedTolerancePenalty: [0.06, 0.08, 0.11],
} as const;

function* grid(): Generator<AdaptiveTuning> {
  for (const throughput of GRID.throughput)
    for (const health of GRID.health)
      for (const cost of GRID.cost)
        for (const prose of GRID.prose)
          for (const complexityPull of GRID.complexityPull)
            for (const complexityMidpoint of GRID.complexityMidpoint)
              for (const speedTolerance of GRID.speedTolerance)
                for (const speedTolerancePenalty of GRID.speedTolerancePenalty)
                  yield {
                    ...DEFAULT_TUNING,
                    throughput,
                    health,
                    cost,
                    prose,
                    complexityPull,
                    complexityMidpoint,
                    speedTolerance,
                    speedTolerancePenalty,
                  };
}

function row(share: Record<string, number>): string {
  return CONTENDERS.map((m) => (share[m] ?? 0).toFixed(1).padStart(5)).join(' /');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const documents = numberFlag(argv, 'docs', 196);
  const top = numberFlag(argv, 'top', 10);
  const wanted = parseTarget(argv);
  const corpusDir = argv.find((a) => a.startsWith('--corpus='))?.slice(9);

  const corpus = await loadCorpus(documents, corpusDir);
  if (corpus.length === 0) throw new Error('No corpus: expected .bio.md files under input/ru or out/ru');

  process.stderr.write('recording one real run to replay against…\n');
  const recorded = await runOnce(corpus, undefined, undefined, true);
  // Only the decisions that reached openrouter: which endpoint a call lands on
  // is settled by occupancy — the two free endpoints saturate — rather than by
  // the score, and replaying a `gpt-luna` decision against these three would
  // invent a request that never existed.
  const requests = recorded.requests.filter((r) => ENDPOINT_OF[r.chosen] === 'openrouter');
  if (requests.length === 0) throw new Error('No openrouter routing requests captured');

  // The replay's own accuracy check, printed before anything is fitted to it.
  const observed = Object.fromEntries(
    CONTENDERS.map((m) => [m, (100 * (recorded.byTarget.get(m) ?? 0)) / Math.max(recorded.onOpenRouter, 1)]),
  );
  const predicted = shareOf(requests, DEFAULT_TUNING, SCENARIOS[0]!);
  console.log(
    `\nreplay check at the current tuning — measured ${row(observed)}  ·  replayed ${row(predicted)}` +
      `  (${requests.length} requests over ${corpus.length} documents)\n`,
  );

  const candidates: Candidate[] = [];
  let considered = 0;
  let disqualified = 0;

  for (const tuning of grid()) {
    considered += 1;
    const nominal = shareOf(requests, tuning, SCENARIOS[0]!);
    const slow = shareOf(requests, tuning, SCENARIOS[1]!);
    const verySlow = shareOf(requests, tuning, SCENARIOS[2]!);

    // Requirements, not preferences, so a candidate that misses one is dropped
    // rather than scored down.
    //
    // A 2.5x reading is inside the provider lottery — it may not survive the
    // next four calls — so deepseek must still be doing **the bulk** of the
    // work on it. Against the family and not against either model separately:
    // a split of 37 / 30 / 33 leaves deepseek nominally ahead of each of them
    // and has still handed 63% of the corpus to minimax, which is the thing
    // this is meant to prevent.
    const holdsUnderNoise = (slow['deepseek'] ?? 0) >= 50;
    // It must nonetheless notice. A term that is flat inside the band is not
    // tolerant, it is switched off.
    const respondsInsideBand = (nominal['deepseek'] ?? 0) - (slow['deepseek'] ?? 0) >= 2;
    // And past the noise floor the ranking must move, and move harder.
    const responsiveness = (slow['deepseek'] ?? 0) - (verySlow['deepseek'] ?? 0);
    if (!holdsUnderNoise || !respondsInsideBand || responsiveness < 12) {
      disqualified += 1;
      continue;
    }

    const error = CONTENDERS.reduce((sum, m) => sum + Math.abs((nominal[m] ?? 0) - (wanted[m] ?? 0)), 0);
    candidates.push({ tuning, nominal, slow, verySlow, error, responsiveness, fragility: 0 });
  }

  // Fragility only for the ones worth the arithmetic: it costs ten extra
  // replays apiece, and a candidate thirty points from the target is not going
  // to be rescued by being stable about it.
  candidates.sort((a, b) => a.error - b.error);
  const examined = candidates.slice(0, 400);
  for (const candidate of examined) {
    candidate.fragility = fragilityOf(requests, candidate.tuning, candidate.nominal);
  }

  // A split that cannot survive a 15% nudge to one weight is not a split, so
  // fragility gates before error ranks — but as a band rather than a threshold,
  // because a point or two of it is meaningless.
  const stable = examined.filter((c) => c.fragility <= 10);
  const ranked = (stable.length > 0 ? stable : examined).sort(
    (a, b) => a.error - b.error || a.fragility - b.fragility || b.responsiveness - a.responsiveness,
  );
  candidates.length = 0;
  candidates.push(...ranked);
  console.log(
    `
${examined.length} best-fitting examined for stability · ${stable.length} survive a 15% nudge to any one weight
`,
  );

  console.log(
    `${considered} combinations · ${disqualified} disqualified on the speed requirements · ` +
      `${candidates.length} left · target ${CONTENDERS.map((m) => `${m}=${wanted[m] ?? 0}`).join('/')}\n`,
  );
  console.log(
    '  thr  hlth  cost prose  pull   mid   tol  pen | nominal            | 2.5x slow          | 3.5x slow          | err  resp  frag',
  );
  for (const c of candidates.slice(0, top)) {
    const t = c.tuning;
    console.log(
      `  ${t.throughput.toFixed(2)}  ${t.health.toFixed(2)}  ${t.cost.toFixed(2)}  ${t.prose.toFixed(2)}  ` +
        `${t.complexityPull.toFixed(2)}  ${t.complexityMidpoint.toFixed(2)}  ${t.speedTolerance.toFixed(1)}  ` +
        `${t.speedTolerancePenalty.toFixed(2)} | ` +
        `${row(c.nominal)} | ${row(c.slow)} | ${row(c.verySlow)} | ${c.error.toFixed(1).padStart(4)}  ` +
        `${c.responsiveness.toFixed(1).padStart(4)}  ${c.fragility.toFixed(1).padStart(4)}`,
    );
  }
  console.log(
    '\nConfirm a shortlist on the real scheduler before believing any of it:\n' +
      '  npx tsx tools/calibrate-adaptive.ts --corpus=out/ru --docs=196 --runs=5 --fix=<the row you picked>\n',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
