import { describe, expect, it } from 'vitest';

import { reasoningFields } from '../src/llm/OpenAiCompatibleClient.js';
import { reasoningSchema } from '../src/config/schema.js';
import { mergeMetadata } from '../src/pipelines/extraction/merge.js';
import type { MetadataDocument } from '../src/pipelines/extraction/MetadataContract.js';
import { emptyMetadata } from '../src/pipelines/extraction/MetadataContract.js';
import { normalizeDate, normalizeList, normalizeMetadata } from '../src/pipelines/extraction/normalize.js';

const LIST_FIELDS = ['metadata.genres', 'metadata.instruments', 'metadata.jobs'];
const OPTIONS = { listFields: LIST_FIELDS, onInvalidDate: 'drop' as const };

function document(metadata: Record<string, unknown>, rest: Partial<MetadataDocument> = {}): MetadataDocument {
  return { ...emptyMetadata(), ...rest, metadata } as MetadataDocument;
}

describe('date normalization', () => {
  it('accepts the format the guide specifies', () => {
    expect(normalizeDate('11.02.1920')).toBe('11.02.1920');
  });

  it('rewrites the ISO form models keep emitting', () => {
    expect(normalizeDate('1893-02-21')).toBe('21.02.1893');
    expect(normalizeDate('1893-02')).toBe('02.1893');
  });

  it('pads a single-digit day and month', () => {
    expect(normalizeDate('1.2.1920')).toBe('01.02.1920');
    expect(normalizeDate('1/2/1920')).toBe('01.02.1920');
  });

  it('keeps a bare year rather than inventing a day', () => {
    expect(normalizeDate('1893')).toBe('1893');
  });

  it('refuses an impossible or unreadable date', () => {
    expect(normalizeDate('32.01.1920')).toBeUndefined();
    expect(normalizeDate('11.13.1920')).toBeUndefined();
    expect(normalizeDate('circa 1893')).toBeUndefined();
    expect(normalizeDate('')).toBeUndefined();
  });

  it('drops what it cannot read and says so', () => {
    const result = normalizeMetadata(document({ dates: { born: '1893', died: 'unknown' } }), OPTIONS);
    expect(result.document.metadata['dates']).toEqual({ born: '1893' });
    expect(result.notes.join(' ')).toMatch(/died="unknown"/);
    expect(result.rejection).toBeUndefined();
  });

  it('rejects instead, when the config asks it to', () => {
    const result = normalizeMetadata(document({ dates: { born: 'circa 1893' } }), {
      ...OPTIONS,
      onInvalidDate: 'reject',
    });
    expect(result.rejection).toMatch(/unreadable date/);
  });

  it('removes an empty dates object rather than writing one', () => {
    const result = normalizeMetadata(document({ dates: { born: '' } }), OPTIONS);
    expect(result.document.metadata['dates']).toBeUndefined();
  });
});

describe('list normalization', () => {
  it('applies the guide s parsing rule: split, trim, drop empties', () => {
    expect(normalizeList('rock, pop ,, jazz')).toBe('rock,pop,jazz');
  });

  it('removes a duplicate without changing the spelling that came first', () => {
    expect(normalizeList('Rock,rock,ROCK')).toBe('Rock');
  });

  it('normalizes every configured list field and counts the change', () => {
    const result = normalizeMetadata(document({ jobs: 'guitarist, teacher', genres: 'classical' }), OPTIONS);
    expect(result.document.metadata['jobs']).toBe('guitarist,teacher');
    expect(result.notes.join(' ')).toMatch(/1 comma-separated list field/);
  });
});

describe('index-owned fields', () => {
  it('lifts them out of the dossier and into a catalogue hint', () => {
    const result = normalizeMetadata(
      document({ forename: 'Andrés', country: 'ES', gender: 'M' }, { catalog: { type: 'Guitarist' } } as never),
      OPTIONS,
    );

    expect(result.document.metadata).toEqual({ forename: 'Andrés' });
    expect(result.document).not.toHaveProperty('catalog');
    expect(result.hints).toEqual({ country: 'es', gender: 'm', type: 'guitarist' });
  });

  it('ignores a classification that is not a legal value', () => {
    const result = normalizeMetadata(document({ gender: 'male', country: 'Spain' }), OPTIONS);
    expect(result.hints.gender).toBeUndefined();
    expect(result.hints.country).toBeUndefined();
    // Still removed from the dossier — lint:content rejects them either way.
    expect(result.document.metadata).toEqual({});
  });

  it('leaves a document s own type alone', () => {
    const result = normalizeMetadata(
      document({}, { documents: [{ label: 'Interview', type: 'transcript', target: 'embedded' }] }),
      OPTIONS,
    );
    expect(result.document.documents[0]?.type).toBe('TRANSCRIPT');
  });
});

describe('ranking', () => {
  it('clamps and rounds into the documented 0–100 range', () => {
    expect(normalizeMetadata(document({ ranking: 142.6 }), OPTIONS).document.metadata['ranking']).toBe(100);
    expect(normalizeMetadata(document({ ranking: -3 }), OPTIONS).document.metadata['ranking']).toBe(0);
  });

  it('drops a ranking that is not a number at all', () => {
    expect(normalizeMetadata(document({ ranking: 'high' }), OPTIONS).document.metadata['ranking']).toBeUndefined();
  });
});

describe('chunk merge', () => {
  const chunks: MetadataDocument[] = [
    document({ forename: 'Пако', instruments: 'guitar', genres: 'flamenco' }),
    document({ forename: 'Пако де Лусия', instruments: 'flamenco guitar', genres: 'jazz,flamenco' }),
  ];

  it('unions list fields instead of taking the first chunk that mentioned any', () => {
    const merged = mergeMetadata(chunks, LIST_FIELDS);
    expect(merged.metadata['instruments']).toBe('guitar,flamenco guitar');
    expect(merged.metadata['genres']).toBe('flamenco,jazz');
  });

  it('still takes the earliest mention for a scalar identity field', () => {
    expect(mergeMetadata(chunks, LIST_FIELDS).metadata['forename']).toBe('Пако');
  });

  it('leaves list fields alone when none are configured', () => {
    expect(mergeMetadata(chunks).metadata['genres']).toBe('flamenco');
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
