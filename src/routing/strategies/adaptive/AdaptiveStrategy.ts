import type { ModelTarget } from '../../../llm/types.js';
import { fittingFirst, recentThroughput, type RoutingContext, type RoutingStrategy } from '../../types.js';
import { DEFAULT_PROFILE, profileFor } from './ModelProfiles.js';

/**
 * Rank on measured behaviour rather than on one declared number.
 *
 * `cost-optimized` ranks on the price list and `least-busy` on queue depth, and
 * each is right about the thing it looks at. This one is for the case where
 * neither is: several models that could all serve the request, differing in
 * ways the config cannot state — one is quick but loses track of structure, one
 * is slower and never does, one costs nothing until it rate-limits.
 *
 * Four inputs, three of them about the *target* and one about the *payload*:
 *
 *  - **throughput**, tokens/sec over the last few completed calls. A short
 *    window rather than the run average, because the question is who is fast
 *    now; and tokens rather than seconds, because seconds measure the document
 *    as much as the model.
 *  - **health**, the observed failure rate, with consecutive failures counted
 *    twice over — a target that has failed its last three calls is a different
 *    proposition from one that failed three calls out of a hundred.
 *  - **cost**, the estimate for this specific request.
 *  - **complexity** of the payload, from `request.signals.complexity`, matched
 *    against each model's `tolerance`.
 *
 * The first three are combined into one quality score. Complexity does not join
 * that sum — it *bends* it, so a hard document moves work towards models that
 * hold structure together and a clean one lets price and speed decide. On a
 * corpus that is mostly clean, that means the tolerant model is held in reserve
 * for the documents that need it instead of being paid for throughout.
 *
 * ### What this deliberately keeps from `least-busy`
 *
 * Occupancy stays a **gate**, not a term. Scoring it would let a high-quality
 * target on a saturated endpoint outrank a good one on an idle endpoint, and
 * the caller would then queue behind everything already there — the exact
 * failure `least-busy` exists to prevent, re-introduced through the back door.
 * So the ranking happens *within* the least-loaded tier and the rest of the
 * pool keeps its order behind it.
 */

/** How many observations it takes before live data outweighs the profile prior. */
const PRIOR_STRENGTH = 3;

/** Weights of the three target-quality terms. Normalised, so only ratios matter. */
const W_THROUGHPUT = 1.0;
const W_HEALTH = 1.5;
const W_COST = 0.5;

/**
 * How far complexity is allowed to bend the quality score.
 *
 * At 0.7 a maximally tolerant model gains up to 0.35 on a maximally tangled
 * document — enough to overturn a moderate quality gap, not enough to hand the
 * work to something that is failing outright.
 */
const COMPLEXITY_PULL = 0.9;

/** A consecutive-failure streak counts this many times over against a target. */
const STREAK_PENALTY = 0.12;

/** Most a short window may claim over a target's historical throughput. */
const OUTLIER_CEILING = 3;

export interface TargetScore {
  target: ModelTarget;
  score: number;
  throughput: number;
  health: number;
  cost: number;
  tolerance: number;
}

/**
 * Blend an observation with its prior, weighted by how much evidence there is.
 *
 * The alternative — trusting live data immediately — hands the corpus to
 * whichever target happened to draw the first short document, on a sample of
 * one. This decays that: at `n = 0` the prior stands, and by `n = 12` it is
 * contributing a fifth.
 */
function shrink(observed: number, prior: number, observations: number): number {
  if (observations <= 0) return prior;
  return (observations * observed + PRIOR_STRENGTH * prior) / (observations + PRIOR_STRENGTH);
}

/**
 * Rescale a set of raw values onto 0…1, best first, **in proportion**.
 *
 * The obvious implementation is min-max — best gets 1, worst gets 0 — and it is
 * wrong here, for a reason worth stating because it is not visible until the
 * numbers are real. Min-max reports only the *ordering* and throws away the
 * *magnitude*: two targets failing 4.7% and 1.8% of the time are three
 * percentage points apart, and min-max hands one a 1 and the other a 0, exactly
 * as if one never worked at all. Every difference gets stretched to fill the
 * scale, so the smaller and noisier it is, the more it is amplified.
 *
 * Ratios keep the distance. `0.71` against `1.0` says "about a third slower",
 * which is what it is, and a term whose candidates genuinely barely differ
 * quietly stops affecting the ranking instead of dominating it by accident.
 */
