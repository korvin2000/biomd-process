import type { Dossier, EntryRow } from '../../domain/types.js';
import { text } from '../../domain/values.js';
import { isLatinScript, romanizeCyrillic, toAscii } from '../../domain/romanize.js';

/** The part of a dossier the catalogue reads: the name components only. */
export type DossierNames = Pick<Dossier, 'metadata'> & { [key: string]: unknown };

/**
 * How many aliases to author, and on whose authority.
 *
 * `spec` is `external/04` §4.5 as written: every form a reader plausibly types,
 * the bare family name and the inverted order included.
 *
 * `distinct` is this deployment's deliberate narrowing of it, and the second
 * place (after `catalogue.datePrecision`) where a configured value overrides the
 * specification on purpose. The reasoning is the consumer's own match grading —
 * `external/04` §4.5 weights a hit by position, *word-start* among them — which
 * means a query for `Сеговия` already reaches `Андрес Сеговия` without an alias
 * saying so. An alias wholly contained in one that is already there therefore
 * adds a row, a byte and a tie, and no reachability at all. What it does *not*
 * cover is a reordering: `Сеговия Андрес` is not a substring of anything, so it
 * stays. The rule is exactly "no alias is a substring of another", never "fewer
 * aliases".
 */
export type AliasPolicy = 'distinct' | 'spec';

/**
 * Which name lands in `index-<lang>.json[0]`.
 *
 * `[0]` is not one alias among several: the reader prints it under the
 * thumbnail and searches everything after it. So the choice is a deployment
 * decision, not a derivation.
 *
 *  - `roster` — the roster's own `fullname` for the roster's language, falling
 *    back to `Surname Forename` when the roster does not know the entry; every
 *    other language keeps `Forename Surname`, because a Russian catalogue's
 *    filing order is not an English one.
 *  - `surname-first` — `Surname Forename` in every language.
 *  - `given-first` — `Forename Surname` in every language.
 *
 * Whichever order loses becomes the first alias, so both stay searchable.
 */
export type DisplayNameOrder = 'roster' | 'surname-first' | 'given-first';

export interface NameOptions {
  /** Emit search-only aliases after the display name. */
  aliases: boolean;
  /** Which alias set to author. Defaults to `distinct`. */
  policy?: AliasPolicy;
  /**
   * Which order `[0]` takes. Defaults to `given-first`, which is what this
   * function has always meant when told nothing; the *deployment* default is
   * `roster`, and `CatalogPipeline` always passes the configured value.
   */
  order?: DisplayNameOrder;
  /** The language the roster is written in — the only one `roster` order acts on. */
  rosterLanguage?: string;
  /**
   * The roster's own heading for this entry, keyed by language.
   *
   * A person wrote it, in the catalogue's own order, and for a collective it is
   * frequently the only real name in the system. Supplied only when the record
   * reads as a name at all: `authors.bio.md` is a page title chopped across the
   * name columns, and `RosterEntry.personName` is what tells the two apart.
   */
  preferred?: ReadonlyMap<string, string>;
  /**
   * Extra names for one language, from the roster: alternative spellings,
   * pseudonyms, the catalogue's own inverted form. Keyed by language, because
   * the roster is written in exactly one and its names are not translations.
   */
  extra?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Display names per language, in the `index-<lang>.json` shape.
 *
 * `[0]` is the rendered display name; `[1…]` are **search-only** aliases, and
 * they are the whole reason the file exists — a reader who types `Сеговия`,
 * `Segovia Andres` or `Баццотти` should reach the same entry.
 *
 * What earns a place there is decided by {@link AliasPolicy}: every form the
 * specification lists, or only the forms that are not already reachable through
 * one of the others. Four sources feed it — the inverted order, the birth name,
 * the roster's hand-authored spellings, and (under `spec`) the bare family name
 * and a transliteration.
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
  const policy = options.policy ?? 'distinct';
  const order = options.order ?? 'given-first';
  const rosterLanguage = options.rosterLanguage ?? '';

