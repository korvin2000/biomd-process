import { describe, expect, it } from 'vitest';

import { validateCatalogue, type CatalogueSnapshot, type Finding, type LoadedFile } from '../src/domain/validate.js';

const LANGUAGES = ['ru', 'de', 'en', 'zh'];

function file(value: unknown, raw?: string): LoadedFile {
  return raw === undefined ? { value } : { value, raw };
}

function snapshot(overrides: Partial<CatalogueSnapshot> = {}): CatalogueSnapshot {
  return {
    index: file([
      {
        id: '1',
        title: 'Agustin Barrios Mangore',
        lang: 'ru',
        type: 'guitarist',
        gender: 'm',
        country: 'py',
        md: '/agustin-barrios.bio.md',
        json: '/agustin-barrios.bio.json',
      },
    ]),
    names: new Map([['ru', file({ '1': ['Агустин Барриос', 'Барриос'] })]]),
    dossiers: new Map([
      ['ru/agustin-barrios.bio.json', file({ metadata: { forename: 'Агустин', surname: 'Барриос' } })],
    ]),
    files: new Set(['index.json', 'index-ru.json', 'ru/agustin-barrios.bio.md', 'ru/agustin-barrios.bio.json']),
    ...overrides,
  };
}

function codes(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((finding) => finding.invariant))].sort();
}

describe('a conforming catalogue', () => {
  it('produces no findings at all', () => {
    expect(validateCatalogue(snapshot(), { supportedLanguages: LANGUAGES })).toEqual([]);
  });
});

describe('index.json', () => {
  it('treats a root that is not an array as fatal', () => {
    const findings = validateCatalogue(snapshot({ index: file({}) }), { supportedLanguages: LANGUAGES });
    expect(findings[0]?.message).toMatch(/not an array/);
  });

  it('catches a duplicate id and a duplicate slug — both make an entry vanish', () => {
    const rows = [
      { id: '1', title: 'A', type: 'guitarist', md: '/a.bio.md' },
      { id: '1', title: 'B', type: 'guitarist', md: '/b.bio.md' },
      { id: '2', title: 'C', type: 'guitarist', md: '/a.md' },
    ];
    const findings = validateCatalogue(snapshot({ index: file(rows), files: new Set(['index.json']) }), {
      supportedLanguages: LANGUAGES,
      checkFiles: false,
    });
    expect(codes(findings)).toContain('INV-1');
    expect(codes(findings)).toContain('INV-3');
  });

  it('catches a numeric id, which is a different object key from the string one', () => {
    const findings = validateCatalogue(
      snapshot({ index: file([{ id: 1, title: 'A', type: 'guitarist', md: '/a.bio.md' }]) }),
      { supportedLanguages: LANGUAGES, checkFiles: false },
    );
    expect(findings.some((f) => f.invariant === 'INV-2' && /must be a JSON string/.test(f.message))).toBe(true);
  });

  it('catches every defect of the specification s own counter-example', () => {
    const rows = [
      {
        id: '1',
        title: 'Андрес Сеговия',
        lang: 'ch',
        type: 'Guitarist',
        gender: 'male',
        country: 'Spain',
        born: '21.02.1893',
        md: '/ru/andres-segovia.bio.md',
        json: '/andres-segovia.bio.json',
      },
    ];
    const findings = validateCatalogue(snapshot({ index: file(rows) }), {
      supportedLanguages: LANGUAGES,
      checkFiles: false,
    });
    expect(codes(findings)).toEqual(expect.arrayContaining(['INV-6', 'INV-9', 'INV-10', 'INV-11', 'INV-25']));
  });

  it('warns that a hidden row carries fields it will never render', () => {
    const rows = [{ id: '1', title: 'About', type: 'hidden', md: '/about.md', img: 'photos/x.jpg', gender: 'm' }];
    const findings = validateCatalogue(snapshot({ index: file(rows) }), {
      supportedLanguages: LANGUAGES,
      checkFiles: false,
    });
    expect(codes(findings)).toContain('INV-24');
  });
});

