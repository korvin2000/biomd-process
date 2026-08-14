import { estimateCost } from '../llm/CostCalculator.js';
import { hasCapabilities, usableInputTokens, type ModelTarget } from '../llm/types.js';
import type { TargetStatsRegistry } from './TargetStats.js';
import type { RoutingContext, RoutingRequest, RoutingStrategy } from './types.js';

export interface RouterFittingOptions {
  reserveOutputTokens: number;
  safetyMarginRatio: number;
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
    return dedupe(ranked.length > 0 ? ranked : pool);
  }

  private buildContext(pool: readonly ModelTarget[], request: RoutingRequest): RoutingContext {
    this.sequence += 1;

    const headroom = (target: ModelTarget): number =>
      usableInputTokens(target, this.fitting) - request.estimatedInputTokens;

    return {
      candidates: pool,
      request,
      stats: (key) => this.stats.get(key),
      fits: (target) => headroom(target) >= 0,
      headroom,
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
