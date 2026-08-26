import { describe, expect, it } from 'vitest';

import { routingSchema } from '../src/config/schema.js';
import type { ModelTarget } from '../src/llm/types.js';
import { Router } from '../src/routing/Router.js';
import { RoutingStrategyRegistry } from '../src/routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import type { OccupancyView, RoutingContext } from '../src/routing/types.js';
import {
  adaptive,
  adaptiveWith,
  DEFAULT_TUNING,
  scoreTargets,
} from '../src/routing/strategies/adaptive/AdaptiveStrategy.js';
import { complexityOf, scoreComplexity } from '../src/routing/strategies/adaptive/ComplexityScorer.js';
import { profileFor, profiledModelIds } from '../src/routing/strategies/adaptive/ModelProfiles.js';

function target(modelId: string, overrides: Partial<ModelTarget> = {}): ModelTarget {
  return {
    key: `${overrides.endpointId ?? 'openrouter'}:${modelId}`,
    modelId,
    endpointId: 'openrouter',
    modelName: modelId,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M: 1, outputPer1M: 2 },
    capabilities: [],
    reasoning: { enabled: false, effort: 'medium', dialect: 'reasoning', exclude: true },
    tags: [],
    weight: 1,
    params: {},
    timeoutMs: 120_000,
    endpoint: {
      id: overrides.endpointId ?? 'openrouter',
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
    ...overrides,
  } as ModelTarget;
}

const deepseek = target('deepseek', { pricing: { inputPer1M: 0.08, outputPer1M: 0.18 } });
const minimax = target('minimax-m3', { pricing: { inputPer1M: 0.3, outputPer1M: 1.2 } });
const minimaxFree = target('minimax-m3-free', { pricing: { inputPer1M: 0, outputPer1M: 0 } });
const luna = target('gpt-luna', { endpointId: 'omniroute', pricing: { inputPer1M: 0, outputPer1M: 0 } });
const gemma = target('gemma-local', { endpointId: 'local', pricing: { inputPer1M: 0, outputPer1M: 0 } });

const fitting = { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 };

/** An occupancy view stated as "this endpoint is this full", 0…1. */
function occupancy(loads: Record<string, number> = {}): OccupancyView {
  return {
    load: (_pool, t) => loads[t.endpointId] ?? 0,
    freeSlots: (_pool, t) => (loads[t.endpointId] === 1 ? 0 : Number.POSITIVE_INFINITY),
    inFlight: () => 0,
  };
}

function makeRouter(stats = new TargetStatsRegistry(), loads: Record<string, number> = {}): Router {
  return new Router(
    new RoutingStrategyRegistry().register(adaptive),
    routingSchema.parse({ strategy: 'adaptive' }),
    stats,
    fitting,
    occupancy(loads),
  );
}

/** USD for this request on this target, the way `Router.buildContext` computes it. */
function priceOf(target: ModelTarget, inputTokens: number, outputTokens: number): number {
  return (target.pricing.inputPer1M * inputTokens + target.pricing.outputPer1M * outputTokens) / 1e6;
}

/** A minimal RoutingContext, for asserting on the arithmetic rather than the winner. */
function contextFor(complexity: number, stats = new TargetStatsRegistry(), realPrices = false): RoutingContext {
  return {
    candidates: [],
    request: {
      pipeline: 'translate',
      estimatedInputTokens: 2000,
      expectedOutputTokens: 2000,
      requiredCapabilities: [],
      signals: { complexity },
    },
    stats: (key) => stats.get(key),
    fits: () => true,
    headroom: () => 1000,
    outputHeadroom: () => 1000,
    estimatedCost: (target) => (realPrices ? priceOf(target, 2000, 2000) : 0.001),
    freeSlots: () => Number.POSITIVE_INFINITY,
    inFlight: () => 0,
    load: () => 0,
    sequence: 0,
    options: {},
  };
}

const ask = (complexity?: number) => ({
  pipeline: 'translate',
  estimatedInputTokens: 2000,
  expectedOutputTokens: 2000,
  requiredCapabilities: [],
  ...(complexity === undefined ? {} : { signals: { complexity } }),
});

