import { describe, expect, it } from 'vitest';

import type { ModelTarget } from '../src/llm/types.js';
import { Router } from '../src/routing/Router.js';
import { RoutingStrategyRegistry } from '../src/routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import { defineStrategy } from '../src/routing/strategies/builtin.js';

function target(overrides: Partial<ModelTarget> & { modelId: string }): ModelTarget {
  return {
    key: `endpoint:${overrides.modelId}`,
    endpointId: 'endpoint',
    modelName: overrides.modelId,
    contextWindow: 16_000,
    maxOutputTokens: 2048,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M: 1, outputPer1M: 2 },
    capabilities: [],
    reasoning: { enabled: false, effort: 'medium', dialect: 'reasoning_effort', exclude: true },
    tags: [],
    weight: 1,
    params: {},
    timeoutMs: 1000,
    endpoint: {
      id: 'endpoint',
      baseUrl: 'http://localhost/v1',
      apiKey: '',
      headers: {},
      query: {},
      maxConcurrent: 0,
      requestsPerMinute: 0,
      enabled: true,
    },
    ...overrides,
  } as ModelTarget;
}

const cheap = target({ modelId: 'cheap', pricing: { inputPer1M: 0.1, outputPer1M: 0.2 }, contextWindow: 8_000 });
const mid = target({ modelId: 'mid', pricing: { inputPer1M: 1, outputPer1M: 2 }, contextWindow: 32_000 });
const wide = target({ modelId: 'wide', pricing: { inputPer1M: 5, outputPer1M: 10 }, contextWindow: 200_000 });

const fitting = { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 };
const request = (estimatedInputTokens: number, capabilities: ModelTarget['capabilities'] = []) => ({
  pipeline: 'test',
  estimatedInputTokens,
  expectedOutputTokens: 512,
  requiredCapabilities: capabilities,
});

function router(strategyId: string): Router {
  return new Router(new RoutingStrategyRegistry().get(strategyId), new TargetStatsRegistry(), fitting);
}

describe('routing strategies', () => {
  it('cost-optimized puts the cheapest fitting target first', () => {
    const order = router('cost-optimized').select([wide, mid, cheap], request(1000));
    expect(order.map((t) => t.modelId)).toEqual(['cheap', 'mid', 'wide']);
  });

  it('cost-optimized demotes a target that cannot hold the request', () => {
    // 10k tokens does not fit `cheap` (8k window) but fits the others.
    const order = router('cost-optimized').select([wide, mid, cheap], request(10_000));
    expect(order[0]?.modelId).toBe('mid');
    expect(order.at(-1)?.modelId).toBe('cheap');
  });

  it('context-optimized prefers the widest headroom', () => {
    const order = router('context-optimized').select([cheap, mid, wide], request(1000));
    expect(order.map((t) => t.modelId)).toEqual(['wide', 'mid', 'cheap']);
  });

  it('sequential keeps declaration order', () => {
    const order = router('sequential').select([wide, cheap, mid], request(1000));
    expect(order.map((t) => t.modelId)).toEqual(['wide', 'cheap', 'mid']);
  });

  it('round-robin rotates the head between calls', () => {
    const instance = router('round-robin');
    const first = instance.select([cheap, mid, wide], request(1000))[0]?.modelId;
    const second = instance.select([cheap, mid, wide], request(1000))[0]?.modelId;
    expect(first).not.toBe(second);
  });

  it('filters by required capability before ranking', () => {
    const structured = target({ modelId: 'structured', capabilities: ['json_schema'], pricing: { inputPer1M: 9, outputPer1M: 9 } });
    const order = router('cost-optimized').select([cheap, structured], request(1000, ['json_schema']));
    expect(order.map((t) => t.modelId)).toEqual(['structured']);
  });

  it('falls back to the raw pool when nothing has the capability, rather than routing nowhere', () => {
    const order = router('cost-optimized').select([cheap, mid], request(1000, ['vision']));
    expect(order.length).toBe(2);
  });

  it('accepts a custom strategy registered by id', () => {
    const registry = new RoutingStrategyRegistry();
    registry.register(
      defineStrategy('reverse-alpha', 'test', (context) =>
        [...context.candidates].sort((a, b) => b.modelId.localeCompare(a.modelId)),
      ),
    );
    const custom = new Router(registry.get('reverse-alpha'), new TargetStatsRegistry(), fitting);
    expect(custom.select([cheap, mid, wide], request(100)).map((t) => t.modelId)).toEqual(['wide', 'mid', 'cheap']);
  });

  it('reports unknown strategies with the available ones listed', () => {
    expect(() => new RoutingStrategyRegistry().get('nope')).toThrowError(/Available: /);
  });
});
