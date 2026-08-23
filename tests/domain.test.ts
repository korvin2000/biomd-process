import { describe, expect, it } from 'vitest';

import { countryName, resolveCountry, isCountryCode } from '../src/domain/countries.js';
import {
  isEmptyDossier,
  mergeDossier,
  presentFields,
  sanitizeDossier,
  type DossierOptions,
} from '../src/domain/dossier.js';
import type { Dossier } from '../src/domain/types.js';
import {
  datePrecisionOf,
  isValidDate,
  normalizeCsvList,
  normalizeDate,
  normalizeRanking,
  normalizeTarget,
  normalizeUrl,
  refinesDate,
  slugOf,
  normalizeId,
  isValidSlug,
} from '../src/domain/values.js';
import {
  languageName,
  resolveDocumentType,
  resolveEnsemble,
  resolveEntryType,
  resolveGender,
  resolveLanguage,
} from '../src/domain/vocabulary.js';

const OPTIONS: DossierOptions = { supportedLanguages: ['ru', 'en', 'de', 'zh'] };

describe('VD-DATE', () => {
  it('accepts the canonical form and pads the tolerated one', () => {
    expect(normalizeDate('21.02.1893')).toBe('21.02.1893');
    expect(normalizeDate('5.5.1885')).toBe('05.05.1885');
  });

  it('rewrites the ISO form rather than spending a retry on it', () => {
    expect(normalizeDate('1893-02-21')).toBe('21.02.1893');
    expect(normalizeDate('21/02/1893')).toBe('21.02.1893');
  });

  it('reads a month spelled out in any corpus language', () => {
    expect(normalizeDate('21 февраля 1893')).toBe('21.02.1893');
    expect(normalizeDate('February 21, 1893')).toBe('21.02.1893');
    expect(normalizeDate('21 de marzo de 1893')).toBe('21.03.1893');
  });

  it('reads a date printed in both calendars, keeping the first', () => {
    // `aleksandrov.bio.md`: "род. 11(23).12.1818, ум. 24.12.1884 / 05.01.1885".
    // Neither form parsed, so the entry published no dates at all.
    expect(normalizeDate('11(23).12.1818')).toBe('11.12.1818');
    expect(normalizeDate('11 (23).12.1818')).toBe('11.12.1818');
    expect(normalizeDate('24.12.1884 / 05.01.1885')).toBe('24.12.1884');
    expect(normalizeDate('24.12.1884 (05.01.1885)')).toBe('24.12.1884');
  });

  it('still refuses a range, which names two dates rather than one twice', () => {
    expect(normalizeDate('1884 / 1885', 'year')).toBeUndefined();
    expect(normalizeDate('01.01.1900 / 31.12.1900')).toBeUndefined();
    expect(normalizeDate('1884–1885', 'year')).toBeUndefined();
  });

  it('refuses a partial date at day precision, the specification default', () => {
    expect(normalizeDate('1885')).toBeUndefined();
    expect(normalizeDate('05.1885')).toBeUndefined();
    expect(normalizeDate('1893-02')).toBeUndefined();
    expect(normalizeDate('c. 1885')).toBeUndefined();
  });

  it('keeps what is known when the floor is lowered', () => {
    expect(normalizeDate('1885', 'year')).toBe('1885');
    expect(normalizeDate('05.1885', 'year')).toBe('05.1885');
    expect(normalizeDate('1893-02', 'month')).toBe('02.1893');
    expect(normalizeDate('май 1885', 'month')).toBe('05.1885');
    expect(normalizeDate('c. 1885', 'year')).toBe('1885');
    expect(normalizeDate('1885 г.', 'year')).toBe('1885');
    // A month floor still refuses a bare year.
    expect(normalizeDate('1885', 'month')).toBeUndefined();
  });

  it('refuses a range: two dates are named and neither is the date', () => {
    expect(normalizeDate('1885–1890', 'year')).toBeUndefined();
    expect(normalizeDate('1885 - 1890', 'year')).toBeUndefined();
  });

  it('refuses a date that is not on the calendar', () => {
    expect(normalizeDate('31.02.1900')).toBeUndefined();
    expect(normalizeDate('29.02.1900')).toBeUndefined();
    expect(normalizeDate('29.02.2000')).toBe('29.02.2000');
    expect(normalizeDate('31.04.1990')).toBeUndefined();
  });

  it('reports precision and recognizes a sharper reading of the same date', () => {
    expect(datePrecisionOf('21.02.1893')).toBe('day');
    expect(datePrecisionOf('02.1893')).toBe('month');
    expect(datePrecisionOf('1893')).toBe('year');
    expect(datePrecisionOf('21.02.93')).toBeUndefined();

    expect(refinesDate('1893', '21.02.1893')).toBe(true);
    expect(refinesDate('02.1893', '21.02.1893')).toBe(true);
    // Not a refinement: a different year, a different month, or no gain.
    expect(refinesDate('1893', '21.02.1894')).toBe(false);
    expect(refinesDate('02.1893', '21.03.1893')).toBe(false);
    expect(refinesDate('21.02.1893', '1893')).toBe(false);
  });

  it('validates partial values only when the floor allows them', () => {
    expect(isValidDate('1893')).toBe(false);
    expect(isValidDate('1893', 'year')).toBe(true);
    expect(isValidDate('02.1893', 'year')).toBe(true);
    expect(isValidDate('13.1893', 'year')).toBe(false);
    expect(isValidDate('21.02.1893', 'year')).toBe(true);
  });
});

