import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planJob, runJob } from '../src/app/runJob.js';
import type { AppConfigInput } from '../src/config/schema.js';
import type { CompletionRequest, CompletionResponse, LlmClient, ModelTarget } from '../src/llm/types.js';
import { FakeClient, Workspace, echoTable, isStringBatch, respond } from './helpers/workspace.js';

/**
 * Scheduling: what a run does *before* it spends anything, and how it spreads
 * what it does spend across the endpoints that are available.
 */

const ARTICLE = `# Пако де Лусия

::: lead

Испанский гитарист и композитор.

:::

## От традиции к новому звучанию

Первые уроки Пако получил в семье, в Альхесирасе.

Позже он играл с Ларри Кориэллом и Джоном Маклафлином.
`;

/** Three endpoints, sized the way the real deployment is. */
const ENDPOINTS: AppConfigInput['llm'] = {
  endpoints: [
    { id: 'local', baseUrl: 'http://local/v1', maxConcurrent: 1 },
    { id: 'omniroute', baseUrl: 'http://omniroute/v1', maxConcurrent: 1 },
    { id: 'openrouter', baseUrl: 'http://openrouter/v1', maxConcurrent: 3 },
  ],
  models: [
    { id: 'local-small', endpoint: 'local', model: 'local', pricing: { inputPer1M: 0, outputPer1M: 0 } },
    { id: 'or-luna', endpoint: 'omniroute', model: 'luna', pricing: { inputPer1M: 0, outputPer1M: 0 } },
    { id: 'or-cheap', endpoint: 'openrouter', model: 'cheap', pricing: { inputPer1M: 0.07, outputPer1M: 0.17 } },
  ],
  routing: {
    strategy: 'cost-optimized',
    pools: {
      default: ['local-small', 'or-luna', 'or-cheap'],
      translate: {
        models: ['local-small', 'or-luna', 'or-cheap'],
        strategy: 'least-busy',
        maxConcurrent: { openrouter: 1 },
      },
    },
  },
};

/** Records who served what, and how many were in flight at once. */
class ConcurrencyProbe implements LlmClient {
  readonly endpointId = 'probe';
  readonly served: string[] = [];
  private readonly active = new Map<string, number>();
  readonly peak = new Map<string, number>();

  constructor(private readonly delayMs = 5) {}

  async complete(target: ModelTarget, request: CompletionRequest): Promise<CompletionResponse> {
    const endpoint = target.endpointId;
    this.served.push(endpoint);

    const now = (this.active.get(endpoint) ?? 0) + 1;
    this.active.set(endpoint, now);
    this.peak.set(endpoint, Math.max(this.peak.get(endpoint) ?? 0, now));

    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return respond(isStringBatch(request) ? echoTable(request) : lastBlock(request));
    } finally {
      this.active.set(endpoint, (this.active.get(endpoint) ?? 1) - 1);
    }
  }

  countFor(endpoint: string): number {
    return this.served.filter((id) => id === endpoint).length;
  }
}

function lastBlock(request: CompletionRequest): string {
  const user = request.messages.at(-1)?.content ?? '';
  const matches = [...user.matchAll(/```markdown\n([\s\S]*?)\n```/g)];
  return matches.at(-1)?.[1] ?? user;
}

let workspace: Workspace;

beforeEach(async () => {
  workspace = await Workspace.create();
  await workspace.writeDefaultPrompts();
  for (const slug of ['paco', 'segovia', 'abiton', 'krylov', 'armik', 'aussel']) {
    await workspace.writeFile(`corpus/ru/${slug}.bio.md`, ARTICLE);
  }
});

afterEach(async () => {
  await workspace.destroy();
});

/**
 * Point 1: three settings that all say "this output already exists" must be
 * read *before* a model is called, not after it has been paid for.
 */
describe('skipping before spending', () => {
  const SETTINGS = (skipExistingOutputs: boolean): Partial<AppConfigInput> => ({
    tasks: {
      extract: { enabled: true, onExistingDossier: 'reuse' },
      translate: { enabled: true, targetLanguages: ['en'] },
      localize: { enabled: true, targetLanguages: ['en'] },
      catalog: { enabled: true },
    },
    output: { baseDir: 'out', onExisting: 'skip' },
    input: { baseDir: 'corpus', include: ['ru/paco.bio.md'], sourceLanguage: 'auto' },
    run: { concurrency: 2, stateDir: '.biomd/runs', resume: 'off', skipExistingOutputs },
  });

  it('calls nothing on a second run when the outputs are all on disk', async () => {
    const first = FakeClient.happyPath();
    await runJob(workspace.app(SETTINGS(true), first));
    expect(first.calls.length).toBeGreaterThan(0);

    const second = FakeClient.happyPath();
    const outcome = await runJob(workspace.app(SETTINGS(true), second));

    expect(second.calls).toHaveLength(0);
    expect(outcome.plan.skipped.every((task) => task.reason === 'existing-output')).toBe(true);
  });

  /**
   * The regression this closes. `output.onExisting: skip` means the writer will
   * refuse to replace the file whatever this run produces — so running the task
   * is guaranteed waste, and the planner used not to look at the setting at
   * all. Every document was extracted, translated and localized again, and
   * every answer was billed and then discarded with a warning.
   */
  it('reads output.onExisting: skip as a reason not to run, not as a reason to discard', async () => {
    const first = FakeClient.happyPath();
    await runJob(workspace.app(SETTINGS(false), first));

    const second = FakeClient.happyPath();
    const plan = await planJob(workspace.app(SETTINGS(false), second));
    await runJob(workspace.app(SETTINGS(false), second));

    expect(second.calls).toHaveLength(0);
    expect(plan.skipped.map((task) => task.pipeline).sort()).toEqual(['extract', 'localize', 'translate', 'translate']);
  });

  /** `overwrite` means what it says: the run is *meant* to replace the files. */
  it('still runs everything when the output is meant to be overwritten', async () => {
    const settings = { ...SETTINGS(false), output: { baseDir: 'out', onExisting: 'overwrite' as const } };
    await runJob(workspace.app(settings, FakeClient.happyPath()));

    const second = FakeClient.happyPath();
    await runJob(workspace.app(settings, second));
    expect(second.calls.length).toBeGreaterThan(0);
  });
});