describe('index-<lang>.json', () => {
  it('catches a key that matches no row — the fossil of a renumbering', () => {
    const findings = validateCatalogue(snapshot({ names: new Map([['ru', file({ '99': ['Нет такого'] })]]) }), {
      supportedLanguages: LANGUAGES,
    });
    expect(codes(findings)).toContain('INV-12');
  });

  it('catches a value that is not an array, and a padded key', () => {
    const findings = validateCatalogue(
      snapshot({ names: new Map([['ru', file({ '1': 'Барриос', '01': ['Барриос'] })]]) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toEqual(expect.arrayContaining(['INV-2', 'INV-13']));
  });

  it('warns about dead weight and about an alias too short to be useful', () => {
    const findings = validateCatalogue(
      snapshot({
        names: new Map([['ru', file({ '1': ['Agustin Barrios Mangore'] })], ['de', file({ '1': ['Barrios', 'Ба'] })]]),
      }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toEqual(expect.arrayContaining(['INV-14', 'INV-28']));
  });
});

describe('dossiers', () => {
  it('reports a document with no top-level metadata, which a reader discards whole', () => {
    const findings = validateCatalogue(
      snapshot({ dossiers: new Map([['ru/agustin-barrios.bio.json', file({ forename: 'Агустин' })]]) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toContain('INV-19');
  });

  it('reports the members version 2 withdrew, a bad ranking and a bad date', () => {
    const dossier = {
      title: 'Barrios',
      metadata: { country: 'py', ranking: '94', dates: { born: '1885-05-05' } },
    };
    const findings = validateCatalogue(
      snapshot({ dossiers: new Map([['ru/agustin-barrios.bio.json', file(dossier)]]) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toEqual(expect.arrayContaining(['INV-7', 'INV-20', 'INV-21']));
  });

  it('reports an item with no label or target, and a mis-cased sentinel', () => {
    const dossier = {
      metadata: {},
      media: { photos: [{ target: 'photo/x.jpg' }] },
      documents: [{ label: 'X', target: 'Embedded' }],
    };
    const findings = validateCatalogue(
      snapshot({ dossiers: new Map([['ru/agustin-barrios.bio.json', file(dossier)]]) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toContain('INV-22');
  });

  it('warns when a Russian edition holds nothing but ASCII', () => {
    const dossier = { metadata: { forename: 'Agustin', surname: 'Barrios', birthplace: 'Misiones, Paraguay' } };
    const findings = validateCatalogue(
      snapshot({ dossiers: new Map([['ru/agustin-barrios.bio.json', file(dossier)]]) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toContain('INV-18');
  });

  it('warns when two editions disagree on a language-invariant value', () => {
    const index = file([
      { id: '1', title: 'A', lang: 'ru,de', type: 'guitarist', md: '/a.bio.md', json: '/a.bio.json' },
    ]);
    const dossiers = new Map([
      ['ru/a.bio.json', file({ metadata: { forename: 'Агустин', ranking: 94 } })],
      ['de/a.bio.json', file({ metadata: { forename: 'Agustin', ranking: 60 } })],
    ]);
    const findings = validateCatalogue(snapshot({ index, dossiers }), {
      supportedLanguages: LANGUAGES,
      checkFiles: false,
    });
    expect(codes(findings)).toContain('INV-17');
  });
});

describe('the filesystem checks', () => {
  it('reports a declared edition whose files are not there', () => {
    const index = file([
      { id: '1', title: 'A', lang: 'ru,de', type: 'guitarist', md: '/a.bio.md', json: '/a.bio.json' },
    ]);
    const findings = validateCatalogue(
      snapshot({ index, files: new Set(['index.json', 'ru/a.bio.md', 'ru/a.bio.json']), dossiers: new Map() }),
      { supportedLanguages: LANGUAGES },
    );
    expect(findings.filter((f) => f.invariant === 'INV-8')).toHaveLength(2);
  });

  it('reports media parked inside a language directory', () => {
    const findings = validateCatalogue(
      snapshot({ files: new Set([...snapshot().files, 'ru/photo/x.jpg']) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toContain('INV-23');
  });
});

describe('JSON hygiene', () => {
  it('reports a null, which is never authored in this format', () => {
    const findings = validateCatalogue(
      snapshot({ dossiers: new Map([['ru/agustin-barrios.bio.json', file({ metadata: { surname: null } })]]) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toContain('INV-26');
  });

  it('reports a duplicate key, which no parser will tell you about', () => {
    const raw = '{"metadata":{"forename":"Агустин","forename":"Agustin"}}';
    const findings = validateCatalogue(
      snapshot({
        dossiers: new Map([['ru/agustin-barrios.bio.json', file(JSON.parse(raw), raw)]]),
      }),
      { supportedLanguages: LANGUAGES },
    );
    expect(findings.some((f) => f.invariant === 'INV-26' && /forename/.test(f.message))).toBe(true);
  });

  it('does not mistake a repeated key in two sibling objects for a duplicate', () => {
    const raw = '[{"id":"1","md":"/a.bio.md"},{"id":"2","md":"/b.bio.md"}]';
    const findings = validateCatalogue(
      snapshot({ index: file(JSON.parse(raw), raw), files: new Set(['index.json']) }),
      { supportedLanguages: LANGUAGES, checkFiles: false },
    );
    expect(findings.filter((f) => f.invariant === 'INV-26')).toHaveLength(0);
  });
});