describe('date precision in a dossier', () => {
  const YEARS: DossierOptions = { ...OPTIONS, datePrecision: 'year' };

  it('keeps a year-only date when the catalogue publishes one', () => {
    const dossier = { metadata: { dates: { born: '1885', died: '03.1960', activeFrom: 'ерунда' } } };

    expect(sanitizeDossier(dossier, OPTIONS).dossier.metadata.dates).toBeUndefined();
    expect(sanitizeDossier(dossier, YEARS).dossier.metadata.dates).toEqual({ born: '1885', died: '03.1960' });
  });

  it('sharpens a date on merge but never replaces one with a different date', () => {
    const base: Dossier = { metadata: { dates: { born: '1885', died: '21.02.1960' } } };
    const incoming: Dossier = { metadata: { dates: { born: '05.05.1885', died: '01.01.1961' } } };

    const merged = mergeDossier(base, incoming, YEARS);
    expect(merged.dossier.metadata.dates).toEqual({ born: '05.05.1885', died: '21.02.1960' });
    expect(merged.filled.some((entry) => entry.includes('born'))).toBe(true);
  });
});

describe('VD-CSV-LIST', () => {
  it('splits, trims, drops empties and dedupes case-insensitively', () => {
    expect(normalizeCsvList('rock, pop ,, jazz')).toBe('rock,pop,jazz');
    expect(normalizeCsvList('Rock,rock,ROCK')).toBe('Rock');
  });
});

describe('VD-RANKING and VD-URL', () => {
  it('clamps and rounds a ranking into 0–100', () => {
    expect(normalizeRanking(142.6)).toBe(100);
    expect(normalizeRanking(-3)).toBe(0);
    expect(normalizeRanking('96')).toBe(96);
    expect(normalizeRanking('high')).toBeUndefined();
  });

  it('accepts only an absolute http(s) URL', () => {
    expect(normalizeUrl('https://example.org/x')).toBe('https://example.org/x');
    expect(normalizeUrl('/reference/x')).toBeUndefined();
    expect(normalizeUrl('ftp://example.org')).toBeUndefined();
  });
});

describe('VD-TARGET', () => {
  it('matches the sentinel exactly, and lower-cases a near miss', () => {
    expect(normalizeTarget('embedded', ['ru']).target).toBe('embedded');
    const fixed = normalizeTarget('Embedded', ['ru']);
    expect(fixed.target).toBe('embedded');
    expect(fixed.note).toMatch(/Lower-cased/);
  });

  it('strips a language directory, because media is never localized', () => {
    const fixed = normalizeTarget('de/photo/x.jpg', ['ru', 'de']);
    expect(fixed.target).toBe('photo/x.jpg');
    expect(fixed.note).toMatch(/INV-23/);
  });

  it('leaves an ordinary path and an absolute URL alone', () => {
    expect(normalizeTarget('photo/a/x.jpg', ['ru']).target).toBe('photo/a/x.jpg');
    expect(normalizeTarget('^/main/x.jpg', ['ru']).target).toBe('^/main/x.jpg');
    expect(normalizeTarget('https://example.org/x.jpg', ['ru']).target).toBe('https://example.org/x.jpg');
  });
});

