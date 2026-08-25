import { describe, expect, it } from 'vitest';

import { routingSchema } from '../src/config/schema.js';
import type { ModelTarget } from '../src/llm/types.js';
import { Router } from '../src/routing/Router.js';
import { RoutingStrategyRegistry } from '../src/routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import type { OccupancyView } from '../src/routing/types.js';
import { adaptive } from '../src/routing/strategies/adaptive/AdaptiveStrategy.js';
import { complexityOf, scoreComplexity } from '../src/routing/strategies/adaptive/ComplexityScorer.js';
import { profileFor, profiledModelIds } from '../src/routing/strategies/adaptive/ModelProfiles.js';

function target(modelId: string, overrides: Partial<ModelTarget> = {}): ModelTarget {
  return {
    key: `${overrides.endpointId ?? 'openrouter'}:${modelId}`,
    modelId,
    endpointId: 'openrouter',
    modelName: modelId,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M: 1, outputPer1M: 2 },
    capabilities: [],
    reasoning: { enabled: false, effort: 'medium', dialect: 'reasoning', exclude: true },
    tags: [],
    weight: 1,
    params: {},
    timeoutMs: 120_000,
    endpoint: {
      id: overrides.endpointId ?? 'openrouter',
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

const deepseek = target('deepseek', { pricing: { inputPer1M: 0.08, outputPer1M: 0.18 } });
const minimax = target('minimax-m3', { pricing: { inputPer1M: 0.3, outputPer1M: 1.2 } });
const minimaxFree = target('minimax-m3-free', { pricing: { inputPer1M: 0, outputPer1M: 0 } });
const luna = target('gpt-luna', { endpointId: 'omniroute', pricing: { inputPer1M: 0, outputPer1M: 0 } });
const gemma = target('gemma-local', { endpointId: 'local', pricing: { inputPer1M: 0, outputPer1M: 0 } });

const fitting = { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 };

/** An occupancy view stated as "this endpoint is this full", 0…1. */
function occupancy(loads: Record<string, number> = {}): OccupancyView {
  return {
    load: (_pool, t) => loads[t.endpointId] ?? 0,
    freeSlots: (_pool, t) => (loads[t.endpointId] === 1 ? 0 : Number.POSITIVE_INFINITY),
    inFlight: () => 0,
  };
}

function makeRouter(stats = new TargetStatsRegistry(), loads: Record<string, number> = {}): Router {
  return new Router(
    new RoutingStrategyRegistry().register(adaptive),
    routingSchema.parse({ strategy: 'adaptive' }),
    stats,
    fitting,
    occupancy(loads),
  );
}

const ask = (complexity?: number) => ({
  pipeline: 'translate',
  estimatedInputTokens: 2000,
  expectedOutputTokens: 2000,
  requiredCapabilities: [],
  ...(complexity === undefined ? {} : { signals: { complexity } }),
});

describe('the complexity scorer', () => {
  const plain = 'Родился в Москве в 1939 году. Учился у известного педагога и много концертировал.';

  it('scores clean prose low and the same prose wrapped in markup high', () => {
    const tangled = [
      '::: image',
      'src: photo/b/brouwer.jpg',
      'position: right',
      'size: small',
      'caption: Лео Брауэр на обложке "Classical Guitar"',
      ':::',
      '| Musica Incidental | [MIDI](music/midi/brouwer.mid) |',
      '**Juan Leovigildo Brouwer** — ⟦1⟧ и ⟦2⟧',
    ].join('\n');

    expect(complexityOf(plain)).toBeLessThan(0.2);
    expect(complexityOf(tangled)).toBeGreaterThan(0.4);
  });

  it('does not punish a document for being long', () => {
    // The corpus comparison this scorer is built on found no length effect at
    // all: broken documents had a median 2899 chars against 2910 for clean ones.
    const short = complexityOf(plain);
    const long = complexityOf(Array.from({ length: 40 }, () => plain).join('\n\n'));
    expect(Math.abs(long - short)).toBeLessThan(0.05);
  });

  it('counts script mixing by the minority share, in either direction', () => {
    const cyrillic = complexityOf('Родился в Москве и учился в консерватории у педагога.');
    const mixed = complexityOf('Родился Juan Leovigildo Brouwer, Classical Guitar Review, Habana.');
    expect(mixed).toBeGreaterThan(cyrillic);
  });

  it('stays inside 0…1 and survives an empty document', () => {
    expect(complexityOf('')).toBe(0);
    const extreme = complexityOf('::: a\nb: c\n:::\n'.repeat(200));
    expect(extreme).toBeGreaterThanOrEqual(0);
    expect(extreme).toBeLessThanOrEqual(1);
  });

  it('reports which feature carried the score', () => {
    const { parts } = scoreComplexity('src: photo.jpg\ncaption: Une photo\n');
    expect(parts['containerKv']).toBeGreaterThan(0);
    expect(parts['tableRows']).toBe(0);
  });
});

describe('the model profiles', () => {
  it('gives an unknown model the neutral stance rather than excluding it', () => {
    const unknown = profileFor('something-nobody-measured');
    expect(unknown.tolerance).toBe(0.5);
  });

  it('separates the two models this deployment cares about', () => {
    expect(profileFor('deepseek').tolerance).toBeLessThan(profileFor('minimax-m3').tolerance);
  });

  it('rates the free tier below the paid one it shares a name with', () => {
    // Not the same deployment: the free variant is served by a single fp8 host
    // and does not advertise `structured_outputs`, so it holds a table together
    // less reliably than the paid one. Same model name, different profile.
    expect(profileFor('minimax-m3-free').tolerance).toBeLessThan(profileFor('minimax-m3').tolerance);
    expect(profiledModelIds()).toContain('minimax-m3-free');
  });
});

describe('the adaptive strategy', () => {
  it('prefers the cheap model on a clean document', () => {
    const order = makeRouter().select([deepseek, minimax], { ...ask(0.05), pool: 'p' });
    expect(order[0]!.modelId).toBe('deepseek');
  });

  it('moves a tangled document to the model that holds structure together', () => {
    const order = makeRouter().select([deepseek, minimax], { ...ask(0.95), pool: 'p' });
    expect(order[0]!.modelId).toBe('minimax-m3');
  });

  it('leaves the loser as the fallback rather than removing it', () => {
    const order = makeRouter().select([deepseek, minimax], { ...ask(0.95), pool: 'p' });
    expect(order.map((t) => t.modelId)).toEqual(['minimax-m3', 'deepseek']);
  });

  it('pays for the paid tier on a tangled document and takes the free one on a clean one', () => {
    const hard = makeRouter().select([minimax, minimaxFree], { ...ask(0.9), pool: 'p' });
    expect(hard[0]!.modelId).toBe('minimax-m3');
    const easy = makeRouter().select([minimax, minimaxFree], { ...ask(0.1), pool: 'p' });
    expect(easy[0]!.modelId).toBe('minimax-m3-free');
  });

  it('demotes a target that is failing right now, whatever the document', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 6; i += 1) stats.recordFailure(minimax.key);
    const order = makeRouter(stats).select([deepseek, minimax], { ...ask(0.95), pool: 'p' });
    expect(order[0]!.modelId).toBe('deepseek');
  });

  it('does not let one lucky fast call hand over the corpus', () => {
    const stats = new TargetStatsRegistry();
    // One enormous, instant response for the model that is otherwise slower.
    stats.recordSuccess(minimax.key, 100, 0, 100_000);
    const order = makeRouter(stats).select([deepseek, minimax], { ...ask(0.05), pool: 'p' });
    // Shrinkage towards the prior keeps the clean-document answer unchanged.
    expect(order[0]!.modelId).toBe('deepseek');
  });

  it('lets a sustained speed difference through once the window fills', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 8; i += 1) {
      stats.recordSuccess(minimax.key, 1000, 0, 20_000);
      stats.recordSuccess(deepseek.key, 20_000, 0, 1000);
    }
    const order = makeRouter(stats).select([deepseek, minimax], { ...ask(0.5), pool: 'p' });
    expect(order[0]!.modelId).toBe('minimax-m3');
  });

  it('ranks only within the least-loaded tier and never queues on a full endpoint', () => {
    // openrouter saturated, omniroute idle: the omniroute target leads even
    // though the scorer would otherwise rank the openrouter ones above it.
    const order = makeRouter(new TargetStatsRegistry(), { openrouter: 1, omniroute: 0, local: 0.5 }).select(
      [deepseek, minimax, luna],
      { ...ask(0.9), pool: 'p' },
    );
    expect(order[0]!.modelId).toBe('gpt-luna');
    expect(order.map((t) => t.modelId)).toHaveLength(3);
  });

  it('orders the busy remainder by how busy it is', () => {
    const order = makeRouter(new TargetStatsRegistry(), { omniroute: 0, local: 0.5, openrouter: 0.9 }).select(
      [deepseek, gemma, luna],
      { ...ask(0.5), pool: 'p' },
    );
    expect(order.map((t) => t.modelId)).toEqual(['gpt-luna', 'gemma-local', 'deepseek']);
  });

  it('is deterministic: the same inputs give the same chain', () => {
    const stats = new TargetStatsRegistry();
    stats.recordSuccess(deepseek.key, 5000, 0.01, 3000);
    const first = makeRouter(stats).select([deepseek, minimax, minimaxFree], { ...ask(0.4), pool: 'p' });
    const second = makeRouter(stats).select([deepseek, minimax, minimaxFree], { ...ask(0.4), pool: 'p' });
    expect(first.map((t) => t.key)).toEqual(second.map((t) => t.key));
  });

  it('falls back to health and cost when no complexity was measured', () => {
    const order = makeRouter().select([deepseek, minimax], { ...ask(), pool: 'p' });
    expect(order[0]!.modelId).toBe('deepseek');
  });
});

describe('the rolling window', () => {
  it('keeps only the last four successes', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 1; i <= 6; i += 1) stats.recordSuccess('t', 1000, 0, i * 1000);
    expect(stats.get('t').recent.map((c) => c.totalTokens)).toEqual([3000, 4000, 5000, 6000]);
  });

  it('ignores a success with no usage rather than recording it as zero throughput', () => {
    const stats = new TargetStatsRegistry();
    stats.recordSuccess('t', 1000, 0);
    expect(stats.get('t').recent).toHaveLength(0);
    expect(stats.get('t').successes).toBe(1);
  });
});
