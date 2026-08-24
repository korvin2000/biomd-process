import { describe, expect, it } from 'vitest';

import { modelSchema, providerRoutingSchema } from '../src/config/schema.js';
import { buildRequestBody, toWireProvider } from '../src/llm/OpenAiCompatibleClient.js';
import type { EndpointConfig } from '../src/config/schema.js';
import type { ModelTarget } from '../src/llm/types.js';

/**
 * Naming the providers that may serve a model, and sending the two samplers
 * that are not OpenAI fields.
 *
 * The failure this prevents leaves no trace: OpenRouter serves one model id
 * from twenty-nine hosts whose `supported_parameters` differ, and a host that
 * does not implement `min_p` answers 200 with the field ignored. `top_k` and
 * `min_p` therefore have to reach the wire *and* the request has to be able to
 * say "only a provider that implements these".
 */

const endpoint: EndpointConfig = {
  id: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'k',
  headers: {},
  query: {},
  maxConcurrent: 3,
  requestsPerMinute: 0,
  minRequestSpacingMs: 0,
  stream: false,
  enabled: true,
};

function target(overrides: Partial<ModelTarget> = {}): ModelTarget {
  return {
    key: 'openrouter:or-cheap',
    modelId: 'or-cheap',
    endpointId: 'openrouter',
    modelName: 'deepseek/deepseek-v4-flash-0731',
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M: 0.07, outputPer1M: 0.17 },
    capabilities: [],
    reasoning: { enabled: false, effort: 'medium', dialect: 'none', exclude: true },
    tags: [],
    weight: 1,
    params: {},
    provider: { order: [], only: [], ignore: [], quantizations: [] },
    timeoutMs: 1000,
    endpoint,
    ...overrides,
  };
}

const request = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('toWireProvider', () => {
  it('sends nothing at all when nothing is configured', () => {
    // An endpoint that has never heard of the field must not receive an empty
    // object either — this is what keeps the block free for every other gateway.
    expect(toWireProvider({ order: [], only: [], ignore: [], quantizations: [] })).toBeUndefined();
  });

  it('translates the config names into the gateway names', () => {
    expect(
      toWireProvider({
        order: ['deepinfra/fp8', 'ambient/fp4'],
        only: [],
        ignore: ['relace/fp4'],
        quantizations: ['fp8', 'bf16'],
        allowFallbacks: false,
        requireParameters: true,
        sort: 'throughput',
      }),
    ).toEqual({
      order: ['deepinfra/fp8', 'ambient/fp4'],
      ignore: ['relace/fp4'],
      quantizations: ['fp8', 'bf16'],
      allow_fallbacks: false,
      require_parameters: true,
      sort: 'throughput',
    });
  });

  it('keeps allowFallbacks: false, which is a value and not an absence', () => {
    const wire = toWireProvider({ order: ['x'], only: [], ignore: [], quantizations: [], allowFallbacks: false });
    expect(wire).toHaveProperty('allow_fallbacks', false);
  });
});

describe('buildRequestBody', () => {
  it('puts top_k and min_p on the wire under their real names', () => {
    const body = buildRequestBody(target(), { ...request, params: { temperature: 0.6, topP: 0.9, topK: 40, minP: 0.02 } }, false);
    expect(body).toMatchObject({ temperature: 0.6, top_p: 0.9, top_k: 40, min_p: 0.02 });
  });

  it('omits a sampler that was never set', () => {
    const body = buildRequestBody(target(), { ...request, params: { temperature: 0.6 } }, false);
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('min_p');
    expect(body).not.toHaveProperty('provider');
  });

  it('carries topK: 0 through, because 0 means "no cutoff" rather than "unset"', () => {
    const body = buildRequestBody(target(), { ...request, params: { topK: 0 } }, false);
    expect(body).toHaveProperty('top_k', 0);
  });

  it('attaches the provider block from the model config', () => {
    const body = buildRequestBody(
      target({ provider: { order: ['deepinfra/fp8'], only: [], ignore: [], quantizations: [], requireParameters: true } }),
      request,
      false,
    );
    expect(body['provider']).toEqual({ order: ['deepinfra/fp8'], require_parameters: true });
  });

  it('still lets params.extra override the block, which is what an escape hatch is for', () => {
    const body = buildRequestBody(
      target({
        provider: { order: ['deepinfra/fp8'], only: [], ignore: [], quantizations: [] },
        params: { extra: { provider: { only: ['together'] } } },
      }),
      request,
      false,
    );
    expect(body['provider']).toEqual({ only: ['together'] });
  });
});

describe('the provider config itself', () => {
  it('defaults to empty lists, so an existing model config is unchanged', () => {
    const model = modelSchema.parse({ id: 'm', endpoint: 'e', model: 'x/y' });
    expect(model.provider).toEqual({ order: [], only: [], ignore: [], quantizations: [] });
    expect(toWireProvider(model.provider)).toBeUndefined();
  });

  it('reads a provider list and the two flags that make it mean something', () => {
    const parsed = providerRoutingSchema.parse({
      order: ['deepinfra/fp8', 'ambient/fp4', 'together'],
      allowFallbacks: false,
      requireParameters: true,
    });
    expect(parsed.order).toHaveLength(3);
    expect(parsed.requireParameters).toBe(true);
  });

  it('rejects a slug that is both required and forbidden', () => {
    const result = providerRoutingSchema.safeParse({ order: ['deepinfra/fp8'], ignore: ['deepinfra/fp8'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/both "order" and "ignore"/);
  });

  it('rejects a min_p outside the unit interval before a run spends anything', () => {
    expect(modelSchema.safeParse({ id: 'm', endpoint: 'e', model: 'x/y', params: { minP: 3 } }).success).toBe(false);
    expect(modelSchema.safeParse({ id: 'm', endpoint: 'e', model: 'x/y', params: { topK: -5 } }).success).toBe(false);
  });
});
