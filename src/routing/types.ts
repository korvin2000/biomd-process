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
  /** True when the request's estimated input fits the target's usable window. */
  fits(target: ModelTarget): boolean;
  /** Usable input tokens left over after the request would be placed. Negative = overflow. */
  headroom(target: ModelTarget): number;
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
 * Shared final ordering rule: anything that cannot hold the request is pushed
 * behind everything that can, no matter what the strategy thinks — a call that
 * certainly overflows is never the best first choice.
 */
export function fittingFirst(targets: ModelTarget[], context: RoutingContext): ModelTarget[] {
  const fitting = targets.filter((target) => context.fits(target));
  const overflowing = targets.filter((target) => !context.fits(target));
  overflowing.sort((a, b) => context.headroom(b) - context.headroom(a));
  return [...fitting, ...overflowing];
}
