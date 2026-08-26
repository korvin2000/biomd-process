import { describe, expect, it } from 'vitest';

import { reasoningFields, toWireResponseFormat } from '../src/llm/OpenAiCompatibleClient.js';
import { reasoningSchema } from '../src/config/schema.js';
import {
  answeredKeys,
  buildDossier,
  fieldsFor,
  mergeFlat,
  normalizeFlat,
  parseFlatAnswer,
  toCardKey,
  type FlatRecord,
} from '../src/pipelines/extraction/FlatFields.js';

const FIELDS = fieldsFor({ catalogHints: true });
const OPTIONS = { supportedLanguages: ['ru', 'en', 'de'] };

function parse(text: string): FlatRecord {
  const parsed = parseFlatAnswer(text, FIELDS);
  expect(parsed.ok).toBe(true);
  return normalizeFlat(parsed.record, FIELDS).record;
}

describe('the flat field card', () => {
  it('leaves the catalogue keys out when hints are off', () => {
    const keys = fieldsFor({ catalogHints: false }).map((field) => field.key);
    expect(keys).not.toContain('country');
    expect(keys).toContain('forename');
  });

  it('honours an explicit selection, and still adds the catalogue keys', () => {
    const keys = fieldsFor({ include: ['forename', 'born', 'ranking'], catalogHints: true }).map((f) => f.key);
    expect(keys).toEqual(['forename', 'born', 'ranking', 'type', 'gender', 'country', 'latin']);
  });

  it('omits `ranking` by default — an editorial score is not a fact in an article', () => {
    expect(fieldsFor({ catalogHints: true }).map((field) => field.key)).not.toContain('ranking');
  });

  it('reads a requiredFields entry written as a dossier path', () => {
    expect(toCardKey('metadata.forename')).toBe('forename');
    expect(toCardKey('metadata.dates.born')).toBe('born');
    expect(toCardKey('surname')).toBe('surname');
  });
});

describe('reading an answer', () => {
  it('reads the flat object it asked for', () => {
    expect(parse('{"forename":"Пако","surname":"де Лусия"}')).toEqual({
      forename: 'Пако',
      surname: 'де Лусия',
    });
  });

  it('recovers the object from prose and a code fence', () => {
    const text = 'Sure! Here is the data:\n```json\n{"forename":"Пако"}\n```\nHope that helps.';
    expect(parse(text)).toEqual({ forename: 'Пако' });
  });

  it('flattens a nested answer rather than rejecting it', () => {
    const text = '{"metadata":{"forename":"Andrés","dates":{"born":"21.02.1893"}},"catalog":{"country":"es"}}';
    expect(parse(text)).toEqual({ forename: 'Andrés', born: '21.02.1893', country: 'es' });
  });

  it('falls back to key: value lines', () => {
    expect(parse('forename: Пако\nsurname: де Лусия\nnonsense: ignored')).toEqual({
      forename: 'Пако',
      surname: 'де Лусия',
    });
  });

  it('joins an array a model used where a comma list was asked for', () => {
    expect(parse('{"genres":["flamenco","jazz"]}')).toEqual({ genres: 'flamenco,jazz' });
  });

  it('drops the placeholders a model writes instead of omitting a key', () => {
    expect(parse('{"forename":"Пако","birthplace":"unknown","deathplace":"—","birthname":"не указано"}')).toEqual({
      forename: 'Пако',
    });
  });

  it('reports an answer that is not readable at all', () => {
    const parsed = parseFlatAnswer('I cannot help with that request.', FIELDS);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/neither a JSON object nor/);
  });
});

