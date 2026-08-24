import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import { routingSchema, type AppConfigInput, type EndpointConfig } from '../src/config/schema.js';
import { AttemptScope } from '../src/core/AttemptScope.js';
import { markdownSkeleton } from '../src/documents/markdown/skeleton.js';
import {
  applyTextSpans,
  escapeBlockMarker,
  extractTextSpans,
  structuralDrift,
} from '../src/documents/markdown/textSpans.js';
import type { GatewayCallOptions, GatewayResult, LlmPort } from '../src/llm/LlmGateway.js';
import type { CompletionRequest, CompletionResponse, LlmClient, ModelTarget } from '../src/llm/types.js';
import { AllTargetsFailedError, LlmCallError } from '../src/reliability/index.js';
import { Router } from '../src/routing/Router.js';
import { RoutingStrategyRegistry } from '../src/routing/StrategyRegistry.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import { Workspace, echoTable, isStringBatch, respond } from './helpers/workspace.js';

/**
 * Fallback for the failure the gateway cannot see: every call returned 200 and
 * the answer they add up to is unusable.
 */

// --- the fragment-level guard ---------------------------------------------

describe('structural drift in one fragment', () => {
  const paragraph = extractTextSpans(':::lead\nОн родился в Москве.\n:::\n').find((s) => s.kind === 'paragraph')!;

  /**
   * Structure the model invented, which nothing local can settle: the answer
   * has to be re-asked. A *list marker* is the other case and is escaped
   * instead — see the collision block below.
   */
  it.each([
    ['a heading', '## He was born in Moscow.', 'h2'],
    ['a block quote', '> He was born in Moscow.', 'quote'],
  ])('rejects %s', (_name, answer, token) => {
    expect(structuralDrift(paragraph, answer)).toContain(token);
  });

  it('rejects an answer split over two lines (belousov -> es)', () => {
    expect(structuralDrift(paragraph, 'He was born.\nIn Moscow.')).toMatch(/one line/);
  });

  it('accepts a translation that is only different words', () => {
    expect(structuralDrift(paragraph, 'He was born in Moscow.')).toBeUndefined();
  });

  /**
   * A list item's marker never crossed the wire, so its text may begin however
   * it likes — the line is already a list item and stays one.
   */
  it('leaves a list item alone', () => {
    const item = extractTextSpans('- пункт списка\n').find((s) => s.kind === 'listItem')!;
    expect(structuralDrift(item, '1. list item')).toBeUndefined();
  });
});

/**
 * The case no model can be asked its way out of: an ordinal date is correct in
 * German and is also a list marker in CommonMark. `blackmore -> de` failed on
 * exactly one fragment, nine times across three models, all of them right.
 */
describe('a translation that collides with Markdown', () => {
  const doc = '## Даты\n\n27 марта 2002 г.\n\nОбычный абзац.\n';
  const spans = extractTextSpans(doc);
  const date = spans.find((s) => s.text.startsWith('27'))!;

  it('accepts the correct German rather than re-asking for a worse answer', () => {
    expect(structuralDrift(date, '27. März 2002')).toBeUndefined();
  });

  it('escapes the marker at the splice, so the line stays prose', () => {
    const out = applyTextSpans(doc, spans, new Map([[date.text, '27. März 2002']]));
    expect(out).toContain('27\\. März 2002');
    expect(markdownSkeleton(out)).toEqual(markdownSkeleton(doc));
  });

  it('escapes a bullet the same way', () => {
    expect(escapeBlockMarker(date, '- 27 March 2002')).toBe('\\- 27 March 2002');
  });

  /** Invented structure is not a collision, and is still re-asked. */
  it('does not escape its way out of an invented heading', () => {
    expect(structuralDrift(date, '## 27. März 2002')).toMatch(/h2/);
    expect(escapeBlockMarker(date, '## 27. März 2002')).toBe('## 27. März 2002');
  });
});

// --- routing ---------------------------------------------------------------

function endpoint(id: string): EndpointConfig {
  return {
    id,
    baseUrl: `http://${id}/v1`,
    apiKey: '',
    headers: {},
    query: {},
    maxConcurrent: 1,
    requestsPerMinute: 0,
    minRequestSpacingMs: 0,
    stream: false,
    enabled: true,
  };
}

