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

describe('INV-15 — the display name against the dossier', () => {
  /** `[0]` names one person, the dossier another: the drift a renumbering leaves behind. */
  it('warns when the card and the dossier hold different names', () => {
    const findings = validateCatalogue(
      snapshot({ names: new Map([['ru', file({ '1': ['Иван Петров', 'Петров'] })]]) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).toContain('INV-15');
  });

  /**
   * The false positive this check exists to avoid. `displayNameOrder: roster`
   * files the roster's own language surname-first on purpose, so a strict
   * reading of `INV-15` would warn on every correctly-produced Russian row.
   */
  it('accepts the roster order for the roster language, and only there', () => {
    const names = new Map([['ru', file({ '1': ['Барриос Агустин', 'Агустин Барриос'] })]]);
    const rosterOrder = validateCatalogue(snapshot({ names }), {
      supportedLanguages: LANGUAGES,
      displayNameOrder: 'roster',
      rosterLanguage: 'ru',
    });
    expect(codes(rosterOrder)).not.toContain('INV-15');

    // Same files, a deployment that declared the other order: now it is a bug.
    const givenFirst = validateCatalogue(snapshot({ names }), {
      supportedLanguages: LANGUAGES,
      displayNameOrder: 'given-first',
    });
    expect(codes(givenFirst)).toContain('INV-15');
  });

  /**
   * `roster` order for a language the roster is not written in keeps
   * `Forename Surname`, because a Russian filing convention is not a German one.
   */
  it('holds every other language to the given-first order under roster', () => {
    const index = file([
      { id: '1', title: 'A', lang: 'ru,de', type: 'guitarist', md: '/a.bio.md', json: '/a.bio.json' },
    ]);
    const dossiers = new Map([
      ['de/a.bio.json', file({ metadata: { forename: 'Agustin', surname: 'Barrios' } })],
    ]);
    const findings = validateCatalogue(
      snapshot({ index, dossiers, names: new Map([['de', file({ '1': ['Barrios Agustin'] })]]) }),
      { supportedLanguages: LANGUAGES, checkFiles: false, displayNameOrder: 'roster', rosterLanguage: 'ru' },
    );
    expect(codes(findings)).toContain('INV-15');
  });

  /**
   * The roster heading the setting exists for: `Абреу Зекинья` is the name a
   * reader looks for, `Хосе Гомеш де Абреу` is what the article calls him. The
   * roster is an input and never reaches the snapshot, so the only claim left
   * is that the two names have a word in common.
   */
  it('lets a roster heading say something the dossier does not, if it is the same man', () => {
    const dossiers = new Map([
      ['ru/agustin-barrios.bio.json', file({ metadata: { forename: 'Хосе Гомеш', surname: 'де Абреу' } })],
    ]);
    const options = { supportedLanguages: LANGUAGES, displayNameOrder: 'roster', rosterLanguage: 'ru' } as const;

    const sameMan = validateCatalogue(
      snapshot({ dossiers, names: new Map([['ru', file({ '1': ['Абреу Зекинья'] })]]) }),
      options,
    );
    expect(codes(sameMan)).not.toContain('INV-15');

    const somebodyElse = validateCatalogue(
      snapshot({ dossiers, names: new Map([['ru', file({ '1': ['Иван Петров'] })]]) }),
      options,
    );
    expect(codes(somebodyElse)).toContain('INV-15');
  });

  /** `INV-16`, first exemption: a comma-list is several people, not a given name. */
  it('exempts a collective whose forename is the roster s comma-list of members', () => {
    const findings = validateCatalogue(
      snapshot({
        dossiers: new Map([
          ['ru/agustin-barrios.bio.json', file({ metadata: { forename: 'Иванов, Петров', surname: 'Дуэт' } })],
        ]),
      }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).not.toContain('INV-15');
  });

  /**
   * `INV-16`, second exemption. `external/01` §1.6 asks the producer to record
   * which of two rows sharing a dossier is canonical and to distinguish the
   * other by a qualifier — but the format has no member for it, so checking
   * either would report the qualifier as the defect.
   */
  it('exempts rows that do not own their dossier outright', () => {
    const index = file([
      { id: '1', title: 'A', lang: 'ru', type: 'guitarist', md: '/a.bio.md', json: '/shared.bio.json' },
      { id: '2', title: 'B', lang: 'ru', type: 'guitarist', md: '/b.bio.md', json: '/shared.bio.json' },
    ]);
    const findings = validateCatalogue(
      snapshot({
        index,
        names: new Map([['ru', file({ '1': ['Агустин Барриос'], '2': ['Агустин Барриос (вариант)'] })]]),
        dossiers: new Map([
          ['ru/shared.bio.json', file({ metadata: { forename: 'Агустин', surname: 'Барриос' } })],
        ]),
      }),
      { supportedLanguages: LANGUAGES, checkFiles: false },
    );
    expect(codes(findings)).not.toContain('INV-15');
  });

  /** A mononym is filed in both columns; publishing it twice would be the bug. */
  it('does not ask a mononym for its name twice', () => {
    const findings = validateCatalogue(
      snapshot({
        names: new Map([['ru', file({ '1': ['Армик', 'Armik'] })]]),
        dossiers: new Map([
          ['ru/agustin-barrios.bio.json', file({ metadata: { forename: 'Армик', surname: 'Армик' } })],
        ]),
      }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).not.toContain('INV-15');
  });

  /** No name components is the premise missing, not the conclusion failing. */
  it('says nothing about a dossier that carries no name at all', () => {
    const findings = validateCatalogue(
      snapshot({ dossiers: new Map([['ru/agustin-barrios.bio.json', file({ metadata: { birthplace: 'Мисьонес' } })]]) }),
      { supportedLanguages: LANGUAGES },
    );
    expect(codes(findings)).not.toContain('INV-15');
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
