import type { ModelTarget } from '../../llm/types.js';
import { fittingFirst, type RoutingContext, type RoutingStrategy } from '../types.js';

/**
 * Cheapest first.
 *
 * The default, and the one that pays for itself on a large corpus: combined with
 * fallback, a run tries the cheap model on every document and only escalates the
 * ones it fails on.
 */
export const costOptimized: RoutingStrategy = {
  id: 'cost-optimized',
  description: 'Cheapest target that fits the request, escalating on failure.',
  select(context) {
    const ranked = [...context.candidates].sort(
      (a, b) => context.estimatedCost(a) - context.estimatedCost(b) || b.weight - a.weight,
    );
    return fittingFirst(ranked, context);
  },
};

/**
 * Most headroom first.
 *
 * For corpora with long documents, where a retry caused by an overflow costs
 * more than the wider model would have.
 */
export const contextOptimized: RoutingStrategy = {
  id: 'context-optimized',
  description: 'Target with the most context headroom for this request.',
  select(context) {
    return [...context.candidates].sort(
      (a, b) => context.headroom(b) - context.headroom(a) || context.estimatedCost(a) - context.estimatedCost(b),
    );
  },
};

/**
 * Declaration order — primary, then fallbacks.
 *
 * The predictable choice when a pool encodes an explicit preference
 * ("the good model, and the cheap one only if it is down").
 */
export const sequential: RoutingStrategy = {
  id: 'sequential',
  description: 'Pool order as declared: first entry is primary, the rest are fallbacks.',
  select(context) {
    return fittingFirst([...context.candidates], context);
  },
};

/**
 * Spread load across the pool.
 *
 * Useful against several equivalent local workers, or to stay under a
 * per-key rate limit by using several keys.
 */
export const roundRobin: RoutingStrategy = {
  id: 'round-robin',
  description: 'Rotate through the pool to spread load across equivalent targets.',
  select(context) {
    const pool = [...context.candidates];
    if (pool.length <= 1) return pool;
    const offset = context.sequence % pool.length;
    return fittingFirst([...pool.slice(offset), ...pool.slice(0, offset)], context);
  },
};

/**
 * Fewest recent failures first — a health-aware complement to the circuit
 * breaker, which only reacts once a target is already broken.
 */
export const leastFailures: RoutingStrategy = {
  id: 'least-failures',
  description: 'Prefer targets with the fewest consecutive failures, then the cheapest.',
  select(context) {
    const ranked = [...context.candidates].sort((a, b) => {
      const health = context.stats(a.key).consecutiveFailures - context.stats(b.key).consecutiveFailures;
      return health || context.estimatedCost(a) - context.estimatedCost(b);
    });
    return fittingFirst(ranked, context);
  },
};

/**
 * Spread the work: the emptiest endpoint first, the cheapest among equals.
 *
 * The strategy for a stage whose scarce resource is **time** rather than money.
 * `cost-optimized` ranks the free local model first for every request, which is
 * right about price and, on a corpus of a thousand translations, disastrous
 * about throughput: every task queues behind an endpoint that serves one
 * request at a time while two other endpoints sit idle. Occupancy is what tells
 * the two situations apart — a target with room answers now, a target without
 * it answers after everything already queued on it.
 *
 * It ranks on **how full** each endpoint is, not on how many slots it has left,
 * and the difference is the whole point. An endpoint that allows three parallel
 * requests has three free slots while idle and an endpoint that allows one has
 * one; ranking on the count would hand the generous endpoint every request from
 * the first one onwards, which is precisely the imbalance this exists to
 * prevent. As a fraction of what each can hold, idle is idle, and the tie is
 * broken by cost — so an untouched pool behaves exactly like `cost-optimized`
 * and only starts to differ once something is actually busy.
 *
 * The companion setting is `llm.routing.pools.<pool>.maxConcurrent`: an
 * endpoint's own limit is what the provider tolerates, and a lane is this
 * pool's share of it.
 */
export const leastBusy: RoutingStrategy = {
  id: 'least-busy',
  description: 'Spread load: emptiest endpoint first (as a fraction of its capacity), cheapest as the tie-break.',
  select(context) {
    const ranked = [...context.candidates].sort(
      (a, b) =>
        context.load(a) - context.load(b) ||
        context.estimatedCost(a) - context.estimatedCost(b) ||
        b.weight - a.weight,
    );
    return fittingFirst(ranked, context);
  },
};

export const builtinStrategies: readonly RoutingStrategy[] = [
  costOptimized,
  contextOptimized,
  sequential,
  roundRobin,
  leastFailures,
  leastBusy,
];

/** Convenience for custom strategies defined inline in user code. */
export function defineStrategy(
  id: string,
  description: string,
  select: (context: RoutingContext) => ModelTarget[],
): RoutingStrategy {
  return { id, description, select };
}
