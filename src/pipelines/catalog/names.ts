import type { CatalogRow } from './IdAllocator.js';

/** The part of a dossier the catalogue reads: the display name only. */
export interface DossierNames {
  metadata?: {
    forename?: unknown;
    surname?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Display names per language, in the `index-<lang>.json` shape.
 *
 * `[0]` is the rendered display name; `[1…]` are search-only aliases. The one
 * alias derivable without guesswork is the bare surname, which the format guide
 * lists as the canonical example.
 *
 * A language is omitted when its name equals the Latin `title` and there is no
 * alias to add — the guide calls a lone `["Django Reinhardt"]` under a row
 * already titled that "dead weight", and its validator warns about it.
 *
 * TODO(domain): real alias generation — inverted order, maiden and stage names,
 * common misspellings, alternate romanizations — is what makes multilingual
 * search work and is not derivable from the dossier alone.
 */
export function displayNamesOf(
  row: CatalogRow,
  dossiers: ReadonlyMap<string, DossierNames>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const [lang, dossier] of dossiers) {
    const forename = text(dossier.metadata?.forename);
    const surname = text(dossier.metadata?.surname);
    const display = [forename, surname].filter(Boolean).join(' ').trim();
    if (!display) continue;

    const entries = [display];
    if (surname && surname !== display) entries.push(surname);

    if (entries.length === 1 && display === row.title) continue;
    result.set(lang, entries);
  }
  return result;
}

/**
 * Latin/ASCII fallback title.
 *
 * Prefers a Latin-script edition's own name; otherwise de-slugs the filename,
 * which for `paco-de-lucia` gives a usable `Paco De Lucia`.
 *
 * TODO(domain): the de-slugged form does not know that `de` is a particle, and
 * has no path at all from a Cyrillic- or CJK-only entry to a romanization. That
 * is the one place in this pipeline where an LLM would genuinely earn its cost.
 */
export function latinTitleOf(slug: string, dossiers: ReadonlyMap<string, DossierNames>): string {
  for (const dossier of dossiers.values()) {
    const forename = text(dossier.metadata?.forename);
    const surname = text(dossier.metadata?.surname);
    const candidate = [forename, surname].filter(Boolean).join(' ').trim();
    if (candidate && isLatin(candidate)) return candidate;
  }
  return deslug(slug);
}

function deslug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isLatin(value: string): boolean {
  return /^[\p{Script=Latin}\p{M}\p{P}\p{Zs}\d]+$/u.test(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