function proportional(values: readonly number[], higherIsBetter: boolean): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return values.map(() => 0.5);
  if (higherIsBetter) return values.map((value) => clamp01(value / max));
  // A floor keeps a free target from making every paid one exactly zero, which
  // would turn "costs nothing" into a veto rather than an advantage.
  const floor = max / 100;
  return values.map((value) => clamp01((min + floor) / (value + floor)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function complexityOfRequest(context: RoutingContext): number | undefined {
  const raw = context.request.signals?.['complexity'];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}

/**
 * Score every candidate, best first. Exported so a test — and `biomd models` —
 * can show the arithmetic rather than only its conclusion.
 */
export function scoreTargets(candidates: readonly ModelTarget[], context: RoutingContext): TargetScore[] {
  const complexity = complexityOfRequest(context);

  const rows = candidates.map((target) => {
    const profile = profileFor(target.modelId);
    const stats = context.stats(target.key);

    const measured = recentThroughput(stats);
    const throughput = Math.min(
      shrink(
        measured ?? profile.priorThroughput,
        profile.priorThroughput,
        measured === undefined ? 0 : stats.recent.length,
      ),
      // A four-call window is short enough that one tiny prompt answered
      // instantly reads as a hundredfold speed-up. Shrinkage alone cannot
      // absorb an outlier that size, so the window is not allowed to claim
      // more than this multiple of what the target has historically done.
      profile.priorThroughput * OUTLIER_CEILING,
    );

    const observedFailure = stats.requests > 0 ? stats.failures / stats.requests : profile.priorFailureRate;
    const failureRate = shrink(observedFailure, profile.priorFailureRate, stats.requests);
    // A streak is evidence about *now* in a way a run-long ratio is not, and it
    // is what the circuit breaker is still counting towards its threshold.
    const health = 1 - Math.min(1, failureRate + stats.consecutiveFailures * STREAK_PENALTY);

    return { target, throughput, health, cost: context.estimatedCost(target), tolerance: profile.tolerance };
  });

  const throughputScores = proportional(rows.map((row) => row.throughput), true);
  const healthScores = proportional(rows.map((row) => row.health), true);
  const costScores = proportional(rows.map((row) => row.cost), false);
  const totalWeight = W_THROUGHPUT + W_HEALTH + W_COST;

  const scored = rows.map((row, index): TargetScore => {
    const quality =
      (throughputScores[index]! * W_THROUGHPUT +
        healthScores[index]! * W_HEALTH +
        costScores[index]! * W_COST) /
      totalWeight;

    // Centred on **both** axes, and the complexity half is the one that is easy
    // to get wrong. Scaling straight from `complexity` — 0 at the clean end —
    // means a clean document applies no bend at all, so "simple text should go
    // to the cheap model" never actually happens: the ranking just falls back
    // to whatever the quality score said, which is the outcome this exists to
    // change. Measuring from the midpoint instead makes the statement
    // symmetric, and it is the honest reading of `tolerance`: robustness that a
    // clean document cannot use is capacity being paid for and wasted.
    //
    // Centred on the profile axis too, so an uncharacterised model — which sits
    // exactly at the neutral tolerance — is never bent in either direction, and
    // keeps the position its own measurements earned.
    const bend =
      complexity === undefined
        ? 0
        : COMPLEXITY_PULL * (complexity - 0.5) * 2 * (row.tolerance - DEFAULT_PROFILE.tolerance);

    return { ...row, score: quality + bend };
  });

  return scored.sort((a, b) => b.score - a.score || a.cost - b.cost || b.target.weight - a.target.weight);
}

export const adaptive: RoutingStrategy = {
  id: 'adaptive',
  description:
    'Measured throughput, health and cost among the least-loaded targets, bent by payload complexity.',
  select(context) {
    const candidates = [...context.candidates];
    if (candidates.length <= 1) return fittingFirst(candidates, context);

    // Occupancy first and as a gate: rank only among the emptiest endpoints,
    // and leave everything busier in least-busy order behind them.
    let minLoad = Infinity;
    for (const target of candidates) {
      const load = context.load(target);
      if (load < minLoad) minLoad = load;
    }
    const idle = candidates.filter((target) => context.load(target) === minLoad);
    const busy = candidates
      .filter((target) => context.load(target) !== minLoad)
      .sort((a, b) => context.load(a) - context.load(b) || context.estimatedCost(a) - context.estimatedCost(b));

    const ranked = scoreTargets(idle, context).map((row) => row.target);
    return fittingFirst([...ranked, ...busy], context);
  },
};
