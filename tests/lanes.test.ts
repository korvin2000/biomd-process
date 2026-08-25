import { describe, expect, it } from 'vitest';

import { routingSchema, type EndpointConfig } from '../src/config/schema.js';
import { LaneRegistry } from '../src/llm/Lanes.js';
import type { ModelTarget } from '../src/llm/types.js';
import { RateLimiterRegistry } from '../src/reliability/RateLimiter.js';
import { Router } from '../src/routing/Router.js';
import { RoutingStrategyRegistry } from '../src/routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';

/**
 * Endpoint concurrency, and the two things it decides: who gets ranked first
 * when several endpoints could serve a request, and who is actually allowed to
 * talk at once.
 */

function endpoint(id: string, maxConcurrent: number): EndpointConfig {
  return {
    id,
    baseUrl: `http://${id}/v1`,
    apiKey: '',
    headers: {},
    query: {},
    maxConcurrent,
    requestsPerMinute: 0,
    minRequestSpacingMs: 0,
    stream: false,
    responsesPromptCache: false,
    usage: { chatCachedTokens: 'included' },
    enabled: true,
  };
}

function target(modelId: string, ep: EndpointConfig, inputPer1M = 0): ModelTarget {
  return {
    key: `${ep.id}:${modelId}`,
    modelId,
    endpointId: ep.id,
    modelName: modelId,
    apiFormat: 'chat_completions',
    contextWindow: 64_000,
    maxOutputTokens: 8192,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M, outputPer1M: inputPer1M },
    capabilities: [],
    reasoning: { enabled: false, effort: 'medium', dialect: 'none', exclude: true },
    tags: [],
    weight: 1,
    params: {},
    provider: { order: [], only: [], ignore: [], quantizations: [] },
    timeoutMs: 1000,
    endpoint: ep,
  };
}

const local = endpoint('local', 1);
const omniroute = endpoint('omniroute', 1);
const openrouter = endpoint('openrouter', 3);

const localSmall = target('local-small', local, 0);
const orLuna = target('or-luna', omniroute, 0);
const orCheap = target('or-cheap', openrouter, 0.07);
const CHAIN = [localSmall, orLuna, orCheap];

function lanes(pools: Record<string, unknown> = {}): LaneRegistry {
  return new LaneRegistry(
    routingSchema.parse({ pools }),
    [local, omniroute, openrouter],
    new RateLimiterRegistry(),
  );
}

function router(pools: Record<string, unknown>, registry: LaneRegistry, strategy = 'cost-optimized'): Router {
  return new Router(
    new RoutingStrategyRegistry(),
    routingSchema.parse({ strategy, pools }),
    new TargetStatsRegistry(),
    { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 },
    registry,
  );
}

const request = (overrides: Record<string, unknown> = {}) => ({
  pipeline: 'translate',
  pool: 'translate',
  estimatedInputTokens: 2000,
  expectedOutputTokens: 1024,
  requiredCapabilities: [],
  ...overrides,
});

describe('lane accounting', () => {
  it('reports an uncapped endpoint as unbounded rather than as full', () => {
    const registry = new LaneRegistry(
      routingSchema.parse({ pools: {} }),
      [endpoint('anything', 0)],
      new RateLimiterRegistry(),
    );
    const free = target('m', endpoint('anything', 0));
    expect(registry.freeSlots('translate', free)).toBe(Number.POSITIVE_INFINITY);
  });

  it('counts a claim against the pool that made it, and gives the slot back on release', () => {
    const registry = lanes({ translate: { models: ['local-small'] } });

    expect(registry.freeSlots('translate', localSmall)).toBe(1);
    const release = registry.claim('translate', localSmall);
    expect(registry.freeSlots('translate', localSmall)).toBe(0);
    expect(registry.inFlight('translate', localSmall)).toBe(1);

    release();
    expect(registry.freeSlots('translate', localSmall)).toBe(1);
    // Releasing twice must not invent capacity that does not exist.
    release();
    expect(registry.freeSlots('translate', localSmall)).toBe(1);
  });

  /**
   * An endpoint another pool is saturating has nothing to offer this one.
   * Counting only a pool's own lane would tell `translate` that the local
   * gateway is idle while `extract` is talking to it, and the spread would be
   * computed against a number that is not true.
   */
  it('counts an endpoint another pool is occupying', () => {
    const registry = lanes({
      extract: { models: ['local-small'] },
      translate: { models: ['local-small'] },
    });

    expect(registry.freeSlots('translate', localSmall)).toBe(1);
    registry.claim('extract', localSmall);
    expect(registry.freeSlots('translate', localSmall)).toBe(0);
    expect(registry.load('translate', localSmall)).toBe(1);
    // …and it is still the other pool's request, not this one's.
    expect(registry.inFlight('translate', localSmall)).toBe(0);
  });

  it('takes the narrower of the endpoint cap and the pool lane', () => {
    const registry = lanes({ translate: { models: ['or-cheap'], maxConcurrent: { openrouter: 1 } } });
    // The endpoint allows three; this pool's share of them is one.
    expect(registry.limitOf('translate', 'openrouter')).toBe(1);
    expect(registry.limitOf('extract', 'openrouter')).toBe(3);
  });
});

