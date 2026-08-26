import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import type { AppConfigInput } from '../src/config/schema.js';
import { echoTable, isStringBatch, respond, FakeClient, Workspace } from './helpers/workspace.js';
import { TargetStatsRegistry } from '../src/routing/TargetStats.js';
import { scoreTargets } from '../src/routing/strategies/adaptive/AdaptiveStrategy.js';
import type { ModelTarget } from '../src/llm/types.js';
import type { RoutingContext } from '../src/routing/types.js';
import { scoreComplexity } from '../src/routing/strategies/adaptive/ComplexityScorer.js';

/**
 * The `adaptive` strategy driven end to end over a corpus, with no network.
 *
 * This exists because the alternative was measuring it against live paid
 * endpoints, and that turned out to be both expensive and a bad instrument: a
 * live run reports the split it produced and nothing about why, so every
 * hypothesis costs another run and four of them in a row came back "deepseek
 * took everything" for four unrelated reasons. Here the whole scheduler runs —
 * `runJob`, the real Router, the real lanes, the real gateway — against a
 * provider that answers instantly and deterministically, and every decision is
 * inspectable.
 *
 * What the fake reproduces is the one thing the strategy actually reads:
 * generated tokens per second, at the rates measured from OpenRouter's own
 * activity log (deepseek 90.5, minimax-m3 154.5, minimax-m3-free 81.9 median
 * tok/s) and this repo's run journals. It does *not* sleep for the modelled
 * duration — it reports it, which is what the gateway records and what a test
 * suite can afford.
 */

/** Generated tokens/sec per model, from measurement. See `ModelProfiles.ts`. */
const SPEED: Record<string, number> = {
  'gemma-local': 53,
  'gpt-luna': 51,
  deepseek: 81,
  'minimax-m3': 127,
  'minimax-m3-free': 78,
};

const ENDPOINT_OF: Record<string, string> = {
  'gemma-local': 'local',
  'gpt-luna': 'omniroute',
  deepseek: 'openrouter',
  'minimax-m3': 'openrouter',
  'minimax-m3-free': 'openrouter',
};

function poolConfig(): AppConfigInput {
  return {
    llm: {
      endpoints: [
        { id: 'local', baseUrl: 'http://localhost:9/v1', maxConcurrent: 1 },
        { id: 'omniroute', baseUrl: 'http://localhost:9/v1', apiKey: 'x', maxConcurrent: 3 },
        { id: 'openrouter', baseUrl: 'http://localhost:9/v1', apiKey: 'x', maxConcurrent: 4 },
      ],
      models: [
        {
          id: 'gemma-local',
          endpoint: 'local',
          model: 'gemma4-31b-local',
          contextWindow: 65_536,
          maxOutputTokens: 16_384,
          capabilities: ['json_object'],
          pricing: { inputPer1M: 0, outputPer1M: 0 },
        },
        {
          id: 'gpt-luna',
          endpoint: 'omniroute',
          model: 'cx/gpt-5.6-luna',
          contextWindow: 272_000,
          maxOutputTokens: 32_768,
          capabilities: ['json_object'],
          pricing: { inputPer1M: 0, outputPer1M: 0 },
        },
        {
          id: 'deepseek',
          endpoint: 'openrouter',
          model: 'deepseek/deepseek-v4-flash-0731',
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
          capabilities: ['json_object'],
          pricing: { inputPer1M: 0.08, outputPer1M: 0.18 },
        },
        {
          id: 'minimax-m3',
          endpoint: 'openrouter',
          model: 'minimax/minimax-m3',
          contextWindow: 262_144,
          maxOutputTokens: 32_768,
          capabilities: ['json_object'],
          pricing: { inputPer1M: 0.3, outputPer1M: 1.2 },
        },
        {
          id: 'minimax-m3-free',
          endpoint: 'openrouter',
          model: 'minimax/minimax-m3:free',
          contextWindow: 262_144,
          maxOutputTokens: 32_768,
          capabilities: ['json_object'],
          pricing: { inputPer1M: 0, outputPer1M: 0 },
        },
      ],
      routing: {
        strategy: 'cost-optimized',
        pools: {
          translate: {
            models: ['gemma-local', 'gpt-luna', 'deepseek', 'minimax-m3', 'minimax-m3-free'],
            strategy: 'adaptive',
            maxConcurrent: { local: 1, omniroute: 3, openrouter: 4 },
          },
        },
      },
    },
    tasks: {
      extract: { enabled: false },
      websearch: { enabled: false },
      localize: { enabled: false },
      portrait: { enabled: false },
      catalog: { enabled: false },
      translate: {
        enabled: true,
        pool: 'translate',
        targetLanguages: ['en', 'fr', 'es', 'de', 'it'],
        mode: 'segments',
        useTranslationMemory: 'off',
      },
    },
    run: { concurrency: 8, stateDir: '.biomd/runs', resume: 'off' },
  } as AppConfigInput;
}

