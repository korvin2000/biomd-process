import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import { falseSourceEvidence, isTranslatable, untranslatedReason } from '../src/pipelines/shared/script.js';
import type { CompletionRequest, CompletionResponse, LlmClient, ModelTarget } from '../src/llm/types.js';
import {
  DEFAULT_FACTS,
  Workspace,
  echoTable,
  isStringBatch,
  requestedTable,
  respond,
  translated,
} from './helpers/workspace.js';

describe('a value the model did not answer', () => {
  /** Judged on its own, with a source it is not a copy of. */
  const ruToEs = (text: string) => untranslatedReason('Источник', text, 'ru', 'es');

  it('is caught when every letter is still Cyrillic', () => {
    expect(ruToEs('Наталья Липницкая')).toMatch(/untranslated/);
  });

  /** Digits and punctuation are not letters, so they never acquit a value. */
  it('is caught behind a year, a bracket or a dash', () => {
    expect(ruToEs('Наталья Липницкая (2003)')).toMatch(/untranslated/);
    expect(ruToEs('Гитара — 1987–1991')).toMatch(/untranslated/);
  });

  /**
   * One letter from anywhere else is enough. A gloss is a judgement about
   * bibliographic style and a half-transliteration belongs to
   * `introducedMixedScriptWords`; neither is this check's business.
   */
  it('is not claimed when the value carries a rendering as well', () => {
    expect(ruToEs('«Нева» (Neva)')).toBeUndefined();
    expect(ruToEs('Дебюсси / Debussy')).toBeUndefined();
    expect(ruToEs('Debussи')).toBeUndefined();
  });

  /** ru → uk is a translation between two languages written in the same alphabet. */
  it('says nothing when the target uses the source alphabet', () => {
    expect(untranslatedReason('Наталья Липницкая', 'Наталя Липницька', 'ru', 'uk')).toBeUndefined();
    expect(untranslatedReason('Наталья Липницкая', 'Наталья Липницкая', 'ru', 'ru')).toBeUndefined();
  });

  /**
   * Nothing here can tell an English sentence from an untranslated Italian one,
   * which is the same reason `isTranslatable` gives for the weaker test.
   */
  it('has no opinion about a source language written in Latin', () => {
    expect(untranslatedReason('Andrés Segovia', 'Andrés Segovia', 'en', 'es')).toBeUndefined();
  });

  /** The rule is about alphabets, not about Latin. */
  it('accepts a target language with an alphabet of its own', () => {
    expect(untranslatedReason('Наталья Липницкая', 'ナタリヤ・リプニツカヤ', 'ru', 'ja')).toBeUndefined();
    expect(untranslatedReason('Наталья Липницкая', 'Наталья Липницкая', 'ru', 'ja')).toMatch(/exactly as it was sent/);
  });

  /**
   * The hole the alphabet test alone leaves, measured on a real run: eight
   * lines of Russian prose in a Spanish edition, every one of them carrying a
   * Latin word — a competition, an album, a composer — that acquitted it.
   */
  it('is caught when the value is exactly what was sent, whatever else is in it', () => {
    const sentence = 'Лауреат международного конкурса "Ghitaralia" (Польша, 1998)';
    expect(untranslatedReason(sentence, sentence, 'ru', 'es')).toMatch(/exactly as it was sent/);
    expect(untranslatedReason(sentence, sentence, 'ru', 'es')).toBeDefined();
    // The same sentence, worked on, is not this check's business any more.
    expect(untranslatedReason(sentence, 'Laureada del concurso "Ghitaralia"', 'ru', 'es')).toBeUndefined();
  });

  /** A fragment with nothing to translate is answered locally and never sent. */
  it('does not claim a fragment that carries no source-language words', () => {
    expect(untranslatedReason('Allegro vivo', 'Allegro vivo', 'ru', 'es')).toBeUndefined();
  });

  it('has nothing to say about a value with no letters in it', () => {
    expect(ruToEs('1893–1987')).toBeUndefined();
    expect(ruToEs('⟦1⟧')).toBeUndefined();
  });
});