describe('least-busy routing', () => {
  it('leaves the cheapest first while every endpoint is idle', () => {
    const registry = lanes({ translate: { models: ['local-small', 'or-luna', 'or-cheap'] } });
    const order = router({ translate: { models: [] } }, registry, 'least-busy').select(CHAIN, request());
    expect(order.map((t) => t.modelId)).toEqual(['local-small', 'or-luna', 'or-cheap']);
  });

  it('moves past an endpoint that is already full', () => {
    const registry = lanes({ translate: { models: ['local-small', 'or-luna', 'or-cheap'] } });
    const routed = router({ translate: { models: [] } }, registry, 'least-busy');

    registry.claim('translate', localSmall);
    expect(routed.select(CHAIN, request())[0]?.modelId).toBe('or-luna');

    registry.claim('translate', orLuna);
    expect(routed.select(CHAIN, request())[0]?.modelId).toBe('or-cheap');
  });

  it('keeps the busy target in the chain rather than dropping it', () => {
    const registry = lanes({ translate: { models: ['local-small', 'or-luna', 'or-cheap'] } });
    const routed = router({ translate: { models: [] } }, registry, 'least-busy');

    registry.claim('translate', localSmall);
    expect(routed.select(CHAIN, request()).map((t) => t.modelId)).toEqual(['or-luna', 'or-cheap', 'local-small']);
  });

  /**
   * The reason the metric is a fraction. `openrouter` allows three parallel
   * requests, the others one each: ranked by the *count* of free slots it would
   * be first for every request from the very first one, and the two endpoints
   * this deployment actually prefers would never be asked at all.
   */
  it('does not reward an endpoint for merely allowing more parallelism', () => {
    const registry = lanes({ translate: { models: ['local-small', 'or-luna', 'or-cheap'] } });
    const routed = router({ translate: { models: [] } }, registry, 'least-busy');
    expect(routed.select(CHAIN, request())[0]?.endpointId).toBe('local');
  });

  /**
   * The point of a lane. `openrouter` allows three parallel requests and the
   * other two allow one each; without a lane the third task would rank the
   * generous endpoint first for every request after the first two, and it would
   * end up serving most of the corpus simply because it says yes more often.
   */
  it('stops one generous endpoint taking more than its lane allows', () => {
    const pools = {
      translate: {
        models: ['local-small', 'or-luna', 'or-cheap'],
        strategy: 'least-busy',
        maxConcurrent: { openrouter: 1 },
      },
    };
    const registry = lanes(pools);
    const routed = router(pools, registry, 'cost-optimized');

    // Three tasks start together: each takes the best target still free.
    const chosen = [0, 1, 2].map(() => {
      const best = routed.select(CHAIN, request())[0];
      if (best) registry.claim('translate', best);
      return best?.endpointId;
    });
    expect(chosen).toEqual(['local', 'omniroute', 'openrouter']);

    // A fourth has nowhere free to go, and says so by falling back to the
    // preference order rather than by pretending a slot exists.
    expect([...new Set([0, 1, 2].map((i) => chosen[i]))]).toHaveLength(3);
    expect(routed.select(CHAIN, request()).map((t) => t.endpointId)).toEqual(['local', 'omniroute', 'openrouter']);
  });

  it('degrades to the cost ordering when nothing is capped', () => {
    const uncapped = [endpoint('a', 0), endpoint('b', 0)];
    const registry = new LaneRegistry(routingSchema.parse({}), uncapped, new RateLimiterRegistry());
    const dear = target('dear', uncapped[0]!, 5);
    const cheap = target('cheap', uncapped[1]!, 1);

    const routed = new Router(
      new RoutingStrategyRegistry(),
      routingSchema.parse({ strategy: 'least-busy' }),
      new TargetStatsRegistry(),
      { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 },
      registry,
    );
    expect(routed.select([dear, cheap], request()).map((t) => t.modelId)).toEqual(['cheap', 'dear']);
  });
});

