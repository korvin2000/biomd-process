import type { ModelTarget } from '../../../llm/types.js';
import {
  fittingFirst,
  recentFailureRate,
  recentThroughput,
  type RoutingContext,
  type RoutingStrategy,
} from '../../types.js';
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
 * Five inputs, four of them about the *target* and one about the *payload*:
 *
 *  - **throughput**, tokens/sec over the last few completed calls. A short
 *    window rather than the run average, because the question is who is fast
 *    now; and tokens rather than seconds, because seconds measure the document
 *    as much as the model.
 *  - **health**, the observed failure rate, with consecutive failures counted
 *    twice over — a target that has failed its last three calls is a different
 *    proposition from one that failed three calls out of a hundred.
 *  - **cost**, the estimate for this specific request.
 *  - **prose quality**, the deployment's own judgement of how well a model
 *    reads once it has finished. Nothing else here can see it, and without it
 *    a model that translates well and follows instructions badly has no way to
 *    win except by being rewarded for the second half.
 *  - **complexity** of the payload, from `request.signals.complexity`, matched
 *    against each model's `tolerance`.
 *
 * A target may also declare `maxComfortableTokens`, which is subtracted from
 * the result rather than blended into it: a metered free tier that answers the
 * long articles has spent on three documents what it could have spent on ten.
 *
 * The first four are combined into one quality score. Complexity does not join
 * that sum — it *bends* it, so a hard document moves work towards models that
 * hold structure together and a clean one lets price and speed decide. On a
 * corpus that is mostly clean, that means the tolerant model is held in reserve
 * for the documents that need it instead of being paid for throughout.
 *
 * ### What this deliberately keeps from `least-busy`
 *
 * Occupancy outranks the score rather than joining it. Scoring it would let a
 * high-quality target on a saturated endpoint outrank a good one on an idle
 * endpoint, and the caller would then queue behind everything already there —
 * the exact failure `least-busy` exists to prevent, re-introduced through the
 * back door. So load is the primary sort key and the score only ever separates
 * targets that are equally busy, which in practice means the ones sharing an
 * endpoint.
 */

/** How many observations it takes before live data outweighs the profile prior. */
const PRIOR_STRENGTH = 3;

/**
 * Weights of the four target-quality terms. Normalised, so only ratios matter.
 *
 * Fitted against `tests/adaptive.simulation.test.ts`, **averaged over five runs
 * per combination**, and that qualifier is the important part.
 *
 * The split is not a function of these constants. The strategy learns during a
 * run, so whichever target draws the first requests accumulates measured
 * throughput and pulls ahead, and task order under `run.concurrency` varies.
 * Ten harness runs at identical constants gave deepseek 73.7–85.9%, minimax-m3
 * 12.8–13.7% and minimax-m3-free 1.3–13.2%. A single run is a sample; fitting to
 * one is fitting noise, which is how an earlier calibration in this file came to
 * quote point values it could not reproduce.
 *
 * At these values the mean over five runs is roughly 63 / 21 / 16 against a
 * stated target of 65 / 25 / 10.
 */
const W_THROUGHPUT = 0.8;
const W_HEALTH = 1.8;
const W_COST = 1.2;
const W_PROSE = 0.8;

/**
 * How far complexity is allowed to bend the quality score.
 *
 * There is a safety ceiling on this constant, because the bend must never be
 * able to outvote a target that is failing *right now* — the hardest documents
 * in the corpus are exactly the ones a broken target answers worst. Worth
 * knowing two things about it.
 *
 * The first is that it is a *consequence* of the four weights rather than a
 * rule, so it moves whenever any of them does, silently. The comment here used
 * to state 0.85; the arithmetic, once run, put it at **0.658** — the healthy
 * target's margin was a third of what this file claimed.
 *
 * The second is that most of the danger came from a term that had no business
 * being in the comparison at all: a target with health 0 was still collecting
 * the *reward* half of its bend. Scaling that half by measured health (see
 * `scoreTargets`) removes it, and moves the ceiling to roughly **1.85** — where
 * what finally loses the comparison is the healthy low-tolerance target's own
 * penalty on a tangled document, which is a real statement rather than an
 * artefact. 0.43 now sits a factor of four under the bound instead of a factor
 * of one and a half, and `tests/adaptive.test.ts` pins the mechanism rather
 * than the number, so the next weight change cannot move it back unnoticed.
 *
 * Fitted on this corpus, averaged over ten harness runs.
 */
