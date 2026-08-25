import type { PoolConfig, RoutingConfig } from '../config/schema.js';
import { estimateCost } from '../llm/CostCalculator.js';
import { hasCapabilities, usableInputTokens, type ModelTarget } from '../llm/types.js';
import type { RoutingStrategyRegistry } from './StrategyRegistry.js';
import type { TargetStatsRegistry } from './TargetStats.js';
import {
  slackOf,
  type OccupancyView,
  type RoutingContext,
  type RoutingRequest,
  type RoutingStrategy,
} from './types.js';

/** What to do with a target that cannot serve the request. See `llm.routing.onOverflow`. */
export type OverflowPolicy = 'demote' | 'skip';

export interface RouterFittingOptions {
  reserveOutputTokens: number;
  safetyMarginRatio: number;
  /** Defaults to `demote` — rank it last, but still call it if nothing else is left. */
  onOverflow?: OverflowPolicy;
}

/** Nothing is capped and nothing is in flight — the view a Router without one uses. */
const UNCAPPED: OccupancyView = {
  freeSlots: () => Number.POSITIVE_INFINITY,
  inFlight: () => 0,
  load: () => 0,
};

const EMPTY_POOL: PoolConfig = { models: [], options: {}, maxConcurrent: {}, prefer: {} };

/**
 * Builds the {@link RoutingContext} and delegates ranking to the pool's
 * strategy. Everything mechanical — capability filtering, context fitting, cost
 * estimation, occupancy — happens here exactly once, so a strategy stays a few
 * lines of comparison logic.
 *
 * Two things sit *around* the strategy rather than inside it, because they are
 * deployment facts rather than ranking policy:
 *
 *  - **which strategy** — `llm.routing.pools.<pool>.strategy`, falling back to
 *    the global `llm.routing.strategy`. Extraction, translation and web search
 *    have different scarce resources (money, wall-clock, a working search
 *    model), and one global answer forces them to pretend otherwise.
 *  - **`prefer`** — a per-variant reordering applied *after* the strategy has
 *    ranked, so a language's preferred model outranks whatever the strategy
 *    thought and everything else keeps its order behind it. It is a quality
 *    statement ("DeepSeek renders Chinese better"), and quality outranks both
 *    price and queue depth; the rest of the pool remains the fallback chain, so
 *    preferring a model can never make a language unroutable.
 */
export class Router {
  private sequence = 0;

  constructor(
    private readonly strategies: RoutingStrategyRegistry,
    private readonly routing: RoutingConfig,
    private readonly stats: TargetStatsRegistry,
    private readonly fitting: RouterFittingOptions,
    /** Live concurrency, for load-spreading strategies. Uncapped when absent. */
    private readonly occupancy: OccupancyView = UNCAPPED,
  ) {
    // A strategy id that does not resolve is a config error, and the only
    // honest time to say so is before the first document is planned — not on
    // the one call that happens to use that pool.
    this.strategies.get(routing.strategy);
    for (const pool of Object.values(routing.pools)) {
      if (pool.strategy) this.strategies.get(pool.strategy);
    }
  }

  /** The globally configured strategy id — what a pool without its own uses. */
  get strategyId(): string {
    return this.routing.strategy;
  }

  /** The strategy id a pool actually routes with, unless one call overrides it. */
  strategyIdFor(pool: string | undefined, override?: string): string {
    return override ?? this.poolConfig(pool).strategy ?? this.routing.strategy;
  }

  /**
   * Ordered fallback chain for one logical call. A required capability is a
   * safety boundary, not a preference: when no candidate satisfies it, routing
   * returns no target rather than asking an incapable model to improvise.
   */
  select(candidates: readonly ModelTarget[], request: RoutingRequest): ModelTarget[] {
    if (candidates.length === 0) return [];

    const capable = candidates.filter((target) => hasCapabilities(target, request.requiredCapabilities));
    if (request.requiredCapabilities.length > 0 && capable.length === 0) return [];
    const pool = request.requiredCapabilities.length > 0 ? capable : [...candidates];
    const context = this.buildContext(pool, request);

    const ranked = this.strategyFor(request.pool, request.strategy).select(context);
    const preferred = this.applyPreference(dedupe(ranked.length > 0 ? ranked : pool), request);
    // Avoidance is applied *after* preference, and that order is the point: a
    // language's preferred model is a statement about quality, and a model that
    // has just produced a broken answer for this very task is evidence.
    const ordered = this.applyAvoidance(preferred, request.avoid);
    return this.applyOverflowPolicy(ordered, context);
  }

  private strategyFor(pool: string | undefined, override?: string): RoutingStrategy {
    return this.strategies.get(this.strategyIdFor(pool, override));
  }

  private poolConfig(pool: string | undefined): PoolConfig {
    return (pool ? this.routing.pools[pool] : undefined) ?? this.routing.pools['default'] ?? EMPTY_POOL;
  }