describe('the complexity scorer', () => {
  const plain = 'Родился в Москве в 1939 году. Учился у известного педагога и много концертировал.';

  it('scores clean prose low and the same prose wrapped in markup high', () => {
    const tangled = [
      '::: image',
      'src: photo/b/brouwer.jpg',
      'position: right',
      'size: small',
      'caption: Лео Брауэр на обложке "Classical Guitar"',
      ':::',
      '| Musica Incidental | [MIDI](music/midi/brouwer.mid) |',
      '**Juan Leovigildo Brouwer** — ⟦1⟧ и ⟦2⟧',
    ].join('\n');

    expect(complexityOf(plain)).toBeLessThan(0.2);
    expect(complexityOf(tangled)).toBeGreaterThan(0.4);
  });

  it('does not punish a document for being long', () => {
    // The corpus comparison this scorer is built on found no length effect at
    // all: broken documents had a median 2899 chars against 2910 for clean ones.
    const short = complexityOf(plain);
    const long = complexityOf(Array.from({ length: 40 }, () => plain).join('\n\n'));
    expect(Math.abs(long - short)).toBeLessThan(0.05);
  });

  it('counts script mixing by the minority share, in either direction', () => {
    const cyrillic = complexityOf('Родился в Москве и учился в консерватории у педагога.');
    const mixed = complexityOf('Родился Juan Leovigildo Brouwer, Classical Guitar Review, Habana.');
    expect(mixed).toBeGreaterThan(cyrillic);
  });

  it('stays inside 0…1 and survives an empty document', () => {
    expect(complexityOf('')).toBe(0);
    const extreme = complexityOf('::: a\nb: c\n:::\n'.repeat(200));
    expect(extreme).toBeGreaterThanOrEqual(0);
    expect(extreme).toBeLessThanOrEqual(1);
  });

  it('reports which feature carried the score', () => {
    const { parts } = scoreComplexity('src: photo.jpg\ncaption: Une photo\n');
    expect(parts['containerKv']).toBeGreaterThan(0);
    expect(parts['tableRows']).toBe(0);
  });
});

describe('the model profiles', () => {
  it('gives an unknown model the neutral stance rather than excluding it', () => {
    const unknown = profileFor('something-nobody-measured');
    expect(unknown.tolerance).toBe(0.5);
  });

  it('separates the two models this deployment cares about', () => {
    expect(profileFor('deepseek').tolerance).toBeLessThan(profileFor('minimax-m3').tolerance);
  });

  it('rates the free tier below the paid one it shares a name with', () => {
    // Not the same deployment: the free variant is served by a single fp8 host
    // and does not advertise `structured_outputs`, so it holds a table together
    // less reliably than the paid one. Same model name, different profile.
    expect(profileFor('minimax-m3-free').tolerance).toBeLessThan(profileFor('minimax-m3').tolerance);
    expect(profiledModelIds()).toContain('minimax-m3-free');
  });
});

