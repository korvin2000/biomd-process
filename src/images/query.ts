/**
 * What we know about the person, in the shapes a filename can carry it.
 *
 * Three sources, deliberately combined rather than ranked:
 *
 *  - the **slug** (`andres-segovia`) — always present, always Latin, and
 *    already the form a Latin filename uses;
 *  - the **dossier** (`forename`, `surname`, `birthname`) — in the article's
 *    own language, which for this corpus means the Cyrillic spelling that
 *    `nameTokensRu` was generated to match;
 *  - the **catalogue hint** `title` — the extractor's ASCII rendering, the only
 *    thing that romanizes a name no algorithm can (CJK, and any name whose
 *    conventional Latin spelling is not its transliteration).
 *
 * Everything is folded to the same lower-case, accent-free form the index
 * tokens use, so comparison never has to be case- or accent-aware again.
 */

import { romanizeCyrillic, toAscii } from '../domain/romanize.js';
import type { Dossier } from '../domain/types.js';
import { fold, isParticle, phoneticKey, scriptOf, splitTokens } from './tokens.js';

export interface NameQuery {
  slug: string;
  /** Family-name spellings, folded. Latin and Cyrillic both live here. */
  surnames: string[];
  /** Given-name spellings, folded. */
  forenames: string[];
  /** Every name spelling, whichever part it belongs to. */
  all: string[];
  /** Phonetic keys of the surnames, for the spelling-insensitive stage. */
  surnamePhonetics: string[];
  /** Unsplit spellings a filename may use: `delucia`, `andressegovia`. */
  concatenations: string[];
  /** First letters of every name part, for the bucket-letter check. */
  initials: string[];
  /**
   * Words that belong to this person's story but are not their name —
   * birthplace, bands, teachers, instruments.
   *
   * Their only job is to stop `segovia_linares.jpg` from being read as a
   * photograph of two people: Linares is where Segovia was born, and a token
   * that the dossier already explains is not evidence of a second person.
   */
  context: ReadonlySet<string>;
}

export interface QueryInput {
  slug: string;
  dossier?: Dossier;
  /** `catalogHints.title` — the ASCII full name the extractor produced. */
  latinTitle?: string;
  /** Anything else worth treating as a name: an article heading, an alias. */
  extraNames?: readonly string[];
}

/** Fields whose words describe the person's world rather than name them. */
const CONTEXT_FIELDS = [
  'birthplace',
  'deathplace',
  'instruments',
  'genres',
  'bands',
  'awards',
  'teachers',
  'jobs',
] as const;

export function buildQuery(input: QueryInput): NameQuery {
  const surnames = new Set<string>();
  const forenames = new Set<string>();
  const concatenations = new Set<string>();
  const context = new Set<string>();

  const meta = input.dossier?.metadata ?? {};
  const addName = (value: string | undefined, into: Set<string>): void => {
    for (const spelling of spellings(value)) into.add(spelling);
  };

  addName(typeof meta.surname === 'string' ? meta.surname : undefined, surnames);
  addName(typeof meta.forename === 'string' ? meta.forename : undefined, forenames);

  // The slug is `forename-surname` by convention, with the family name last and
  // any particle attached to it: `paco-de-lucia` is Paco / de Lucía.
  const slugParts = splitTokens(input.slug);
  if (slugParts.length > 0) {
    const tail = trailingSurname(slugParts);
    // The particle joins the concatenations but never the name list on its own:
    // `de` as a searchable surname matches half the archive.
    for (const part of tail) if (!isParticle(part)) surnames.add(part);
    for (const part of slugParts.slice(0, slugParts.length - tail.length)) {
      if (!isParticle(part)) forenames.add(part);
    }
    concatenations.add(slugParts.join(''));
    concatenations.add(tail.join(''));
  }

  // A full name, from wherever it comes, contributes its last part as the
  // family name and the rest as given names — the same rule as the slug.
  for (const full of [input.latinTitle, typeof meta.birthname === 'string' ? meta.birthname : undefined, ...(input.extraNames ?? [])]) {
    const parts = splitTokens(full ?? '').filter((part) => part.length > 1);
    if (parts.length === 0) continue;

    const tail = trailingSurname(parts);
    for (const part of tail) if (!isParticle(part)) addName(part, surnames);
    for (const part of parts.slice(0, parts.length - tail.length)) {
      if (!isParticle(part)) addName(part, forenames);
    }
    concatenations.add(parts.join(''));
    concatenations.add(tail.join(''));
  }

  for (const field of CONTEXT_FIELDS) {
    const value = meta[field];
    if (typeof value !== 'string') continue;
    for (const word of splitTokens(value.replace(/,/g, ' '))) {
      if (word.length < 3) continue;
      context.add(word);
      const romanized = romanizeCyrillic(word);
      if (romanized) context.add(fold(romanized));
    }
  }

  // A name is never context, whatever else it appears in.
  for (const name of [...surnames, ...forenames]) context.delete(name);

  const all = [...new Set([...surnames, ...forenames])];
  return {
    slug: input.slug,
    surnames: [...surnames],
    forenames: [...forenames],
    all,
    surnamePhonetics: [...new Set([...surnames].map((name) => phoneticKey(name)).filter(Boolean))],
    concatenations: [...concatenations].filter((value) => value.length >= 4),
    initials: [...new Set(all.map((name) => name.slice(0, 1)).filter(Boolean))],
    context,
  };
}

/**
 * The family-name part of a name written given-name-first.
 *
 * `["paco","de","lucia"]` → `["de","lucia"]`. A particle belongs to the name
 * that follows it, and dropping it would leave `lucia` alone to match every
 * `lucia` in the index.
 */
function trailingSurname(parts: readonly string[]): string[] {
  if (parts.length <= 1) return [...parts];

  let start = parts.length - 1;
  while (start > 1 && isParticle(parts[start - 1] as string)) start -= 1;
  return parts.slice(start);
}

/**
 * Every folded spelling of one name part: as written, and — for a Cyrillic
 * name — romanized, because `nameTokens` only ever holds Latin.
 */
function spellings(value: string | undefined): string[] {
  const raw = (value ?? '').trim();
  if (!raw) return [];

  const out = new Set<string>();
  for (const part of splitTokens(raw)) {
    if (part.length < 2 || isParticle(part)) continue;
    out.add(part);

    if (scriptOf(part) === 'cyrillic') {
      const romanized = romanizeCyrillic(part);
      if (romanized) out.add(fold(romanized));
    } else {
      const ascii = toAscii(part);
      if (ascii) out.add(fold(ascii));
    }
  }
  return [...out];
}
