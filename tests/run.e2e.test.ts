import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planJob, runJob } from '../src/app/runJob.js';
import { LlmCallError } from '../src/reliability/errors.js';
import type { JournalRecord } from '../src/state/types.js';
import { FakeClient, Workspace, echoTable, respond } from './helpers/workspace.js';

const ARTICLE = `# Пако де Лусия

::: lead

Испанский гитарист и композитор.

:::

## От традиции к новому звучанию

Первые уроки Пако получил в семье.

[Официальная биография](https://fundacionpacodelucia.com/legado/)
`;

const TASKS = {
  extract: { enabled: true, requiredFields: ['metadata.forename'] },
  translate: { enabled: true, targetLanguages: ['en', 'de'] },
};

let workspace: Workspace;

beforeEach(async () => {
  workspace = await Workspace.create();
  await workspace.writeDefaultPrompts();
  await workspace.writeFile('corpus/ru/paco-de-lucia.bio.md', ARTICLE);
});

afterEach(async () => {
  await workspace.destroy();
});

async function readJournal(runDir: string): Promise<JournalRecord[]> {
  const raw = await readFile(`${runDir}/events.jsonl`, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalRecord);
}

describe('end-to-end run', () => {
  it('extracts metadata and translates into every target language', async () => {
    const client = FakeClient.happyPath();
    const app = workspace.app({ tasks: TASKS }, client);

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('completed');
    expect(outcome.plan.tasks).toHaveLength(3); // 1 extraction + 2 languages
    expect(outcome.summary.failures).toEqual([]);

    const metadata = JSON.parse(await readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8'));
    expect(metadata.metadata.forename).toBe('Пако');

    for (const lang of ['en', 'de']) {
      const translated = await readFile(workspace.path(`out/${lang}/paco-de-lucia.bio.md`), 'utf8');
      expect(translated.trim()).toBe(ARTICLE.trim());
    }
  });

  it('writes a journal that accounts for every LLM call and artifact', async () => {
    const app = workspace.app({ tasks: TASKS }, FakeClient.happyPath());
    const outcome = await runJob(app);
    const journal = await readJournal(outcome.runDir);

    const types = journal.map((record) => record.type);
    expect(types).toContain('run.started');
    expect(types).toContain('plan.created');
    expect(types).toContain('run.finished');
    expect(journal.filter((record) => record.type === 'llm.attempt')).toHaveLength(3);
    expect(journal.filter((record) => record.type === 'artifact.written')).toHaveLength(3);
    expect(journal.every((record) => record.seq > 0 && record.runId === outcome.runId)).toBe(true);
  });

  it('records token usage and cost in the manifest', async () => {
    const app = workspace.app({ tasks: TASKS }, FakeClient.happyPath());
    const outcome = await runJob(app);

    const manifest = JSON.parse(await readFile(`${outcome.runDir}/run.json`, 'utf8'));
    expect(manifest.totals.llmRequests).toBe(3);
    expect(manifest.totals.promptTokens).toBe(300);
    expect(manifest.totals.costUsd).toBeGreaterThan(0);
    expect(manifest.status).toBe('completed');
  });

  it('redacts endpoint secrets in the manifest', async () => {
    const app = workspace.app({ tasks: TASKS }, FakeClient.happyPath());
    const outcome = await runJob(app);

    const manifest = JSON.parse(await readFile(`${outcome.runDir}/run.json`, 'utf8'));
    expect(manifest.config.llm.endpoints[0].apiKey).toBe('***');
  });

  it('skips work already completed when resuming', async () => {
    const first = workspace.app({ tasks: TASKS }, FakeClient.happyPath());
    const firstOutcome = await runJob(first);

    const second = workspace.app({ tasks: TASKS, run: { resume: firstOutcome.runId } }, FakeClient.happyPath());
    const plan = await planJob(second);

    expect(plan.tasks).toHaveLength(0);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.skipped.every((task) => task.reason === 'resume')).toBe(true);
  });

  it('re-plans work whose prompt template changed', async () => {
    const first = workspace.app({ tasks: TASKS }, FakeClient.happyPath());
    const firstOutcome = await runJob(first);

    await workspace.writeFile('prompts/extraction/user.md', 'Language: <%= it.language %>. Be exhaustive.');

    const second = workspace.app({ tasks: TASKS, run: { resume: firstOutcome.runId } }, FakeClient.happyPath());
    const plan = await planJob(second);

    expect(plan.tasks.map((task) => task.pipeline)).toEqual(['extract']);
    expect(plan.skipped).toHaveLength(2);
  });

  it('writes nothing in dry-run mode', async () => {
    const app = workspace.app({ tasks: TASKS, run: { dryRun: true } }, FakeClient.happyPath());
    const plan = await planJob(app);

    expect(plan.tasks).toHaveLength(3);
    await expect(readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8')).rejects.toThrow();
  });
});

describe('language editions and catalogue', () => {
  const FULL = {
    extract: { enabled: true, requiredFields: ['metadata.forename'] },
    translate: { enabled: true, targetLanguages: ['en'] },
    localize: { enabled: true },
    catalog: { enabled: true },
  };

  it('puts a localized article and a localized dossier in the target directory', async () => {
    const app = workspace.app({ tasks: FULL }, FakeClient.happyPath());
    const outcome = await runJob(app);

    expect(outcome.summary.failures).toEqual([]);
    // ru: source article + extracted dossier. en: translated article + localized dossier.
    const dossier = JSON.parse(await readFile(workspace.path('out/en/paco-de-lucia.bio.json'), 'utf8'));
    const article = await readFile(workspace.path('out/en/paco-de-lucia.bio.md'), 'utf8');

    expect(dossier.metadata.forename).toBe('Пако'); // identity "translation" from the fake
    expect(article.trim()).toBe(ARTICLE.trim());
    await expect(readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8')).resolves.toContain('forename');
  });

  it('runs localization after the extraction it depends on', async () => {
    const app = workspace.app({ tasks: FULL }, FakeClient.happyPath());
    const outcome = await runJob(app);
    const journal = await readJournal(outcome.runDir);

    const started = journal.filter((record) => record.type === 'task.started');
    const extractAt = started.findIndex((record) => 'pipeline' in record && record.pipeline === 'extract');
    const localizeAt = started.findIndex((record) => 'pipeline' in record && record.pipeline === 'localize');

    expect(extractAt).toBeGreaterThanOrEqual(0);
    expect(localizeAt).toBeGreaterThan(extractAt);
  });

  it('keeps language-invariant dossier fields identical across editions', async () => {
    const metadata = {
      metadata: {
        forename: 'Пако',
        surname: 'де Лусия',
        dates: { born: '21.12.1947' },
        ranking: 98,
        url: 'https://fundacionpacodelucia.com/legado/',
      },
      media: { photos: [{ label: 'Портрет', target: '/photos/paco.jpg' }], music: [] },
      documents: [],
    };
    // Uppercase every translated value, so anything that came back unchanged is
    // provably a field that was never sent.
    const client = new FakeClient((call) => {
      if (call.request.responseFormat?.type === 'json_schema') return respond(JSON.stringify(metadata));
      if (call.request.responseFormat?.type === 'json_object') {
        return respond(echoTable(call.request, (text) => text.toUpperCase()));
      }
      return respond('');
    });

    const app = workspace.app({ tasks: { ...FULL, translate: { enabled: false }, localize: { enabled: true, targetLanguages: ['en'] } } }, client);
    await runJob(app);

    const source = JSON.parse(await readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8'));
    const edition = JSON.parse(await readFile(workspace.path('out/en/paco-de-lucia.bio.json'), 'utf8'));

    expect(edition.metadata.forename).toBe('ПАКО');
    expect(edition.media.photos[0].label).toBe('ПОРТРЕТ');
    expect(edition.metadata.dates).toEqual(source.metadata.dates);
    expect(edition.metadata.ranking).toBe(source.metadata.ranking);
    expect(edition.metadata.url).toBe(source.metadata.url);
    expect(edition.media.photos[0].target).toBe(source.media.photos[0].target);
  });

  it('writes a catalogue index listing the editions that exist', async () => {
    const app = workspace.app({ tasks: FULL }, FakeClient.happyPath());
    await runJob(app);

    const index = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      id: '1',
      lang: 'ru,en',
      md: '/paco-de-lucia.bio.md',
      json: '/paco-de-lucia.bio.json',
    });

    const names = JSON.parse(await readFile(workspace.path('out/index-ru.json'), 'utf8'));
    expect(names['1'][0]).toBe('Пако де Лусия');
  });

  it('keeps catalogue ids stable across runs', async () => {
    await runJob(workspace.app({ tasks: FULL }, FakeClient.happyPath()));
    const first = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));

    await workspace.writeFile('corpus/ru/andres-segovia.bio.md', '# Андрес Сеговия\n\nГитарист.\n');
    await runJob(workspace.app({ tasks: FULL }, FakeClient.happyPath()));
    const second = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));

    const paco = second.find((row: { md: string }) => row.md.includes('paco'));
    expect(paco.id).toBe(first[0].id);
    expect(second).toHaveLength(2);
  });

  it('skips localization when its extraction failed, instead of paying for it', async () => {
    const client = new FakeClient((call) =>
      call.request.responseFormat?.type === 'json_schema'
        ? new LlmCallError('server', 'extraction is down')
        : respond(echoTable(call.request)),
    );
    const app = workspace.app({ tasks: { ...FULL, translate: { enabled: false }, localize: { enabled: true, targetLanguages: ['en'] }, catalog: { enabled: false } } }, client);

    const outcome = await runJob(app);
    const journal = await readJournal(outcome.runDir);

    expect(outcome.summary.failures.map((failure) => failure.pipeline)).toEqual(['extract']);
    expect(
      journal.some((record) => record.type === 'task.skipped' && record.reason === 'dependency-failed'),
    ).toBe(true);
  });
});

