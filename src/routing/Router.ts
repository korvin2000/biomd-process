import { estimateCost } from '../llm/CostCalculator.js';
import { hasCapabilities, usableInputTokens, type ModelTarget } from '../llm/types.js';
import type { TargetStatsRegistry } from './TargetStats.js';
import { slackOf, type RoutingContext, type RoutingRequest, type RoutingStrategy } from './types.js';

/** What to do with a target that cannot serve the request. See `llm.routing.onOverflow`. */
export type OverflowPolicy = 'demote' | 'skip';

export interface RouterFittingOptions {
  reserveOutputTokens: number;
  safetyMarginRatio: number;
  /** Defaults to `demote` — rank it last, but still call it if nothing else is left. */
  onOverflow?: OverflowPolicy;
}

/**
 * Builds the {@link RoutingContext} and delegates ranking to the configured
 * strategy. Everything mechanical — capability filtering, context fitting, cost
 * estimation — happens here exactly once, so a strategy stays a few lines of
 * comparison logic.
 */
export class Router {
  private sequence = 0;

  constructor(
    private readonly strategy: RoutingStrategy,
    private readonly stats: TargetStatsRegistry,
    private readonly fitting: RouterFittingOptions,
    private readonly options: Record<string, unknown> = {},
  ) {}

  get strategyId(): string {
    return this.strategy.id;
  }

  /**
   * Ordered fallback chain for one logical call. Never empty as long as the pool
   * is non-empty: when no candidate satisfies the required capabilities we fall
   * back to the raw pool so the caller gets a real provider error instead of a
   * silent "no route" that hides a config mistake.
   */
  select(candidates: readonly ModelTarget[], request: RoutingRequest): ModelTarget[] {
    if (candidates.length === 0) return [];

    const capable = candidates.filter((target) => hasCapabilities(target, request.requiredCapabilities));
    const pool = capable.length > 0 ? capable : [...candidates];
    const context = this.buildContext(pool, request);

    const ranked = this.strategy.select(context);
    return this.applyOverflowPolicy(dedupe(ranked.length > 0 ? ranked : pool), context);
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
            reasoningTokens: 0,
            totalTokens: request.estimatedInputTokens + request.expectedOutputTokens,
          },
          target.pricing,
        ),
      sequence: this.sequence,
      options: this.options,
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
