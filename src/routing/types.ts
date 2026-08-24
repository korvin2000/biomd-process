import type { Capability } from '../config/schema.js';
import type { ModelTarget } from '../llm/types.js';

export interface TargetStats {
  key: string;
  requests: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  totalLatencyMs: number;
  costUsd: number;
  lastUsedAt: number;
}

export interface RoutingRequest {
  /** Task type asking for a model — lets custom strategies specialize. */
  pipeline: string;
  /** Routing pool this request draws from; `default` when omitted. */
  pool?: string;
  /**
   * The task's variant, which for `translate` and `localize` is the **target
   * language**. It is what `llm.routing.pools.<pool>.prefer` keys on: "render
   * Chinese with the Chinese model" is a statement about the language, and the
   * language is the only thing here that knows it.
   */
  variant?: string;
  /**
   * Targets a previous attempt at this same task already used.
   *
   * Set by the orchestrator's task-level fallback and by nothing else. They are
   * demoted rather than removed — see {@link Router.applyAvoidance}.
   */
  avoid?: ReadonlySet<string>;
  /** Strategy override for this one call; falls back to the pool's own. */
  strategy?: string;
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  requiredCapabilities: readonly Capability[];
}

/**
 * Read-only view of who is busy, for strategies that balance load.
 *
 * Deliberately narrow: a strategy may *observe* occupancy and must never change
 * it. The claim that makes a decision real is the gateway's, taken in the same
 * tick as the ranking.
 */
export interface OccupancyView {
  /** Free concurrent slots this pool has on the target's endpoint; `Infinity` when uncapped. */
  freeSlots(pool: string | undefined, target: ModelTarget): number;
  /** Logical calls this pool already has in flight on the target's endpoint. */
  inFlight(pool: string | undefined, target: ModelTarget): number;
  /** How full that endpoint is for this pool, as a fraction: 0 idle, 1 full. */
  load(pool: string | undefined, target: ModelTarget): number;
}

export interface RoutingContext {
  /** Capability-filtered pool members, in declaration order. */
  readonly candidates: readonly ModelTarget[];
  readonly request: RoutingRequest;
  /** Live per-target counters. */
  stats(key: string): TargetStats;
  /**
   * True when the target can both *hold* the request and *emit* the answer it
   * expects.
   *
   * Both halves matter, and only the first used to be checked: a 64K window with
   * an 8K output ceiling accepts a long article without complaint and then cuts
   * its translation off mid-sentence. That failure looks nothing like an
   * overflow — the prompt fit perfectly — so it has to be predicted from
   * `maxOutputTokens` rather than discovered from the response.
   */
  fits(target: ModelTarget): boolean;
  /** Usable input tokens left over after the request would be placed. Negative = overflow. */
  headroom(target: ModelTarget): number;
  /** Output tokens left over after the expected answer. Negative = the answer gets cut off. */
  outputHeadroom(target: ModelTarget): number;
  /** Estimated USD cost of this request on this target. */
  estimatedCost(target: ModelTarget): number;
  /**
   * Concurrent slots this request's pool still has free on the target's
   * endpoint — `Infinity` when nothing caps it, 0 when the endpoint (or this
   * pool's lane on it) is already full.
   *
   * The signal a load-spreading strategy ranks on: a free endpoint that costs a
   * little is worth more than a busy one that is free of charge, because the
   * busy one is not a price, it is a queue.
   */
  freeSlots(target: ModelTarget): number;
  /** Requests this pool already has in flight on the target's endpoint. */
  inFlight(target: ModelTarget): number;
  /**
   * How full the target's endpoint is for this pool: `0` idle, `1` full, and
   * always `0` when nothing caps it.
   *
   * The **fraction**, not the count, is what balances load. An endpoint that
   * allows three parallel requests has three free slots while it is idle and an
   * endpoint that allows one has one — ranking on that number alone hands the
   * generous endpoint every request from the very first one, which is the
   * imbalance a spreading strategy exists to prevent. As a proportion of what
   * each endpoint can hold, an idle endpoint is an idle endpoint.
   */
  load(target: ModelTarget): number;
  /** Monotonic per-run counter; the basis for round-robin. */
  readonly sequence: number;
  /** `llm.routing.options` — strategy-specific knobs. */
  readonly options: Record<string, unknown>;
}

/**
 * Ranks candidate targets, best first. A strategy is pure: it never performs a
 * call, mutates stats, or knows about retries. The gateway walks the returned
 * list as its fallback chain.
 */
export interface RoutingStrategy {
  readonly id: string;
  readonly description: string;
  select(context: RoutingContext): ModelTarget[];
}

export function emptyStats(key: string): TargetStats {
  return {
    key,
    requests: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    totalLatencyMs: 0,
    costUsd: 0,
    lastUsedAt: 0,
  };
}

/**
 * Shared final ordering rule: anything that cannot serve the request is pushed
 * behind everything that can, no matter what the strategy thinks — a call that
 * certainly overflows is never the best first choice.
 */
export function fittingFirst(targets: ModelTarget[], context: RoutingContext): ModelTarget[] {
  const fitting = targets.filter((target) => context.fits(target));
  const overflowing = targets.filter((target) => !context.fits(target));
  overflowing.sort((a, b) => slackOf(context, b) - slackOf(context, a));
  return [...fitting, ...overflowing];
}

/**
 * The binding constraint, in tokens: whichever of the two windows runs out
 * first. Negative means the target cannot serve the request, and how negative
 * says by how much — which is the only sensible order for a list of targets that
 * all fail, and the basis for picking the least-bad one when none fit.
 */
export function slackOf(context: RoutingContext, target: ModelTarget): number {
  return Math.min(context.headroom(target), context.outputHeadroom(target));
}
