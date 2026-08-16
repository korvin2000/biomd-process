import { describe, expect, it } from 'vitest';

import { CatalogIndex, mergeNameIndex, type CatalogOptions, type RowUpdate } from '../src/domain/catalog.js';
import type { EntryRow } from '../src/domain/types.js';
import { displayNamesOf, latinTitleOf, type DossierNames } from '../src/pipelines/catalog/names.js';
import { foldToAscii, isLatinScript, romanizeCyrillic } from '../src/domain/romanize.js';

const OPTIONS: CatalogOptions = {
  supportedLanguages: ['ru', 'en', 'de'],
  defaultType: 'musician',
  defaultPageType: 'hidden',
};

const EXISTING: EntryRow[] = [
  {
    id: '3',
    title: 'Andres Segovia',
    lang: 'ru,de',
    type: 'guitarist',
    gender: 'm',
    country: 'es',
    md: '/andres-segovia.bio.md',
    json: '/andres-segovia.bio.json',
    img: 'photos/andres-segovia.jpg',
  },
  { id: '9', title: 'Paco de Lucia', lang: 'ru', type: 'guitarist', md: '/paco-de-lucia.bio.md' },
];

function update(overrides: Partial<RowUpdate> & Pick<RowUpdate, 'slug' | 'md'>): RowUpdate {
  return { verifiedLanguages: ['ru'], checkedLanguages: ['ru', 'en'], ...overrides };
}

describe('CatalogIndex — identity', () => {
  it('keeps the id an entry already had', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    expect(index.upsert(update({ slug: 'paco-de-lucia', md: '/paco-de-lucia.bio.md' })).row.id).toBe('9');
    expect(index.upsert(update({ slug: 'andres-segovia', md: '/andres-segovia.bio.md' })).row.id).toBe('3');
  });

  it('assigns a new id above the highest ever used, never filling a gap', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    expect(index.upsert(update({ slug: 'django-reinhardt', md: '/django-reinhardt.bio.md' })).row.id).toBe('10');
    expect(index.upsert(update({ slug: 'jimi-hendrix', md: '/jimi-hendrix.bio.md' })).row.id).toBe('11');
  });

  it('retires the id of a row it had to skip, because ids are never reused', () => {
    const index = CatalogIndex.load([{ id: '40', title: 'Broken' } as EntryRow, ...EXISTING], OPTIONS);
    expect(index.upsert(update({ slug: 'new-entry', md: '/new-entry.bio.md' })).row.id).toBe('41');
  });

  it('starts at 1 with no prior index', () => {
    const index = CatalogIndex.load(undefined, OPTIONS);
    expect(index.upsert(update({ slug: 'first', md: '/first.bio.md' })).row.id).toBe('1');
  });

  it('is idempotent: a second run over the same corpus adds no rows', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    index.upsert(update({ slug: 'paco-de-lucia', md: '/paco-de-lucia.bio.md' }));
    index.upsert(update({ slug: 'paco-de-lucia', md: '/paco-de-lucia.bio.md' }));
    expect(index.size()).toBe(2);
  });

  it('drops a duplicate id and a duplicate slug, keeping the first occurrence', () => {
    const index = CatalogIndex.load(
      [
        ...EXISTING,
        { id: '3', title: 'Copy', type: 'guitarist', md: '/other.bio.md' } as EntryRow,
        { id: '50', title: 'Same slug', type: 'guitarist', md: '/paco-de-lucia.md' } as EntryRow,
      ],
      OPTIONS,
    );
    expect(index.size()).toBe(2);
    expect(index.loadNotes.join(' ')).toMatch(/duplicates id 3/);
    expect(index.loadNotes.join(' ')).toMatch(/duplicates slug "paco-de-lucia"/);
  });

  it('skips a row a reader would skip too, and says why', () => {
    const index = CatalogIndex.load([{ title: 'No id', md: '/x.bio.md' } as EntryRow], OPTIONS);
    expect(index.size()).toBe(0);
    expect(index.loadNotes.join(' ')).toMatch(/no usable id/);
  });
});

