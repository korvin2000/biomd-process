import { ConfigError } from '../shared/errors.js';
import { builtinStrategies } from './strategies/builtin.js';
import type { RoutingStrategy } from './types.js';

/**
 * Name → strategy. Built-ins are pre-registered; a custom strategy is one
 * `register()` call away and becomes selectable from config by its id.
 */
export class RoutingStrategyRegistry {
  private readonly strategies = new Map<string, RoutingStrategy>();

  constructor(initial: readonly RoutingStrategy[] = builtinStrategies) {
    for (const strategy of initial) this.register(strategy);
  }

  register(strategy: RoutingStrategy): this {
    this.strategies.set(strategy.id, strategy);
    return this;
  }

  get(id: string): RoutingStrategy {
    const strategy = this.strategies.get(id);
    if (!strategy) {
      throw new ConfigError(
        `Unknown routing strategy "${id}". Available: ${this.ids().join(', ')}`,
        { details: { id, available: this.ids() } },
      );
    }
    return strategy;
  }

  has(id: string): boolean {
    return this.strategies.has(id);
  }

  ids(): string[] {
    return [...this.strategies.keys()].sort();
  }

  all(): RoutingStrategy[] {
    return [...this.strategies.values()];
  }
}
