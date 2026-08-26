import { describe, expect, it } from 'vitest';

import { scoreTargets } from '../src/routing/strategies/adaptive/AdaptiveStrategy.js';
import { scoreComplexity } from '../src/routing/strategies/adaptive/ComplexityScorer.js';
import { profileFor } from '../src/routing/strategies/adaptive/ModelProfiles.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import type { ModelTarget } from '../src/llm/types.js';
import type { RoutingContext } from '../src/routing/types.js';
import { ENDPOINT_OF, loadCorpus, runOnce, speedAwareClient, SPEED } from './helpers/adaptiveHarness.js';

/**
 * The `adaptive` strategy driven end to end over a corpus, with no network.
 *
 * This exists because the alternative was measuring it against live paid
 * endpoints, and that turned out to be both expensive and a bad instrument: a
 * live run reports the split it produced and nothing about why, so every
 * hypothesis costs another run and four of them in a row came back "deepseek
 * took everything" for four unrelated reasons.
 *
 * The pool, the fake provider and the run driver live in
 * `helpers/adaptiveHarness.ts`, shared with `tools/split-adaptive.ts` so a
 * constant fitted with the tool is fitted against what this file asserts.
 */

describe('the harness itself', () => {
  /**
   * The instrument check, and it goes first because everything below is
   * worthless without it.
   *
   * The gateway measures `Date.now() - startedAt` and ignores the `latencyMs` a
   * response declares, so a fake that answers instantly reports every call as
   * having taken no time at all. This harness did exactly that: measured
   * throughput was `tokens / ~0ms`, clamped by `OUTLIER_CEILING` to three times
   * the profile prior, for whichever target happened to answer first — and it
   * stayed there, because the window only refills for a target that is being
   * called. The throughput term was a first-mover bonus, minimax-m3's share
   * ranged from 0.8% to 25% between identical runs, and every constant in
   * `AdaptiveStrategy.ts` had been fitted against that.
   */
  it('measures the tokens per second it says it does', async () => {
    const corpus = await loadCorpus(8);
    expect(corpus.length).toBeGreaterThan(0);

    const outcome = await runOnce(corpus);

    for (const [modelId, modelled] of Object.entries(SPEED)) {
      const rate = outcome.measured.get(`${ENDPOINT_OF[modelId]}:${modelId}`);
      if (rate === undefined) continue; // served nothing this run; nothing to check
      // gemma-local holds one concurrent slot, so its wall clock carries a queue
      // — which is the quantity `RecentCall` is defined to include. Every other
      // target should land within timer jitter of what it was asked to model.
      if (modelId === 'gemma-local') {
        expect(rate).toBeLessThanOrEqual(modelled * 1.3);
        continue;
      }
      expect(rate, `${modelId} measured ${rate.toFixed(1)} against a modelled ${modelled}`).toBeGreaterThan(
        modelled * 0.75,
      );
      expect(rate).toBeLessThan(modelled * 1.25);
    }
  });
});