  for (const [lang, dossier] of dossiers) {
    const forename = text(dossier.metadata?.forename) ?? '';
    const surname = text(dossier.metadata?.surname) ?? '';
    const birthname = text(dossier.metadata?.birthname) ?? '';
    // A mononym reaches this as `forename === surname` — `Армик`, `Sting`,
    // and every collective whose title was filed in both columns. Joining them
    // would publish the name twice.
    const mononym = fold(forename) === fold(surname);
    const given = (mononym ? [surname] : [forename, surname]).filter(Boolean).join(' ').trim();
    // A comma-separated `forename` is a roster convention holding several
    // people, not a person's name; inverting it would produce nonsense.
    const inverted =
      mononym || !forename || !surname || forename.includes(',') ? given : `${surname} ${forename}`;

    const preferred = text(options.preferred?.get(lang));
    const display = chooseDisplay({ order, lang, rosterLanguage, preferred, given, inverted });
    if (!display) continue;

    const extra = options.extra?.get(lang) ?? [];
    const entries = options.aliases
      ? withAliases({
          display,
          given,
          inverted,
          surname,
          birthname,
          title: row.title,
          // A roster heading this deployment chose not to render is still a
          // name somebody wrote down, so it stays searchable either way.
          extra: preferred ? [preferred, ...extra] : extra,
          policy,
        })
      : [display];

    // Exact, deliberately: `external/04` §4.4 requires the display name to carry
    // its diacritics in full and `index.json.title` to be the diacritic-free
    // spelling, so `Andrés Segovia` and `Andres Segovia` are *not* the same
    // entry — folding them together would drop the accented name the reader is
    // supposed to render.
    if (entries.length === 1 && display === row.title) continue;
    result.set(lang, entries);
  }
  return result;
}

interface AliasInput {
  display: string;
  /** `Forename Surname`. */
  given: string;
  /** `Surname Forename`, or the same string as {@link AliasInput.given} when it cannot invert. */
  inverted: string;
  surname: string;
  birthname: string;
  title: string;
  extra: readonly string[];
  policy: AliasPolicy;
}

interface DisplayInput {
  order: DisplayNameOrder;
  lang: string;
  rosterLanguage: string;
  preferred: string | undefined;
  given: string;
  inverted: string;
}

/**
 * The one name a reader sees.
 *
 * `roster` order is the only one that consults anything outside the dossier,
 * and it is deliberately scoped to a single language: the roster's names are
 * variant spellings in Russian, not translations, so `Абитон Жерар`
 * under an English heading would be a mistake rather than a localization.
 */
function chooseDisplay(input: DisplayInput): string {
  const { order, lang, rosterLanguage, preferred, given, inverted } = input;

  if (order === 'given-first') return given;
  if (order === 'surname-first') return inverted || given;

  if (lang !== rosterLanguage) return given;
  if (!preferred) return inverted || given;

  // The roster is written in the catalogue's own filing style, which routinely
  // abbreviates: `Адамян С.В.` where the article says
  // `Сергей Викторович Адамян`, `Барбериис` where it says
  // `Мелькиоре де Барбериис`. That is the roster's *order* being better and its
  // *content* being worse, and taking it whole would publish initials in place
  // of a name a reader would recognize. So a roster name that only reduces what
  // is already known loses to the same name in the roster's order, while one
  // that says something new — `Абреу Зекинья` for a man the article files as
  // `Хосе Гомеш де Абреу` — is exactly what this setting is for and wins.
  return reduces(preferred, inverted) ? inverted : preferred;
}

/**
 * Is `candidate` the same name as `full`, only with less of it?
 *
 * Every word of the candidate must already be in the full name, either whole or
 * as its initial, and the candidate must carry strictly fewer spelled-out words.
 * A single word the full name does not account for — a pseudonym, a stage name,
 * a different spelling — makes it a *different* name rather than a shorter one,
 * and that is the case the roster exists to contribute.
 */