describe('value normalization', () => {
  it('rewrites the ISO date models keep emitting', () => {
    expect(parse('{"born":"1893-02-21"}')).toEqual({ born: '21.02.1893' });
    expect(parse('{"born":"1.2.1920"}')).toEqual({ born: '01.02.1920' });
  });

  it('drops a date that is not known to the day — the format cannot represent one', () => {
    expect(parse('{"born":"1893","died":"1893-02"}')).toEqual({});
  });

  it('drops a date that does not exist in the calendar', () => {
    expect(parse('{"born":"31.02.1900","died":"32.01.1920"}')).toEqual({});
  });

  it('applies the comma-list rule: split, trim, drop empties, dedupe', () => {
    expect(parse('{"genres":"rock, Pop ,, rock"}')).toEqual({ genres: 'rock,Pop' });
  });

  it('resolves a country written as a name, a demonym or alpha-3', () => {
    expect(parse('{"country":"Spain"}')).toEqual({ country: 'es' });
    expect(parse('{"country":"испанский"}')).toEqual({ country: 'es' });
    expect(parse('{"country":"ESP"}')).toEqual({ country: 'es' });
  });

  it('drops a country it cannot resolve rather than guessing', () => {
    expect(parse('{"country":"Middle-earth"}')).toEqual({});
  });

  it('maps a craft written in any language, and collapses two crafts to musician', () => {
    expect(parse('{"type":"Гитарист"}')).toEqual({ type: 'guitarist' });
    expect(parse('{"type":"guitar player"}')).toEqual({ type: 'guitarist' });
    expect(parse('{"type":"guitarist and composer"}')).toEqual({ type: 'musician' });
  });

  it('maps a gender written as a word', () => {
    expect(parse('{"gender":"Male"}')).toEqual({ gender: 'm' });
    expect(parse('{"gender":"коллектив"}')).toEqual({ gender: 'mixed' });
  });

  it('folds the Latin title to ASCII and refuses a relative url', () => {
    expect(parse('{"latin":"Andrés Segovia"}')).toEqual({ latin: 'Andres Segovia' });
    expect(parse('{"url":"/reference/segovia"}')).toEqual({});
    expect(parse('{"url":"https://example.org/x"}')).toEqual({ url: 'https://example.org/x' });
  });
});

describe('chunk merge', () => {
  const chunks: FlatRecord[] = [
    { forename: 'Пако', instruments: 'guitar', genres: 'flamenco' },
    { forename: 'Пако де Лусия', instruments: 'flamenco guitar', genres: 'jazz,flamenco' },
  ];

  it('unions list fields instead of taking the first chunk that mentioned any', () => {
    const merged = mergeFlat(chunks, FIELDS);
    expect(merged['instruments']).toBe('guitar,flamenco guitar');
    expect(merged['genres']).toBe('flamenco,jazz');
  });

  it('still takes the earliest mention for a scalar identity field', () => {
    expect(mergeFlat(chunks, FIELDS)['forename']).toBe('Пако');
  });
});

describe('assembling the dossier', () => {
  const record: FlatRecord = {
    forename: 'Андрес',
    surname: 'Сеговия',
    born: '21.02.1893',
    died: '02.06.1987',
    jobs: 'Гитарист,Педагог',
    url: 'https://example.org/segovia',
    type: 'guitarist',
    gender: 'm',
    country: 'es',
    latin: 'Andres Segovia',
  };

  it('nests the dates and keeps the lists as comma strings', () => {
    const { dossier } = buildDossier(record, FIELDS, OPTIONS);
    expect(dossier.metadata.dates).toEqual({ born: '21.02.1893', died: '02.06.1987' });
    expect(dossier.metadata.jobs).toBe('Гитарист,Педагог');
  });

  it('routes the identity facts to the catalogue instead of the dossier', () => {
    const { dossier, hints } = buildDossier(record, FIELDS, OPTIONS);
    expect(hints).toEqual({ type: 'guitarist', gender: 'm', country: 'es', title: 'Andres Segovia' });
    for (const forbidden of ['type', 'gender', 'country', 'title', 'img']) {
      expect(dossier.metadata).not.toHaveProperty(forbidden);
      expect(dossier).not.toHaveProperty(forbidden);
    }
  });

  it('writes the three sections even when nothing was found', () => {
    const { dossier } = buildDossier({}, FIELDS, OPTIONS);
    expect(dossier).toEqual({ metadata: {}, media: { photos: [], music: [] }, documents: [] });
  });

  it('carries the media harvested from the article', () => {
    const media = { photos: [{ label: 'Портрет', target: 'photo/s/segovia.jpg' }], music: [] };
    const { dossier } = buildDossier(record, FIELDS, { ...OPTIONS, media });
    expect(dossier.media?.photos).toEqual(media.photos);
  });

  it('carries the documents harvested from the article', () => {
    const documents = [{ label: 'Программка', target: 'articles/programme.pdf' }];
    const { dossier } = buildDossier(record, FIELDS, { ...OPTIONS, documents });
    expect(dossier.documents).toEqual(documents);
  });

  it('drops a harvested document that repeats metadata.url, whatever its spelling', () => {
    // `external/05` §5.4.5: the reader is shown `url` as a trailing source row,
    // so the same link as a `documents` item is a visible duplicate. The two
    // spellings are rarely identical — the prose says `MarinaAlexandra.com` and
    // the answer comes back lower-cased with a trailing slash.
    const documents = [
      { label: 'Источник', target: 'HTTPS://Example.ORG/segovia' },
      { label: 'Другая страница', target: 'https://example.org/other' },
    ];
    const { dossier, notes } = buildDossier(record, FIELDS, { ...OPTIONS, documents });
    expect(dossier.documents).toEqual([{ label: 'Другая страница', target: 'https://example.org/other' }]);
    expect(notes.join(' ')).toMatch(/repeating metadata\.url/);
  });

  it('emits the members in the house order, so an unchanged corpus re-renders identically', () => {
    const { dossier } = buildDossier(record, FIELDS, OPTIONS);
    expect(Object.keys(dossier)).toEqual(['metadata', 'media', 'documents']);
    expect(Object.keys(dossier.metadata)).toEqual(['forename', 'surname', 'dates', 'jobs', 'url']);
  });

  it('answeredKeys reports what the model actually supplied', () => {
    expect([...answeredKeys({ forename: 'x', surname: '' })]).toEqual(['forename']);
  });
});

