import type { ContextConfig } from '../../config/schema.js';
import { ConfigError } from '../../shared/errors.js';
import type { Segmenter } from '../Segmenter.js';
import type { ContextStrategy } from '../types.js';
import { builtinContextStrategies, type ContextStrategyFactory } from './strategies.js';

/**
 * Name → strategy factory, with the segmenter and config injected once.
 * Registering a factory is how a project adds its own tactic (summarize-first,
 * section-targeted extraction, retrieval) without touching the pipelines.
 */
export class ContextStrategyRegistry {
  private readonly factories = new Map<string, ContextStrategyFactory>();
  private readonly instances = new Map<string, ContextStrategy>();

  constructor(
    private readonly segmenter: Segmenter,
    private readonly config: ContextConfig,
    initial: Readonly<Record<string, ContextStrategyFactory>> = builtinContextStrategies,
  ) {
    for (const [id, factory] of Object.entries(initial)) this.register(id, factory);
  }

  register(id: string, factory: ContextStrategyFactory): this {
    this.factories.set(id, factory);
    this.instances.delete(id);
    return this;
  }

  get(id: string): ContextStrategy {
    const cached = this.instances.get(id);
    if (cached) return cached;

    const factory = this.factories.get(id);
    if (!factory) {
      throw new ConfigError(`Unknown context strategy "${id}". Available: ${this.ids().join(', ')}`, {
        details: { id, available: this.ids() },
      });
    }
    const strategy = factory({ segmenter: this.segmenter, config: this.config });
    this.instances.set(id, strategy);
    return strategy;
  }

  ids(): string[] {
    return [...this.factories.keys()].sort();
  }
}