function reduces(candidate: string, full: string): boolean {
  const words = (value: string): string[] => fold(value).split(' ').filter(Boolean);
  const parts = words(candidate);
  const whole = words(full);
  if (parts.length === 0 || whole.length === 0) return false;

  const accountedFor = parts.every(
    (part) => whole.includes(part) || (part.length === 1 && whole.some((word) => word.startsWith(part))),
  );
  if (!accountedFor) return false;

  const spelledOut = (list: readonly string[]): number => list.filter((word) => word.length > 1).length;
  return spelledOut(parts) < spelledOut(whole) || parts.length < whole.length;
}

/**
 * The display name first, then aliases in the order a search index benefits
 * from them.
 *
 * Four sources, in descending order of how sure we are that a reader will type
 * them: the catalogue's own inverted order, the roster's hand-authored
 * spellings and pseudonyms, the birth name, and — under `spec` — the bare
 * family name and a transliteration.
 *
 * The transliteration is deliberately *not* in the `distinct` set. It produces
 * `Andres Segoviya` and `Dzhon Vilyams`, which nobody types and which the
 * consumer does not need: `external/04` §4.5 already has it expanding a Cyrillic
 * query into Latin variants and testing them against the ASCII `title`, so the
 * bridge exists in the other direction and this end of it is machine noise in a
 * file people edit by hand.
 */
function withAliases(input: AliasInput): string[] {
  const { display, given, inverted, surname, birthname, title, extra, policy } = input;

  // Both orders, always: whichever one did not become the display name is the
  // single most likely thing a reader types next. `inverted` already collapsed
  // to `given` where a name cannot be inverted, and the dedupe drops the repeat.
  const candidates = [display, given, inverted];
  if (birthname) candidates.push(birthname);
  candidates.push(...extra);

  if (policy === 'spec') {
    if (surname) candidates.push(surname);
    // Only for a name a Latin-keyboard reader cannot type as it stands.
    if (!isLatinScript(display)) {
      const romanized = romanizeCyrillic(display);
      if (romanized && romanized !== title) candidates.push(romanized);

      const romanizedSurname = surname ? romanizeCyrillic(surname) : undefined;
      if (romanizedSurname) candidates.push(romanizedSurname);
    }
  }

  return filterAliases(candidates, policy === 'distinct' ? { title } : {});
}

/**
 * Names worth keeping, in the order given.
 *
 * `[0]` is the display name and is never dropped. Two rules always apply to the
 * rest, both of them `INV-28`: a repeat after case and diacritic folding is dead
 * weight, and anything shorter than three characters matches nearly everything
 * and degrades ranking catalogue-wide.
 *
 * Passing a `title` adds the `distinct` policy's third rule — drop what is
 * already reachable: an alias contained in one that is kept (a word-start match
 * on the longer string finds it) and an alias equal to the row's Latin `title`
 * (which the consumer searches in its own right).
 */
function filterAliases(values: readonly string[], options: { title?: string }): string[] {
  const kept: string[] = [];
  const folded: string[] = [];
  const titleKey = options.title === undefined ? '' : fold(options.title);
  const dropRedundant = options.title !== undefined;

  for (const value of values) {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;

    const key = fold(trimmed);
    if (!key) continue;

    if (kept.length === 0) {
      kept.push(trimmed);
      folded.push(key);
      continue;
    }
    if (trimmed.length < 3 || key.length < 3) continue;
    if (folded.includes(key)) continue;
    if (dropRedundant) {
      if (titleKey && key === titleKey) continue;
      if (folded.some((existing) => coversWords(existing, key) || coversWords(key, existing))) continue;
    }

    kept.push(trimmed);
    folded.push(key);
  }
  return kept;
}

/**
 * Does `whole` contain `part` as a run of whole words?
 *
 * Whole words, not characters: `Ким` is a name in its own right and must not be
 * swallowed by `Иоаким`, while `Сеговия` genuinely is reachable inside
 * `Андрес Сеговия` because a consumer grades a word-start match.
 */
function coversWords(whole: string, part: string): boolean {
  if (whole === part) return true;
  return ` ${whole} `.includes(` ${part} `);
}

/** Case, diacritics and punctuation removed — how a consumer compares two names. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
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


