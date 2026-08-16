import type { Dossier, EntryRow } from '../../domain/types.js';
import { text } from '../../domain/values.js';
import { isLatinScript, romanizeCyrillic, toAscii } from '../../domain/romanize.js';

/** The part of a dossier the catalogue reads: the name components only. */
export type DossierNames = Pick<Dossier, 'metadata'> & { [key: string]: unknown };

export interface NameOptions {
  /** Emit search-only aliases after the display name. */
  aliases: boolean;
}

/**
 * Display names per language, in the `index-<lang>.json` shape.
 *
 * `[0]` is the rendered display name; `[1…]` are **search-only** aliases, and
 * they are the whole reason the file exists — a reader who types `Сеговия`,
 * `Segovia` or `Segovia Andres` should reach the same entry. Three aliases are
 * derivable without guesswork and each answers a real query:
 *
 *  - the **bare surname**, which is how most people search;
 *  - the **inverted order**, which is how catalogues and record sleeves print it;
 *  - a **romanization**, for a non-Latin edition — the one mechanism that lets a
 *    Latin query reach an entry whose every name is in Cyrillic.
 *
 * A language is omitted when its only name would repeat the Latin `title`: the
 * fallback chain produces exactly that string anyway, so the entry would be dead
 * weight (`INV-14`).
 */
export function displayNamesOf(
  row: Pick<EntryRow, 'title'>,
  dossiers: ReadonlyMap<string, DossierNames>,
  options: NameOptions = { aliases: true },
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const [lang, dossier] of dossiers) {
    const forename = text(dossier.metadata?.forename) ?? '';
    const surname = text(dossier.metadata?.surname) ?? '';
    const display = [forename, surname].filter(Boolean).join(' ').trim();
    if (!display) continue;

    const entries = options.aliases
      ? withAliases(display, forename, surname, row.title)
      : [display, ...(surname && surname !== display ? [surname] : [])];

    if (entries.length === 1 && display === row.title) continue;
    result.set(lang, entries);
  }
  return result;
}

/**
 * The display name first, then aliases in the order a search index benefits
 * from them. Deduplicated case-insensitively, because an alias identical to the
 * display name is dead weight a validator flags.
 */
function withAliases(display: string, forename: string, surname: string, title: string): string[] {
  const candidates = [display];

  if (surname) candidates.push(surname);
  // A comma-separated `forename` is the roster convention, not a person's name;
  // inverting it would produce nonsense.
  if (forename && surname && !forename.includes(',')) candidates.push(`${surname} ${forename}`);

  // Only for a name a Latin-keyboard reader cannot type as it stands.
  if (!isLatinScript(display)) {
    const romanized = romanizeCyrillic(display);
    if (romanized && romanized !== title) candidates.push(romanized);

    const romanizedSurname = surname ? romanizeCyrillic(surname) : undefined;
    if (romanizedSurname) candidates.push(romanizedSurname);
  }

  return unique(candidates);
}

/**
 * The Latin/ASCII fallback title, in the order the sources deserve to be trusted.
 *
 *  1. What a model concluded while reading the article (the catalogue hint) —
 *     the only source that can romanize a CJK name at all.
 *  2. A Latin-script edition's own name, folded to ASCII: `Andrés` → `Andres`,
 *     which is what `VD-LATIN` asks for and what a Latin query can reach.
 *  3. The de-slugged filename.
 *  4. A transliteration of a non-Latin edition's name.
 *
 * The slug outranks transliteration deliberately. Slugs are Latin by rule and
 * authored by a person, so `paco-de-lucia` yields `Paco de Lucia` — the name the
 * man actually used — where transliterating `Пако де Лусия` yields
 * `Pako de Lusiya`, defensible as a search alias and wrong as a title.
 */
export function latinTitleOf(slug: string, dossiers: ReadonlyMap<string, DossierNames>, hint?: string): string {
  const fromHint = hint ? toAscii(hint) : undefined;
  if (fromHint) return fromHint;

  const names = [...dossiers.values()]
    .map((dossier) => nameOf(dossier))
    .filter((name): name is string => Boolean(name));

  for (const name of names) {
    if (!isLatinScript(name)) continue;
    const ascii = toAscii(name);
    if (ascii) return ascii;
  }

  const fromSlug = deslug(slug);
  if (fromSlug) return fromSlug;

  for (const name of names) {
    const ascii = toAscii(name);
    if (ascii) return ascii;
  }
  return slug;
}

function nameOf(dossier: DossierNames): string | undefined {
  const forename = text(dossier.metadata?.forename) ?? '';
  const surname = text(dossier.metadata?.surname) ?? '';
  return [forename, surname].filter(Boolean).join(' ').trim() || undefined;
}

/**
 * Nobiliary and prepositional particles, which stay lowercase inside a name:
 * `paco-de-lucia` → `Paco de Lucia`, not `Paco De Lucia`. A leading particle is
 * still capitalized — `De La Torre` as a surname-first title is correct.
 */
const PARTICLES = new Set([
  'de', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'les', 'lo',
  'van', 'von', 'der', 'den', 'ter', 'ten', 'el', 'al', 'bin', 'ibn', 'y', 'e',
]);

function deslug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word, index) =>
      index > 0 && PARTICLES.has(word.toLowerCase())
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const fold = trimmed.toLocaleLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    result.push(trimmed);
  }
  return result;
}