function target(modelId: string, ep: EndpointConfig, inputPer1M = 0): ModelTarget {
  return {
    key: `${ep.id}:${modelId}`,
    modelId,
    endpointId: ep.id,
    modelName: modelId,
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

const a = target('a', endpoint('e1'), 0);
const b = target('b', endpoint('e2'), 1);
const c = target('c', endpoint('e3'), 2);
const CHAIN = [a, b, c];

function router(routing: Record<string, unknown> = {}): Router {
  return new Router(
    new RoutingStrategyRegistry(),
    routingSchema.parse({ strategy: 'cost-optimized', ...routing }),
    new TargetStatsRegistry(),
    { reserveOutputTokens: 1024, safetyMarginRatio: 0.9 },
  );
}

const request = (overrides: Record<string, unknown> = {}) =>
  ({
    pipeline: 'translate',
    pool: 'translate',
    estimatedInputTokens: 1000,
    expectedOutputTokens: 512,
    requiredCapabilities: [],
    ...overrides,
  }) as Parameters<Router['select']>[1];

describe('avoiding what already failed the task', () => {
  it('leads with a model this task has not used', () => {
    const ranked = router().select(CHAIN, request({ avoid: new Set(['e1:a']) }));
    expect(ranked.map((t) => t.modelId)).toEqual(['b', 'c', 'a']);
  });

  /** Demotion, not exclusion: the chain behind it is still the fallback chain. */
  it('keeps the avoided model as the last resort', () => {
    const ranked = router().select(CHAIN, request({ avoid: new Set(['e1:a', 'e2:b']) }));
    expect(ranked.map((t) => t.modelId)).toEqual(['c', 'a', 'b']);
  });

  it('changes nothing once every model has been tried', () => {
    const ranked = router().select(CHAIN, request({ avoid: new Set(['e1:a', 'e2:b', 'e3:c']) }));
    expect(ranked.map((t) => t.modelId)).toEqual(['a', 'b', 'c']);
  });

  /**
   * `prefer` is a claim about quality; a model that has just produced a broken
   * answer *for this task* is evidence, and evidence wins.
   */
  it('outranks a language preference', () => {
    const routing = { pools: { translate: { models: ['a', 'b', 'c'], prefer: { de: ['a'] } } } };
    const preferred = router(routing).select(CHAIN, request({ variant: 'de' }));
    expect(preferred[0]?.modelId).toBe('a');

    const avoided = router(routing).select(CHAIN, request({ variant: 'de', avoid: new Set(['e1:a']) }));
    expect(avoided.map((t) => t.modelId)).toEqual(['b', 'c', 'a']);
  });

  it('takes a per-call strategy override over the pool default', () => {
    const routing = { pools: { translate: { models: ['a', 'b', 'c'], strategy: 'cost-optimized' } } };
    expect(router(routing).select(CHAIN, request()).map((t) => t.modelId)).toEqual(['a', 'b', 'c']);
    expect(router(routing).select(CHAIN, request({ strategy: 'round-robin' })).map((t) => t.modelId)).toHaveLength(3);
  });
});

// --- the scope -------------------------------------------------------------

describe('one attempt at a task', () => {
  const options: GatewayCallOptions = { pipeline: 'translate', estimatedInputTokens: 10, expectedOutputTokens: 10 };
  const anyRequest = { messages: [] } as unknown as CompletionRequest;

  function port(result: Partial<GatewayResult> | Error): LlmPort & { seen: GatewayCallOptions[] } {
    const seen: GatewayCallOptions[] = [];
    return {
      seen,
      async complete(_request: CompletionRequest, opts: GatewayCallOptions) {
        seen.push(opts);
        if (result instanceof Error) throw result;
        return result as GatewayResult;
      },
      plan(opts: GatewayCallOptions) {
        seen.push(opts);
        return [];
      },
    };
  }

  it('carries the tuning into every call the task makes', async () => {
    const inner = port({ attempts: [{ target: 'e1:a' }] } as unknown as GatewayResult);
    const scope = new AttemptScope(inner, { avoid: new Set(['e2:b']), temperature: 0.1 });

    await scope.complete(anyRequest, options);
    scope.plan(options);

    expect(inner.seen.every((o) => o.tuning?.temperature === 0.1)).toBe(true);
    expect([...(inner.seen[0]?.tuning?.avoid ?? [])]).toEqual(['e2:b']);
  });

  it('remembers who answered, for the next attempt to avoid', async () => {
    const inner = port({ attempts: [{ target: 'e1:a' }, { target: 'e2:b' }] } as unknown as GatewayResult);
    const scope = new AttemptScope(inner, {});
    await scope.complete(anyRequest, options);
    expect([...scope.used]).toEqual(['e1:a', 'e2:b']);
  });

  it('remembers who was asked even when the whole chain failed', async () => {
    const inner = port(new AllTargetsFailedError('nope', [new LlmCallError('server', 'boom', { target: 'e1:a' })]));
    const scope = new AttemptScope(inner, {});
    await expect(scope.complete(anyRequest, options)).rejects.toThrow();
    expect([...scope.used]).toEqual(['e1:a']);
  });

  it('knows whether it got as far as asking anybody', async () => {
    const scope = new AttemptScope(port({ attempts: [] } as unknown as GatewayResult), {});
    expect(scope.calledModel).toBe(false);
    await scope.complete(anyRequest, options);
    expect(scope.calledModel).toBe(true);
  });
});

// --- end to end ------------------------------------------------------------

const ARTICLE = [
  '# Пако де Лусия',
  '',
  '::: lead',
  '',
  'Испанский гитарист и композитор.',
  '',
  ':::',
  '',
  'Первые уроки Пако получил в семье, в Альхесирасе.',
  '',
].join('\n');

const LLM: AppConfigInput['llm'] = {
  endpoints: [
    { id: 'e1', baseUrl: 'http://e1/v1', maxConcurrent: 1 },
    { id: 'e2', baseUrl: 'http://e2/v1', maxConcurrent: 1 },
  ],
  models: [
    { id: 'sloppy', endpoint: 'e1', model: 'sloppy', pricing: { inputPer1M: 0, outputPer1M: 0 } },
    { id: 'careful', endpoint: 'e2', model: 'careful', pricing: { inputPer1M: 1, outputPer1M: 1 } },
  ],
  // `cost-optimized` puts the free `sloppy` first for everything, which is what
  // makes this a test: the model that breaks the document is the one chosen.
  routing: { strategy: 'cost-optimized', pools: { default: ['sloppy', 'careful'] } },
};

const SETTINGS = (maxAttempts: number): Partial<AppConfigInput> => ({
  llm: LLM,
  tasks: {
    extract: { enabled: false },
    websearch: { enabled: false },
    localize: { enabled: false },
    portrait: { enabled: false },
    catalog: { enabled: false },
    translate: { enabled: true, targetLanguages: ['en'], verifyStructure: 'strict' },
  },
  input: { baseDir: 'corpus', include: ['ru/paco.bio.md'], sourceLanguage: 'auto' },
  output: { baseDir: 'out' },
  reliability: { taskFallback: { maxAttempts, lastAttempt: { temperature: 0.1 } } },
  run: { concurrency: 1, stateDir: '.biomd/runs', resume: 'off', skipExistingOutputs: false },
});

/**
 * Answers every fragment with a bullet in front of it — the real `bitetti -> en`
 * failure. Every call returns 200 and the document is ruined.
 *
 * `careless` names the models that do it, and `settles` the temperature at
 * which they stop: a model asked more literally is the last thing left to try
 * once nobody in the pool is left untried.
 */
class Careless implements LlmClient {
  readonly endpointId = 'probe';
  readonly served: string[] = [];
  readonly temperatures: (number | undefined)[] = [];

  constructor(
    private readonly careless: readonly string[],
    private readonly settles?: number,
  ) {}

  async complete(model: ModelTarget, request: CompletionRequest): Promise<CompletionResponse> {
    this.served.push(model.modelId);
    const temperature = request.params?.temperature;
    this.temperatures.push(temperature);
    if (!isStringBatch(request)) return respond('# Paco de Lucia\n');

    const behaves = this.settles !== undefined && temperature === this.settles;
    const sloppy = this.careless.includes(model.modelId) && !behaves;
    // A heading, not a bullet: a stray list marker is escaped at the splice
    // now, so it never reaches the task at all. Invented structure does.
    return respond(sloppy ? echoTable(request, (text) => `## ${text}`) : echoTable(request));
  }
}

let workspace: Workspace;

beforeEach(async () => {
  workspace = await Workspace.create();
  await workspace.writeDefaultPrompts();
  await workspace.writeFile('corpus/ru/paco.bio.md', ARTICLE);
});

afterEach(async () => {
  await workspace.destroy();
});

describe('a task whose answer was wrong', () => {
  /**
   * The cheap half of the fix, and the one that settles the three real
   * failures: a fragment that would change its line's shape is caught *as a
   * fragment*, so it is repaired — or falls back to another model — inside the
   * call it belongs to. The task never reaches its own structure guard, and no
   * attempt is spent. Task fallback is switched off here to prove it.
   */
  it('repairs invented structure without re-running the task', async () => {
    const client = new Careless(['sloppy']);
    const outcome = await runJob(workspace.app(SETTINGS(1), client));

    expect(outcome.summary.totals.tasksFailed).toBe(0);
    expect(client.served).toContain('careful');
  });

  /**
   * The half that catches what the first cannot foresee. Every model in the
   * pool answers badly, so there is no fresh target left and the ordinary
   * fallback chain has nothing to offer — the last attempt changes *how* it
   * asks instead of whom, and the run finishes with an edition on disk.
   */
  it('runs the task again at a lower temperature when every model answers badly', async () => {
    const client = new Careless(['sloppy', 'careful'], 0.1);
    const outcome = await runJob(workspace.app(SETTINGS(3), client));

    expect(outcome.summary.totals.tasksFailed).toBe(0);
    expect(client.temperatures).toContain(0.1);
    // Only the last attempt lowers it: until then a different model is the
    // better answer than the same model asked differently.
    expect(client.temperatures[0]).not.toBe(0.1);
  });

  it('gives up as it used to when task fallback is switched off', async () => {
    const client = new Careless(['sloppy', 'careful'], 0.1);
    const outcome = await runJob(workspace.app(SETTINGS(1), client));

    expect(outcome.summary.totals.tasksFailed).toBe(1);
    expect(client.temperatures).not.toContain(0.1);
  });
});