/**
 * `Danсa` is `Dança` typed on a Russian keyboard: the `с` is U+0441, Cyrillic.
 * One mistyped letter used to be the whole of the evidence that a Portuguese
 * album title was a Russian sentence, and the cost of reading it that way was
 * eleven editions of `assad_b` that no model in the pool could ever produce —
 * every one of them handing the title back correctly and being told it had
 * translated nothing.
 */
describe('a source-language word, rather than a source-language letter', () => {
  const TITLE = '**Danсa dos Tons**';

  it('does not find one in a Latin title with a mistyped Cyrillic letter', () => {
    expect(isTranslatable(TITLE, 'ru')).toBe(false);
    expect(untranslatedReason(TITLE, TITLE, 'ru', 'es')).toBeUndefined();
  });

  it('still finds one in Russian prose that quotes a Latin name', () => {
    const prose = 'Играл на гитаре Pedro Maldonado';
    expect(isTranslatable(prose, 'ru')).toBe(true);
    expect(untranslatedReason(prose, prose, 'ru', 'es')).toMatch(/exactly as it was sent/);
  });

  /** One typo in a sentence is a typo; it does not excuse the sentence. */
  it('is not fooled by a typo sitting inside a real Russian sentence', () => {
    const sentence = 'Лауреат международного конкурса Danсa dos Tons';
    expect(isTranslatable(sentence, 'ru')).toBe(true);
    expect(untranslatedReason(sentence, sentence, 'ru', 'es')).toMatch(/exactly as it was sent/);
  });

  /** Kept verbatim is right, and silent — so the typo is named for the run notes. */
  it('names the word that caused it', () => {
    expect(falseSourceEvidence(TITLE, 'ru')).toEqual(['Danсa']);
    expect(falseSourceEvidence('Allegro vivo', 'ru')).toEqual([]);
    expect(falseSourceEvidence('Наталья Липницкая', 'ru')).toEqual([]);
    expect(falseSourceEvidence('Лауреат международного конкурса Danсa', 'ru')).toEqual([]);
  });
});

const ARTICLE = `# Наталья Липницкая

Липницкая родилась в Екатеринбурге.

::: image
src: /img/lipnitskaya.jpg
caption: Наталья Липницкая
:::
`;

const POOL = {
  llm: {
    endpoints: [{ id: 'fake', baseUrl: 'http://localhost:9/v1', apiKey: 'x' }],
    models: [
      { id: 'lazy', endpoint: 'fake', model: 'lazy-model', contextWindow: 32_000, maxOutputTokens: 4096 },
      { id: 'diligent', endpoint: 'fake', model: 'diligent-model', contextWindow: 32_000, maxOutputTokens: 4096 },
    ],
    routing: { strategy: 'sequential', pools: { default: ['lazy', 'diligent'] } },
  },
};

let workspace: Workspace;

beforeEach(async () => {
  workspace = await Workspace.create();
  await workspace.writeDefaultPrompts();
  await workspace.writeFile('corpus/ru/lipnitskaya.bio.md', ARTICLE);
});

afterEach(async () => {
  await workspace.destroy();
});

/**
 * `lazy` reproduces the measured defect and `diligent` does not.
 *
 * The defect is narrow, and the fixture keeps it narrow: prose is translated,
 * the name standing on its own as a heading or a caption is handed back. A fake
 * that fails *every* fragment would only ever exercise "the whole answer was
 * unusable", which is a different path — the batch fails outright instead of
 * going round the repair ladder one key at a time.
 */
class TwoTranslators implements LlmClient {
  readonly endpointId = 'fake';
  readonly served: { model: string; keys: string[] }[] = [];
  /** Every fragment that actually crossed the wire, for the checks about what did not. */
  readonly sent: string[] = [];