describe('the adaptive strategy', () => {
  it('prefers the cheap model on a clean document', () => {
    const order = makeRouter().select([deepseek, minimax], { ...ask(0.05), pool: 'p' });
    expect(order[0]!.modelId).toBe('deepseek');
  });

  it('moves a tangled document to the model that holds structure together', () => {
    const order = makeRouter().select([deepseek, minimax], { ...ask(0.95), pool: 'p' });
    expect(order[0]!.modelId).toBe('minimax-m3');
  });

  it('leaves the loser as the fallback rather than removing it', () => {
    const order = makeRouter().select([deepseek, minimax], { ...ask(0.95), pool: 'p' });
    expect(order.map((t) => t.modelId)).toEqual(['minimax-m3', 'deepseek']);
  });

  it('pays for the paid tier on a tangled document and takes the free one on a clean one', () => {
    const hard = makeRouter().select([minimax, minimaxFree], { ...ask(0.9), pool: 'p' });
    expect(hard[0]!.modelId).toBe('minimax-m3');
    const easy = makeRouter().select([minimax, minimaxFree], { ...ask(0.1), pool: 'p' });
    expect(easy[0]!.modelId).toBe('minimax-m3-free');
  });

  it('demotes a target that is failing right now, even on the document it suits best', () => {
    // The safety property that caps COMPLEXITY_PULL. A target whose last six
    // calls all failed has health 0; no amount of "but this document needs its
    // tolerance" may put it back at the head of the chain, because the hardest
    // documents are precisely the ones a broken target handles worst.
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 6; i += 1) stats.recordFailure(minimax.key);
    const order = makeRouter(stats).select([deepseek, minimax], { ...ask(1.0), pool: 'p' });
    expect(order[0]!.modelId).toBe('deepseek');
  });

  it('never rewards a model for being fragile', () => {
    // Stated as the invariant rather than as a matchup, because a matchup
    // depends on whichever profile numbers happen to hold today. Low tolerance
    // is the absence of a virtue, so a below-neutral model must score no higher
    // on a clean document than on a neutral one — its bend may cost it
    // something on hard payloads and may never pay it anything on easy ones.
    const scoreAt = (complexity: number): number => {
      const rows = scoreTargets([deepseek], contextFor(complexity));
      return rows[0]!.score;
    };
    // Against `complexityMidpoint` rather than 0.5, which is where this used to
    // read the neutral point from — back when the midpoint was hard-coded to
    // the middle of the scale rather than fitted to the corpus. The invariant is
    // unchanged; the complexity it is measured from is a constant now.
    const neutral = DEFAULT_TUNING.complexityMidpoint;
    expect(profileFor('deepseek').tolerance).toBeLessThan(0.5);
    expect(scoreAt(0)).toBeCloseTo(scoreAt(neutral), 10);
    expect(scoreAt(1)).toBeLessThan(scoreAt(neutral));
  });

  it('does not let one lucky fast call hand over the corpus', () => {
    const stats = new TargetStatsRegistry();
    // One enormous, instant response for the model that is otherwise slower.
    stats.recordSuccess(minimax.key, 100, 0, 100_000);
    const order = makeRouter(stats).select([deepseek, minimax], { ...ask(0.05), pool: 'p' });
    // Shrinkage towards the prior keeps the clean-document answer unchanged.
    expect(order[0]!.modelId).toBe('deepseek');
  });

  it('lets a sustained speed difference through once the window fills', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 8; i += 1) {
      stats.recordSuccess(minimax.key, 1000, 0, 20_000);
      stats.recordSuccess(deepseek.key, 20_000, 0, 1000);
    }
    const order = makeRouter(stats).select([deepseek, minimax], { ...ask(0.5), pool: 'p' });
    expect(order[0]!.modelId).toBe('minimax-m3');
  });

  it('ranks only within the least-loaded tier and never queues on a full endpoint', () => {
    // openrouter saturated, omniroute idle: the omniroute target leads even
    // though the scorer would otherwise rank the openrouter ones above it.
    const order = makeRouter(new TargetStatsRegistry(), { openrouter: 1, omniroute: 0, local: 0.5 }).select(
      [deepseek, minimax, luna],
      { ...ask(0.9), pool: 'p' },
    );
    expect(order[0]!.modelId).toBe('gpt-luna');
    expect(order.map((t) => t.modelId)).toHaveLength(3);
  });

  it('orders the busy remainder by how busy it is', () => {
    const order = makeRouter(new TargetStatsRegistry(), { omniroute: 0, local: 0.5, openrouter: 0.9 }).select(
      [deepseek, gemma, luna],
      { ...ask(0.5), pool: 'p' },
    );
    expect(order.map((t) => t.modelId)).toEqual(['gpt-luna', 'gemma-local', 'deepseek']);
  });

  it('is deterministic: the same inputs give the same chain', () => {
    const stats = new TargetStatsRegistry();
    stats.recordSuccess(deepseek.key, 5000, 0.01, 3000);
    const first = makeRouter(stats).select([deepseek, minimax, minimaxFree], { ...ask(0.4), pool: 'p' });
    const second = makeRouter(stats).select([deepseek, minimax, minimaxFree], { ...ask(0.4), pool: 'p' });
    expect(first.map((t) => t.key)).toEqual(second.map((t) => t.key));
  });

  it('treats a missing complexity signal as the neutral midpoint, not as zero', () => {
    // A caller that measured nothing must not be read as "this document is as
    // simple as documents get" — that is a claim, and nobody made it. `bend = 0`
    // is what a missing signal produces, and `bend = 0` is by construction the
    // same thing as a document sitting exactly on `complexityMidpoint`.
    const unmeasured = makeRouter().select([deepseek, minimax], { ...ask(), pool: 'p' });
    const neutral = makeRouter().select([deepseek, minimax], {
      ...ask(DEFAULT_TUNING.complexityMidpoint),
      pool: 'p',
    });
    const easy = makeRouter().select([deepseek, minimax], { ...ask(0.0), pool: 'p' });

    expect(unmeasured.map((t) => t.modelId)).toEqual(neutral.map((t) => t.modelId));
    expect(easy[0]!.modelId).toBe('deepseek');
  });
});

