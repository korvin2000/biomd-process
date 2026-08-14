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

export const builtinStrategies: readonly RoutingStrategy[] = [
  costOptimized,
  contextOptimized,
  sequential,
  roundRobin,
  leastFailures,
];

/** Convenience for custom strategies defined inline in user code. */
export function defineStrategy(
  id: string,
  description: string,
  select: (context: RoutingContext) => ModelTarget[],
): RoutingStrategy {
  return { id, description, select };
}