const COMPLEXITY_PULL = 0.7;

/**
 * The complexity a document has to beat to count as a hard one.
 *
 * The bend is centred here, and this used to be hard-coded to 0.5 — the midpoint
 * of the 0…1 scale, chosen because it is the midpoint of the *scale*. That is
 * not a fact about any corpus, and on this one it was quietly wrong: the median
 * document scores 0.24 and the mean 0.265, so measuring "above average" from 0.5
 * made roughly 93% of the corpus below average and handed the tolerant model a
 * penalty on nearly every document it saw. The complexity term was not
 * discriminating between documents; it was a blanket levy with a rebate for the
 * top 7%.
 *
 * Centring on what the corpus actually looks like restores the thing the term is
 * for — above this line the structure-holding model, below it the prose model —
 * and it is the constant to change when the corpus changes, which
 * `tools/simulate-adaptive.ts` prints the distribution for.
 *
 * Note that this is **not** the same quantity as `DEFAULT_PROFILE.tolerance`,
 * which is also 0.5 and is the neutral point of a different axis. They were the
 * same number by coincidence.
 */
const COMPLEXITY_MIDPOINT = 0.16;

/** A consecutive-failure streak counts this many times over against a target. */
const STREAK_PENALTY = 0.12;

/**
 * How long a failure streak keeps counting against a target that is not being
 * called.
 *
 * Without this the penalty is permanent: a streak only resets on a *success*,
 * and a target scored to the bottom of the chain never gets the request that
 * would produce one. The streak is the sharpest term in the score and it was
 * the one with no way out. Sixty seconds is twice the circuit breaker's
 * `resetAfterMs` default, so the breaker offers the half-open probe first and
 * this only matters for the failures that never opened a breaker at all —
 * `response_format` and friends, which by design count towards nothing.
 */
const STREAK_DECAY_MS = 60_000;

/** Most a short window may claim over a target's historical throughput. */
const OUTLIER_CEILING = 3;

/**
 * How large a speed difference is still, most likely, the provider lottery.
 *
 * The other three terms compare properties of a *model*. Speed on openrouter is
 * not one: a model id there is served by dozens of providers at once, one
 * managing ten tokens a second while another does a hundred, and the population
 * drifts with the time of day. Two identical models measured over four calls
 * each can differ threefold for no reason that will still be true in a minute.
 *
 * So this term is scored through a knee rather than in proportion, and the knee
 * is placed at the noise floor. Inside {@link SPEED_TOLERANCE} a difference
 * costs {@link SPEED_TOLERANCE_PENALTY} at most — enough to break a tie, not
 * enough to overturn a quality judgement. Beyond it the difference is more
 * likely to be real, and the remaining score is spent over the octaves up to
 * {@link SPEED_FULL_PENALTY_RATIO}.
 *
 * `v / max` — what this used to be, and what the other three terms still are —
 * has the response backwards for that job. It is steepest exactly where the
 * measurement is least trustworthy: a 2.5x reading costs 0.6 of the term, and
 * going on to 3.5x costs only 0.11 more, so the strategy reacted hardest to the
 * differences most likely to be noise and had almost nothing left to say about
 * the ones that were not.
 *
 * The band is set from the harness's own `SPREAD`: +-55% per call on an
 * openrouter id means two identical targets can read as far apart as 3.4x on a
 * bad pair of draws.
 */
const SPEED_TOLERANCE = 3.0;

/** What a target exactly {@link SPEED_TOLERANCE} times slower gives up, 0…1. */
const SPEED_TOLERANCE_PENALTY = 0.06;

/** Speed ratio at which this term is spent entirely and the score reaches 0. */
const SPEED_FULL_PENALTY_RATIO = 8;