describe('reasoning parameters', () => {
  const reasoning = (input: unknown) => ({ reasoning: reasoningSchema.parse(input) });

  it('sends nothing at all when no dialect is declared', () => {
    expect(reasoningFields(reasoning({}))).toEqual({});
    expect(reasoningFields(reasoning({ enabled: true }))).toEqual({});
  });

  it('turns reasoning on in the dialect the model speaks', () => {
    expect(reasoningFields(reasoning({ enabled: true, dialect: 'reasoning_effort', effort: 'low' }))).toEqual({
      reasoning_effort: 'low',
    });
    expect(reasoningFields(reasoning({ enabled: true, dialect: 'thinking', maxTokens: 2048 }))).toEqual({
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
  });

  it('turns it explicitly off, which is the only way to stop a model that reasons by default', () => {
    expect(reasoningFields(reasoning({ enabled: false, dialect: 'reasoning' }))).toEqual({
      reasoning: { enabled: false },
    });
    expect(reasoningFields(reasoning({ enabled: false, dialect: 'reasoning_effort' }))).toEqual({
      reasoning_effort: 'none',
    });
    expect(reasoningFields(reasoning({ enabled: false, dialect: 'thinking' }))).toEqual({
      thinking: { type: 'disabled' },
    });
  });
});

describe('response_format is a capability, not a default', () => {
  const target = (capabilities: string[]): any => ({ modelId: 't', capabilities });

  it('sends json_object only to a target that declares it', () => {
    expect(toWireResponseFormat({ type: 'json_object' }, target(['json_object']))).toEqual({ type: 'json_object' });
    // `openai/*:online` answers "Web Search cannot be used with JSON mode" — a
    // 400 on every websearch call, because that task always asks for JSON mode.
    expect(toWireResponseFormat({ type: 'json_object' }, target(['tools', 'web_search']))).toBeUndefined();
  });

  it('sends json_schema only to a target that declares it', () => {
    const format = { type: 'json_schema', name: 'x', schema: {} } as const;
    expect(toWireResponseFormat(format, target(['json_schema']))).toMatchObject({ type: 'json_schema' });
    expect(toWireResponseFormat(format, target(['json_object']))).toBeUndefined();
  });

  it('never sends anything for plain text', () => {
    expect(toWireResponseFormat({ type: 'text' }, target(['json_object']))).toBeUndefined();
    expect(toWireResponseFormat(undefined, target(['json_object']))).toBeUndefined();
  });
});