describe('VD-SLUG and VD-ID', () => {
  it('derives the slug from the md basename', () => {
    expect(slugOf('/andres-segovia.bio.md')).toBe('andres-segovia');
    expect(slugOf('/about.md')).toBe('about');
    expect(slugOf('/series/part-2.bio.md')).toBe('part-2');
  });

  it('refuses a slug a route validator would refuse', () => {
    expect(isValidSlug('andres-segovia')).toBe(true);
    expect(isValidSlug('андрес')).toBe(false);
  });

  it('coerces a numeric id for tolerance but refuses a padded one', () => {
    expect(normalizeId(7)).toBe('7');
    expect(normalizeId(' 7 ')).toBe('7');
    expect(normalizeId('0007')).toBeUndefined();
    expect(normalizeId('')).toBeUndefined();
  });
});

describe('VD-COUNTRY', () => {
  it('accepts a code, an alpha-3, a name in any deployment language, and a demonym', () => {
    expect(resolveCountry('es')).toBe('es');
    expect(resolveCountry('ESP')).toBe('es');
    expect(resolveCountry('Spain')).toBe('es');
    expect(resolveCountry('Испания')).toBe('es');
    expect(resolveCountry('испанский')).toBe('es');
    expect(resolveCountry('Paraguay')).toBe('py');
    expect(resolveCountry('парагвайский')).toBe('py');
    expect(resolveCountry('American')).toBe('us');
  });

  it('returns nothing rather than a guess', () => {
    expect(resolveCountry('Middle-earth')).toBeUndefined();
    expect(resolveCountry('xx')).toBeUndefined();
    expect(resolveCountry('')).toBeUndefined();
  });

  it('knows which two-letter codes are real regions', () => {
    expect(isCountryCode('es')).toBe(true);
    expect(isCountryCode('xx')).toBe(false);
  });

  it('reaches the alias table for a two-letter value that is not itself a region', () => {
    expect(resolveCountry('uk')).toBe('gb');
  });

  it('spells a code back out in the language of the edition that will carry it', () => {
    expect(countryName('au', 'ru')).toBe('Австралия');
    expect(countryName('es', 'en')).toBe('Spain');
    expect(countryName('es', 'es')).toBe('España');
    // Unknown locale falls back to English rather than to two letters of noise.
    expect(countryName('es', 'zz')).toBe('Spain');
    expect(countryName('xx', 'en')).toBeUndefined();
  });
});

describe('the token vocabularies', () => {
  it('maps a craft written in any of the corpus languages', () => {
    expect(resolveEntryType('Guitarist').type).toBe('guitarist');
    expect(resolveEntryType('гитарист').type).toBe('guitarist');
    expect(resolveEntryType('guitarrista').type).toBe('guitarist');
    expect(resolveEntryType('лютье').type).toBe('luthier');
  });

  it('collapses two crafts to musician, which is what the vocabulary assigns to that case', () => {
    expect(resolveEntryType('Guitarist, Composer').type).toBe('musician');
    expect(resolveEntryType('гитарист и композитор').type).toBe('musician');
  });

  it('lets `hidden` win over any craft, because it is a visibility switch', () => {
    expect(resolveEntryType('hidden, guitarist').type).toBe('hidden');
    expect(resolveEntryType('About').type).toBe('hidden');
  });

  it('drops an unrecognized craft unless the caller opts into the open vocabulary', () => {
    expect(resolveEntryType('blacksmith').type).toBeUndefined();
    expect(resolveEntryType('blacksmith', true).type).toBe('blacksmith');
  });

  it('maps gender, document type and language codes', () => {
    expect(resolveGender('Male')).toBe('m');
    expect(resolveGender('коллектив')).toBe('mixed');
    expect(resolveGender('nonsense')).toBeUndefined();
    expect(resolveDocumentType('scan')).toBe('SCAN');
    expect(resolveDocumentType('дискография')).toBe('DISCOGRAPHY');
    expect(resolveDocumentType('concert programme')).toBe('CONCERT_PROGRAMME');
    expect(resolveLanguage('ch')).toBe('zh');
    expect(resolveLanguage('EN')).toBe('en');
    expect(resolveLanguage('xx')).toBeUndefined();
  });
});