describe('CatalogIndex — merging', () => {
  it('never overwrites a classification the index already carries', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    index.upsert(update({ slug: 'andres-segovia', md: '/andres-segovia.bio.md', country: 'fr', gender: 'f', title: 'Wrong' }));

    const row = index.rowOf('andres-segovia');
    expect(row).toMatchObject({ country: 'es', gender: 'm', title: 'Andres Segovia' });
  });

  it('fills a classification the index is missing', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    index.upsert(update({ slug: 'paco-de-lucia', md: '/paco-de-lucia.bio.md', country: 'Spain', gender: 'male' }));
    expect(index.rowOf('paco-de-lucia')).toMatchObject({ country: 'es', gender: 'm' });
  });

  it('preserves an unknown member a later format version added', () => {
    const index = CatalogIndex.load([{ ...EXISTING[0], curator: 'sergey' } as EntryRow], OPTIONS);
    index.upsert(update({ slug: 'andres-segovia', md: '/andres-segovia.bio.md' }));
    expect(index.toArray()[0]).toMatchObject({ curator: 'sergey' });
  });

  it('keeps rows this run never visited', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    index.upsert(update({ slug: 'new-entry', md: '/new-entry.bio.md' }));
    expect(index.toArray().map((row) => row.id)).toEqual(['3', '9', '10']);
  });

  it('pins the original language first and appends new editions', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    index.upsert({
      slug: 'andres-segovia',
      md: '/andres-segovia.bio.md',
      verifiedLanguages: ['ru', 'en'],
      checkedLanguages: ['ru', 'en'],
    });
    expect(index.rowOf('andres-segovia')?.lang).toBe('ru,de,en');
  });

  it('drops a declared edition whose files are gone, but only if it looked for it', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    index.upsert({
      slug: 'andres-segovia',
      md: '/andres-segovia.bio.md',
      verifiedLanguages: ['ru'],
      checkedLanguages: ['ru', 'de'],
    });
    expect(index.rowOf('andres-segovia')?.lang).toBe('ru');

    const untouched = CatalogIndex.load(EXISTING, OPTIONS);
    untouched.upsert({
      slug: 'andres-segovia',
      md: '/andres-segovia.bio.md',
      verifiedLanguages: ['ru'],
      checkedLanguages: ['ru'],
    });
    expect(untouched.rowOf('andres-segovia')?.lang).toBe('ru,de');
  });

  it('adds `json` when a dossier appears, and never removes one', () => {
    const index = CatalogIndex.load(EXISTING, OPTIONS);
    index.upsert(update({ slug: 'paco-de-lucia', md: '/paco-de-lucia.bio.md', json: '/paco-de-lucia.bio.json' }));
    expect(index.rowOf('paco-de-lucia')?.json).toBe('/paco-de-lucia.bio.json');

    index.upsert(update({ slug: 'andres-segovia', md: '/andres-segovia.bio.md' }));
    expect(index.rowOf('andres-segovia')?.json).toBe('/andres-segovia.bio.json');
  });

  it('classifies an article-only entry as a page, not as an unclassified musician', () => {
    const index = CatalogIndex.load([], OPTIONS);
    expect(index.upsert(update({ slug: 'about', md: '/about.md' })).row.type).toBe('hidden');
    expect(index.upsert(update({ slug: 'x', md: '/x.bio.md', json: '/x.bio.json' })).row.type).toBe('musician');
  });

  it('writes the members in the house order', () => {
    const index = CatalogIndex.load([], OPTIONS);
    index.upsert(update({ slug: 'x', md: '/x.bio.md', json: '/x.bio.json', title: 'X', type: 'guitarist', country: 'es' }));
    expect(Object.keys(index.toArray()[0] ?? {})).toEqual(['id', 'title', 'lang', 'type', 'country', 'md', 'json']);
  });
});