/**
 * How long a throughput measurement keeps counting for a target that is not
 * being called.
 *
 * The window only refills for a target that is *getting* work, so a slow window
 * is self-sealing: it pushes the target down the chain, and being down the
 * chain is what stops the next measurement arriving. Health has two ways out of
 * that trap and throughput had none.
 *
 * Decaying towards the prior rather than to nothing, so what expires is the
 * *evidence*, not the target — after two idle minutes it is scored on its
 * profile again and gets another turn, which is the same shape as the circuit
 * breaker's half-open probe. Twice `STREAK_DECAY_MS`, because a measurement
 * goes stale more slowly than a failure does.
 */
const THROUGHPUT_DECAY_MS = 120_000;

/**
 * Head start given to a target this run has not measured yet, decaying as it
 * accumulates observations.
 *
 * Without it the strategy is self-confirming and the first request decides the
 * run. That is not a hypothetical: on a live 96-task run deepseek's opening
 * call returned 2874 tokens in 5.3 seconds — 539 tokens/sec against a profile
 * that predicted 120 — and from that moment it out-scored a pool-mate which
 * had never been called at all and therefore had nothing but its profile to
 * argue with. Final tally 51-0. The untested model was not rejected on
 * evidence; it was rejected for having none.
 *
 * A measured target is a known quantity and an unmeasured one is a question, so
 * the bonus is a statement about *uncertainty* rather than about quality. At
 * `n = 0` it is paid in full, by the fourth call it is a fifth of that, and by
 * the tenth it has effectively gone — long before it could distort a split.
 */
const EXPLORATION_BONUS = 0.3;

/**
 * Worst the size penalty can get, for a target that declares a comfortable
 * ceiling and is handed something well past it.
 *
 * Large enough to move such a target off the head of the chain on the documents
 * it should not be spending its allowance on, and bounded so it stays a
 * preference: the target remains in the chain and still catches a failure above
 * it. Reached at twice the declared ceiling.
 */
const OVERSIZE_PENALTY = 0.35;

/**
 * The six constants a calibration would ever sweep, in one object.
 *
 * They are compile-time in production — {@link DEFAULT_TUNING} is what
 * `adaptive` runs and nothing in `biomd.config.yaml` reaches it — and a
 * parameter here only so that a calibration tool can drive the **real** scoring
 * function instead of a copy of it. `tools/calibrate-adaptive.ts` used to hold
 * its own transcription of the arithmetic below, with a comment admitting the
 * transcription could drift; it had, and a constant fitted against a formula the
 * router does not run is a number about nothing.
 *
 * The rest of the constants in this file are structural rather than fitted —
 * how long evidence survives, how far a single window may overreach — and
 * turning them is a design change, not a calibration.
 */
export interface AdaptiveTuning {
  throughput: number;
  health: number;
  cost: number;
  prose: number;
  complexityPull: number;
  /** Complexity above which a document counts as hard. See {@link COMPLEXITY_MIDPOINT}. */
  complexityMidpoint: number;
  explorationBonus: number;
  /** Speed ratio still inside the provider lottery. See {@link SPEED_TOLERANCE}. */
  speedTolerance: number;
  /** What a target exactly `speedTolerance` times slower gives up, 0…1. */
  speedTolerancePenalty: number;
  /** Speed ratio at which the term is spent entirely. */
  speedFullPenaltyRatio: number;
}

export const DEFAULT_TUNING: AdaptiveTuning = Object.freeze({
  throughput: W_THROUGHPUT,
  health: W_HEALTH,
  cost: W_COST,
  prose: W_PROSE,
  complexityPull: COMPLEXITY_PULL,
  complexityMidpoint: COMPLEXITY_MIDPOINT,
  explorationBonus: EXPLORATION_BONUS,
  speedTolerance: SPEED_TOLERANCE,
  speedTolerancePenalty: SPEED_TOLERANCE_PENALTY,
  speedFullPenaltyRatio: SPEED_FULL_PENALTY_RATIO,
});