describe('the adaptive strategy over a whole corpus', () => {
  it('spreads a corpus across the pool instead of locking onto one target', async () => {
    const corpus = await loadCorpus(12);
    expect(corpus.length).toBeGreaterThan(0);

    const outcome = await runOnce(corpus);
    expect(outcome.failures).toBe(0);

    // Every member of the pool must see work. The bug this pins down is the one
    // four live runs showed: a target that is never tried keeps its profile
    // forever, so it is never tried — 51-0-0 across three models sharing an
    // endpoint. Two of them had nothing wrong with them.
    for (const modelId of Object.keys(SPEED)) {
      expect(outcome.byTarget.get(modelId) ?? 0, `${modelId} served no request`).toBeGreaterThan(0);
    }

    // …and no single target may swallow the corpus.
    for (const [modelId, served] of outcome.byTarget) {
      expect(served / outcome.total, `${modelId} took ${served}/${outcome.total}`).toBeLessThan(0.75);
    }
  });

  it('sends the openrouter share mostly to deepseek, with minimax holding a real slice', async () => {
    const corpus = await loadCorpus(12);
    expect(corpus.length).toBeGreaterThan(0);

    const outcome = await runOnce(corpus);
    const share = (modelId: string): number =>
      (outcome.byTarget.get(modelId) ?? 0) / Math.max(outcome.onOpenRouter, 1);

    expect(outcome.onOpenRouter).toBeGreaterThan(8);
    // Bands rather than points, and wide ones. The split is not a function of
    // the constants: the strategy learns during a run and task order varies, so
    // a single run is one sample from a distribution. `tools/split-adaptive.ts`
    // reports the mean and spread over repeated runs, which is what a constant
    // should ever be fitted against.
    expect(share('deepseek')).toBeGreaterThan(0.4);
    expect(share('minimax-m3')).toBeGreaterThan(0.05);
    expect(share('minimax-m3-free')).toBeGreaterThan(0);
  });

  /**
   * The world this deployment actually runs in.
   *
   * An openrouter model id is served by dozens of providers at once — one will
   * manage ten tokens a second while another does a hundred — and the whole
   * population drifts with the time of day. A four-call window is a *noisy*
   * estimator of that, which is fine as long as the noise moves work around
   * rather than stranding a pool member: the strategy must not lock onto
   * whichever target drew a lucky draw, and must not write off one that drew a
   * bad one, because neither draw was about the model.
   */
  it('keeps the pool in play when provider speed swings between calls', async () => {
    const corpus = await loadCorpus(12);
    expect(corpus.length).toBeGreaterThan(0);

    const outcome = await runOnce(corpus, speedAwareClient({ jitter: true }));
    expect(outcome.failures).toBe(0);

    for (const modelId of Object.keys(SPEED)) {
      expect(outcome.byTarget.get(modelId) ?? 0, `${modelId} was stranded by a bad draw`).toBeGreaterThan(0);
    }
    for (const [modelId, served] of outcome.byTarget) {
      expect(served / outcome.total, `${modelId} took ${served}/${outcome.total} on a lucky draw`).toBeLessThan(
        0.75,
      );
    }
  });

  it('measures the corpus it is being asked about', async () => {
    const corpus = await loadCorpus(16);
    expect(corpus.length).toBeGreaterThan(0);
    const scores = corpus.map((d) => scoreComplexity(d.text).score);
    // A scorer that rates everything the same is an expensive no-op; this is the
    // assertion that would have caught complexity being measured on stripped
    // prose, where the whole corpus collapsed to a near-constant 0.08.
    const spread = Math.max(...scores) - Math.min(...scores);
    expect(spread).toBeGreaterThan(0.2);
  });
});

/**
 * What happens when a target starts refusing.
 *
 * The four live runs that shaped this strategy all completed with 0 retries and
 * 0 fallbacks, so none of the health machinery was ever exercised against a real
 * failure. These do it here, where a 429 costs nothing.
 */
describe('the adaptive strategy under failure', () => {
  it('completes the corpus when one target refuses every call', async () => {
    const corpus = await loadCorpus(10);
    expect(corpus.length).toBeGreaterThan(0);

    const client = speedAwareClient({
      broken: 'deepseek',
      fails: () => Object.assign(new Error('slow down'), { status: 429 }),
    });
    const outcome = await runOnce(corpus, client);

    // A refusing target must cost documents nothing: the pool is the fallback
    // chain and `rate_limit` is both retryable and fallbackable.
    expect(outcome.failures).toBe(0);
    // It was tried — an untried target proves nothing about failure handling.
    expect(outcome.byTarget.get('deepseek') ?? 0).toBeGreaterThan(0);
    // …and the work landed elsewhere.
    const elsewhere = [...outcome.byTarget].filter(([m]) => m !== 'deepseek').reduce((n, [, c]) => n + c, 0);
    expect(elsewhere).toBeGreaterThan(0);
  });

  it('backs off a target that starts refusing part-way through', async () => {
    const corpus = await loadCorpus(10);
    expect(corpus.length).toBeGreaterThan(0);

    // The free tier answers its allowance, then 429s for the rest of the run —
    // the failure a metered free tier actually produces.
    const ALLOWANCE = 3;
    let servedFree = 0;
    const client = speedAwareClient({
      broken: 'minimax-m3-free',
      fails: () => {
        servedFree += 1;
        return servedFree > ALLOWANCE
          ? Object.assign(new Error('rate limit exceeded'), { status: 429 })
          : undefined;
      },
    });

    const outcome = await runOnce(corpus, client);
    expect(outcome.failures).toBe(0);

    const attempts = outcome.byTarget.get('minimax-m3-free') ?? 0;
    // It kept its allowance and was not hammered indefinitely afterwards: the
    // streak penalty must actually push a refusing target down the chain.
    expect(attempts).toBeGreaterThanOrEqual(ALLOWANCE);
    expect(attempts).toBeLessThan(outcome.total / 2);
  });
});

