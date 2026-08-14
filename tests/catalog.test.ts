import { describe, expect, it } from 'vitest';

import { IdAllocator, type CatalogRow } from '../src/pipelines/catalog/IdAllocator.js';
import { displayNamesOf, latinTitleOf, type DossierNames } from '../src/pipelines/catalog/names.js';

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

  it('uses the dossier name as the display name, with the surname as an alias', () => {
    const names = displayNamesOf(row, dossiers);
    expect(names.get('ru')).toEqual(['Пако де Лусия', 'де Лусия']);
  });

  it('still emits a language whose name matches the title, because it carries an alias', () => {
    expect(displayNamesOf(row, dossiers).get('en')).toEqual(['Paco de Lucia', 'de Lucia']);
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

  it('de-slugs when no Latin edition exists', () => {
    const cyrillicOnly = new Map<string, DossierNames>([['ru', { metadata: { forename: 'Пако', surname: 'де Лусия' } }]]);
    expect(latinTitleOf('paco-de-lucia', cyrillicOnly)).toBe('Paco De Lucia');
  });
});
