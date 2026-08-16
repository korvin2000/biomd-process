import { describe, expect, it } from 'vitest';

import { buildIndex } from '../src/images/ImageIndexStore.js';
import { buildQuery } from '../src/images/query.js';
import { selectPortrait } from '../src/images/select.js';
import { similarity } from '../src/images/similarity.js';
import { analysePath, phoneticKey } from '../src/images/tokens.js';
import type { RawImageRecord } from '../src/images/types.js';
import { assetPath } from '../src/pipelines/portrait/PortraitPipeline.js';

/**
 * Every fixture below is a real record from the archive this was built against,
 * trimmed to the fields under test. They are the cases that actually decide
 * whether a portrait is right: a co-photograph filed under the other person, a
 * CD sleeve that classifies as a clean portrait, a name written unsplit, and a
 * place name that looks exactly like a second surname.
 */
function record(relPath: string, overrides: Partial<RawImageRecord> = {}): RawImageRecord {
  return {
    relPath,
    fileName: relPath.split('/').pop() ?? relPath,
    image: { width: 400, height: 560, orientation: 'portrait', mp: 0.22 },
    color: { mode: 'color' },
    meta: { title: '', description: '', keywords: [], people: [], ocr: '' },
    ai: { class: 'portrait', confidence: 0.9, faceCount: 1, faceCoverage: 0.24 },
    ...overrides,
  };
}

const SEGOVIA = buildQuery({
  slug: 'andres-segovia',
  latinTitle: 'Andres Segovia',
  dossier: { metadata: { forename: 'Андрес', surname: 'Сеговия', birthplace: 'Линарес, Испания' } },
});

describe('path analysis', () => {
  it('reads the bucket letter, the directory and the initials', () => {
    const analysis = analysePath('photo/s/f_sor.jpg');
    expect(analysis.bucket).toBe('s');
    expect(analysis.initials).toContain('f');
    expect(analysis.tokens.map((token) => token.text)).toEqual(['sor']);

    const nested = analysePath('photo/a/almeida_laurindo/unused/4lalm01.jpg');
    expect(nested.tokens.filter((token) => token.source === 'dir').map((token) => token.text)).toEqual([
      'almeida',
      'laurindo',
    ]);
    expect(nested.markers).toContain('unused');
  });

  it('recognizes a release sleeve, which underscores hide from a word boundary', () => {
    expect(analysePath('photo/p/paco_pena/pena_cd05_1993.jpg').markers).toContain('release-cover');
    expect(analysePath('photo/p/paco_pena/pena_lp16_1978.jpg').markers).toContain('release-cover');
    expect(analysePath('photo/p/paco_pena2.jpg').markers).not.toContain('release-cover');
  });

  it('collapses the spellings transliteration disagrees about', () => {
    expect(phoneticKey('segovia')).toBe(phoneticKey('segoviya'));
    expect(phoneticKey('schmidt')).toBe(phoneticKey('shmidt'));
    expect(phoneticKey('segovia')).not.toBe(phoneticKey('sanlucar'));
    expect(similarity('sanz', 'sainz')).toBeLessThan(1);
  });
});

describe('identity', () => {
  const index = buildIndex(
    [
      record('photo/s/segovia_a.jpg', { nameTokens: ['segovia'], nameTokensRu: ['сеговия', 'сеговиа', 'зеговия'] }),
      record('photo/b/buek_segovia.jpg', { nameTokens: ['buek', 'segovia'], nameTokensRu: ['буек', 'сеговия'] }),
      record('photo/s/segovia_linares.jpg', {
        nameTokens: ['segovia', 'linares'],
        ai: { class: 'upper_body', confidence: 0.54, faceCount: 1, faceCoverage: 0.01 },
      }),
    ],
    'fixture',
  );

  it('prefers the file the archive files under this person', () => {
    const selection = selectPortrait(index, SEGOVIA);
    expect(selection.chosen?.record.relPath).toBe('photo/s/segovia_a.jpg');
  });

  it('demotes a photograph filed under the other person in it', () => {
    const selection = selectPortrait(index, SEGOVIA, { keep: 10 });
    const buek = selection.candidates.find((candidate) => candidate.record.relPath.includes('buek'));

    expect(buek?.identity.score).toBeLessThan(0.9);
    expect(buek?.identity.reasons.join(' ')).toContain('files this under "b"');
  });

  it('does not read a Cyrillic spelling variant as a second person', () => {
    const selection = selectPortrait(index, SEGOVIA, { keep: 10 });
    const segovia = selection.candidates.find((candidate) => candidate.record.relPath.endsWith('segovia_a.jpg'));

    expect(segovia?.identity.foreign).toEqual([]);
    expect(segovia?.identity.score).toBeGreaterThanOrEqual(0.9);
  });

  it('does not read the birthplace as a second person either', () => {
    const selection = selectPortrait(index, SEGOVIA, { keep: 10 });
    const linares = selection.candidates.find((candidate) => candidate.record.relPath.includes('linares'));
    expect(linares?.identity.foreign).toEqual([]);

    // Without the dossier there is nothing to explain "linares", and the same
    // file is correctly treated as a photograph of two people.
    const bare = buildQuery({ slug: 'andres-segovia' });
    const withoutContext = selectPortrait(index, bare, { keep: 10 }).candidates.find((candidate) =>
      candidate.record.relPath.includes('linares'),
    );
    expect(withoutContext?.identity.foreign).toEqual(['linares']);
  });

  it('matches a name the filename writes unsplit', () => {
    const unsplit = buildIndex([record('photo/p/delucia.jpg', { nameTokens: ['delucia'] })], 'fixture');
    const query = buildQuery({ slug: 'paco-de-lucia', latinTitle: 'Paco de Lucia' });

    expect(query.surnames).not.toContain('de');
    expect(selectPortrait(unsplit, query).chosen?.record.relPath).toBe('photo/p/delucia.jpg');
  });
});