/** Answers a batch and reports the latency the modelled speed implies. */
function speedAwareClient(): FakeClient {
  return new FakeClient((call) => {
    const text = isStringBatch(call.request) ? echoTable(call.request) : '';
    const completionTokens = Math.max(50, Math.ceil(text.length / 3.2));
    const promptTokens = Math.max(100, Math.ceil(JSON.stringify(call.request.messages).length / 3.2));
    const rate = SPEED[call.target] ?? 60;
    return respond(text, {
      latencyMs: Math.round((completionTokens / rate) * 1000),
      usage: {
        promptTokens,
        completionTokens,
        cachedPromptTokens: 0,
        cacheWritePromptTokens: 0,
        reasoningTokens: 0,
        totalTokens: promptTokens + completionTokens,
      },
    });
  });
}

/** Real articles when the repo has them, so the complexity scores are real ones. */
async function loadCorpus(limit: number): Promise<{ slug: string; text: string }[]> {
  for (const dir of ['input/ru', 'out/ru']) {
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.bio.md')).slice(0, limit);
      if (files.length === 0) continue;
      return await Promise.all(
        files.map(async (f) => ({ slug: f.replace('.bio.md', ''), text: await readFile(join(dir, f), 'utf8') })),
      );
    } catch {
      continue;
    }
  }
  return [];
}

describe('the adaptive strategy over a whole corpus', () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await Workspace.create();
    await workspace.writeDefaultPrompts();
  });

  afterEach(async () => {
    await workspace.destroy();
  });

  it('spreads a corpus across the pool instead of locking onto one target', async () => {
    const corpus = await loadCorpus(16);
    if (corpus.length === 0) return; // no corpus checked out; nothing to assert
    for (const doc of corpus) await workspace.writeFile(`corpus/ru/${doc.slug}.bio.md`, doc.text);

    const client = speedAwareClient();
    const app = workspace.app(poolConfig(), client);
    const outcome = await runJob(app);

    expect(outcome.summary.failures).toEqual([]);

    const byTarget = new Map<string, number>();
    for (const call of client.calls) byTarget.set(call.target, (byTarget.get(call.target) ?? 0) + 1);

    // Every member of the pool must see work. The bug this pins down is the one
    // four live runs showed: a target that is never tried keeps its profile
    // forever, so it is never tried — 51-0-0 across three models sharing an
    // endpoint. Two of them had nothing wrong with them.
    for (const modelId of Object.keys(SPEED)) {
      expect(byTarget.get(modelId) ?? 0, `${modelId} served no request`).toBeGreaterThan(0);
    }

    // …and no single target may swallow the corpus.
    const total = client.calls.length;
    for (const [modelId, n] of byTarget) {
      expect(n / total, `${modelId} took ${n}/${total}`).toBeLessThan(0.75);
    }
  });

  it('sends the openrouter share mostly to deepseek, with minimax holding a real slice', async () => {
    const corpus = await loadCorpus(16);
    if (corpus.length === 0) return;
    for (const doc of corpus) await workspace.writeFile(`corpus/ru/${doc.slug}.bio.md`, doc.text);

    const client = speedAwareClient();
    const app = workspace.app(poolConfig(), client);
    await runJob(app);

    const onOpenRouter = client.calls.filter((c) => ENDPOINT_OF[c.target] === 'openrouter');
    const share = (modelId: string): number =>
      onOpenRouter.filter((c) => c.target === modelId).length / Math.max(onOpenRouter.length, 1);

    expect(onOpenRouter.length).toBeGreaterThan(8);
    // Bands rather than points: the split is a property of this corpus's
    // complexity distribution, and a different set of articles moves it.
    expect(share('deepseek')).toBeGreaterThan(0.4);
    expect(share('minimax-m3')).toBeGreaterThan(0.05);
    expect(share('minimax-m3-free')).toBeGreaterThan(0);
  });

  it('measures the corpus it is being asked about', async () => {
    const corpus = await loadCorpus(16);
    if (corpus.length === 0) return;
    const scores = corpus.map((d) => scoreComplexity(d.text).score);
    // A scorer that rates everything the same is an expensive no-op; this is the
    // assertion that would have caught complexity being measured on stripped
    // prose, where the whole corpus collapsed to a near-constant 0.08.
    const spread = Math.max(...scores) - Math.min(...scores);
    expect(spread).toBeGreaterThan(0.2);
  });
});