/** A bare `ModelTarget` for the unit-level recovery assertions. */
function bareTarget(modelId: string): ModelTarget {
  return {
    key: `openrouter:${modelId}`,
    modelId,
    endpointId: 'openrouter',
    modelName: modelId,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M: 0.3, outputPer1M: 1.2 },
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
      maxConcurrent: 0,
      requestsPerMinute: 0,
      minRequestSpacingMs: 0,
      stream: false,
      enabled: true,
    },
  } as unknown as ModelTarget;
}

const minimax = bareTarget('minimax-m3');

/** A RoutingContext carrying a specific stats registry, for scoring assertions. */
function contextFor(complexity: number, stats: TargetStatsRegistry): RoutingContext {
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
    estimatedCost: () => 0.001,
    freeSlots: () => Number.POSITIVE_INFINITY,
    inFlight: () => 0,
    load: () => 0,
    sequence: 0,
    options: {},
  };
}

describe('recovery', () => {
  it('lets a failure streak fade once nothing has been sent for a while', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 5; i += 1) stats.recordFailure(minimax.key);

    const fresh = scoreTargets([minimax], contextFor(0.5, stats))[0]!;
    // Rewind the clock past the decay window: the same five failures, older.
    stats.get(minimax.key).lastUsedAt = Date.now() - 120_000;
    const stale = scoreTargets([minimax], contextFor(0.5, stats))[0]!;

    expect(fresh.health).toBeLessThan(0.2);
    expect(stale.health).toBeGreaterThan(fresh.health);
  });

  it('forgets old failures once the window refills with successes', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 5; i += 1) stats.recordFailure(minimax.key);
    const broken = scoreTargets([minimax], contextFor(0.5, stats))[0]!;

    for (let i = 0; i < 10; i += 1) stats.recordSuccess(minimax.key, 1000, 0, 500);
    const healed = scoreTargets([minimax], contextFor(0.5, stats))[0]!;

    // The run-long ratio still says 5/15; the window says 0/10, and the window
    // is what the strategy reads.
    expect(stats.get(minimax.key).failures).toBe(5);
    expect(healed.health).toBeGreaterThan(broken.health + 0.5);
  });

  /**
   * The throughput half of the same problem, which had no recovery path at all.
   *
   * A slow window demotes a target, and being demoted is what stops the next
   * measurement arriving — so without a decay the first bad window a target
   * draws is the one it is judged on for the rest of the run.
   */
  it('lets a stale throughput measurement decay back to the profile prior', () => {
    const prior = profileFor('minimax-m3').priorThroughput;
    const stats = new TargetStatsRegistry();
    // Forty genuinely slow calls: 500 tokens in 20 seconds, 25 tok/s against a
    // profile that says a great deal more. Enough of them that the measurement,
    // not the prior, is what the term reports.
    for (let i = 0; i < 40; i += 1) stats.recordSuccess(minimax.key, 20_000, 0, 500);

    const fresh = scoreTargets([minimax], contextFor(0.5, stats))[0]!;
    expect(fresh.throughput).toBeLessThan(40);

    stats.get(minimax.key).lastUsedAt = Date.now() - 240_000;
    const stale = scoreTargets([minimax], contextFor(0.5, stats))[0]!;
    expect(stale.throughput).toBeCloseTo(prior, 0);
  });
});