describe('visual suitability', () => {
  it('rejects a record sleeve even when it classifies as a clean portrait', () => {
    const index = buildIndex(
      [
        record('photo/p/paco_pena/pena_cd05_1993.jpg', { nameTokens: ['pena'] }),
        record('photo/p/paco_pena2.jpg', {
          nameTokens: ['paco', 'pena'],
          ai: { class: 'upper_body', confidence: 0.45, faceCount: 1, faceCoverage: 0.09 },
        }),
      ],
      'fixture',
    );
    const query = buildQuery({ slug: 'paco-pena', latinTitle: 'Paco Pena' });

    expect(selectPortrait(index, query).chosen?.record.relPath).toBe('photo/p/paco_pena2.jpg');
    expect(selectPortrait(index, query, { excludeReleaseCovers: false }).chosen?.record.relPath).toBe(
      'photo/p/paco_pena/pena_cd05_1993.jpg',
    );
  });

  it('never lets sheet music or a group photograph win', () => {
    const index = buildIndex(
      [
        record('photo/s/sor.jpg', {
          nameTokens: ['sor'],
          ai: { class: 'sheet_music', confidence: 0.96, faceCount: 0, faceCoverage: 0 },
        }),
        record('photo/s/sor_group.jpg', {
          nameTokens: ['sor'],
          ai: { class: 'group', confidence: 0.98, faceCount: 6, faceCoverage: 0.02 },
        }),
      ],
      'fixture',
    );
    const selection = selectPortrait(buildIndex([], 'empty'), buildQuery({ slug: 'fernando-sor' }));
    expect(selection.chosen).toBeUndefined();

    const withMatches = selectPortrait(index, buildQuery({ slug: 'fernando-sor', latinTitle: 'Fernando Sor' }));
    expect(withMatches.chosen).toBeUndefined();
    expect(withMatches.declined).toContain('unusable as a portrait');
  });

  it('prefers a bigger face over a bigger file', () => {
    const index = buildIndex(
      [
        record('photo/x/xuefeiyang_cg.jpg', {
          nameTokens: ['xuefeiyang'],
          image: { width: 1600, height: 1200, orientation: 'landscape', mp: 1.92 },
          ai: { class: 'portrait', confidence: 0.9, faceCount: 1, faceCoverage: 0.02 },
        }),
        record('photo/x/xuefeiyang.jpg', {
          nameTokens: ['xuefeiyang'],
          image: { width: 300, height: 400, orientation: 'portrait', mp: 0.12 },
          color: { mode: 'bw' },
          ai: { class: 'portrait', confidence: 0.9, faceCount: 1, faceCoverage: 0.28 },
        }),
      ],
      'fixture',
    );
    // A name the archive writes as one word, and a monochrome 0.12 MP file
    // beating a colour 1.9 MP one because the subject is actually visible in it.
    const chosen = selectPortrait(index, buildQuery({ slug: 'xuefei-yang', latinTitle: 'Xuefei Yang' })).chosen;
    expect(chosen?.record.relPath).toBe('photo/x/xuefeiyang.jpg');
  });
});

describe('the answer', () => {
  it('declines rather than guessing, and says which kind of failure it was', () => {
    const empty = selectPortrait(buildIndex([], 'empty'), buildQuery({ slug: 'nobody-here' }));
    expect(empty.chosen).toBeUndefined();
    expect(empty.declined).toContain('nothing under this name');
  });

  it('builds a bucket-relative asset path', () => {
    expect(assetPath('pages/', 'photo/s/segovia_a.jpg')).toBe('pages/photo/s/segovia_a.jpg');
    expect(assetPath('', 'photo/s/segovia_a.jpg')).toBe('photo/s/segovia_a.jpg');
    expect(assetPath('pages', '/photo/s/segovia_a.jpg')).toBe('pages/photo/s/segovia_a.jpg');
  });
});