describe('the split this corpus produces', () => {
  let workspace: Workspace;
  beforeEach(async () => {
    workspace = await Workspace.create();
    await workspace.writeDefaultPrompts();
  });
  afterEach(async () => { await workspace.destroy(); });

  // Writes its report beside the workspace rather than into the repo: a test
  // that leaves a file in the working tree turns `git status` into noise.
  it('reports the distribution', async () => {
    const corpus = await loadCorpus(16);
    expect(corpus.length).toBeGreaterThan(0);
    for (const doc of corpus) await workspace.writeFile(`corpus/ru/${doc.slug}.bio.md`, doc.text);
    const client = speedAwareClient();
    await runJob(workspace.app(poolConfig(), client));
    const by = new Map<string, number>();
    for (const c of client.calls) by.set(c.target, (by.get(c.target) ?? 0) + 1);
    const total = client.calls.length;
    const or = client.calls.filter((c) => ENDPOINT_OF[c.target] === 'openrouter').length;
    const lines = ['ALL TARGETS'];
    for (const [m, n] of [...by].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${m.padEnd(18)} ${String(n).padStart(3)}  ${((100 * n) / total).toFixed(1)}%`);
    }
    lines.push('', 'OPENROUTER SHARE');
    for (const m of ['deepseek', 'minimax-m3', 'minimax-m3-free']) {
      const n = by.get(m) ?? 0;
      lines.push(`  ${m.padEnd(18)} ${String(n).padStart(3)}  ${((100 * n) / or).toFixed(1)}%`);
    }
    await writeFile('C:/work.ai/biomd-process/.ab/split.txt', lines.join(String.fromCharCode(10)), 'utf8');
    expect(total).toBeGreaterThan(0);
  });
});

/**
 * What happens when a target starts refusing.
 *
 * The four live runs that shaped this strategy all completed with 0 retries and
 * 0 fallbacks, so none of the health machinery was ever exercised against a real
 * failure. These do it here, where a 429 costs nothing.
 */
describe('the adaptive strategy under failure', () => {
  let workspace: Workspace;
  beforeEach(async () => {
    workspace = await Workspace.create();
    await workspace.writeDefaultPrompts();
  });
  afterEach(async () => { await workspace.destroy(); });

  /** Answers normally, except for `broken`, which always throws `kind`. */
  function failingClient(broken: string, error: () => unknown): FakeClient {
    return new FakeClient((call) => {
      if (call.target === broken) return error() as Error;
      const text = isStringBatch(call.request) ? echoTable(call.request) : '';
      const completionTokens = Math.max(50, Math.ceil(text.length / 3.2));
      return respond(text, {
        latencyMs: Math.round((completionTokens / (SPEED[call.target] ?? 60)) * 1000),
        usage: {
          promptTokens: 2000,
          completionTokens,
          cachedPromptTokens: 0,
          cacheWritePromptTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2000 + completionTokens,
        },
      });
    });
  }

  it('completes the corpus when one target refuses every call', async () => {
    const corpus = await loadCorpus(12);
    expect(corpus.length).toBeGreaterThan(0);
    for (const doc of corpus) await workspace.writeFile(`corpus/ru/${doc.slug}.bio.md`, doc.text);

    const client = failingClient('deepseek', () => Object.assign(new Error('slow down'), { status: 429 }));
    const outcome = await runJob(workspace.app(poolConfig(), client));

    // A refusing target must cost documents nothing: the pool is the fallback
    // chain and `rate_limit` is both retryable and fallbackable.
    expect(outcome.summary.failures).toEqual([]);

    const served = new Map<string, number>();
    for (const call of client.calls) served.set(call.target, (served.get(call.target) ?? 0) + 1);
    // It was tried — an untried target proves nothing about failure handling.
    expect(served.get('deepseek') ?? 0).toBeGreaterThan(0);
    // …and the work landed elsewhere.
    const elsewhere = [...served].filter(([m]) => m !== 'deepseek').reduce((n, [, c]) => n + c, 0);
    expect(elsewhere).toBeGreaterThan(0);
  });

  it('backs off a target that starts refusing part-way through', async () => {
    const corpus = await loadCorpus(12);
    expect(corpus.length).toBeGreaterThan(0);
    for (const doc of corpus) await workspace.writeFile(`corpus/ru/${doc.slug}.bio.md`, doc.text);

    // The free tier answers its allowance, then 429s for the rest of the run —
    // the failure a metered free tier actually produces.
    const ALLOWANCE = 3;
    let servedFree = 0;
    const client = new FakeClient((call) => {
      if (call.target === 'minimax-m3-free') {
        servedFree += 1;
        if (servedFree > ALLOWANCE) {
          return Object.assign(new Error('rate limit exceeded'), { status: 429 }) as Error;
        }
      }
      const text = isStringBatch(call.request) ? echoTable(call.request) : '';
      const completionTokens = Math.max(50, Math.ceil(text.length / 3.2));
      return respond(text, {
        latencyMs: Math.round((completionTokens / (SPEED[call.target] ?? 60)) * 1000),
        usage: {
          promptTokens: 2000,
          completionTokens,
          cachedPromptTokens: 0,
          cacheWritePromptTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2000 + completionTokens,
        },
      });
    });

    const outcome = await runJob(workspace.app(poolConfig(), client));
    expect(outcome.summary.failures).toEqual([]);

    const attempts = client.calls.filter((c) => c.target === 'minimax-m3-free').length;
    // It kept its allowance and was not hammered indefinitely afterwards: the
    // streak penalty must actually push a refusing target down the chain.
    expect(attempts).toBeGreaterThanOrEqual(ALLOWANCE);
    expect(attempts).toBeLessThan(client.calls.length / 2);
  });
});

/** A bare `ModelTarget` for the unit-level recovery assertions. */
function bareTarget(modelId: string): ModelTarget {
  return {
    key: `openrouter:${modelId}`,
    modelId,
    endpointId: 'openrouter',
    modelName: modelId,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    maxTokensParam: 'max_tokens',
    pricing: { inputPer1M: 0.3, outputPer1M: 1.2 },
    capabilities: [],
    reasoning: { enabled: false, effort: 'medium', dialect: 'reasoning', exclude: true },
    tags: [],
    weight: 1,
    params: {},
    timeoutMs: 120_000,
    endpoint: {
      id: 'openrouter',
      baseUrl: 'http://localhost:9/v1',
      apiKey: '',
      headers: {},
      query: {},
      maxConcurrent: 0,
      requestsPerMinute: 0,
      minRequestSpacingMs: 0,
      stream: false,
      enabled: true,
    },
  } as unknown as ModelTarget;
}

const minimax = bareTarget('minimax-m3');

/** A RoutingContext carrying a specific stats registry, for scoring assertions. */
function contextFor(complexity: number, stats: TargetStatsRegistry): RoutingContext {
  return {
    candidates: [],
    request: {
      pipeline: 'translate',
      estimatedInputTokens: 2000,
      expectedOutputTokens: 2000,
      requiredCapabilities: [],
      signals: { complexity },
    },
    stats: (key) => stats.get(key),
    fits: () => true,
    headroom: () => 1000,
    outputHeadroom: () => 1000,
    estimatedCost: () => 0.001,
    freeSlots: () => Number.POSITIVE_INFINITY,
    inFlight: () => 0,
    load: () => 0,
    sequence: 0,
    options: {},
  };
}

describe('recovery', () => {
  it('lets a failure streak fade once nothing has been sent for a while', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 5; i += 1) stats.recordFailure(minimax.key);

    const fresh = scoreTargets([minimax], contextFor(0.5, stats))[0]!;
    // Rewind the clock past the decay window: the same five failures, older.
    stats.get(minimax.key).lastUsedAt = Date.now() - 120_000;
    const stale = scoreTargets([minimax], contextFor(0.5, stats))[0]!;

    expect(fresh.health).toBeLessThan(0.2);
    expect(stale.health).toBeGreaterThan(fresh.health);
  });

  it('forgets old failures once the window refills with successes', () => {
    const stats = new TargetStatsRegistry();
    for (let i = 0; i < 5; i += 1) stats.recordFailure(minimax.key);
    const broken = scoreTargets([minimax], contextFor(0.5, stats))[0]!;

    for (let i = 0; i < 10; i += 1) stats.recordSuccess(minimax.key, 1000, 0, 500);
    const healed = scoreTargets([minimax], contextFor(0.5, stats))[0]!;

    // The run-long ratio still says 5/15; the window says 0/10, and the window
    // is what the strategy reads.
    expect(stats.get(minimax.key).failures).toBe(5);
    expect(healed.health).toBeGreaterThan(broken.health + 0.5);
  });
});