export interface TargetScore {
  target: ModelTarget;
  score: number;
  throughput: number;
  health: number;
  cost: number;
  tolerance: number;
  prose: number;
  /** Penalty already subtracted for exceeding a declared size ceiling. */
  oversize: number;
  /** Uncertainty bonus already added; decays towards zero as the target is used. */
  explore: number;
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
  let max = -Infinity;
  for (const value of values) if (value > max) max = value;
  // Nothing to rank on: every candidate is identical (all free, all perfectly
  // healthy), so the term abstains rather than inventing an order.
  if (!Number.isFinite(max) || max <= 0) return values.map(() => 0.5);
  if (higherIsBetter) return values.map((value) => clamp01(value / max));
  // The mirror of the branch above, and deliberately *not* `min / value`, which
  // is the obvious lower-is-better analogue and fails on the one case this pool
  // always contains. When the cheapest candidate is free, `min` is zero, every
  // paid target's score collapses onto whatever floor is used to avoid dividing
  // by it, and two targets four times apart in price become indistinguishable.
  // Measured on the real translate pool: the deepseek-to-minimax gap on this
  // term was 0.82 with the free tier out of the pool and 0.045 with it in — an
  // eighteen-fold change in a comparison the free tier is not part of. Which is
  // exactly the magnitude-destroying behaviour of min-max, arriving by a
  // different route.
  //
  // Anchoring on `max` keeps the term a property of the pair being compared.
  // The price of it is that the dearest candidate always scores 0 and one very
  // expensive outlier compresses everyone else towards 1; that is the better
  // failure, because a pool with a free member is this deployment's normal
  // case and a pool with a tenfold outlier is not.
  return values.map((value) => clamp01(1 - value / max));
}

/**
 * Speed against the fastest candidate, through the knee described at
 * {@link SPEED_TOLERANCE}.
 *
 * Piecewise-linear in **octaves** rather than in the ratio, because a speed
 * difference is naturally multiplicative: "twice as slow" is one step whether it
 * happens at 40 tok/s or at 400. The two segments are a gentle slope inside the
 * lottery band and a steep one outside it, and both are stated as *what the
 * target gives up* so the constants can be read without doing the arithmetic.
 */