  /**
   * Floats this variant's preferred models to the front, in the order they were
   * listed. A stable partition rather than a filter: a preference says which
   * model to *try first*, never which models are allowed, so the pool behind it
   * is untouched and still catches a preferred model that is down.
   */
  private applyPreference(targets: ModelTarget[], request: RoutingRequest): ModelTarget[] {
    const preferred = request.variant ? this.poolConfig(request.pool).prefer[request.variant] : undefined;
    if (!preferred || preferred.length === 0) return targets;

    const rank = new Map(preferred.map((modelId, index) => [modelId, index]));
    const wanted = targets
      .filter((target) => rank.has(target.modelId))
      .sort((a, b) => (rank.get(a.modelId) ?? 0) - (rank.get(b.modelId) ?? 0));
    if (wanted.length === 0) return targets;

    return [...wanted, ...targets.filter((target) => !rank.has(target.modelId))];
  }

  /**
   * Demotes the targets a previous attempt at this task already used.
   *
   * The gateway's own fallback chain answers "this call failed"; this answers
   * the different question "this call succeeded and the answer was wrong",
   * which only the task that assembled the answer can know. The model that
   * produced it is the one fact we have about the failure, so the next attempt
   * leads with somebody else.
   *
   * Demotion, not exclusion, for the same reason `onOverflow: demote` exists: a
   * pool of three whose three models have all been tried still has to route
   * somewhere, and the last attempt's job is to try again *differently* — at a
   * lower temperature, say — not to fail for want of a candidate.
   */
  private applyAvoidance(targets: ModelTarget[], avoid: ReadonlySet<string> | undefined): ModelTarget[] {
    if (!avoid || avoid.size === 0) return targets;
    const fresh = targets.filter((target) => !avoid.has(target.key));
    if (fresh.length === 0 || fresh.length === targets.length) return targets;
    return [...fresh, ...targets.filter((target) => avoid.has(target.key))];
  }

  /**
   * `skip` removes what cannot serve the request instead of merely ranking it
   * last — the setting for a pool whose small model would otherwise be called,
   * have its answer cut off, be retried on the identical payload, and only then
   * give way to something wider.
   *
   * It never routes nowhere: when *no* target fits, the least-overloaded one is
   * kept so the caller gets a real provider error instead of a silent "no route"
   * that hides a pool nobody sized for this corpus.
   */
  private applyOverflowPolicy(targets: ModelTarget[], context: RoutingContext): ModelTarget[] {
    if ((this.fitting.onOverflow ?? 'demote') !== 'skip') return targets;

    const fitting = targets.filter((target) => context.fits(target));
    if (fitting.length > 0) return fitting;

    const leastBad = [...targets].sort((a, b) => slackOf(context, b) - slackOf(context, a))[0];
    return leastBad ? [leastBad] : targets;
  }

  private buildContext(pool: readonly ModelTarget[], request: RoutingRequest): RoutingContext {
    this.sequence += 1;

    /**
     * The answer shares the context window with the prompt on most runtimes, so
     * a request expecting more output than the configured reserve has to reserve
     * what it actually needs — the same rule `runWithEscalation` sizes its
     * ladder by. `usableInputTokens` clamps the reserve to what the model can
     * emit anyway, which is what `outputHeadroom` then checks separately.
     */
    const fitting = {
      reserveOutputTokens: Math.max(this.fitting.reserveOutputTokens, request.expectedOutputTokens),
      safetyMarginRatio: this.fitting.safetyMarginRatio,
    };

    const headroom = (target: ModelTarget): number =>
      usableInputTokens(target, fitting) - request.estimatedInputTokens;
    const outputHeadroom = (target: ModelTarget): number => target.maxOutputTokens - request.expectedOutputTokens;

    return {
      candidates: pool,
      request,
      stats: (key) => this.stats.get(key),
      fits: (target) => headroom(target) >= 0 && outputHeadroom(target) >= 0,
      headroom,
      outputHeadroom,
      estimatedCost: (target) =>
        estimateCost(
          {
            promptTokens: request.estimatedInputTokens,
            completionTokens: request.expectedOutputTokens,
            cachedPromptTokens: 0,
            cacheWritePromptTokens: 0,
            reasoningTokens: 0,
            totalTokens: request.estimatedInputTokens + request.expectedOutputTokens,
          },
          target.pricing,
        ),
      freeSlots: (target) => this.occupancy.freeSlots(request.pool, target),
      inFlight: (target) => this.occupancy.inFlight(request.pool, target),
      load: (target) => this.occupancy.load(request.pool, target),
      sequence: this.sequence,
      // Per-pool knobs win over the global ones, and a pool that sets none
      // inherits them whole.
      options: { ...this.routing.options, ...this.poolConfig(request.pool).options },
    };
  }
}

function dedupe(targets: readonly ModelTarget[]): ModelTarget[] {
  const seen = new Set<string>();
  const result: ModelTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.key)) continue;
    seen.add(target.key);
    result.push(target);
  }
  return result;
}
