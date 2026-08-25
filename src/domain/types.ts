/**
 * The catalogue data format, as TypeScript.
 *
 * These types are a transcription of `external/08-json-schemas.md` §8.4 and are
 * the *only* place the shape of the published files is stated. Everything else
 * in `src/domain` normalizes values into these types; everything outside it
 * consumes them and never re-derives the format's rules.
 *
 * Format version 2. The identity fields (`id`, `title`, `type`, `gender`,
 * `country`, `img`) live in `index.json` and are forbidden inside a dossier —
 * see {@link FORBIDDEN_DOSSIER_MEMBERS}.
 */

/** One row of `index.json`. Unknown members are preserved, never rejected. */
export interface EntryRow {
  /** VD-ID — stable decimal string; join key to `index-<lang>.json`. */
  id: string;
  /** VD-LATIN — Latin fallback name and last-resort search key. */
  title: string;
  /** VD-ENUM-TYPE — craft, or the reserved value `hidden`. */
  type: string;
  /** VD-PATH-CONTENT — root-relative article path; its basename yields the slug. */
  md: string;
  /** VD-LANGLIST — `"ru,de"`; the first code is the original language. */
  lang?: string;
  /** VD-ENUM-GENDER. */
  gender?: string;
  /** VD-COUNTRY — ISO 3166-1 alpha-2, authored lowercase. */
  country?: string;
  /** VD-PATH-CONTENT — root-relative dossier path. Present ⟺ biography. */
  json?: string;
  /** VD-PATH-ASSET — bucket-relative portrait; never localized. */
  img?: string;
  [key: string]: unknown;
}

/** `index-<lang>.json` — `id` → `[display name, ...search-only aliases]`. */
export type NameIndex = Record<string, string[]>;

/**
 * Which name lands in `index-<lang>.json[0]` — `tasks.catalog.displayNameOrder`.
 *
 * `[0]` is not one alias among several: the reader prints it under the
 * thumbnail and searches everything after it, so the choice is a deployment
 * decision rather than a derivation. It lives here because two layers have to
 * agree about it — `catalog` authors `[0]` and `validate` checks it (`INV-15`)
 * — exactly as {@link DatePrecision} is shared by the writer and the checker.
 *
 *  - `roster` — the roster's own `fullname` for the roster's language, falling
 *    back to `Surname Forename` when the roster does not know the entry; every
 *    other language keeps `Forename Surname`, because a Russian catalogue's
 *    filing order is not an English one.
 *  - `surname-first` — `Surname Forename` in every language.
 *  - `given-first` — `Forename Surname` in every language, which is `INV-15`
 *    as `external/07` §7.3 states it.
 *
 * Whichever order loses becomes the first alias, so both stay searchable.
 */
export type DisplayNameOrder = 'roster' | 'surname-first' | 'given-first';

/** VD-DATE values, all optional, all L0. */
export interface EntryDates {
  born?: string;
  died?: string;
  activeFrom?: string;
  activeTo?: string;
}

export interface EntryMeta {
  forename?: string;
  surname?: string;
  birthname?: string;
  birthplace?: string;
  deathplace?: string;
  dates?: EntryDates;
  /** VD-CSV-LIST — comma-separated strings, never arrays. */
  relatives?: string;
  instruments?: string;
  genres?: string;
  bands?: string;
  awards?: string;
  teachers?: string;
  disciples?: string;
  jobs?: string;
  /** L0 — identical in every edition. */
  ranking?: number;
  url?: string;
  [key: string]: unknown;
}

export interface MediaItem {
  /** L1 — translated per edition. */
  label: string;
  /** L0 — identical in every edition. */
  target: string;
  /** Item objects tolerate unknown members, and a producer preserves them. */
  [key: string]: unknown;
}

export interface DocumentItem {
  label: string;
  /** VD-ENUM-DOCTYPE — uppercase symbolic category; open set. */
  type?: string;
  /** VD-TARGET, or the exact sentinel `embedded`. */
  target: string;
  [key: string]: unknown;
}

export interface Dossier {
  metadata: EntryMeta;
  media?: { photos?: MediaItem[]; music?: MediaItem[] };
  documents?: DocumentItem[];
  [key: string]: unknown;
}

/**
 * Classification the catalogue owns but a biography is the only place to learn.
 *
 * `external/01-data-model.md` §1.1 puts these in `index.json`, and
 * `external/05-entry-dossier.md` §5.3 forbids them inside a dossier. They are
 * nonetheless visible to whoever reads the article, so they travel from the
 * extractor to the catalogue on their own channel rather than being thrown away.
 */
export interface CatalogHints {
  type?: string;
  gender?: string;
  country?: string;
  title?: string;
  img?: string;
}

/** Withdrawn in version 2 — an error inside a dossier (`INV-7`). */
export const FORBIDDEN_DOSSIER_MEMBERS = [
  'id',
  'title',
  'type',
  'gender',
  'country',
  'img',
  'bio',
  'dataStatus',
] as const;

/** `metadata` members the format defines, in the house order for legible diffs. */
export const METADATA_ORDER = [
  'forename',
  'surname',
  'birthname',
  'birthplace',
  'deathplace',
  'dates',
  'relatives',
  'instruments',
  'genres',
  'bands',
  'awards',
  'teachers',
  'disciples',
  'jobs',
  'ranking',
  'url',
] as const;

/** `dates` is a closed member set (`additionalProperties: false`). */
export const DATE_KEYS = ['born', 'died', 'activeFrom', 'activeTo'] as const;

/** VD-CSV-LIST members of `metadata`. */
export const LIST_KEYS = [
  'relatives',
  'instruments',
  'genres',
  'bands',
  'awards',
  'teachers',
  'disciples',
  'jobs',
] as const;

/** VD-LOCALIZED members of `metadata` that are plain prose, not lists. */
export const PROSE_KEYS = ['forename', 'surname', 'birthname', 'birthplace', 'deathplace'] as const;

/** `index.json` members, in the house order: identity, classification, paths. */
export const ROW_ORDER = ['id', 'title', 'lang', 'type', 'gender', 'country', 'md', 'json', 'img'] as const;

/** The ten languages of the reference deployment (`VD-LANG`). */
export const DEFAULT_SUPPORTED_LANGUAGES = [
  'en',
  'es',
  'ja',
  'de',
  'fr',
  'it',
  'pt',
  'ru',
  'zh',
  'ko',
] as const;

/** The `documents[].type` values `external/02` records as observed. */
export const OBSERVED_DOCUMENT_TYPES = [
  'TRANSCRIPT',
  'DOSSIER',
  'ARTICLE',
  'REFERENCE',
  'SCAN',
  'DISCOGRAPHY',
] as const;