describe('failure handling', () => {
  it('falls back to the next model when the first one keeps failing', async () => {
    const client = new FakeClient((call) => {
      if (call.target === 'primary') return new LlmCallError('server', 'upstream exploded');
      return respond(JSON.stringify({ metadata: { forename: 'Пако' } }));
    });
    const app = workspace.app({ tasks: { extract: TASKS.extract } }, client);

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('completed');
    // 2 retries against primary, then a successful call against secondary.
    expect(client.calls.map((call) => call.target)).toEqual(['primary', 'primary', 'secondary']);

    const journal = await readJournal(outcome.runDir);
    expect(journal.some((record) => record.type === 'llm.fallback')).toBe(true);
    expect(journal.some((record) => record.type === 'llm.retry')).toBe(true);
  });

  it('fails the task, not the process, when every target is exhausted', async () => {
    const client = new FakeClient(() => new LlmCallError('server', 'everything is down'));
    const app = workspace.app({ tasks: { extract: TASKS.extract } }, client);

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('failed');
    expect(outcome.summary.failures).toHaveLength(1);
    expect(outcome.summary.failures[0]?.message).toContain('exhausted');
  });

  it('rejects a response that fails the required-field check and retries', async () => {
    let calls = 0;
    const client = new FakeClient(() => {
      calls += 1;
      return respond(calls === 1 ? JSON.stringify({ metadata: {} }) : JSON.stringify({ metadata: { forename: 'Пако' } }));
    });
    const app = workspace.app({ tasks: { extract: TASKS.extract } }, client);

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('completed');
    expect(calls).toBeGreaterThan(1);
  });

  it('rejects a whole-document translation whose Markdown structure diverged', async () => {
    const client = new FakeClient(() => respond('# Wrong\n\nCompletely different structure.'));
    const app = workspace.app(
      { tasks: { translate: { enabled: true, targetLanguages: ['en'], mode: 'document' } } },
      client,
    );

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('failed');
    expect(outcome.summary.failures[0]?.message).toMatch(/structure/i);
  });

  it('rejects a segment translation that dropped a link placeholder', async () => {
    // Every fragment is echoed except the one carrying a masked URL, which is
    // returned without it — the failure a lost link would look like.
    const client = FakeClient.batch((text) => text.replace(/⟦\d+⟧/g, ''));
    const app = workspace.app({ tasks: { translate: { enabled: true, targetLanguages: ['en'] } } }, client);

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('failed');
    expect(outcome.summary.failures[0]?.message).toMatch(/placeholder/i);
  });

  it('stops the run once the request budget is spent', async () => {
    const app = workspace.app(
      { tasks: TASKS, cost: { budget: { maxRequests: 1 }, onExceeded: 'stop' }, run: { concurrency: 1 } },
      FakeClient.happyPath(),
    );

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('aborted');
    expect(app.metrics.snapshot().llmRequests).toBeLessThanOrEqual(2);
  });
});
