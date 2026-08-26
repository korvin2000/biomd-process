import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppConfigInput } from '../../src/config/schema.js';
import { runJob } from '../../src/app/runJob.js';
import {
  adaptiveWith,
  DEFAULT_TUNING,
  type AdaptiveTuning,
} from '../../src/routing/strategies/adaptive/AdaptiveStrategy.js';
import { sleep } from '../../src/shared/async.js';
import { echoTable, isStringBatch, respond, FakeClient, Workspace } from './workspace.js';

/**
 * The `adaptive` strategy driven end to end over a real corpus, with no network.
 *
 * Shared by `tests/adaptive.simulation.test.ts` and `tools/split-adaptive.ts`,
 * and shared rather than copied for the reason `tools/calibrate-adaptive.ts`
 * demonstrated: a second transcription of the thing under test drifts from it,
 * and a number fitted against the copy is a number about nothing.
 *
 * The whole scheduler runs — `runJob`, the real Router, the real lanes, the real
 * gateway — against a provider that answers deterministically. Every decision is
 * inspectable and the run costs nothing.
 */

/**
 * Generated tokens/sec per model. Matches `ModelProfiles.ts` on purpose: this is
 * the *mean* each target is asked to hit, and `SPREAD` is how far individual
 * calls wander from it.
 */
export const SPEED: Record<string, number> = {
  'gemma-local': 53,
  'gpt-luna': 51,
  deepseek: 81,
  'minimax-m3': 105,
  'minimax-m3-free': 78,
};

/**
 * How wide a single call's speed may swing, as a fraction of {@link SPEED}.
 *
 * A modelled call runs at `SPEED × (1 ± SPREAD)`, uniform. The numbers are not
 * decoration: an openrouter model id is served by dozens of providers at once,
 * one of which will manage ten tokens a second while another does a hundred, and
 * the population drifts with the time of day besides. A harness that hands every
 * call the same speed tests a world this deployment does not run in, and it is
 * the world in which a four-call window is a reliable estimator.
 *
 * `local` and `omniroute` each front one deployment, so they get a narrow band —
 * whatever varies there is load, not which machine answered.
 */
export const SPREAD: Record<string, number> = {
  'gemma-local': 0.1,
  'gpt-luna': 0.15,
  deepseek: 0.55,
  'minimax-m3': 0.55,
  // One named fp8 host rather than a mixture, so its own load is all that moves.
  'minimax-m3-free': 0.2,
};

export const ENDPOINT_OF: Record<string, string> = {
  'gemma-local': 'local',
  'gpt-luna': 'omniroute',
  deepseek: 'openrouter',
  'minimax-m3': 'openrouter',
  'minimax-m3-free': 'openrouter',
};

/**
 * How much faster than life the fake runs.
 *
 * The fake has to **spend wall clock**, and that is not a stylistic point. The
 * gateway records `Date.now() - startedAt`, never the `latencyMs` a response
 * declares, so a client that returns immediately reports every call as having
 * taken no time — and `completionTokens / 0ms` is not a throughput, it is
 * whatever {@link OUTLIER_CEILING} happens to clamp it to. That is exactly what
 * this harness used to do: measured throughput for the first target to answer
 * pinned at 3x its profile prior and stayed there, so the throughput term became
 * a first-mover bonus, the run-to-run spread of minimax-m3's share ran from 0.8%
 * to 25%, and every constant fitted here was fitted against the artefact.
 *
 * Sleeping the modelled duration in full would cost ~10 seconds a call. Instead
 * both halves of the ratio are divided by this: the response reports
 * `tokens / TIME_SCALE` and the client sleeps for the time *that many* tokens
 * would take at the modelled rate. Tokens per second — the only quantity the
 * strategy reads — comes out unchanged, and a call costs ~100ms.
 *
 * The residue is timer jitter, a few percent, which is a fair likeness of a real
 * endpoint and is why the harness is averaged over runs rather than trusted once.
 */
export const TIME_SCALE = 80;

