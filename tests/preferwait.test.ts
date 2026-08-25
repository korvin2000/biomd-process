import { describe, expect, it } from 'vitest';

import { LaneRegistry } from '../src/llm/Lanes.js';
import { LlmGateway } from '../src/llm/LlmGateway.js';
import { EMPTY_USAGE } from '../src/llm/types.js';
import type { BudgetGuard } from '../src/llm/Budget.js';
import type { LlmClientFactory } from '../src/llm/LlmClientFactory.js';
import type { ModelRegistry } from '../src/llm/ModelRegistry.js';
import { CircuitBreakerRegistry } from '../src/reliability/CircuitBreaker.js';
import { RateLimiter, RateLimiterRegistry } from '../src/reliability/RateLimiter.js';
import { Router } from '../src/routing/Router.js';
import { RoutingStrategyRegistry } from '../src/routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import { reliabilitySchema, routingSchema, type EndpointConfig } from '../src/config/schema.js';
import type { ModelTarget } from '../src/llm/types.js';

/**
 * `preferMode: wait` — a preferred model is worth queueing for, and not worth
 * queueing for forever.
 *
 * The parts that can go wrong quietly, and so are pinned here: a cancelled wait
 * must not take a slot it then never releases, an `exclude`d model must be gone
 * from *every* tier rather than merely demoted, and an expired wait must widen
 * the choice rather than fail the call.
 */

function endpoint(id: string, maxConcurrent: number): EndpointConfig {
  return {
    id,
    baseUrl: `http://localhost/${id}`,
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
  } as EndpointConfig;
}

function target(modelId: string, ep: EndpointConfig): ModelTarget {
  return {
    key: `${ep.id}:${modelId}`,
    modelId,
    endpointId: ep.id,
    modelName: modelId,
    apiFormat: 'chat_completions',
    contextWindow: 64_000,
    maxOutputTokens: 8192,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M: 1, outputPer1M: 1 },
    capabilities: [],
    reasoning: { enabled: false, effort: 'medium', dialect: 'reasoning_effort', exclude: true },
    tags: [],
    weight: 1,
    params: {},
    timeoutMs: 1000,
    endpoint: ep,
  } as unknown as ModelTarget;
}

const local = endpoint('local', 1);
const remote = endpoint('remote', 1);
const spare = endpoint('spare', 1);

const gemma = target('gemma-local', local);
const luna = target('gpt-luna', remote);
const deep = target('deepseek', spare);

function lanes(): LaneRegistry {
  return new LaneRegistry(
    routingSchema.parse({ pools: { translate: { models: ['gemma-local', 'gpt-luna', 'deepseek'] } } }),
    [local, remote, spare],
    new RateLimiterRegistry(),
  );
}

/**
 * Occupy a target the way the gateway does: a claim *and* a semaphore slot.
 *
 * Taking only the semaphore is not "busy" as routing sees it. `freeSlots`
 * counts claims — the synchronous routing input — while `acquire` takes the
 * semaphore that enforces it, and the gateway always does both. A test that
 * takes one and not the other builds a state production cannot reach.
 */
async function occupy(registry: LaneRegistry, target: ModelTarget): Promise<() => void> {
  const unclaim = registry.claim('translate', target);
  const release = await registry.acquire('translate', target);
  return () => {
    release();
    unclaim();
  };
}

describe('an abandoned wait for a concurrency slot', () => {
  it('rejects, and leaves the slot count where it found it', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, requestsPerMinute: 0, minRequestSpacingMs: 0 });
    const held = await limiter.acquire();

    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toThrow(/Aborted while waiting/);
    // The bug this pins: the abandoned waiter used to resolve *and* increment,
    // so `active` went to 2 against a limit of 1 and the caller could not tell
    // it had given up.
    expect(limiter.hasFreeSlot).toBe(false);
    held();
    expect(limiter.hasFreeSlot).toBe(true);
  });

  it('does not swallow the wakeup a live waiter was owed', async () => {
    // `release` hands the freed slot to `waiters.shift()`. A dead waiter left in
    // that queue eats the handoff and the live one behind it stalls.
    const limiter = new RateLimiter({ maxConcurrent: 1, requestsPerMinute: 0, minRequestSpacingMs: 0 });
    const held = await limiter.acquire();

    const controller = new AbortController();
    const abandoned = limiter.acquire(controller.signal);
    const live = limiter.acquire();
    controller.abort();
    await expect(abandoned).rejects.toThrow();

    held();
    await expect(live).resolves.toBeTypeOf('function');
  });
});