  constructor(private readonly lazyAnswer: (text: string) => string = (text) => text) {}

  private answerAsLazy = (text: string): string =>
    text.startsWith('Наталья') ? this.lazyAnswer(text) : translated(text);

  async complete(target: ModelTarget, request: CompletionRequest): Promise<CompletionResponse> {
    if (!isStringBatch(request)) {
      return respond(request.responseFormat?.type === 'json_object' ? JSON.stringify(DEFAULT_FACTS) : '');
    }
    const table = requestedTable({ target: target.modelId, request });
    this.served.push({ model: target.modelId, keys: Object.keys(table) });
    this.sent.push(...Object.values(table));
    return respond(echoTable(request, target.modelId === 'lazy' ? this.answerAsLazy : translated));
  }
}

describe('a model that hands the fragment straight back', () => {
  /**
   * The defect this exists for, measured: twenty documents translated ru → es
   * by one model came back with nineteen values still in Cyrillic, twelve of
   * them a person's name standing as a heading or a caption. The prompt forbids
   * it in three places; an instruction is a request, and this is a check.
   */
  it('is asked again, and then replaced by one that translates', async () => {
    const client = new TwoTranslators();
    const app = workspace.app(
      { ...POOL, tasks: { translate: { enabled: true, targetLanguages: ['es'] } } },
      client,
    );

    const outcome = await runJob(app);
    expect(outcome.summary.failures).toEqual([]);

    // The cheap axis first: the one bad key is re-asked on the model already
    // chosen, alone, and only the key that survives that moves to another model.
    const lazyCalls = client.served.filter((call) => call.model === 'lazy');
    expect(lazyCalls.length).toBeGreaterThan(1);
    expect(lazyCalls.at(-1)?.keys.length).toBe(1);
    expect(client.served.some((call) => call.model === 'diligent')).toBe(true);

    const article = await readFile(workspace.path('out/es/lipnitskaya.bio.md'), 'utf8');
    expect(article).toContain('Natalya Lipnitskaya');
    expect(article).not.toContain('Наталья Липницкая');
  });

  /** The heading and the caption both go through the check, not only the prose. */
  it('does not let a Cyrillic heading reach a Spanish page', async () => {
    const client = new TwoTranslators();
    await runJob(
      workspace.app({ ...POOL, tasks: { translate: { enabled: true, targetLanguages: ['es'] } } }, client),
    );

    const article = await readFile(workspace.path('out/es/lipnitskaya.bio.md'), 'utf8');
    expect(article.split('\n')[0]).toBe('# Natalya Lipnitskaya');
    expect(article).toContain('caption: Natalya Lipnitskaya');
  });

  /** The same check, on the flat table of names and places `localize` sends. */
  it('is caught in a dossier field as well as in an article', async () => {
    const client = new TwoTranslators();
    const app = workspace.app(
      {
        ...POOL,
        tasks: {
          extract: { enabled: true },
          localize: { enabled: true, targetLanguages: ['es'] },
        },
      },
      client,
    );

    const outcome = await runJob(app);
    expect(outcome.summary.failures).toEqual([]);

    const dossier = JSON.parse(await readFile(workspace.path('out/es/lipnitskaya.bio.json'), 'utf8'));
    expect(dossier.metadata.forename).toBe('Pako');
  });
});

