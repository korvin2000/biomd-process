import { describe, expect, it } from 'vitest';

import { parseWebAnswer } from '../src/pipelines/websearch/answer.js';
import { findGaps, ageOf, type GapOptions } from '../src/pipelines/websearch/gaps.js';
import { leadParagraph } from '../src/pipelines/websearch/WebSearchPipeline.js';
import type { Dossier } from '../src/domain/types.js';

const OPTIONS: GapOptions = {
  fields: ['born', 'died', 'birthplace', 'deathplace', 'country'],
  datePrecision: 'year',
  upgradePrecision: false,
  livenessAgeYears: 78,
  now: new Date('2026-08-16T00:00:00Z'),
};

const answerOptions = {
  asked: ['born', 'died', 'birthplace', 'country'] as const,
  datePrecision: 'year' as const,
  requireSource: true,
  minConfidence: 0.7,
};

describe('gap analysis', () => {
  it('asks only about what is missing', () => {
    const dossier: Dossier = {
      metadata: { birthplace: 'Линарес, Испания', dates: { born: '21.02.1893', died: '02.06.1987' } },
    };
    const gaps = findGaps(dossier, OPTIONS);

    expect(gaps.questions.map((question) => question.field)).toEqual(['deathplace', 'country']);
    expect(gaps.checkLiveness).toBe(false);
  });

  it('does not ask for a country that index.json already has', () => {
    const gaps = findGaps({ metadata: {} }, { ...OPTIONS, known: { country: 'es' } });
    expect(gaps.questions.map((question) => question.field)).not.toContain('country');
  });

  it('treats an absent death as an answer for someone born recently', () => {
    const gaps = findGaps({ metadata: { dates: { born: '1975' } } }, OPTIONS);
    expect(gaps.questions.map((question) => question.field)).not.toContain('died');
    expect(gaps.checkLiveness).toBe(false);
  });

  it('re-checks an undated death once the person would be old enough', () => {
    const gaps = findGaps({ metadata: { dates: { born: '1940' } } }, OPTIONS);
    expect(gaps.checkLiveness).toBe(true);
    expect(gaps.age).toBe(86);
    expect(gaps.questions.map((question) => question.field)).toContain('died');
  });

  it('never asks anything when the birth year is unknown and the fields are filled', () => {
    const dossier: Dossier = {
      metadata: { birthplace: 'X', deathplace: 'Y', dates: { born: '1900', died: '1970' } },
    };
    expect(findGaps(dossier, { ...OPTIONS, known: { country: 'es' } }).questions).toEqual([]);
  });

  it('asks to sharpen a partial date only when told to', () => {
    const dossier: Dossier = { metadata: { dates: { born: '1893' } } };
    expect(findGaps(dossier, OPTIONS).questions.map((question) => question.field)).not.toContain('born');

    const sharpen = findGaps(dossier, { ...OPTIONS, upgradePrecision: true });
    const born = sharpen.questions.find((question) => question.field === 'born');
    expect(born?.refine).toBe(true);
    expect(born?.current).toBe('1893');
  });

  it('measures age from a date of any precision', () => {
    const now = new Date('2026-08-16T00:00:00Z');
    expect(ageOf('21.02.1893', now)).toBe(133);
    expect(ageOf('1893', now)).toBe(133);
    expect(ageOf(undefined, now)).toBeUndefined();
  });
});

describe('reading a web answer', () => {
  it('accepts the documented shape and normalizes every value', () => {
    const answer = parseWebAnswer(
      JSON.stringify({
        born: { value: '1893-02-21', source: 'https://example.org/a', confidence: 0.95 },
        birthplace: { value: 'Linares, Spain', source: 'https://example.org/a', confidence: 0.9 },
        country: { value: 'Spain', source: 'https://example.org/a', confidence: 0.9 },
      }),
      answerOptions,
    );

    expect(answer?.values.map((value) => [value.field, value.value])).toEqual([
      ['born', '21.02.1893'],
      ['birthplace', 'Linares, Spain'],
      ['country', 'es'],
    ]);
  });

  it('reads the flat and sidecar shapes a model reaches for instead', () => {
    const answer = parseWebAnswer(
      'Here is what I found:\n```json\n' +
        JSON.stringify({ born: '1893', born_source: 'https://example.org/a', born_confidence: 0.8 }) +
        '\n```',
      answerOptions,
    );
    expect(answer?.values[0]).toMatchObject({ field: 'born', value: '1893', source: 'https://example.org/a' });
  });

  it('refuses a value with no source, a weak one, and one that is not a date', () => {
    const answer = parseWebAnswer(
      JSON.stringify({
        born: { value: '21.02.1893', confidence: 0.99 },
        birthplace: { value: 'Linares', source: 'https://example.org/a', confidence: 0.3 },
        died: { value: 'probably the 1980s', source: 'https://example.org/a', confidence: 0.9 },
      }),
      { ...answerOptions, asked: ['born', 'died', 'birthplace'] },
    );

    expect(answer?.values).toEqual([]);
    expect(answer?.rejected).toHaveLength(3);
    expect(answer?.rejected.join(' ')).toContain('no usable source URL');
    expect(answer?.rejected.join(' ')).toContain('below 0.70');
  });

  it('refuses a "refinement" that contradicts the record', () => {
    const answer = parseWebAnswer(
      JSON.stringify({ born: { value: '21.02.1894', source: 'https://example.org/a', confidence: 1 } }),
      { ...answerOptions, asked: ['born'], current: { born: '1893' } },
    );
    expect(answer?.values).toEqual([]);
    expect(answer?.rejected[0]).toContain('contradicts');

    const sharper = parseWebAnswer(
      JSON.stringify({ born: { value: '21.02.1893', source: 'https://example.org/a', confidence: 1 } }),
      { ...answerOptions, asked: ['born'], current: { born: '1893' } },
    );
    expect(sharper?.values[0]?.value).toBe('21.02.1893');
  });

  it('reads the liveness status', () => {
    expect(parseWebAnswer(JSON.stringify({ status: 'alive' }), answerOptions)?.status).toBe('alive');
    expect(parseWebAnswer(JSON.stringify({ status: 'Deceased' }), answerOptions)?.status).toBe('dead');
    expect(parseWebAnswer(JSON.stringify({ status: 'not sure' }), answerOptions)?.status).toBe('unknown');
    expect(parseWebAnswer('not json at all', answerOptions)).toBeUndefined();
  });
});

describe('the identity card', () => {
  it('takes the first real paragraph and leaves the markup behind', () => {
    const article = [
      '# Андрес Сеговия',
      '',
      '::: lead',
      'Вводный блок.',
      ':::',
      '',
      '| Область | Описание |',
      '|---|---|',
      '',
      'Сеговия родился в Линаресе, в испанской провинции Хаэн, и осваивал технику самостоятельно.',
    ].join('\n');

    const lead = leadParagraph(article, 600);
    expect(lead).toContain('Сеговия родился в Линаресе');
    expect(lead).not.toContain('#');
    expect(lead).not.toContain('|');
  });

  it('caps its length, so the one growing input cannot grow', () => {
    const long = `${'слово '.repeat(400)}`;
    expect(leadParagraph(long, 100)?.length).toBeLessThanOrEqual(101);
    expect(leadParagraph(long, 0)).toBeUndefined();
  });
});