describe('index-<lang>.json merging', () => {
  const titles = new Map([['3', 'Andres Segovia'], ['9', 'Paco de Lucia']]);
  const knownIds = new Set(['3', '9']);

  it('never replaces a display name someone authored', () => {
    const merged = mergeNameIndex(
      { '3': ['Андрес Сеговия (исправлено)', 'Сеговия'] },
      new Map([['3', ['Андрес Сеговия', 'Сеговия', 'Сеговия Андрес']]]),
      { titles, knownIds },
    );
    expect(merged.index['3']?.[0]).toBe('Андрес Сеговия (исправлено)');
    expect(merged.index['3']).toContain('Сеговия Андрес');
  });

  it('adds no duplicate, however the case or the diacritics differ', () => {
    const merged = mergeNameIndex(
      { '3': ['Andrés Segovia', 'Segovia'] },
      new Map([['3', ['Andrés Segovia', 'SEGOVIA', 'Segovia Andrés']]]),
      { titles, knownIds },
    );
    expect(merged.index['3']).toEqual(['Andrés Segovia', 'Segovia', 'Segovia Andrés']);
  });

  it('reports it changed nothing, so the file is not rewritten', () => {
    const existing = { '3': ['Андрес Сеговия', 'Сеговия'] };
    expect(mergeNameIndex(existing, new Map([['3', ['Андрес Сеговия', 'Сеговия']]]), { titles, knownIds }).unchanged)
      .toBe(true);
  });

  it('keeps an entry for an id this run never visited', () => {
    const merged = mergeNameIndex({ '9': ['Пако де Лусия'] }, new Map(), { titles, knownIds });
    expect(merged.index['9']).toEqual(['Пако де Лусия']);
  });

  it('omits a new entry whose only name repeats the Latin title', () => {
    const merged = mergeNameIndex({}, new Map([['9', ['Paco de Lucia']]]), { titles, knownIds });
    expect(merged.index['9']).toBeUndefined();
  });

  it('refuses an alias too short to be worth matching', () => {
    const merged = mergeNameIndex({ '3': ['Андрес Сеговия'] }, new Map([['3', ['Андрес Сеговия', 'Се']]]), {
      titles,
      knownIds,
    });
    expect(merged.index['3']).toEqual(['Андрес Сеговия']);
  });

  it('reports a key that matches no row, and keeps it rather than deleting data', () => {
    const merged = mergeNameIndex({ '99': ['Удалённая запись'] }, new Map(), { titles, knownIds });
    expect(merged.index['99']).toBeDefined();
    expect(merged.notes.join(' ')).toMatch(/INV-12/);
  });

  it('drops a value that is not a usable array of names', () => {
    const merged = mergeNameIndex({ '3': [], '9': [42] }, new Map(), { titles, knownIds });
    expect(Object.keys(merged.index)).toEqual([]);
  });

  it('sorts numerically, so id 10 follows id 9', () => {
    const merged = mergeNameIndex(
      { '10': ['Ten'], '9': ['Nine'], '3': ['Three'] },
      new Map(),
      { titles: new Map(), knownIds: new Set() },
    );
    expect(Object.keys(merged.index)).toEqual(['3', '9', '10']);
  });
});

describe('catalogue names', () => {
  const row = { title: 'Paco de Lucia' };

  const dossiers = new Map<string, DossierNames>([
    ['ru', { metadata: { forename: 'Пако', surname: 'де Лусия' } }],
    ['en', { metadata: { forename: 'Paco', surname: 'de Lucia' } }],
  ]);

  it('leads with the display name and follows it with search-only aliases', () => {
    expect(displayNamesOf(row, dossiers).get('ru')).toEqual([
      'Пако де Лусия',
      'де Лусия',
      'де Лусия Пако',
      'Pako de Lusiya',
      'de Lusiya',
    ]);
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
    expect(displayNamesOf(row, new Map([['de', { metadata: {} }]])).size).toBe(0);
  });

  it('prefers a Latin edition for the fallback title', () => {
    expect(latinTitleOf('paco-de-lucia', dossiers)).toBe('Paco de Lucia');
  });

  it('folds diacritics out of the title, which VD-LATIN wants in plain ASCII', () => {
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
