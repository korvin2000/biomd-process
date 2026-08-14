import type { AppConfig } from '../config/schema.js';
import { ConfigError } from '../shared/errors.js';
import type { ModelTarget } from './types.js';

/**
 * Turns the declarative `llm` config into resolved {@link ModelTarget}s and
 * answers "which targets may serve this task?" — the only place that knows how
 * pools map onto models.
 */
export class ModelRegistry {
  private readonly targets = new Map<string, ModelTarget>();
  private readonly byModelId = new Map<string, ModelTarget>();

  constructor(private readonly config: AppConfig) {
    const endpoints = new Map(config.llm.endpoints.map((endpoint) => [endpoint.id, endpoint]));

    for (const model of config.llm.models) {
      const endpoint = endpoints.get(model.endpoint);
      if (!endpoint) throw new ConfigError(`Model "${model.id}" references unknown endpoint "${model.endpoint}"`);
      if (!model.enabled || !endpoint.enabled) continue;

      const target: ModelTarget = {
        key: `${endpoint.id}:${model.id}`,
        modelId: model.id,
        endpointId: endpoint.id,
        modelName: model.model,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        maxTokensParam: model.maxTokensParam,
        pricing: model.pricing,
        capabilities: model.capabilities,
        reasoning: model.reasoning,
        tags: model.tags,
        weight: model.weight,
        params: model.params,
        timeoutMs: endpoint.timeoutMs ?? config.llm.defaults.timeoutMs,
        endpoint,
      };
      this.targets.set(target.key, target);
      this.byModelId.set(model.id, target);
    }

    if (this.targets.size === 0) {
      throw new ConfigError('No enabled model targets. Enable at least one model and its endpoint.');
    }
  }

  all(): ModelTarget[] {
    return [...this.targets.values()];
  }

  get(modelId: string): ModelTarget | undefined {
    return this.byModelId.get(modelId);
  }

  /**
   * Candidates for a pool, in declaration order. An unknown or empty pool falls
   * back to `default`, and an empty `default` means "every enabled model" — so a
   * minimal config needs no pools at all.
   */
  pool(name: string | undefined): ModelTarget[] {
    const pools = this.config.llm.routing.pools;
    const members = (name ? pools[name] : undefined) ?? pools['default'] ?? [];
    if (members.length === 0) return this.all();

    return members
      .map((modelId) => this.byModelId.get(modelId))
      .filter((target): target is ModelTarget => target !== undefined);
  }
}
