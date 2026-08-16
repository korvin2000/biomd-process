import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import { FakeClient, Workspace, respond } from './helpers/workspace.js';

/**
 * The pipeline end to end, against a scripted transport.
 *
 * The FakeClient tells the tasks apart the same way it always has — by what the
 * request carries. A web-search call is the one that fences a `yaml` identity
 * card, which nothing else sends.
 */
const ARTICLE = `# Иван Иванов

::: lead

Российский гитарист.

:::

Иванов родился в 1940 году и много концертировал.
`;

/** A dossier with a year-only birth date and nothing else — the case this task is for. */
const DOSSIER = {
  metadata: {
    forename: 'Иван',
    surname: 'Иванов',
    instruments: 'классическая гитара',
    dates: { born: '1940' },
  },
};

const TASKS = {
  extract: { enabled: true },
  websearch: { enabled: true, requireWebSearchCapability: false },
};

function isWebSearch(content: string): boolean {
  return content.includes('```yaml');
}

let workspace: Workspace;

beforeEach(async () => {
  workspace = await Workspace.create();
  await workspace.writeDefaultPrompts();
  await workspace.writeFile('corpus/ru/ivan-ivanov.bio.md', ARTICLE);
  await workspace.writeFile('corpus/ru/ivan-ivanov.bio.json', JSON.stringify(DOSSIER, null, 2));
});

afterEach(async () => {
  await workspace.destroy();
});

async function readDossier(): Promise<{ metadata: Record<string, unknown> }> {
  return JSON.parse(await readFile(workspace.path('out/ru/ivan-ivanov.bio.json'), 'utf8')) as never;
}

describe('websearch', () => {
  it('fills the gaps and records the source it was given', async () => {
    const client = new FakeClient((call) => {
      const content = call.request.messages.at(-1)?.content ?? '';
      if (!isWebSearch(content)) return respond(JSON.stringify({}));

      // The card carries the facts needed to tell a namesake apart.
      expect(content).toContain('name: Иван Иванов');
      expect(content).toContain('instruments: классическая гитара');
      expect(content).not.toContain('много концертировал\n\n#');

      return respond(
        JSON.stringify({
          status: 'dead',
          died: { value: '03.05.2019', source: 'https://example.org/ivanov', confidence: 0.92 },
          birthplace: { value: 'Москва, Россия', source: 'https://example.org/ivanov', confidence: 0.88 },
          country: { value: 'Russia', source: 'https://example.org/ivanov', confidence: 0.95 },
        }),
      );
    });

    const outcome = await runJob(workspace.app({ tasks: TASKS }, client));
    expect(outcome.summary.failures).toEqual([]);

    const dossier = await readDossier();
    expect(dossier.metadata['dates']).toEqual({ born: '1940', died: '03.05.2019' });
    expect(dossier.metadata['birthplace']).toBe('Москва, Россия');
    expect(dossier.metadata['url']).toBe('https://example.org/ivanov');
    // `country` is an index field; it must not land in the dossier (INV-7).
    expect(dossier.metadata['country']).toBeUndefined();

    const hints = JSON.parse(await readFile(workspace.path('out/.hints/ivan-ivanov.web.json'), 'utf8')) as {
      country?: string;
    };
    expect(hints.country).toBe('ru');
  });

  it('never turns "still alive" into a date of death', async () => {
    const client = new FakeClient((call) => {
      const content = call.request.messages.at(-1)?.content ?? '';
      if (!isWebSearch(content)) return respond(JSON.stringify({}));

      expect(content).toContain('status');
      // The shape a model produces when it has found nothing about a death but
      // answers the key anyway.
      return respond(
        JSON.stringify({
          status: 'alive',
          died: { value: '01.01.2020', source: 'https://example.org/guess', confidence: 0.9 },
        }),
      );
    });

    await runJob(workspace.app({ tasks: TASKS }, client));

    const dossier = await readDossier();
    expect((dossier.metadata['dates'] as Record<string, string>)['died']).toBeUndefined();
  });

  it('drops a death date that arrives with no explicit status', async () => {
    const client = new FakeClient((call) => {
      const content = call.request.messages.at(-1)?.content ?? '';
      if (!isWebSearch(content)) return respond(JSON.stringify({}));
      return respond(JSON.stringify({ died: { value: '01.01.2020', source: 'https://x.org/a', confidence: 0.9 } }));
    });

    await runJob(workspace.app({ tasks: TASKS }, client));
    expect((await readDossier()).metadata['dates']).toEqual({ born: '1940' });
  });

  it('spends nothing when the dossier answers everything', async () => {
    await workspace.writeFile(
      'corpus/ru/ivan-ivanov.bio.json',
      JSON.stringify({
        metadata: {
          forename: 'Иван',
          surname: 'Иванов',
          birthplace: 'Москва, Россия',
          deathplace: 'Москва, Россия',
          dates: { born: '1940', died: '2019' },
        },
      }),
    );

    const client = new FakeClient((call) => {
      const content = call.request.messages.at(-1)?.content ?? '';
      if (isWebSearch(content)) throw new Error('websearch should not have called anything');
      return respond(JSON.stringify({}));
    });

    const outcome = await runJob(
      workspace.app({ tasks: { ...TASKS, websearch: { ...TASKS.websearch, fields: ['born', 'died', 'birthplace', 'deathplace'] } } }, client),
    );

    expect(outcome.summary.failures).toEqual([]);
    expect(client.calls.filter((call) => isWebSearch(call.request.messages.at(-1)?.content ?? ''))).toHaveLength(0);
  });

  it('routes only to a model that declares it can search', async () => {
    const app = workspace.app(
      {
        tasks: { ...TASKS, websearch: { enabled: true, requireWebSearchCapability: true } },
        llm: {
          endpoints: [{ id: 'fake', baseUrl: 'http://localhost:9/v1', apiKey: 'x' }],
          models: [
            { id: 'plain', endpoint: 'fake', model: 'plain-model' },
            { id: 'searcher', endpoint: 'fake', model: 'search-model', capabilities: ['web_search'] },
          ],
          routing: { strategy: 'cost-optimized', pools: { default: ['plain', 'searcher'] } },
        },
      },
      new FakeClient(() => respond(JSON.stringify({ status: 'unknown' }))),
    );

    const targets = app.gateway.plan({
      pipeline: 'websearch',
      estimatedInputTokens: 500,
      expectedOutputTokens: 700,
      requiredCapabilities: ['web_search'],
    });
    expect(targets.map((target) => target.modelId)).toEqual(['searcher']);
  });
});