describe('a work title with one mistyped Cyrillic letter in it', () => {
  const TITLE = '**Danсa dos Tons**';

  /**
   * The measured failure, end to end: the title is not sent, so no model can be
   * accused of failing to translate it, and no edition of the article is lost to
   * a fall-back chain that had nothing to fall back to.
   */
  it('is never sent, and the typo is named rather than left silent', async () => {
    await workspace.writeFile(
      'corpus/ru/assad.bio.md',
      `# Сержио Ассад

Ассад записал этот альбом в Париже.

${TITLE}
`,
    );
    const client = new TwoTranslators();
    const app = workspace.app(
      { ...POOL, tasks: { translate: { enabled: true, targetLanguages: ['es'] } } },
      client,
    );

    const outcome = await runJob(app);
    expect(outcome.summary.failures).toEqual([]);
    expect(client.sent.some((text) => text.includes('Danсa'))).toBe(false);

    // Kept verbatim, which is what the title deserves…
    const article = await readFile(workspace.path('out/es/assad.bio.md'), 'utf8');
    expect(article).toContain(TITLE);
    // …and said out loud, because the article is the thing that needs fixing.
    const journal = await readFile(join(outcome.runDir, 'events.jsonl'), 'utf8');
    expect(journal).toContain('fix the typo in the article');
  });
});

/**
 * The other end of the same check, and the reason it has one.
 *
 * Rejecting on the strict round is what reaches a model that translates, and it
 * works — the pool above proves it. But the ladder is finite, and when the last
 * rung has been climbed the check is no longer choosing between a good document
 * and a bad one: it is choosing between a bad document and none. A real run lost
 * eleven editions of one article that way, to a fragment no model would ever
 * have translated.
 */
describe('a fragment every model in the pool hands straight back', () => {
  class Stubborn implements LlmClient {
    readonly endpointId = 'fake';
    batches = 0;

    async complete(_target: ModelTarget, request: CompletionRequest): Promise<CompletionResponse> {
      if (!isStringBatch(request)) {
        return respond(request.responseFormat?.type === 'json_object' ? JSON.stringify(DEFAULT_FACTS) : '');
      }
      this.batches += 1;
      return respond(echoTable(request, (text) => (text.startsWith('Наталья') ? text : translated(text))));
    }
  }

  it('is published with a note rather than costing the document', async () => {
    const client = new Stubborn();
    const app = workspace.app(
      {
        ...POOL,
        reliability: { taskFallback: { maxAttempts: 2 } },
        tasks: { translate: { enabled: true, targetLanguages: ['es'] } },
      },
      client,
    );

    const outcome = await runJob(app);
    expect(outcome.summary.failures).toEqual([]);

    // It insisted first — down the pool and then over a second attempt.
    expect(client.batches).toBeGreaterThan(2);

    // The rest of the article is translated; the value nobody would answer is
    // published as it was sent…
    const article = await readFile(workspace.path('out/es/lipnitskaya.bio.md'), 'utf8');
    expect(article).toContain('Наталья Липницкая');
    expect(article).toContain(translated('Липницкая родилась в Екатеринбурге.'));

    // …and the note is the whole account of a decision that produced a file.
    const journal = await readFile(join(outcome.runDir, 'events.jsonl'), 'utf8');
    expect(journal).toContain('came back untranslated from every model in the pool');
  });
});

describe('a name that changed alphabet halfway through', () => {
  /**
   * Re-asked while that is free and never failed. Which half of `Debussи` is
   * right is not knowable from here, and a document nobody can produce is worse
   * than a name somebody has to check — so the check gives up on the strict
   * round rather than escalating.
   */
  it('is re-asked, but never costs the document', async () => {
    // Translates, then puts one Cyrillic letter back — the shape of a model
    // transliterating a name it half-recognized and stopping in the middle.
    const client = new TwoTranslators((text) => translated(text).replace(/y/g, 'у'));
    const app = workspace.app(
      { ...POOL, tasks: { translate: { enabled: true, targetLanguages: ['es'] } } },
      client,
    );

    const outcome = await runJob(app);
    expect(outcome.summary.failures).toEqual([]);
    expect(client.served.filter((call) => call.model === 'lazy').length).toBeGreaterThan(1);
    // It insisted, so it was published — and nothing was escalated over it.
    expect(client.served.some((call) => call.model === 'diligent')).toBe(false);

    const article = await readFile(workspace.path('out/es/lipnitskaya.bio.md'), 'utf8');
    expect(article).toContain('Natalуa');
  });
});