/**
 * Point 4: the whole reason a translation run is slow is that every task queues
 * on the one endpoint the cost ranking likes best.
 */
describe('spreading translation across endpoints', () => {
  const TRANSLATE: Partial<AppConfigInput> = {
    tasks: {
      extract: { enabled: false },
      translate: {
        enabled: true,
        pool: 'translate',
        targetLanguages: ['en'],
        copySourceArticle: false,
        mode: 'document',
      },
      catalog: { enabled: false },
    },
    llm: ENDPOINTS,
    run: { concurrency: 3, stateDir: '.biomd/runs', resume: 'off' },
  };

  it('keeps every endpoint busy instead of queueing on the cheapest', async () => {
    const probe = new ConcurrencyProbe(15);
    await runJob(workspace.app(TRANSLATE, probe));

    expect(probe.served).toHaveLength(6);
    // All three were used, and the free ones carried at least their share.
    expect(new Set(probe.served).size).toBe(3);
    expect(probe.countFor('local')).toBeGreaterThan(0);
    expect(probe.countFor('omniroute')).toBeGreaterThan(0);
    expect(probe.countFor('openrouter')).toBeGreaterThan(0);
  });

  /**
   * The lane. `openrouter` allows three parallel requests; this pool's share of
   * them is one, so it can never hold more than one at a time however many
   * tasks are looking for somewhere to go.
   */
  it('never exceeds a pool lane, nor an endpoint limit', async () => {
    const probe = new ConcurrencyProbe(15);
    await runJob(workspace.app(TRANSLATE, probe));

    expect(probe.peak.get('local') ?? 0).toBeLessThanOrEqual(1);
    expect(probe.peak.get('omniroute') ?? 0).toBeLessThanOrEqual(1);
    expect(probe.peak.get('openrouter') ?? 0).toBeLessThanOrEqual(1);
  });

  /**
   * Without a spreading strategy the cost ranking is right and the throughput
   * is one request at a time: every task picks the free local model and then
   * waits its turn on a one-slot endpoint.
   */
  it('shows the behaviour it replaces: cost-optimized sends everything to the free model', async () => {
    const probe = new ConcurrencyProbe(5);
    const costOnly: Partial<AppConfigInput> = {
      ...TRANSLATE,
      llm: {
        ...ENDPOINTS,
        // The shorthand pool form, unchanged from every config written before
        // lanes existed: a bare list, inheriting the global strategy.
        routing: {
          strategy: 'cost-optimized',
          pools: {
            default: ['local-small', 'or-luna', 'or-cheap'],
            translate: ['local-small', 'or-luna', 'or-cheap'],
          },
        },
      },
    };
    await runJob(workspace.app(costOnly, probe));

    expect(probe.countFor('local')).toBe(6);
    expect(probe.countFor('openrouter')).toBe(0);
  });

  /** Point 4's third leg: a language may name the model that renders it best. */
  it('routes a language to its preferred model and keeps the rest as fallback', async () => {
    const probe = new ConcurrencyProbe(1);
    const preferred: Partial<AppConfigInput> = {
      tasks: {
        extract: { enabled: false },
        translate: {
          enabled: true,
          pool: 'translate',
          targetLanguages: ['en', 'zh'],
          copySourceArticle: false,
          mode: 'document',
        },
        catalog: { enabled: false },
      },
      input: { baseDir: 'corpus', include: ['ru/paco.bio.md'], sourceLanguage: 'auto' },
      llm: {
        ...ENDPOINTS,
        routing: {
          strategy: 'cost-optimized',
          pools: {
            default: ['local-small', 'or-luna', 'or-cheap'],
            translate: {
              models: ['local-small', 'or-luna', 'or-cheap'],
              prefer: { zh: ['or-cheap'] },
            },
          },
        },
      },
      run: { concurrency: 1, stateDir: '.biomd/runs', resume: 'off' },
    };

    await runJob(workspace.app(preferred, probe));

    expect(probe.served).toHaveLength(2);
    // English took the strategy's own choice; Chinese took the one named for it.
    expect(probe.countFor('local')).toBe(1);
    expect(probe.countFor('openrouter')).toBe(1);
  });
});