/**
 * The arithmetic of the four terms, asserted directly.
 *
 * Every one of these pins a defect that a winner-take-all assertion could not
 * see: the ranking came out the same and the number underneath it was wrong.
 */
describe('the scoring arithmetic', () => {
  it('lets a sustained measurement overrule the profile prior', () => {
    // The prior is a hand-derived number from a few hundred historical calls,
    // and it used to hold 3/7 of this term for the whole run whatever arrived:
    // confidence was weighted by the *window* length, which `RECENT_WINDOW` caps
    // at four. A target sustaining 200 tok/s against a prior of 81 read as 149.
    // The window is the estimate; the cumulative success count is the evidence.
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 40; i += 1) stats.recordSuccess(deepseek.key, 1000, 0.001, 200);

    const row = scoreTargets([deepseek], contextFor(0.3, stats))[0]!;
    expect(profileFor('deepseek').priorThroughput).toBe(81);
    expect(row.throughput).toBeGreaterThan(180);
  });

  it('still refuses to believe one impossible call', () => {
    const stats = new TargetStatsRegistry();
    stats.recordSuccess(minimax.key, 100, 0, 100_000); // a million tokens/sec
    const row = scoreTargets([minimax], contextFor(0.3, stats))[0]!;
    // The ceiling binds the window, not the blend: three times the prior, no
    // matter how confident the cumulative count says we should be.
    expect(row.throughput).toBeLessThanOrEqual(profileFor('minimax-m3').priorThroughput * 3);
  });

  it('compares two paid targets the same way whether or not a free one is present', () => {
    // `min / value` is the obvious lower-is-better normalisation and it breaks
    // on the one case this pool always contains: a free candidate makes `min`
    // zero, every paid target collapses onto the floor, and two targets four
    // times apart in price become indistinguishable. Measured before the fix,
    // the deepseek-to-minimax gap on this term fell from 0.82 to 0.045 — an
    // eighteen-fold change in a comparison the free tier is not part of.
    const gapOf = (pool: ModelTarget[]): number => {
      const rows = scoreTargets(pool, contextFor(0.3, new TargetStatsRegistry(), true));
      const find = (id: string): number => rows.find((r) => r.target.modelId === id)!.score;
      return find('deepseek') - find('minimax-m3');
    };

    expect(gapOf([deepseek, minimax, minimaxFree])).toBeCloseTo(gapOf([deepseek, minimax]), 10);
  });

  it('gives a target that is failing every call no reward for being tolerant', () => {
    // The safety property, stated as a mechanism rather than as a threshold.
    // `COMPLEXITY_PULL` used to have a ceiling above which a health-0 target
    // started winning the hardest documents in the corpus — the ones it is
    // least able to answer — and that ceiling was a consequence of the four
    // weights, so it moved whenever one of them did. Documented at 0.85; the
    // arithmetic said 0.658. Now the reward half of the bend is worth what
    // health says it is worth, and a dead target's is worth nothing.
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 6; i += 1) stats.recordFailure(minimax.key);

    const scoreAt = (complexity: number): { broken: number; healthy: number; brokenHealth: number } => {
      const rows = scoreTargets([deepseek, minimax], contextFor(complexity, stats));
      const broken = rows.find((r) => r.target.modelId === 'minimax-m3')!;
      return {
        broken: broken.score,
        brokenHealth: broken.health,
        healthy: rows.find((r) => r.target.modelId === 'deepseek')!.score,
      };
    };

    const neutral = scoreAt(0.5);
    const tangled = scoreAt(1);
    expect(neutral.brokenHealth).toBe(0); // six failures in six calls, and no older evidence
    // The document got twice as hard and the broken target gained nothing by it.
    expect(tangled.broken).toBeCloseTo(neutral.broken, 10);
    // …while the healthy low-tolerance one honestly loses something, which is
    // the statement the bend is for.
    expect(tangled.healthy).toBeLessThan(neutral.healthy);
    expect(tangled.healthy).toBeGreaterThan(tangled.broken);
  });

  it('ramps the size penalty rather than cutting a target off at its ceiling', () => {
    const ceiling = profileFor('minimax-m3-free').maxComfortableTokens!;
    const penaltyAt = (inputTokens: number): number => {
      const context = { ...contextFor(0.3), request: { ...ask(0.3), estimatedInputTokens: inputTokens } };
      return scoreTargets([minimaxFree], context as RoutingContext)[0]!.oversize;
    };

    expect(penaltyAt(ceiling)).toBe(0);
    expect(penaltyAt(ceiling * 1.25)).toBeGreaterThan(0);
    expect(penaltyAt(ceiling * 1.25)).toBeLessThan(penaltyAt(ceiling * 1.75));
    // Bounded, so it stays a preference: the target keeps its place in the
    // chain and still catches a failure above it.
    expect(penaltyAt(ceiling * 10)).toBe(penaltyAt(ceiling * 2));
  });

  it('spends the exploration bonus down as a target becomes a known quantity', () => {
    const stats = new TargetStatsRegistry();
    const exploreNow = (): number => scoreTargets([deepseek], contextFor(0.3, stats))[0]!.explore;

    const cold = exploreNow();
    for (let i = 0; i < 4; i += 1) stats.recordSuccess(deepseek.key, 1000, 0, 500);
    const warm = exploreNow();
    for (let i = 0; i < 20; i += 1) stats.recordSuccess(deepseek.key, 1000, 0, 500);
    const known = exploreNow();

    expect(cold).toBeGreaterThan(0.25);
    expect(warm).toBeLessThan(cold / 4);
    // Gone long before it could distort a split, but never negative.
    expect(known).toBeLessThan(0.02);
    expect(known).toBeGreaterThan(0);
  });

  it('runs at whatever tuning it is handed, so a sweep measures the real formula', () => {
    // `tools/calibrate-adaptive.ts` fits constants by registering instances of
    // this. Before `AdaptiveTuning` existed it kept its own transcription of the
    // arithmetic, which had drifted — it modelled neither the oversize penalty
    // nor the exploration bonus — so the constants it produced were fitted
    // against a formula the router does not run.
    const flat = adaptiveWith({ ...DEFAULT_TUNING, complexityPull: 0 }, 'flat');
    const router = new Router(
      new RoutingStrategyRegistry().register(flat),
      routingSchema.parse({ strategy: 'flat' }),
      new TargetStatsRegistry(),
      fitting,
      occupancy(),
    );

    // With no bend at all, a tangled document and a clean one rank identically.
    const tangled = router.select([deepseek, minimax], { ...ask(0.95), pool: 'p' });
    const clean = router.select([deepseek, minimax], { ...ask(0.05), pool: 'p' });
    expect(tangled.map((t) => t.modelId)).toEqual(clean.map((t) => t.modelId));
    // …which the real tuning does not do.
    expect(makeRouter().select([deepseek, minimax], { ...ask(0.95), pool: 'p' })[0]!.modelId).toBe('minimax-m3');
  });
});

