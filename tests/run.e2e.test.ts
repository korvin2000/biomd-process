import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planJob, runJob } from '../src/app/runJob.js';
import { validateCatalogue } from '../src/domain/validate.js';
import { readCatalogue } from '../src/io/CatalogueReader.js';
import { LlmCallError } from '../src/reliability/errors.js';
import type { JournalRecord } from '../src/state/types.js';
import { DEFAULT_FACTS, FakeClient, Workspace, echoTable, isStringBatch, respond } from './helpers/workspace.js';

const ARTICLE = `# Пако де Лусия

::: lead

Испанский гитарист и композитор.

:::

::: image
src: photo/p/paco.jpg
position: right
caption: Пако де Лусия

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
    // 1 extraction + 2 translations + the source article, copied verbatim.
    expect(outcome.plan.tasks).toHaveLength(4);
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
    // 1 dossier + 1 catalogue-hint file + 2 translated articles + 1 copied source.
    expect(journal.filter((record) => record.type === 'artifact.written')).toHaveLength(5);
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
    expect(plan.skipped).toHaveLength(4);
    expect(plan.skipped.every((task) => task.reason === 'resume')).toBe(true);
  });

  it('re-plans a task the previous run retired, rather than treating it as finished', async () => {
    // A task retired behind a failed prerequisite never ran, so the checkpoint
    // must not record it as settled — a resume that skips it is a run declining
    // to do the work that would have fixed the corpus.
    const failing = new FakeClient((call) => {
      if (isStringBatch(call.request)) return respond(echoTable(call.request));
      return new LlmCallError('invalid_request', 'no dossier for you');
    });
    const first = workspace.app({ tasks: { ...TASKS, localize: { enabled: true } } }, failing);
    const firstOutcome = await runJob(first);
    expect(firstOutcome.summary.status).toBe('failed');

    const second = workspace.app(
      { tasks: { ...TASKS, localize: { enabled: true } }, run: { resume: firstOutcome.runId } },
      FakeClient.happyPath(),
    );
    const plan = await planJob(second);

    expect(plan.tasks.map((task) => task.pipeline)).toContain('localize');
    expect(plan.skipped.every((task) => task.reason === 'resume')).toBe(true);
  });

  it('re-plans work whose prompt template changed', async () => {
    const first = workspace.app({ tasks: TASKS }, FakeClient.happyPath());
    const firstOutcome = await runJob(first);

    await workspace.writeFile('prompts/extraction/user.md', 'Language: <%= it.language %>. Be exhaustive.');

    const second = workspace.app({ tasks: TASKS, run: { resume: firstOutcome.runId } }, FakeClient.happyPath());
    const plan = await planJob(second);

    expect(plan.tasks.map((task) => task.pipeline)).toEqual(['extract']);
    expect(plan.skipped).toHaveLength(3);
  });

  it('writes nothing in dry-run mode', async () => {
    const app = workspace.app({ tasks: TASKS, run: { dryRun: true } }, FakeClient.happyPath());
    const plan = await planJob(app);

    expect(plan.tasks).toHaveLength(4);
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
    // Uppercase every translated value, so anything that came back unchanged is
    // provably a field that was never sent. The media is not in this answer at
    // all: it is harvested from the article's own `::: image` container.
    const client = new FakeClient((call) => {
      if (isStringBatch(call.request)) return respond(echoTable(call.request, (text) => text.toUpperCase()));
      if (call.request.responseFormat?.type === 'json_object') return respond(JSON.stringify(DEFAULT_FACTS));
      return respond('');
    });

    const app = workspace.app({ tasks: { ...FULL, translate: { enabled: false }, localize: { enabled: true, targetLanguages: ['en'] } } }, client);
    await runJob(app);

    const source = JSON.parse(await readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8'));
    const edition = JSON.parse(await readFile(workspace.path('out/en/paco-de-lucia.bio.json'), 'utf8'));

    expect(edition.metadata.forename).toBe('ПАКО');
    expect(edition.media.photos[0].label).toBe('ПАКО ДЕ ЛУСИЯ');
    expect(edition.metadata.dates).toEqual(source.metadata.dates);
    expect(edition.metadata.url).toBe(source.metadata.url);
    expect(source.media.photos[0].target).toBe('photo/p/paco.jpg');
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

    // `displayNameOrder: roster` files the roster's own language surname-first —
    // the catalogue's order, and what a reader sees under the thumbnail. The
    // other order is kept right behind it, so both stay searchable.
    const names = JSON.parse(await readFile(workspace.path('out/index-ru.json'), 'utf8'));
    expect(names['1'][0]).toBe('де Лусия Пако');
    expect(names['1']).toContain('Пако де Лусия');
  });

  /**
   * The strongest statement this suite can make: a full run produces a
   * catalogue that satisfies the format's own invariant list. Everything else
   * here checks one rule; this checks that the rules hold together.
   */
  it('produces a catalogue that passes every invariant', async () => {
    await workspace.writeFile('corpus/ru/andres-segovia.bio.md', '# Андрес Сеговия\n\nИспанский гитарист.\n');
    await runJob(workspace.app({ tasks: FULL }, FakeClient.happyPath()));

    const snapshot = await readCatalogue(workspace.path('out'), { supportedLanguages: ['ru', 'en'] });
    const findings = validateCatalogue(snapshot, { supportedLanguages: ['ru', 'en'] });

    expect(findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('copies the source article, so the original edition is not a broken link', async () => {
    await runJob(workspace.app({ tasks: FULL }, FakeClient.happyPath()));

    await expect(readFile(workspace.path('out/ru/paco-de-lucia.bio.md'), 'utf8')).resolves.toContain('Пако де Лусия');
    const index = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));
    expect(index[0].lang).toBe('ru,en');
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
      isStringBatch(call.request)
        ? respond(echoTable(call.request))
        : new LlmCallError('server', 'extraction is down'),
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

describe('an entry that already has a dossier', () => {
  const V1_DOSSIER = JSON.stringify({
    title: 'Paco de Lucia',
    type: 'Guitarist',
    country: 'Spain',
    img: 'photos/paco.jpg',
    bio: 'prose that belongs in the article',
    metadata: {
      forename: 'Пако',
      surname: 'де Лусия',
      dates: { born: '1947-12-21' },
      genres: ['фламенко', 'джаз-фьюжн'],
      ranking: 98,
    },
  });

  it('does not call a model at all, and says so in the plan', async () => {
    await workspace.writeFile('corpus/ru/paco-de-lucia.bio.json', V1_DOSSIER);
    const client = FakeClient.happyPath();
    const app = workspace.app({ tasks: { extract: { enabled: true } } }, client);

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('completed');
    expect(client.calls).toHaveLength(0);
    expect(outcome.plan.tasks[0]?.usesLlm).toBe(false);
  });

  it('migrates it to version 2 on the way through', async () => {
    await workspace.writeFile('corpus/ru/paco-de-lucia.bio.json', V1_DOSSIER);
    await runJob(workspace.app({ tasks: { extract: { enabled: true } } }, FakeClient.happyPath()));

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8'));
    for (const member of ['title', 'type', 'country', 'img', 'bio']) {
      expect(dossier).not.toHaveProperty(member);
      expect(dossier.metadata).not.toHaveProperty(member);
    }
    expect(dossier.metadata.dates.born).toBe('21.12.1947');
    expect(dossier.metadata.genres).toBe('фламенко,джаз-фьюжн');

    // The identity fields are not thrown away — they are where index.json gets them.
    const hints = JSON.parse(await readFile(workspace.path('out/.hints/paco-de-lucia.json'), 'utf8'));
    expect(hints).toMatchObject({ title: 'Paco de Lucia', type: 'guitarist', country: 'es', img: 'photos/paco.jpg' });
  });

  it('asks only for the fields it is missing, in `complete` mode', async () => {
    await workspace.writeFile(
      'corpus/ru/paco-de-lucia.bio.json',
      JSON.stringify({ metadata: { forename: 'Пако', surname: 'де Лусия' } }),
    );
    const client = FakeClient.happyPath({ born: '21.12.1947', country: 'es' });
    const app = workspace.app(
      { tasks: { extract: { enabled: true, onExistingDossier: 'complete' } } },
      client,
    );

    await runJob(app);

    const asked = client.calls[0]?.request.messages[0]?.content ?? '';
    expect(asked).not.toContain('- forename:');
    expect(asked).toContain('- born:');

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8'));
    expect(dossier.metadata.forename).toBe('Пако');
    expect(dossier.metadata.dates.born).toBe('21.12.1947');
  });

  it('never overwrites a value the authored file already had', async () => {
    await workspace.writeFile(
      'corpus/ru/paco-de-lucia.bio.json',
      JSON.stringify({ metadata: { forename: 'Пако', surname: 'де Лусия', birthplace: 'Альхесирас, Испания' } }),
    );
    const client = FakeClient.happyPath({ forename: 'WRONG', birthplace: 'WRONG', instruments: 'фламенко-гитара' });
    const app = workspace.app(
      { tasks: { extract: { enabled: true, onExistingDossier: 'rebuild' } } },
      client,
    );
    await runJob(app);
    // `rebuild` is the one mode that is allowed to replace it.
    expect(
      JSON.parse(await readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8')).metadata.forename,
    ).toBe('WRONG');

    await workspace.writeFile('corpus/ru/paco-de-lucia.bio.json', JSON.stringify({
      metadata: { forename: 'Пако', surname: 'де Лусия', birthplace: 'Альхесирас, Испания' },
    }));
    const completing = workspace.app(
      { tasks: { extract: { enabled: true, onExistingDossier: 'complete' } }, output: { onExisting: 'overwrite' } },
      FakeClient.happyPath({ forename: 'WRONG', birthplace: 'WRONG', instruments: 'фламенко-гитара' }),
    );
    await runJob(completing);

    const dossier = JSON.parse(await readFile(workspace.path('out/ru/paco-de-lucia.bio.json'), 'utf8'));
    expect(dossier.metadata.forename).toBe('Пако');
    expect(dossier.metadata.birthplace).toBe('Альхесирас, Испания');
    expect(dossier.metadata.instruments).toBe('фламенко-гитара');
  });
});

/**
 * A biography states its identity in the lead and everything else wherever the
 * prose reached it. The head-first ladder answered the first question and
 * stopped, so every fact past the truncation point came back absent —
 * indistinguishable from an article that never stated it.
 */
describe('extraction reads the whole article', () => {
  /** Long enough to be truncated by `headTokens: 1500`, small enough to fit one call. */
  const TAIL = 'Играл на гитаре, лютне и даже балалайке.';
  const LONG =
    '# Пако де Лусия\n\nИспанский гитарист и композитор.\n\n' +
    'Пако много гастролировал по всему миру и записывал новые альбомы.\n\n'.repeat(200) +
    `${TAIL}\n`;

  const CORPUS = { baseDir: 'corpus', include: ['*/long.bio.md'], sourceLanguage: 'auto' as const };

  /** What the article block of each extraction call actually carried. */
  function articlesSent(client: FakeClient): string[] {
    return client.calls
      .filter((call) => call.request.responseFormat?.type === 'json_object')
      .map((call) => call.request.messages.at(-1)?.content ?? '');
  }

  beforeEach(async () => {
    await workspace.writeFile('corpus/ru/long.bio.md', LONG);
  });

  it('skips the truncated rungs of the configured ladder instead of stopping at one', async () => {
    const client = FakeClient.happyPath();
    const app = workspace.app(
      {
        input: CORPUS,
        tasks: { extract: { enabled: true, requiredFields: ['metadata.forename'] } },
        context: { strategy: 'truncation-first' },
      },
      client,
    );

    await runJob(app);
    const sent = articlesSent(client);

    // One call, and it carried the sentence the head slice would have cut.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(TAIL);
  });

  it('still honours a deployment that asks for the cheap head-first reading', async () => {
    const client = FakeClient.happyPath();
    const app = workspace.app(
      {
        input: CORPUS,
        tasks: {
          extract: { enabled: true, requiredFields: ['metadata.forename'], readWholeDocument: false },
        },
        context: { strategy: 'truncation-first' },
      },
      client,
    );

    await runJob(app);
    const sent = articlesSent(client);

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain(TAIL);
  });
});

describe('the catalogue is updated, not rebuilt', () => {
  const CATALOG_ONLY = { extract: { enabled: true }, catalog: { enabled: true } };

  it('writes the merge even under output.onExisting: skip, which would discard it', async () => {
    await workspace.writeFile('out/index.json', JSON.stringify([]));
    await runJob(workspace.app({ tasks: CATALOG_ONLY, output: { onExisting: 'skip' } }, FakeClient.happyPath()));

    const index = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));
    expect(index).toHaveLength(1);
  });

  it('keeps a row this run never visited, and its id', async () => {
    await workspace.writeFile(
      'out/index.json',
      JSON.stringify([
        { id: '7', title: 'Andres Segovia', lang: 'ru', type: 'guitarist', md: '/andres-segovia.bio.md' },
      ]),
    );

    await runJob(workspace.app({ tasks: CATALOG_ONLY, output: { onExisting: 'overwrite' } }, FakeClient.happyPath()));
    const index = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));

    expect(index.map((row: { id: string }) => row.id)).toEqual(['7', '8']);
    expect(index[0]).toMatchObject({ title: 'Andres Segovia' });
  });

  it('never overwrites a classification an editor set by hand', async () => {
    await workspace.writeFile(
      'out/index.json',
      JSON.stringify([
        {
          id: '2',
          title: 'Curated Title',
          lang: 'ru',
          type: 'composer',
          country: 'fr',
          md: '/paco-de-lucia.bio.md',
          img: 'photos/curated.jpg',
          curator: 'sergey',
        },
      ]),
    );

    await runJob(workspace.app({ tasks: CATALOG_ONLY, output: { onExisting: 'overwrite' } }, FakeClient.happyPath()));
    const index = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));

    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      id: '2',
      title: 'Curated Title',
      type: 'composer',
      country: 'fr',
      img: 'photos/curated.jpg',
      curator: 'sergey',
    });
  });

  it('keeps a hand-authored display name and merges the derived aliases in', async () => {
    await workspace.writeFile(
      'out/index-ru.json',
      JSON.stringify({ '1': ['Пако де Лусия (исправлено)'], '99': ['Другая запись'] }),
    );

    await runJob(workspace.app({ tasks: CATALOG_ONLY, output: { onExisting: 'overwrite' } }, FakeClient.happyPath()));
    const names = JSON.parse(await readFile(workspace.path('out/index-ru.json'), 'utf8'));

    expect(names['1'][0]).toBe('Пако де Лусия (исправлено)');
    expect(names['1']).toContain('де Лусия Пако');
    expect(names['99']).toEqual(['Другая запись']);
  });
});

describe('failure handling', () => {
  it('falls back to the next model when the first one keeps failing', async () => {
    const client = new FakeClient((call) => {
      if (call.target === 'primary') return new LlmCallError('server', 'upstream exploded');
      return respond(JSON.stringify({ forename: 'Пако' }));
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

  it('moves straight to the next model when the answer is cut off, without retrying the same one', async () => {
    // The cut is deterministic: the payload was fine and the model ran out of
    // room, so re-asking it produces the identical truncation. Compare with the
    // `server` case above, which does spend its retries first.
    const client = new FakeClient((call) => {
      if (call.target === 'primary') return respond('{"forename":"Пак', { finishReason: 'length' });
      return respond(JSON.stringify({ forename: 'Пако' }));
    });
    const app = workspace.app({ tasks: { extract: TASKS.extract } }, client);

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('completed');
    expect(client.calls.map((call) => call.target)).toEqual(['primary', 'secondary']);
    expect(app.metrics.snapshot().retries).toBe(0);
  });

  it('still writes the catalogue when one document failed, instead of retiring it', async () => {
    await workspace.writeFile('corpus/ru/other.bio.md', '# Другой\n\nНепереводимый текст.\n');

    // Everything about `other` fails hard; `paco-de-lucia` translates normally.
    const client = new FakeClient((call) => {
      const payload = call.request.messages.at(-1)?.content ?? '';
      if (payload.includes('Непереводимый')) return new LlmCallError('invalid_request', 'no');
      if (isStringBatch(call.request)) return respond(echoTable(call.request));
      if (call.request.responseFormat?.type === 'json_object') return respond(JSON.stringify(DEFAULT_FACTS));
      return respond('');
    });

    const app = workspace.app(
      {
        tasks: {
          ...TASKS,
          translate: { enabled: true, targetLanguages: ['en'] },
          localize: { enabled: true, targetLanguages: ['en'] },
          catalog: { enabled: true },
        },
      },
      client,
    );
    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('failed');

    // The point: the surviving document still has a catalogue row. The index
    // depends on the translations only for *ordering*, and reports what reached
    // the disk — one document's bad luck is not the corpus's.
    const index = JSON.parse(await readFile(workspace.path('out/index.json'), 'utf8'));
    const survivor = index.find((row: { md: string }) => row.md === '/paco-de-lucia.bio.md');
    expect(survivor?.lang).toBe('ru,en');

    // And it ran rather than being retired behind the failure: the index is an
    // artifact this run wrote, not one left over from a previous one.
    const journal = await readJournal(outcome.runDir);
    expect(journal.some((record) => record.type === 'artifact.written' && record.channel === 'catalogIndex')).toBe(true);
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
      return respond(calls === 1 ? JSON.stringify({ surname: 'де Лусия' }) : JSON.stringify({ forename: 'Пако' }));
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