describe('per-pool strategy', () => {
  it('lets each pool choose, and inherits the global one otherwise', () => {
    const pools = {
      default: { models: ['local-small'] },
      extract: { models: ['local-small', 'or-cheap'] },
      websearch: { models: ['or-cheap', 'or-luna'], strategy: 'sequential' },
    };
    const routed = router(pools, lanes(pools), 'cost-optimized');

    expect(routed.strategyIdFor('extract')).toBe('cost-optimized');
    expect(routed.strategyIdFor('websearch')).toBe('sequential');
    expect(routed.strategyId).toBe('cost-optimized');

    // `sequential` keeps the declared order; `cost-optimized` would reverse it.
    expect(
      routed.select([orCheap, orLuna], request({ pool: 'websearch' })).map((t) => t.modelId),
    ).toEqual(['or-cheap', 'or-luna']);
    expect(
      routed.select([orCheap, orLuna], request({ pool: 'extract' })).map((t) => t.modelId),
    ).toEqual(['or-luna', 'or-cheap']);
  });

  it('refuses an unknown strategy id when the app is built, not on the call that uses it', () => {
    expect(() =>
      router({ translate: { models: ['local-small'], strategy: 'nope' } }, lanes()),
    ).toThrowError(/Unknown routing strategy "nope"/);
  });

  it('merges per-pool strategy options over the global ones', () => {
    const registry = new RoutingStrategyRegistry();
    let seen: Record<string, unknown> = {};
    registry.register({
      id: 'spy',
      description: 'test',
      select: (context) => {
        seen = context.options;
        return [...context.candidates];
      },
    });

    new Router(
      registry,
      routingSchema.parse({
        strategy: 'spy',
        options: { a: 1, b: 2 },
        pools: { translate: { models: ['local-small'], options: { b: 3 } } },
      }),
      new TargetStatsRegistry(),
      { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 },
    ).select(CHAIN, request());

    expect(seen).toEqual({ a: 1, b: 3 });
  });
});

describe('per-language model preference', () => {
  const pools = {
    translate: {
      models: ['local-small', 'or-luna', 'or-cheap'],
      prefer: { zh: ['or-cheap'], ja: ['or-cheap', 'or-luna'] },
    },
  };

  it('puts the language’s model first, whatever the strategy ranked', () => {
    const routed = router(pools, lanes(pools), 'cost-optimized');
    expect(routed.select(CHAIN, request({ variant: 'zh' })).map((t) => t.modelId)).toEqual([
      'or-cheap',
      'local-small',
      'or-luna',
    ]);
  });

  it('honours the order the preference lists', () => {
    const routed = router(pools, lanes(pools), 'cost-optimized');
    expect(routed.select(CHAIN, request({ variant: 'ja' })).map((t) => t.modelId)).toEqual([
      'or-cheap',
      'or-luna',
      'local-small',
    ]);
  });

  it('leaves an unlisted language to the strategy', () => {
    const routed = router(pools, lanes(pools), 'cost-optimized');
    expect(routed.select(CHAIN, request({ variant: 'de' }))[0]?.modelId).toBe('local-small');
  });

  /** A preference reorders; it never removes. A preferred model that is down still falls back. */
  it('keeps the rest of the pool behind the preferred model as its fallback chain', () => {
    const routed = router(pools, lanes(pools), 'cost-optimized');
    expect(routed.select(CHAIN, request({ variant: 'zh' }))).toHaveLength(3);
  });
});

describe('lane enforcement', () => {
  it('serializes a pool to its lane even when the endpoint would allow more', async () => {
    const registry = lanes({ translate: { models: ['or-cheap'], maxConcurrent: { openrouter: 1 } } });

    const first = await registry.acquire('translate', orCheap);
    let secondEntered = false;
    const second = registry.acquire('translate', orCheap).then((release) => {
      secondEntered = true;
      return release;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondEntered).toBe(false);

    first();
    (await second)();
    expect(secondEntered).toBe(true);
  });

  it('lets two pools share an endpoint whose lanes are separate', async () => {
    const registry = lanes({
      translate: { models: ['or-cheap'], maxConcurrent: { openrouter: 1 } },
      extract: { models: ['or-cheap'], maxConcurrent: { openrouter: 1 } },
    });

    const a = await registry.acquire('translate', orCheap);
    const b = await registry.acquire('extract', orCheap);
    expect(typeof a).toBe('function');
    expect(typeof b).toBe('function');
    a();
    b();
  });
});
