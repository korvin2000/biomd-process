/**
 * Turning one roster record into something a pipeline may act on.
 *
 * Two judgements are made here and nowhere else: **is this a person's name**,
 * and **is this entry a collective**. Both are cheap, both are wrong
 * occasionally, and both are used only where being wrong costs a note in the
 * run log rather than a claim in a published file.
 */

import { resolveEnsemble } from '../domain/vocabulary.js';
import type { RawRosterRecord, RosterEntry } from './types.js';

/** Particles that stay lowercase inside a name and are not evidence against it. */
const PARTICLES = new Set([
  'de', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'van', 'von', 'der', 'den', 'ter', 'ten',
  'la', 'le', 'les', 'lo', 'el', 'al', 'bin', 'ibn', 'y', 'e', 'mc', 'mac', 'st',
  'де', 'дель', 'ди', 'да', 'дос', 'ван', 'фон', 'ла', 'ле', 'эль', 'аль', 'сан', 'и',
]);

/**
 * Punctuation that never appears inside a person's name in this roster, and
 * always appears in the page titles that were mis-filed as one.
 *
 * The hyphen is deliberately absent: `Иванова-Крамская` is one family name.
 */
const NOT_IN_A_NAME = /[–—…:;()"«»/\\|\d]/u;

/** A single letter, optionally with its full stop: `Е.`, `Н`, `J.` */
const INITIAL = /^\p{L}\.?$/u;

/**
 * Does this column read as part of a person's name?
 *
 * Every word must be a capitalized word, an initial, or a particle. That one
 * rule separates `Носкова Е. Н.` from `Музыкальные пристрастия –` without
 * knowing anything about either language — a lowercase common noun in a name
 * column means the column is not a name.
 */
export function isNamePart(value: string): boolean {
  const text = value.trim();
  if (!text || NOT_IN_A_NAME.test(text)) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;

  return words.every((word) => {
    if (INITIAL.test(word)) return true;
    if (PARTICLES.has(word.toLocaleLowerCase())) return true;
    const first = word[0] ?? '';
    // `toLocaleUpperCase` rather than a character class: this has to hold for
    // Cyrillic and for Latin with diacritics alike.
    return first.toLocaleUpperCase() === first && first.toLocaleLowerCase() !== first;
  });
}

export interface EntryOptions {
  /** Stripped from the roster's `url` to get the slug. */
  slugSuffix: string;
}

/**
 * One normalized entry, or `undefined` when the record names no article.
 *
 * A record without a `url` cannot be joined to anything, which makes it
 * unusable rather than merely imperfect — everything else degrades.
 */
export function toRosterEntry(raw: RawRosterRecord, options: EntryOptions): RosterEntry | undefined {
  const file = clean(raw.url).replace(/^.*[\\/]/, '');
  if (!file) return undefined;

  const slug = file.endsWith(options.slugSuffix) ? file.slice(0, -options.slugSuffix.length) : stripExtension(file);
  if (!slug) return undefined;

  const surname = clean(raw.surname);
  const forename = clean(raw.forename);
  const patronymic = clean(raw.patronymic);
  const fullName = clean(raw.fullname) || [surname, forename, patronymic].filter(Boolean).join(' ');
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
    .map((alias) => clean(alias))
    .filter((alias) => alias.length >= 2);

  // The collective test reads the *full* name: `Торнадо, дуэт` files the word
  // that decides it outside every name column.
  const ensemble = resolveEnsemble([fullName, surname, forename].filter(Boolean).join(' '));

  // A collective has no forename and no family name — `surname: "Амстердамское
  // трио"` is the roster storing the title where the schema had a column, not a
  // claim that anybody is called that.
  const personName =
    !ensemble.group &&
    Boolean(surname) &&
    isNamePart(surname) &&
    (!forename || isNamePart(forename)) &&
    (!patronymic || isNamePart(patronymic));

  const given = [forename, patronymic].filter(Boolean).join(' ');
  const displayName = personName ? [given, surname].filter(Boolean).join(' ') : fullName;

  return {
    file,
    slug,
    fullName: fullName || displayName,
    ...(personName && surname ? { surname } : {}),
    ...(personName && given ? { forename: given } : {}),
    ...(personName && patronymic ? { patronymic } : {}),
    aliases,
    displayName: displayName || fullName,
    ensemble,
    personName,
  };
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function stripExtension(file: string): string {
  return file.replace(/\.[a-z0-9]+$/i, '');
}