describe('how many people the entry is about', () => {
  it('reads the numbered words, in the languages this corpus is written in', () => {
    expect(resolveEnsemble('Гитарный дуэт "Торнадо"')).toMatchObject({ group: true, size: 2 });
    expect(resolveEnsemble('Трио гитаристов Урала')).toMatchObject({ group: true, size: 3 });
    expect(resolveEnsemble('EOS квартет')).toMatchObject({ group: true, size: 4 });
    expect(resolveEnsemble('Munich Guitar Quartet')).toMatchObject({ group: true, size: 4 });
  });

  it('handles a declined Russian word and a Germanic compound', () => {
    // `\w` is ASCII-only in JavaScript, which is exactly how a table like this
    // silently stops matching Cyrillic.
    expect(resolveEnsemble('участники квартета')).toMatchObject({ group: true, size: 4 });
    expect(resolveEnsemble('Amsterdams Gitaartrio')).toMatchObject({ group: true, size: 3 });
    expect(resolveEnsemble('granduet')).toMatchObject({ group: true, size: 2 });
  });

  it('knows a collective without knowing its size', () => {
    expect(resolveEnsemble('Классический ансамбль гитаристов')).toEqual({
      group: true,
      word: 'ансамбль',
    });
  });

  it('prefers the more specific claim when a title makes two', () => {
    expect(resolveEnsemble('Гитарный ансамбль, квартет «Киев»')).toMatchObject({ size: 4 });
  });

  it('says nothing about one person', () => {
    expect(resolveEnsemble('Андрес Сеговия')).toEqual({ group: false });
    expect(resolveEnsemble('Виктор Маркович Кривенко')).toEqual({ group: false });
    // Suffix matching fires on a long compound and on nothing else: this is a
    // corpus full of Spanish and Italian names that end the same way.
    expect(resolveEnsemble('residuo')).toEqual({ group: false });
    expect(resolveEnsemble('Ontario')).toEqual({ group: false });
    expect(resolveEnsemble('Demetrio Ballesteros')).toEqual({ group: false });
    expect(resolveEnsemble('individuo')).toEqual({ group: false });
    // …and the Latin entries are whole words, or `band` would make a group of
    // every Bandini and every bandurria in the corpus.
    expect(resolveEnsemble('Bandini')).toEqual({ group: false });
    expect(resolveEnsemble('bandurria')).toEqual({ group: false });
    // …while a genuine compound still resolves, in either language.
    expect(resolveEnsemble('Gitarrenquartett')).toMatchObject({ size: 4 });
    expect(resolveEnsemble('Blockflötenduo')).toMatchObject({ size: 2 });
  });
});

describe('language names', () => {
  it('spells a code out, because a model reads a word better than a code', () => {
    expect(languageName('ru')).toBe('Russian');
    expect(languageName('pt')).toBe('Portuguese');
    expect(languageName('ru', 'de')).toMatch(/Russisch/);
  });

  it('hands back anything it cannot name', () => {
    expect(languageName('zzz')).toBe('zzz');
    expect(languageName('')).toBe('');
  });
});

