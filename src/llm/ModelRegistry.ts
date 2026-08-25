import type { AppConfig, PoolConfig } from '../config/schema.js';
import { ConfigError } from '../shared/errors.js';
import type { ModelTarget } from './types.js';

/** What a pool without its own entry looks like: no members, no overrides. */
const EMPTY_POOL: PoolConfig = { models: [], options: {}, maxConcurrent: {}, prefer: {}, exclude: {}, preferMode: 'reorder', preferWaitMs: 30_000 };

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
        apiFormat: model.apiFormat,
        webSearchMode: model.webSearchMode,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        maxTokensParam: model.maxTokensParam,
        pricing: model.pricing,
        capabilities: model.capabilities,
        reasoning: model.reasoning,
        tags: model.tags,
        weight: model.weight,
        params: {
          ...config.llm.defaults.params,
          ...model.params,
        },
        provider: model.provider,
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
    const members = this.poolConfig(name).models;
    if (members.length === 0) return this.all();

    return members
      .map((modelId) => this.byModelId.get(modelId))
      .filter((target): target is ModelTarget => target !== undefined);
  }

  /**
   * The pool's own settings — strategy, lanes, language preferences.
   *
   * Resolved through exactly the same fallback as {@link pool}, so "which
   * models" and "how to choose between them" can never disagree about which
   * pool is being talked about.
   */
  poolConfig(name: string | undefined): PoolConfig {
    const pools = this.config.llm.routing.pools;
    return (name ? pools[name] : undefined) ?? pools['default'] ?? EMPTY_POOL;
  }
}