describe('LaneRegistry.acquireAny', () => {
  it('gives up when every target stays busy past the deadline', async () => {
    const registry = lanes();
    const held = await registry.acquire('translate', luna);

    const started = Date.now();
    const won = await registry.acquireAny('translate', [luna], { waitMs: 40 });

    expect(won).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);

    // The slot the abandoned attempt queued for must still be the holder's —
    // asked of the semaphore, which is the enforcement, and not of `freeSlots`,
    // which counts claims and is the routing input. The two are deliberately
    // separate and an abandoned acquisition touches only the first.
    expect(await registry.acquireAny('translate', [luna], { waitMs: 20 })).toBeUndefined();

    held();
    const after = await registry.acquireAny('translate', [luna], { waitMs: 20 });
    expect(after).toBeDefined();
    after?.release();
  });

  it('takes the slot the moment one frees, and names which target it was', async () => {
    const registry = lanes();
    const held = await registry.acquire('translate', luna);
    setTimeout(held, 20);

    const won = await registry.acquireAny('translate', [luna, deep], { waitMs: 500 });
    expect(won?.target.modelId).toBeDefined();
    won?.release();
  });

  it('leaves no slot held by a loser', async () => {
    const registry = lanes();
    // Both free: one wins, the other must be cancelled and give its slot back.
    const won = await registry.acquireAny('translate', [luna, deep], { waitMs: 500 });
    expect(won).toBeDefined();
    won?.release();

    // Everything is free again only if the loser released too.
    const a = await registry.acquireAny('translate', [luna], { waitMs: 50 });
    const b = await registry.acquireAny('translate', [deep], { waitMs: 50 });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    a?.release();
    b?.release();
  });
});

describe('exclude', () => {
  function router(pool: Record<string, unknown>): Router {
    return new Router(
      new RoutingStrategyRegistry(),
      routingSchema.parse({ strategy: 'cost-optimized', pools: { translate: pool } }),
      new TargetStatsRegistry(),
      { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 },
    );
  }
  const ask = (variant: string) => ({
    pipeline: 'translate',
    pool: 'translate',
    variant,
    estimatedInputTokens: 1000,
    expectedOutputTokens: 512,
    requiredCapabilities: [],
  });

  it('removes a model from the chain rather than demoting it', () => {
    const chain = router({
      models: ['gemma-local', 'gpt-luna', 'deepseek'],
      preferMode: 'wait',
      prefer: { de: ['gpt-luna'] },
      exclude: { de: ['deepseek'] },
    }).select([gemma, luna, deep], ask('de'));

    expect(chain.map((t) => t.modelId)).toEqual(['gpt-luna', 'gemma-local']);
  });

  it('applies per variant, leaving the others whole', () => {
    const configured = router({
      models: ['gemma-local', 'gpt-luna', 'deepseek'],
      preferMode: 'wait',
      prefer: { de: ['gpt-luna'] },
      exclude: { de: ['deepseek'] },
    });
    expect(configured.select([gemma, luna, deep], ask('it')).map((t) => t.modelId)).toHaveLength(3);
  });

  it('splits the chain into the tier to wait for and the tier to widen to', () => {
    const configured = router({
      models: ['gemma-local', 'gpt-luna', 'deepseek'],
      preferMode: 'wait',
      preferWaitMs: 1234,
      prefer: { de: ['gpt-luna'] },
      exclude: { de: ['deepseek'] },
    });
    const chain = configured.select([gemma, luna, deep], ask('de'));
    const plan = configured.waitPlan(chain, ask('de'));

    expect(plan?.preferred.map((t) => t.modelId)).toEqual(['gpt-luna']);
    expect(plan?.rest.map((t) => t.modelId)).toEqual(['gemma-local']);
    expect(plan?.waitMs).toBe(1234);
  });

  it('produces no wait plan for the other prefer modes', () => {
    for (const preferMode of ['reorder', 'restrict'] as const) {
      const configured = router({
        models: ['gemma-local', 'gpt-luna'],
        preferMode,
        prefer: { de: ['gpt-luna'] },
      });
      const chain = configured.select([gemma, luna], ask('de'));
      expect(configured.waitPlan(chain, ask('de'))).toBeUndefined();
    }
  });
});