describe('sanitizing a dossier', () => {
  it('migrates a version 1 document instead of publishing its withdrawn members', () => {
    const v1 = {
      title: 'Andrés Segovia',
      type: 'Guitarist',
      gender: 'male',
      country: 'Spain',
      img: 'photos/segovia.jpg',
      bio: 'long prose that belongs in the article',
      dataStatus: 'ok',
      metadata: { forename: 'Андрес', surname: 'Сеговия' },
    };
    const result = sanitizeDossier(v1, OPTIONS);

    expect(result.hints).toEqual({
      title: 'Andrés Segovia',
      type: 'guitarist',
      gender: 'm',
      country: 'es',
      img: 'photos/segovia.jpg',
    });
    for (const member of ['title', 'type', 'gender', 'country', 'img', 'bio', 'dataStatus']) {
      expect(result.dossier).not.toHaveProperty(member);
      expect(result.dossier.metadata).not.toHaveProperty(member);
    }
    expect(result.notes.join(' ')).toMatch(/INV-7/);
  });

  it('re-wraps metadata members left at the root, which a reader would discard whole', () => {
    const broken = { forename: 'Андрес', surname: 'Сеговия', media: { photos: [] } };
    const result = sanitizeDossier(broken, OPTIONS);
    expect(result.dossier.metadata).toEqual({ forename: 'Андрес', surname: 'Сеговия' });
    expect(result.notes.join(' ')).toMatch(/INV-19/);
  });

  it('turns an array list field back into the comma string the format specifies', () => {
    const result = sanitizeDossier({ metadata: { genres: ['Klassik', 'Folk'] } }, OPTIONS);
    expect(result.dossier.metadata.genres).toBe('Klassik,Folk');
    expect(result.notes.join(' ')).toMatch(/VD-CSV-LIST/);
  });

  it('drops a media item that cannot render, and dedupes by target', () => {
    const result = sanitizeDossier(
      {
        metadata: {},
        media: {
          photos: [
            { label: 'A', target: 'photo/x.jpg' },
            { label: '', target: 'photo/y.jpg' },
            { label: 'C', target: '' },
            { label: 'Duplicate', target: 'photo/x.jpg' },
          ],
        },
      },
      OPTIONS,
    );
    expect(result.dossier.media?.photos).toEqual([{ label: 'A', target: 'photo/x.jpg' }]);
    expect(result.notes.join(' ')).toMatch(/INV-22/);
  });

  it('drops every null, because no field in this format is nullable', () => {
    const result = sanitizeDossier(
      { metadata: { forename: 'Пако', surname: null, ranking: null }, media: null, documents: null },
      OPTIONS,
    );
    expect(JSON.stringify(result.dossier)).not.toContain('null');
  });

  it('preserves an unknown member a later format version added', () => {
    const result = sanitizeDossier({ metadata: { forename: 'Пако', nickname: 'El Duende' }, extra: 1 }, OPTIONS);
    expect(result.dossier.metadata['nickname']).toBe('El Duende');
    expect(result.dossier['extra']).toBe(1);
  });

  it('never throws on input that is not a dossier at all', () => {
    expect(sanitizeDossier('nonsense', OPTIONS).dossier).toEqual({
      metadata: {},
      media: { photos: [], music: [] },
      documents: [],
    });
    expect(isEmptyDossier(sanitizeDossier([], OPTIONS).dossier)).toBe(true);
  });

  it('normalizes a document type and keeps an unknown one as a symbol', () => {
    const result = sanitizeDossier(
      { metadata: {}, documents: [{ label: 'X', type: 'transcript', target: 'embedded' }] },
      OPTIONS,
    );
    expect(result.dossier.documents?.[0]?.type).toBe('TRANSCRIPT');
  });
});

describe('completing a dossier', () => {
  const base: Dossier = {
    metadata: {
      forename: 'Андрес',
      surname: 'Сеговия',
      instruments: 'классическая гитара',
      dates: { born: '21.02.1893' },
      ranking: 96,
    },
    media: { photos: [{ label: 'Портрет', target: 'photo/a.jpg' }], music: [] },
    documents: [],
  };

  const incoming: Dossier = {
    metadata: {
      forename: 'Andres',
      birthplace: 'Линарес, Испания',
      instruments: 'гитара',
      dates: { born: '01.01.1900', died: '02.06.1987' },
    },
    media: { photos: [{ label: 'Другой', target: 'photo/b.jpg' }], music: [] },
    documents: [],
  };

  it('never overwrites a value the base already has', () => {
    const merged = mergeDossier(base, incoming, OPTIONS);
    expect(merged.dossier.metadata.forename).toBe('Андрес');
    expect(merged.dossier.metadata.dates).toEqual({ born: '21.02.1893', died: '02.06.1987' });
    expect(merged.dossier.metadata.ranking).toBe(96);
  });

  it('fills a value the base is missing and reports it', () => {
    const merged = mergeDossier(base, incoming, OPTIONS);
    expect(merged.dossier.metadata.birthplace).toBe('Линарес, Испания');
    expect(merged.filled).toContain('metadata.birthplace');
  });

  it('unions a list rather than choosing between two answers', () => {
    expect(mergeDossier(base, incoming, OPTIONS).dossier.metadata.instruments).toBe('классическая гитара,гитара');
  });

  it('appends only the media the base does not already have', () => {
    const merged = mergeDossier(base, incoming, OPTIONS);
    expect(merged.dossier.media?.photos?.map((photo) => photo.target)).toEqual(['photo/a.jpg', 'photo/b.jpg']);
  });

  it('reports which of the format members a dossier carries', () => {
    expect([...presentFields(base)].sort()).toEqual([
      'dates.born',
      'forename',
      'instruments',
      'media.photos',
      'ranking',
      'surname',
    ]);
  });
});