/**
 * How the ranking answers a target that has become slow.
 *
 * Two requirements that pull against each other, asserted together because
 * either alone is trivially satisfiable. Speed on openrouter is only sometimes a
 * fact about the model: one id is served by dozens of providers, one managing
 * ten tokens a second while another does a hundred, and the population drifts
 * with the time of day. So a moderate reading is probably the lottery and must
 * not overturn a quality judgement — and a large one probably is not, and must.
 *
 * Asserted on `scoreTargets` rather than on a run, deliberately. A run's split
 * also carries exploration, task order and endpoint timing, and over a short
 * corpus those swamp the effect being measured: the same question asked of
 * twenty-four documents answered "48% at 2x" and "45% at 2.5x", which is the
 * noise talking. The requirement is a property of the scoring function, so it is
 * pinned where it lives.
 */
describe('the response to a target becoming slow', () => {
  /** Warm stats in which deepseek measures `factor` times slower than its profile. */
  function slowed(factor: number): TargetStatsRegistry {
    const stats = new TargetStatsRegistry();
    const rate: Record<string, number> = {
      deepseek: profileFor('deepseek').priorThroughput / factor,
      'minimax-m3': profileFor('minimax-m3').priorThroughput,
      'minimax-m3-free': profileFor('minimax-m3-free').priorThroughput,
    };
    for (const t of [deepseek, minimax, minimaxFree]) {
      for (let i = 0; i < 30; i += 1) stats.recordSuccess(t.key, 1000, 0.001, rate[t.modelId] ?? 60);
    }
    return stats;
  }

  const scoreAt = (factor: number): number => {
    const rows = scoreTargets([deepseek, minimax, minimaxFree], contextFor(0.24, slowed(factor), true));
    return rows.find((r) => r.target.modelId === 'deepseek')!.score;
  };

  it('treats a reading inside the provider lottery as nearly a tie, and one outside it as evidence', () => {
    const nominal = scoreAt(1);
    const lottery = scoreAt(2.5);
    const real = scoreAt(3.5);
    const severe = scoreAt(5);

    // It notices — a term that is flat here is switched off, not tolerant…
    expect(lottery).toBeLessThan(nominal);
    // …but only just. A 2.5x reading may not survive the next four calls.
    const insideBand = nominal - lottery;
    expect(insideBand).toBeLessThan(0.02);

    // Past the knee the same *increment* of slowness costs several times as
    // much. That ratio is the requirement; the absolutes are a corpus property.
    const firstOctaveOut = lottery - real;
    expect(firstOctaveOut).toBeGreaterThan(insideBand * 3);
    expect(severe).toBeLessThan(real);
  });

  it('never lets a speed reading alone overturn the quality judgement inside the band', () => {
    // The pool ranked at every step from parity to the edge of the band: the
    // structure-holding model must not take a clean document off the prose model
    // on a reading this uncertain, whatever the reading says.
    for (const factor of [1, 1.5, 2, 2.5]) {
      const rows = scoreTargets([deepseek, minimax, minimaxFree], contextFor(0.24, slowed(factor), true));
      expect(rows[0]!.target.modelId, `minimax-m3 took a clean document at ${factor}x`).not.toBe('minimax-m3');
    }
  });
});

