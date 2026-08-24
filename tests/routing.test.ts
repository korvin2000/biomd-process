import { describe, expect, it } from 'vitest';

import type { ModelTarget } from '../src/llm/types.js';
import { Router } from '../src/routing/Router.js';
import { RoutingStrategyRegistry } from '../src/routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import { routingSchema, type RoutingConfig } from '../src/config/schema.js';
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
      minRequestSpacingMs: 0,
      stream: false,
      enabled: true,
    },
    ...overrides,
  } as ModelTarget;
}

const cheap = target({ modelId: 'cheap', pricing: { inputPer1M: 0.1, outputPer1M: 0.2 }, contextWindow: 8_000 });
const mid = target({ modelId: 'mid', pricing: { inputPer1M: 1, outputPer1M: 2 }, contextWindow: 32_000 });
const wide = target({ modelId: 'wide', pricing: { inputPer1M: 5, outputPer1M: 10 }, contextWindow: 200_000 });

/** A wide window with a low output ceiling — the shape that used to route wrong. */
const narrow = target({
  modelId: 'narrow',
  pricing: { inputPer1M: 0.1, outputPer1M: 0.2 },
  contextWindow: 64_000,
  maxOutputTokens: 8_192,
});
const roomy = target({
  modelId: 'roomy',
  pricing: { inputPer1M: 5, outputPer1M: 10 },
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
});

const fitting = { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 };

/** A parsed routing section, so a test states only what it is about. */
function routingConfig(overrides: Record<string, unknown> = {}): RoutingConfig {
  return routingSchema.parse(overrides);
}
const request = (
  estimatedInputTokens: number,
  capabilities: ModelTarget['capabilities'] = [],
  expectedOutputTokens = 512,
) => ({
  pipeline: 'test',
  estimatedInputTokens,
  expectedOutputTokens,
  requiredCapabilities: capabilities,
});

function router(strategyId: string, onOverflow?: 'demote' | 'skip'): Router {
  return new Router(
    new RoutingStrategyRegistry(),
    routingConfig({ strategy: strategyId }),
    new TargetStatsRegistry(),
    { ...fitting, ...(onOverflow ? { onOverflow } : {}) },
  );
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
    const custom = new Router(
      registry,
      routingConfig({ strategy: 'reverse-alpha' }),
      new TargetStatsRegistry(),
      fitting,
    );
    expect(custom.select([cheap, mid, wide], request(100)).map((t) => t.modelId)).toEqual(['wide', 'mid', 'cheap']);
  });

  it('reports unknown strategies with the available ones listed', () => {
    expect(() => new RoutingStrategyRegistry().get('nope')).toThrowError(/Available: /);
  });
});

/**
 * The `williams2` failure: a 64K window happily accepted a long article and then
 * cut its translation off at the 8K output ceiling. Nothing about the prompt was
 * too big, so the only way to see it coming is to route on what the model can
 * *emit* as well as on what it can hold.
 */
describe('output capacity', () => {
  it('demotes a target that cannot emit the expected answer, even though the prompt fits', () => {
    const order = router('cost-optimized').select([narrow, roomy], request(3_000, [], 13_000));
    expect(order.map((t) => t.modelId)).toEqual(['roomy', 'narrow']);
  });

  it('still prefers the cheap target when the answer does fit it', () => {
    const order = router('cost-optimized').select([narrow, roomy], request(3_000, [], 4_000));
    expect(order.map((t) => t.modelId)).toEqual(['narrow', 'roomy']);
  });

  it('onOverflow: skip drops it from the chain instead of calling it last', () => {
    const order = router('cost-optimized', 'skip').select([narrow, roomy], request(3_000, [], 13_000));
    expect(order.map((t) => t.modelId)).toEqual(['roomy']);
  });

  it('onOverflow: skip still routes somewhere when nothing in the pool fits', () => {
    // A pool nobody sized for this corpus is a config mistake, and a real
    // provider error names it better than an empty chain does.
    const order = router('cost-optimized', 'skip').select([narrow, roomy], request(3_000, [], 99_999));
    expect(order.map((t) => t.modelId)).toEqual(['roomy']);
  });

  it('reserves the output the request actually expects, not just the configured floor', () => {
    // 56k input fits narrow's window against the 1024-token default reserve, and
    // does not once the 8k answer it will generate is accounted for.
    const order = router('cost-optimized', 'skip').select([narrow, roomy], request(56_000, [], 8_192));
    expect(order.map((t) => t.modelId)).toEqual(['roomy']);
  });
});