function speedScores(values: readonly number[], tuning: AdaptiveTuning): number[] {
  let max = -Infinity;
  for (const value of values) if (value > max) max = value;
  if (!Number.isFinite(max) || max <= 0) return values.map(() => 0.5);

  // Guard the logs: a tolerance of 1 or below has no band, and a full-penalty
  // ratio at or under the tolerance has no second segment.
  const knee = Math.log2(Math.max(1.0001, tuning.speedTolerance));
  const tail = Math.max(1e-6, Math.log2(Math.max(tuning.speedFullPenaltyRatio, tuning.speedTolerance * 1.0001)) - knee);
  const insideSlope = clamp01(tuning.speedTolerancePenalty) / knee;
  const outsideSlope = (1 - clamp01(tuning.speedTolerancePenalty)) / tail;

  return values.map((value) => {
    if (!(value > 0)) return 0;
    const octavesBehind = Math.log2(max / value);
    const inside = Math.min(octavesBehind, knee);
    const outside = Math.max(0, octavesBehind - knee);
    return clamp01(1 - inside * insideSlope - outside * outsideSlope);
  });
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
export function scoreTargets(
  candidates: readonly ModelTarget[],
  context: RoutingContext,
  tuning: AdaptiveTuning = DEFAULT_TUNING,
): TargetScore[] {
  const complexity = complexityOfRequest(context);
  // Read once, so every candidate in one ranking is judged against the same
  // instant. Two clock reads inside the loop would let the targets scored later
  // decay a fraction more than the ones scored first, which is a tie-break
  // nobody chose.
  const now = Date.now();

  const rows = candidates.map((target) => {
    const profile = profileFor(target.modelId);
    const stats = context.stats(target.key);

    // How long since anything was sent here at all. Both time-decayed terms
    // read it: a measurement and a failure streak are each a claim about *now*,
    // and each stops being one when nothing has been asked for a while.
    const idleMs = stats.lastUsedAt > 0 ? Math.max(0, now - stats.lastUsedAt) : 0;

    // The **window** supplies the estimate, because it forgets; the cumulative
    // **success count** supplies the confidence, because forty clean calls are
    // better evidence than four however short the window is. That is the same
    // split the health term makes below, and it was missing here: weighting by
    // `recent.length` caps confidence at `RECENT_WINDOW`, which leaves the
    // prior holding 3/7 of this term for the entire run however much evidence
    // arrives. Measured on the real numbers, a target sustaining 200 tok/s
    // against a prior of 81 read as 149, and one sustaining 40 against a prior
    // of 127 read as 77 — a 5:1 speed difference scored as 1.9:1. These priors
    // are hand-derived from a few hundred calls; a measurement that can never
    // overrule them is not a measurement.
    const measured = recentThroughput(stats);
    const throughput = shrink(
      // A four-call window is short enough that one tiny prompt answered
      // instantly reads as a hundredfold speed-up, and no amount of shrinkage
      // absorbs an outlier that size. Capped before the blend rather than
      // after, so the ceiling bounds what the *window* is allowed to claim
      // instead of silently re-weighting the prior underneath it.
      measured === undefined
        ? profile.priorThroughput
        : Math.min(measured, profile.priorThroughput * OUTLIER_CEILING),
      profile.priorThroughput,
      // Confidence fades with the evidence: see {@link THROUGHPUT_DECAY_MS}.
      measured === undefined ? 0 : stats.successes * Math.max(0, 1 - idleMs / THROUGHPUT_DECAY_MS),
    );

    // The window, not the run-long ratio: five failures in the first minute of
    // an hour-long run is a claim about that minute. See `TargetStats.outcomes`.
    // Two different quantities, and using one for both was a mistake worth
    // recording: the **window** supplies the estimate, because it forgets; the
    // **cumulative count** supplies the confidence, because two hundred clean
    // calls are better evidence than ten however short the window is. Weighting
    // by the window length instead capped every target's certainty at ten
    // observations, flattened the health term until it no longer separated
    // anyone, and handed the decision to cost — where a free tier wins
    // absolutely. Its share went from 5% to 24% on nothing but that.
    const windowed = recentFailureRate(stats);
    const observedFailure = windowed ?? profile.priorFailureRate;
    const failureRate = shrink(observedFailure, profile.priorFailureRate, stats.requests);
    // A streak is evidence about *now* in a way a run-long ratio is not — and
    // it stops being about now once nothing has been sent for a while, so it
    // fades rather than standing until a success that will never be attempted.
    const streak = stats.consecutiveFailures * Math.max(0, 1 - idleMs / STREAK_DECAY_MS);
    const health = 1 - Math.min(1, failureRate + streak * STREAK_PENALTY);

    // Ramps from nothing at the declared ceiling to the full penalty at twice
    // it, so a document just over the line is barely discouraged and one far
    // past it clearly is.
    const ceiling = profile.maxComfortableTokens;
    const oversize = ceiling
      ? OVERSIZE_PENALTY * clamp01(context.request.estimatedInputTokens / ceiling - 1)
      : 0;

    // Optimism proportional to ignorance: full at zero observations, gone by
    // roughly ten. `requests` and not `recent.length`, so a target that has
    // only ever failed stops being explored too.
    const explore = tuning.explorationBonus / (1 + stats.requests);

    return {
      target,
      throughput,
      health,
      explore,
      cost: context.estimatedCost(target),
      tolerance: profile.tolerance,
      prose: profile.proseQuality,
      oversize,
    };
  });

  // Speed alone is scored through a knee rather than in proportion; the other
  // three terms describe the model rather than whichever host answered.
  const throughputScores = speedScores(
    rows.map((row) => row.throughput),
    tuning,
  );
  const healthScores = proportional(
    rows.map((row) => row.health),
    true,
  );
  const costScores = proportional(
    rows.map((row) => row.cost),
    false,
  );
  const proseScores = proportional(
    rows.map((row) => row.prose),
    true,
  );
  const totalWeight = tuning.throughput + tuning.health + tuning.cost + tuning.prose;

  const scored = rows.map((row, index): TargetScore => {
    const quality =
      (throughputScores[index]! * tuning.throughput +
        healthScores[index]! * tuning.health +
        costScores[index]! * tuning.cost +
        proseScores[index]! * tuning.prose) /
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
    let bend =
      complexity === undefined
        ? 0
        : tuning.complexityPull *
          (complexity - tuning.complexityMidpoint) *
          2 *
          (row.tolerance - DEFAULT_PROFILE.tolerance);

    // Fragility is never a merit. Below the neutral tolerance the symmetric
    // form above turns into a *bonus* on clean documents — the model is being
    // credited for breaking easily — and that is not a preference anybody
    // holds. Whatever such a model is genuinely good at belongs in
    // `proseQuality`, which is a term of its own; here the bend can only ever
    // cost it something on documents it cannot hold together.
    if (row.tolerance < DEFAULT_PROFILE.tolerance) bend = Math.min(0, bend);

    // Tolerance is a claim about a model that is *working*, so the reward half
    // of the bend is worth what the target's health says it is worth. Without
    // this a target that had failed its last six calls — health driven to
    // literally 0 — still banked the full "this document needs my tolerance"
    // bonus, and that is what set the ceiling on `COMPLEXITY_PULL`: it put the
    // margin at 0.658 rather than the 0.85 this file claimed, and moved it
    // again on every weight change. Gating it here costs nothing in normal
    // operation — `healthScores` is proportional, so the healthiest candidate
    // is exactly 1 and a pool of working targets sits within a percent of it —
    // and buys back a factor of three in the safety margin.
    //
    // The reward half only. Softening a *penalty* for a broken target would
    // make brokenness pay on clean documents, which is the fragility bug above
    // wearing a different hat.
    if (bend > 0) bend *= healthScores[index]!;

    return { ...row, score: quality + bend + row.explore - row.oversize };
  });

  return scored.sort((a, b) => b.score - a.score || a.cost - b.cost || b.target.weight - a.target.weight);
}

/**
 * The strategy at one set of constants.
 *
 * `adaptive` is this at {@link DEFAULT_TUNING}. A calibration registers other
 * instances under the same id to sweep a constant end to end — see
 * `tools/calibrate-adaptive.ts` — which is the only way to fit one against the
 * real scheduler rather than against a static preference map.
 */
export function adaptiveWith(tuning: AdaptiveTuning, id = 'adaptive'): RoutingStrategy {
  return {
    id,
    description:
      'Measured throughput, health and cost among the least-loaded targets, bent by payload complexity.',
    select(context) {
      const candidates = [...context.candidates];
      if (candidates.length <= 1) return fittingFirst(candidates, context);

      // Occupancy is the primary key and the score is the secondary one, applied
      // at **every** load level rather than only at the emptiest.
      //
      // The first version of this scored the least-loaded tier and left the rest
      // in `least-busy` order — load, then cost. That reads as a conservative
      // choice and is in fact a way of switching the strategy off. Models sharing
      // an endpoint always share a load value, so a pool spread over three
      // endpoints puts two thirds of itself in that remainder at any moment, and
      // there they were ranked by price alone: the cheapest openrouter model took
      // every openrouter request, whatever the document looked like. A live run
      // over 96 tasks went 49-0-0 across the three of them before this changed.
      //
      // Ordering by load first keeps the property that matters — an emptier
      // endpoint is still always preferred, so nobody queues behind a full one
      // while another sits idle — and lets the score decide among equals, which
      // is the only comparison it was ever meant to make.
      const score = new Map<string, number>();
      for (const row of scoreTargets(candidates, context, tuning)) score.set(row.target.key, row.score);

      const ranked = candidates.sort(
        (a, b) =>
          context.load(a) - context.load(b) ||
          (score.get(b.key) ?? 0) - (score.get(a.key) ?? 0) ||
          b.weight - a.weight,
      );
      return fittingFirst(ranked, context);
    },
  };
}

export const adaptive: RoutingStrategy = adaptiveWith(DEFAULT_TUNING);