describe('the gateway under preferMode: wait', () => {
  /** A gateway whose translate pool prefers `gpt-luna` and forbids `deepseek`. */
  function build(preferWaitMs: number) {
    const routing = routingSchema.parse({
      strategy: 'cost-optimized',
      pools: {
        translate: {
          models: ['gemma-local', 'gpt-luna', 'deepseek'],
          preferMode: 'wait',
          preferWaitMs,
          prefer: { de: ['gpt-luna'] },
          exclude: { de: ['deepseek'] },
        },
      },
    });
    const laneRegistry = new LaneRegistry(routing, [local, remote, spare], new RateLimiterRegistry());
    const registry = {
      pool: () => [gemma, luna, deep],
      all: () => [gemma, luna, deep],
    } as unknown as ModelRegistry;
    const router = new Router(
      new RoutingStrategyRegistry(),
      routing,
      new TargetStatsRegistry(),
      { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 },
    );

    const served: string[] = [];
    const clients = {
      for: (endpointId: string) => ({
        endpointId,
        complete: async (t: ModelTarget) => {
          served.push(t.modelId);
          return {
            text: 'ok',
            finishReason: 'stop' as const,
            usage: { ...EMPTY_USAGE },
            reportedModel: t.modelName,
            latencyMs: 1,
          };
        },
      }),
    } as unknown as LlmClientFactory;

    const gateway = new LlmGateway(
      registry,
      router,
      clients,
      new CircuitBreakerRegistry({ enabled: false, failureThreshold: 5, resetAfterMs: 1000, halfOpenMaxCalls: 1 }),
      laneRegistry,
      new TargetStatsRegistry(),
      { assertAvailable: () => {}, record: () => {} } as unknown as BudgetGuard,
      reliabilitySchema.parse({}),
    );
    return { gateway, lanes: laneRegistry, served };
  }

  const call = () =>
    ({
      pipeline: 'translate',
      pool: 'translate',
      variant: 'de',
      estimatedInputTokens: 100,
      expectedOutputTokens: 100,
    }) as const;

  it('uses the preferred model when it is free', async () => {
    const { gateway, served } = build(50);
    await gateway.complete({ messages: [{ role: 'user', content: 'x' }] }, call());
    expect(served).toEqual(['gpt-luna']);
  });

  it('waits for the preferred model rather than taking a free one straight away', async () => {
    const { gateway, lanes: registry, served } = build(500);
    const held = await occupy(registry, luna);
    setTimeout(held, 40); // frees well inside the budget

    await gateway.complete({ messages: [{ role: 'user', content: 'x' }] }, call());
    expect(served).toEqual(['gpt-luna']);
  });

  it('widens to the rest of the pool once the budget is spent', async () => {
    const { gateway, lanes: registry, served } = build(40);
    const held = await occupy(registry, luna); // never released in time

    await gateway.complete({ messages: [{ role: 'user', content: 'x' }] }, call());

    // gemma-local, never deepseek: the exclusion outranks availability.
    expect(served).toEqual(['gemma-local']);
    held();
  });

  it('waits for the first allowed model when nothing at all is free', async () => {
    // The correction that matters: an expired wait widens the choice, and if the
    // wider choice is busy too the call queues for it. It never fails, and it
    // never reaches for the excluded model however free that one is.
    const { gateway, lanes: registry, served } = build(30);
    const holdLuna = await occupy(registry, luna);
    const holdGemma = await occupy(registry, gemma);
    setTimeout(holdGemma, 80);

    await gateway.complete({ messages: [{ role: 'user', content: 'x' }] }, call());

    expect(served).toEqual(['gemma-local']);
    holdLuna();
  });
});
