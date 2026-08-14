import { describe, expect, it } from 'vitest';

import { IdAllocator, type CatalogRow } from '../src/pipelines/catalog/IdAllocator.js';
import { displayNamesOf, latinTitleOf, type DossierNames } from '../src/pipelines/catalog/names.js';
import { foldToAscii, isLatinScript, romanizeCyrillic } from '../src/pipelines/catalog/romanize.js';

const existing: CatalogRow[] = [
  { id: '3', title: 'Andres Segovia', type: 'guitarist', md: '/andres-segovia.bio.md', country: 'es', gender: 'm' },
  { id: '9', title: 'Paco de Lucia', type: 'guitarist', md: '/paco-de-lucia.bio.md' },
];

describe('IdAllocator', () => {
  it('keeps the id an entry already had', () => {
    const allocator = new IdAllocator(existing);
    expect(allocator.idFor('paco-de-lucia')).toBe('9');
    expect(allocator.idFor('andres-segovia')).toBe('3');
  });

  it('assigns new ids above the highest ever used, never filling a gap', () => {
    const allocator = new IdAllocator(existing);
    expect(allocator.idFor('django-reinhardt')).toBe('10');
    expect(allocator.idFor('jimi-hendrix')).toBe('11');
  });

  it('is stable when called twice for the same slug', () => {
    const allocator = new IdAllocator(existing);
    expect(allocator.idFor('new-entry')).toBe(allocator.idFor('new-entry'));
  });

  it('exposes the previous row so classification fields survive a rebuild', () => {
    const allocator = new IdAllocator(existing);
    expect(allocator.previous('andres-segovia')).toMatchObject({ country: 'es', gender: 'm', type: 'guitarist' });
    expect(allocator.previous('unknown')).toBeUndefined();
  });

  it('starts from 1 with no prior index', () => {
    expect(new IdAllocator([]).idFor('first')).toBe('1');
  });

  it('ignores malformed rows rather than rejecting the file', () => {
    const allocator = new IdAllocator([{ id: '4' } as CatalogRow, ...existing]);
    expect(allocator.idFor('paco-de-lucia')).toBe('9');
  });
});

describe('catalogue names', () => {
  const row: CatalogRow = { id: '9', title: 'Paco de Lucia', type: 'guitarist', md: '/paco-de-lucia.bio.md' };

  const dossiers = new Map<string, DossierNames>([
    ['ru', { metadata: { forename: 'Пако', surname: 'де Лусия' } }],
    ['en', { metadata: { forename: 'Paco', surname: 'de Lucia' } }],
  ]);

  it('leads with the display name and follows it with search-only aliases', () => {
    const names = displayNamesOf(row, dossiers);
    expect(names.get('ru')).toEqual(['Пако де Лусия', 'де Лусия', 'де Лусия Пако', 'Pako de Lusiya', 'de Lusiya']);
  });

  it('romanizes only a name a Latin keyboard cannot already type', () => {
    expect(displayNamesOf(row, dossiers).get('en')).toEqual(['Paco de Lucia', 'de Lucia', 'de Lucia Paco']);
  });

  it('emits the display name alone when aliases are turned off', () => {
    expect(displayNamesOf(row, dossiers, { aliases: false }).get('en')).toEqual(['Paco de Lucia', 'de Lucia']);
  });

  it('does not invert a comma-separated roster forename', () => {
    const roster = new Map<string, DossierNames>([
      ['ru', { metadata: { forename: 'Сергей,Виктор', surname: 'Авторы' } }],
    ]);
    expect(displayNamesOf(row, roster).get('ru')).not.toContain('Авторы Сергей,Виктор');
  });

  it('omits a language whose only entry would repeat the Latin title', () => {
    const single = new Map<string, DossierNames>([['en', { metadata: { forename: 'Paco de Lucia' } }]]);
    expect(displayNamesOf(row, single).has('en')).toBe(false);
  });

  it('skips a dossier with no name at all', () => {
    const empty = new Map<string, DossierNames>([['de', { metadata: {} }]]);
    expect(displayNamesOf(row, empty).size).toBe(0);
  });

  it('prefers a Latin edition for the fallback title', () => {
    expect(latinTitleOf('paco-de-lucia', dossiers)).toBe('Paco de Lucia');
  });

  it('folds diacritics out of the title, which §5.3 wants in plain ASCII', () => {
    const accented = new Map<string, DossierNames>([['es', { metadata: { forename: 'Andrés', surname: 'Segovia' } }]]);
    expect(latinTitleOf('andres-segovia', accented)).toBe('Andres Segovia');
  });

  it('trusts the extraction hint above everything else', () => {
    expect(latinTitleOf('andres-segovia', dossiers, 'Andrés Segovia')).toBe('Andres Segovia');
  });

  it('de-slugs when no Latin edition exists, keeping particles lowercase', () => {
    const cyrillicOnly = new Map<string, DossierNames>([['ru', { metadata: { forename: 'Пако', surname: 'де Лусия' } }]]);
    // The slug is human-authored Latin; transliterating would give "Pako de Lusiya".
    expect(latinTitleOf('paco-de-lucia', cyrillicOnly)).toBe('Paco de Lucia');
  });
});

describe('romanization', () => {
  it('folds Latin letters that carry no combining mark', () => {
    expect(foldToAscii('Søren Æblerød')).toBe('Soren Aeblerod');
    expect(foldToAscii('Straße')).toBe('Strasse');
  });

  it('transliterates Cyrillic and leaves other scripts alone', () => {
    expect(romanizeCyrillic('Андрес Сеговия')).toBe('Andres Segoviya');
    expect(romanizeCyrillic('Segovia')).toBeUndefined();
  });

  it('knows a Latin-script name from a Cyrillic one', () => {
    expect(isLatinScript('Andrés Segovia')).toBe(true);
    expect(isLatinScript('Андрес Сеговия')).toBe(false);
  });
});
