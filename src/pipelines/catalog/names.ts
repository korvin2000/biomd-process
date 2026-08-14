import type { CatalogRow } from './IdAllocator.js';
import { isLatinScript, romanizeCyrillic, toAscii } from './romanize.js';

/** The part of a dossier the catalogue reads: the display name only. */
export interface DossierNames {
  metadata?: {
    forename?: unknown;
    surname?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NameOptions {
  /** Emit search-only aliases after the display name. */
  aliases: boolean;
}

/**
 * Display names per language, in the `index-<lang>.json` shape.
 *
 * `[0]` is the rendered display name; `[1…]` are **search-only** aliases, and
 * they are the whole reason this file exists — a reader who types `Сеговия`,
 * `Segovia` or `Segovia Andres` should reach the same entry. Three aliases are
 * derivable without guesswork and each answers a real query:
 *
 *  - the **bare surname**, which is how most people search;
 *  - the **inverted order**, which is how catalogues and record sleeves print it;
 *  - a **romanization**, for a non-Latin edition — this is what lets a Latin
 *    query find an entry written in Cyrillic, and it is the one case where the
 *    guide's "aliases make multilingual search work" is doing real work.
 *
 * A language is omitted when its name equals the Latin `title` and there is no
 * alias to add — the guide calls a lone `["Django Reinhardt"]` under a row
 * already titled that "dead weight", and its validator warns about it.
 */
export function displayNamesOf(
  row: CatalogRow,
  dossiers: ReadonlyMap<string, DossierNames>,
  options: NameOptions = { aliases: true },
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const [lang, dossier] of dossiers) {
    const forename = text(dossier.metadata?.forename);
    const surname = text(dossier.metadata?.surname);
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
 * display name is dead weight the guide's validator flags.
 */
function withAliases(display: string, forename: string, surname: string, title: string): string[] {
  const candidates = [display];

  if (surname) candidates.push(surname);
  // A comma-separated `forename` is the roster convention, not a person's name;
  // inverting it would produce nonsense.
  if (forename && surname && !forename.includes(',')) candidates.push(`${surname} ${forename}`);

  // Only for a name that a Latin-keyboard reader cannot type as it stands.
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
 *  1. What a model concluded while reading the article (`extract`'s catalogue
 *     hint) — the only source that can romanize a CJK name at all.
 *  2. A Latin-script edition's own name, folded to ASCII: `Andrés` → `Andres`,
 *     which is what §5.3 asks for and what a Latin-keyboard search can reach.
 *  3. The de-slugged filename.
 *  4. A transliteration of a non-Latin edition's name.
 *
 * The slug outranks transliteration deliberately. Slugs are Latin by rule (§4.2)
 * and authored by a person, so `paco-de-lucia` yields `Paco de Lucia` — the name
 * the man actually used — where transliterating `Пако де Лусия` yields
 * `Pako de Lusiya`, which is defensible as a search alias and wrong as a title.
 */
export function latinTitleOf(
  slug: string,
  dossiers: ReadonlyMap<string, DossierNames>,
  hint?: string,
): string {
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
  const forename = text(dossier.metadata?.forename);
  const surname = text(dossier.metadata?.surname);
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

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