/**
 * The metered free tier, which is the pool member most likely to start refusing.
 *
 * Its characteristic failure is not a bad answer but a 429: the allowance runs
 * out, every call fails for a while, and then it works again. The requirement is
 * the whole arc — notice quickly, stop prioritising it, and be able to give it
 * back its place without a restart, because "it is available again" is the
 * normal case rather than the exception.
 */
describe('a free tier that starts refusing', () => {
  const pool = [deepseek, minimax, minimaxFree];
  const rank = (stats: TargetStatsRegistry): string[] =>
    scoreTargets(pool, contextFor(0.2, stats, true)).map((r) => r.target.modelId);
  const scoreOf = (stats: TargetStatsRegistry): number =>
    scoreTargets(pool, contextFor(0.2, stats, true)).find((r) => r.target.modelId === 'minimax-m3-free')!
      .score;

  /** Everyone warm and clean, which is what a run looks like before anything goes wrong. */
  function healthy(): TargetStatsRegistry {
    const stats = new TargetStatsRegistry();
    for (const t of pool) {
      for (let i = 0; i < 20; i += 1) stats.recordSuccess(t.key, 1000, 0.001, profileFor(t.modelId).priorThroughput);
    }
    return stats;
  }

  it('drops it down the chain within a handful of refusals, and hands it back when it recovers', () => {
    const stats = healthy();
    const before = scoreOf(stats);

    // Three 429s in a row. Three, not thirty: an allowance that has run out says
    // so immediately, and a strategy that needs a dozen failures to notice has
    // spent a dozen calls finding out.
    for (let i = 0; i < 3; i += 1) stats.recordFailure(minimaxFree.key);
    const refusing = scoreOf(stats);

    expect(refusing).toBeLessThan(before - 0.15);
    expect(rank(stats).at(-1), 'a refusing target must not still be preferred').toBe('minimax-m3-free');

    // The allowance comes back. Two independent routes have to carry it, because
    // a target scored to the bottom of the chain does not get the call that
    // would clear it: the streak fades once nothing has been sent for a while…
    stats.get(minimaxFree.key).lastUsedAt = Date.now() - 90_000;
    const rested = scoreOf(stats);
    expect(rested).toBeGreaterThan(refusing);

    // …and the window forgets the failures outright once newer outcomes push
    // them out, which is what actually restores it.
    for (let i = 0; i < 10; i += 1) {
      stats.recordSuccess(minimaxFree.key, 1000, 0, profileFor('minimax-m3-free').priorThroughput);
    }
    expect(scoreOf(stats)).toBeCloseTo(before, 1);
    // The run-long ledger still remembers; the routing decision does not.
    expect(stats.get(minimaxFree.key).failures).toBe(3);
  });

  it('keeps it in the chain as a fallback rather than removing it', () => {
    const stats = healthy();
    for (let i = 0; i < 8; i += 1) stats.recordFailure(minimaxFree.key);
    // Demoted, never dropped: the pool is also the fallback chain, and a target
    // that is last is still the thing that catches a failure above it.
    expect(rank(stats)).toHaveLength(3);
    expect(rank(stats).at(-1)).toBe('minimax-m3-free');
  });

  it('does not let a size ceiling and a complexity penalty both be ignored', () => {
    // The two guards the deployment asked for, in one place. This target fails
    // more than deepseek on large *and* on complex requests, so it must lose on
    // each axis independently — a small tangled document and a large clean one
    // both have to move away from it.
    const stats = healthy();
    const ceiling = profileFor('minimax-m3-free').maxComfortableTokens!;
    const scoreWith = (complexity: number, inputTokens: number): number => {
      const base = contextFor(complexity, stats, true);
      const context = { ...base, request: { ...base.request, estimatedInputTokens: inputTokens } };
      return scoreTargets(pool, context as RoutingContext).find((r) => r.target.modelId === 'minimax-m3-free')!
        .score;
    };

    const small = scoreWith(0.1, Math.round(ceiling * 0.8));
    expect(scoreWith(0.55, Math.round(ceiling * 0.8)), 'complexity did not cost it').toBeLessThan(small);
    expect(scoreWith(0.1, ceiling * 2), 'size did not cost it').toBeLessThan(small);
  });
});

describe('the rolling window', () => {
  it('keeps only the last four successes', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 1; i <= 6; i += 1) stats.recordSuccess('t', 1000, 0, i * 1000);
    expect(stats.get('t').recent.map((c) => c.completionTokens)).toEqual([3000, 4000, 5000, 6000]);
  });

  it('ignores a success with no usage rather than recording it as zero throughput', () => {
    const stats = new TargetStatsRegistry();
    stats.recordSuccess('t', 1000, 0);
    expect(stats.get('t').recent).toHaveLength(0);
    expect(stats.get('t').successes).toBe(1);
  });
});
