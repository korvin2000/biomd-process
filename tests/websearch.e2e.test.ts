import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

    const outcome = await runJob(workspace.app({
      tasks: {
        ...TASKS,
        websearch: { ...TASKS.websearch, recordSources: 'url' as const },
      },
    }, client));
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

  /**
   * The case that started this: an article that says "born about 1950" and a
   * cited full date that disagrees about the year. Under the old rule the
   * sourced date was refused as a contradiction and nothing said so, so the
   * catalogue kept publishing the approximation and the run looked clean.
   */
  describe('a sourced date that disagrees with the record', () => {
    const CONFLICT = { born: { value: '25.07.1939', source: 'https://example.org/ivanov', confidence: 0.9 } };

    function answering(payload: unknown): FakeClient {
      return new FakeClient((call) => {
        const content = call.request.messages.at(-1)?.content ?? '';
        if (!isWebSearch(content)) return respond(JSON.stringify({}));
        return respond(JSON.stringify(payload));
      });
    }

    const asking = {
      ...TASKS,
      websearch: {
        ...TASKS.websearch,
        upgradePrecision: true,
        onDateConflict: 'prefer-precise' as const,
        fields: ['born' as const],
      },
    };

    it('prefers the more precise sourced date, and says that it did', async () => {
      const outcome = await runJob(workspace.app({ tasks: asking }, answering(CONFLICT)));
      expect(outcome.summary.failures).toEqual([]);

      const dossier = await readDossier();
      expect(dossier.metadata['dates']).toEqual({ born: '25.07.1939' });
    });

    it('records the conflict instead of publishing it under `report`', async () => {
      const tasks = { ...asking, websearch: { ...asking.websearch, onDateConflict: 'report' as const } };
      await runJob(workspace.app({ tasks }, answering(CONFLICT)));

      // The record stands …
      const dossier = await readDossier();
      expect(dossier.metadata['dates']).toEqual({ born: '1940' });

      // … and the disagreement is on disk with its source, which is the whole
      // difference from the behaviour this replaced.
      const hints = JSON.parse(await readFile(workspace.path('out/.hints/ivan-ivanov.web.json'), 'utf8')) as {
        conflicts?: { field: string; recorded: string; found: string; source?: string }[];
      };
      expect(hints.conflicts).toEqual([
        {
          field: 'born',
          recorded: '1940',
          found: '25.07.1939',
          source: 'https://example.org/ivanov',
          confidence: 0.9,
        },
      ]);
    });

    it('never lets an equally precise disagreement overwrite the record', async () => {
      // Two full dates that disagree are two claims about a person. Precision
      // is the only thing that separates a correction from a coin toss.
      await workspace.writeFile(
        'corpus/ru/ivan-ivanov.bio.json',
        JSON.stringify({ ...DOSSIER, metadata: { ...DOSSIER.metadata, dates: { born: '01.01.1940' } } }, null, 2),
      );
      await runJob(workspace.app({ tasks: asking }, answering(CONFLICT)));

      const dossier = await readDossier();
      expect(dossier.metadata['dates']).toEqual({ born: '01.01.1940' });
    });
  });

  it('writes a place as prose in the edition\'s language, not as a country code', async () => {
    const client = new FakeClient((call) => {
      const content = call.request.messages.at(-1)?.content ?? '';
      if (!isWebSearch(content)) return respond(JSON.stringify({}));

      // The instructions name the language the answer belongs in.
      expect(call.request.messages.map((message) => message.content).join('\n')).toContain('Language: ru');

      // What a search model writes once it has been told countries are ISO
      // codes: the rule belongs to `country`, and it applies it to everything.
      return respond(
        JSON.stringify({
          birthplace: { value: 'Melbourne, au', source: 'https://example.org/w', confidence: 0.9 },
          country: { value: 'au', source: 'https://example.org/w', confidence: 0.9 },
        }),
      );
    });

    const outcome = await runJob(workspace.app({ tasks: TASKS }, client));
    expect(outcome.summary.failures).toEqual([]);

    expect((await readDossier()).metadata['birthplace']).toBe('Melbourne, Австралия');
  });

  it('leaves a place alone when nothing confirms the two letters are a country', async () => {
    const client = new FakeClient((call) => {
      const content = call.request.messages.at(-1)?.content ?? '';
      if (!isWebSearch(content)) return respond(JSON.stringify({}));

      // No country anywhere: `TN` is Tennessee at least as often as Tunisia.
      return respond(
        JSON.stringify({
          birthplace: { value: 'Nashville, TN', source: 'https://example.org/w', confidence: 0.9 },
        }),
      );
    });

    await runJob(workspace.app({ tasks: TASKS }, client));

    expect((await readDossier()).metadata['birthplace']).toBe('Nashville, TN');
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
            {
              id: 'searcher',
              endpoint: 'fake',
              model: 'search-model',
              apiFormat: 'responses',
              webSearchMode: 'responses_tool',
              capabilities: ['web_search'],
            },
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

  it('rejects a well-formed answer when the provider performed no search', async () => {
    const client = new FakeClient((call) => {
      const content = call.request.messages.at(-1)?.content ?? '';
      if (!isWebSearch(content)) return respond(JSON.stringify({}));
      return respond(
        JSON.stringify({ born: { value: '21.02.1893', source: 'https://invented.example/a', confidence: 0.99 } }),
        { webSearch: { performed: false, sources: [] } },
      );
    });

    const outcome = await runJob(workspace.app({ tasks: TASKS }, client));
    expect(outcome.summary.status).toBe('failed');
    expect(outcome.summary.failures[0]?.message).toContain('no completed web_search_call');
  });

  it('drops a field whose citation is absent from the pages the provider opened', async () => {
    // The search really happened; the model cited a page the provider never
    // opened. Not a failed call — a well-formed answer with one unsupported
    // claim in it — so the run succeeds, the field is dropped, and the note is
    // the whole account of why.
    const client = new FakeClient((call) => {
      const content = call.request.messages.at(-1)?.content ?? '';
      if (!isWebSearch(content)) return respond(JSON.stringify({}));
      return respond(
        JSON.stringify({
          birthplace: { value: 'Melbourne', source: 'https://invented.example/a', confidence: 0.99 },
        }),
        { webSearch: { performed: true, sources: [{ url: 'https://consulted.example/somebody-else' }] } },
      );
    });

    const outcome = await runJob(workspace.app({ tasks: TASKS }, client));
    expect(outcome.summary.failures).toEqual([]);
    expect((await readDossier()).metadata['birthplace']).toBeUndefined();

    // The field produced no file, so the journal note is the whole account of
    // why — which is what `biomd report --notes` replays.
    const journal = await readFile(join(outcome.runDir, 'events.jsonl'), 'utf8');
    expect(journal).toContain('not present in provider web-search evidence');
  });
});
