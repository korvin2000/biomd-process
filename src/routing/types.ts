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
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  requiredCapabilities: readonly Capability[];
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
