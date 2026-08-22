import { describe, expect, it } from 'vitest';

import { buildRoster } from '../src/roster/NameRosterStore.js';
import { isNamePart, toRosterEntry } from '../src/roster/entry.js';
import type { RawRosterRecord } from '../src/roster/types.js';

/**
 * Every fixture is a real record from `data/names.json`, including the two that
 * are wrong: `authors.bio.md`, where a page title was filed across the name
 * columns, and `di_meola.bio.md`, where the given and family names are swapped.
 * The roster is a second opinion, and a second opinion has to survive being
 * mistaken.
 */
const OPTIONS = { slugSuffix: '.bio.md', language: 'ru' };

function entry(raw: RawRosterRecord) {
  return toRosterEntry(raw, { slugSuffix: '.bio.md' });
}

describe('reading a roster record', () => {
  it('reads a person, patronymic and all, in natural order', () => {
    const result = entry({
      fullname: 'Русанов Е.М.',
      surname: 'Русанов',
      forename: 'Е.',
      patronymic: 'М.',
      url: 'rusanov_em.bio.md',
    });

    expect(result?.slug).toBe('rusanov_em');
    expect(result?.personName).toBe(true);
    expect(result?.surname).toBe('Русанов');
    // The patronymic travels with the forename: a dossier has no member for it,
    // and inventing one would put a non-format field in a published document.
    expect(result?.forename).toBe('Е. М.');
    expect(result?.displayName).toBe('Е. М. Русанов');
  });

  it('keeps a collective as a title, and counts its members', () => {
    const result = entry({ fullname: 'Амстердамское трио', surname: 'Амстердамское трио', url: 'am_trio.bio.md' });

    expect(result?.ensemble).toEqual({ group: true, size: 3, word: 'трио' });
    expect(result?.personName).toBe(false);
    // `surname: "Амстердамское трио"` is the roster storing a title where the
    // schema had a column, not a claim that anybody is called that.
    expect(result?.surname).toBeUndefined();
    expect(result?.displayName).toBe('Амстердамское трио');
  });

  it('refuses to read a page title as somebody\'s name', () => {
    const result = entry({
      fullname: 'Музыкальные пристрастия – музыка гитариста',
      surname: 'Музыкальные пристрастия –',
      forename: 'музыка',
      patronymic: 'гитариста',
      url: 'authors.bio.md',
      aliases: ['Авторы'],
    });

    expect(result?.personName).toBe(false);
    expect(result?.surname).toBeUndefined();
    expect(result?.forename).toBeUndefined();
    // The aliases are still names a reader might type, so they survive.
    expect(result?.aliases).toEqual(['Авторы']);
  });

  it('keeps hand-authored alternative spellings and pseudonyms', () => {
    const result = entry({
      fullname: 'Черножуков Г.В.',
      surname: 'Черножуков',
      forename: 'Г.',
      patronymic: 'В.',
      url: 'chernozhukov.bio.md',
      aliases: ['Инсаров'],
    });
    expect(result?.aliases).toEqual(['Инсаров']);
  });

  it('drops a record that names no article', () => {
    expect(entry({ fullname: 'Кто-то', surname: 'Кто-то' })).toBeUndefined();
  });
});

describe('is this a name', () => {
  it('accepts capitalized words, initials and particles', () => {
    expect(isNamePart('Носкова')).toBe(true);
    expect(isNamePart('Е.')).toBe(true);
    expect(isNamePart('де Лусия')).toBe(true);
    expect(isNamePart('Иванова-Крамская')).toBe(true);
  });

  it('rejects a lowercase common noun, punctuation and digits', () => {
    expect(isNamePart('музыка')).toBe(false);
    expect(isNamePart('Музыкальные пристрастия –')).toBe(false);
    expect(isNamePart("'КИÏВ'")).toBe(false);
    expect(isNamePart('Квартет (Россия)')).toBe(false);
    expect(isNamePart('Трио 2')).toBe(false);
  });
});

describe('the roster as a whole', () => {
  const roster = buildRoster(
    [
      { fullname: 'Армик', surname: 'Армик', url: 'armik.bio.md' },
      { fullname: 'ГРАН-дуэт', surname: 'ГРАН-дуэт', url: 'granduet.bio.md' },
      { fullname: 'Дубликат', surname: 'Дубликат', url: 'armik.bio.md' },
      { fullname: 'Никто', surname: 'Никто' },
    ],
    'fixture',
    OPTIONS,
  );

  it('indexes by slug and remembers where it came from', () => {
    expect(roster.bySlug.get('armik')?.fullName).toBe('Армик');
    expect(roster.bySlug.get('granduet')?.ensemble.size).toBe(2);
    expect(roster.language).toBe('ru');
  });

  it('counts what it could not use rather than hiding it', () => {
    expect(roster.skipped).toBe(1);
  });

  it('keeps the first of two records claiming the same article', () => {
    expect(roster.bySlug.get('armik')?.fullName).toBe('Армик');
  });
});