/** The `translate` pool as `biomd.config.yaml` declares it. */
export function poolConfig(): AppConfigInput {
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

/**
 * Tokens a response reports, and the wall clock it costs. See {@link TIME_SCALE}.
 *
 * `jitter` off gives every call of a target the same speed, which is what the
 * band assertions need to stay repeatable. On, it draws from {@link SPREAD} —
 * the provider lottery an openrouter id actually runs.
 */
export function timingFor(
  target: string,
  text: string,
  jitter = false,
  speed: Record<string, number> = SPEED,
): { completionTokens: number; delayMs: number } {
  const modelled = Math.max(50, Math.ceil(text.length / 3.2));
  // A floor, because integer rounding is the noise here: at 4 tokens a call the
  // reported rate is quantised to 25% steps.
  const completionTokens = Math.max(8, Math.round(modelled / TIME_SCALE));
  const spread = jitter ? (SPREAD[target] ?? 0) : 0;
  const rate = (speed[target] ?? SPEED[target] ?? 60) * (1 + spread * (Math.random() * 2 - 1));
  return { completionTokens, delayMs: (completionTokens / rate) * 1000 };
}

/**
 * The pool with one target slowed by `factor`, for the speed-response cases.
 *
 * A speed difference on openrouter is only sometimes about the model — the id is
 * served by dozens of providers and the population drifts with the clock — so
 * the strategy is required to treat a moderate one as noise and a large one as
 * signal. These build the two worlds that requirement is stated against.
 */
export function slowedBy(modelId: string, factor: number): Record<string, number> {
  return { ...SPEED, [modelId]: (SPEED[modelId] ?? 60) / factor };
}

/**
 * Answers a batch, taking the wall clock the modelled speed implies.
 *
 * `broken` routes one target through `fails()`, for the failure and rate-limit
 * cases. Returning an error from it refuses the call *without* sleeping, which
 * is what a 429 does; returning `undefined` answers normally, which is how a
 * metered free tier that serves an allowance and then stops is modelled.
 */
export function speedAwareClient(
  options: {
    broken?: string;
    fails?: () => Error | undefined;
    jitter?: boolean;
    /** Per-model speed overrides, tokens/sec, for the "what if X got slow" cases. */
    speed?: Record<string, number>;
  } = {},
): FakeClient {
  return new FakeClient(async (call) => {
    if (options.broken && call.target === options.broken && options.fails) {
      const refusal = options.fails();
      if (refusal) return refusal;
    }
    const text = isStringBatch(call.request) ? echoTable(call.request) : '';
    const { completionTokens, delayMs } = timingFor(call.target, text, options.jitter, options.speed);
    const promptTokens = Math.max(100, Math.ceil(JSON.stringify(call.request.messages).length / 3.2));
    await sleep(delayMs);
    return respond(text, {
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

/**
 * Real articles, so the complexity scores are real ones.
 *
 * `dir` names one directory instead of taking the first that exists — the two
 * available here are not interchangeable and a fit on the wrong one is a fit on
 * the wrong corpus. `input/ru` holds 50 documents and `out/ru` holds 196, and
 * the split they produce differs by several points because the complexity
 * distribution does. Tests take the default and stay quick; a calibration should
 * name `out/ru`.
 */
export async function loadCorpus(limit: number, dir?: string): Promise<{ slug: string; text: string }[]> {
  for (const candidate of dir ? [dir] : ['input/ru', 'out/ru']) {
    try {
      const files = (await readdir(candidate)).filter((f) => f.endsWith('.bio.md')).slice(0, limit);
      if (files.length === 0) continue;
      return await Promise.all(
        files.map(async (f) => ({
          slug: f.replace('.bio.md', ''),
          text: await readFile(join(candidate, f), 'utf8'),
        })),
      );
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * One routing decision as the pipelines actually posed it.
 *
 * Captured so a search can **replay** real requests against candidate constants
 * instead of inventing them. The three numbers are the whole of what the
 * strategy reads about a payload, and all three are properties of the corpus and
 * the segmenter rather than of the tuning — so one recording serves every point
 * in a grid, and a grid becomes milliseconds instead of hours.
 *
 * `chosen` is the head of the chain the recording run produced. A replay uses it
 * to keep only the decisions that reached openrouter at all, because which
 * *endpoint* a call lands on is settled by occupancy — the two free endpoints
 * saturate — rather than by the score, and replaying a `gpt-luna` decision
 * against the openrouter three would invent a request that never existed.
 */
export interface RoutedRequest {
  complexity: number;
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  /** Head of the chain this decision produced — which target would serve it. */
  chosen: string;
}

export interface RunOutcome {
  /** Calls per model id. */
  byTarget: Map<string, number>;
  total: number;
  onOpenRouter: number;
  failures: number;
  /** What each target's rolling window ended up reporting, tokens/sec. */
  measured: Map<string, number>;
  /** Every routing decision the run posed, when `capture` was asked for. */
  requests: RoutedRequest[];
}

/**
 * One end-to-end run against a fresh workspace.
 *
 * `tuning` replaces the strategy registered as `adaptive` before the run starts,
 * which is how a sweep drives the real scheduler at a candidate constant instead
 * of scoring a static preference map. The registry resolves by id at select
 * time, so re-registering after `createApp` is enough.
 */
export async function runOnce(
  corpus: readonly { slug: string; text: string }[],
  client: FakeClient = speedAwareClient(),
  tuning?: AdaptiveTuning,
  capture = false,
): Promise<RunOutcome> {
  const workspace = await Workspace.create();
  const requests: RoutedRequest[] = [];
  try {
    await workspace.writeDefaultPrompts();
    for (const doc of corpus) await workspace.writeFile(`corpus/ru/${doc.slug}.bio.md`, doc.text);
    const app = workspace.app(poolConfig(), client);
    const strategy = adaptiveWith(tuning ?? DEFAULT_TUNING);
    app.strategies.register(
      capture
        ? {
            ...strategy,
            select: (context) => {
              const chain = strategy.select(context);
              const signal = context.request.signals?.['complexity'];
              if (typeof signal === 'number' && chain[0]) {
                requests.push({
                  complexity: signal,
                  estimatedInputTokens: context.request.estimatedInputTokens,
                  expectedOutputTokens: context.request.expectedOutputTokens,
                  chosen: chain[0].modelId,
                });
              }
              return chain;
            },
          }
        : strategy,
    );
    const outcome = await runJob(app);

    const byTarget = new Map<string, number>();
    for (const call of client.calls) byTarget.set(call.target, (byTarget.get(call.target) ?? 0) + 1);

    const measured = new Map<string, number>();
    for (const stats of app.stats.snapshot()) {
      const tokens = stats.recent.reduce((n, c) => n + c.completionTokens, 0);
      const ms = stats.recent.reduce((n, c) => n + c.latencyMs, 0);
      if (ms > 0) measured.set(stats.key, (tokens * 1000) / ms);
    }

    return {
      byTarget,
      total: client.calls.length,
      onOpenRouter: client.calls.filter((c) => ENDPOINT_OF[c.target] === 'openrouter').length,
      failures: outcome.summary.failures.length,
      measured,
      requests,
    };
  } finally {
    await workspace.destroy();
  }
}
