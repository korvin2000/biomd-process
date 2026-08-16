/**
 * The three closed-ish token vocabularies: `type`, `gender`, `documents[].type`.
 *
 * All three are L3/L0 machine tokens — never displayed verbatim, resolved into
 * localized text by the consumer — so a value in the wrong case, the wrong
 * language or the wrong wording is not a cosmetic defect: it drops the entry out
 * of a facet, or the document out of its category. And all three are exactly the
 * kind of thing a language model answers approximately: `"Guitarist"`,
 * `"гитарист"`, `"guitar player"`, `"male"`, `"м"`, `"scan"`.
 *
 * Mapping them here rather than insisting on it in the prompt is the whole
 * trade: the instruction that would enforce it costs tokens on every call, the
 * retry when it is ignored costs a round trip, and this costs a table lookup.
 */

import { DEFAULT_SUPPORTED_LANGUAGES, OBSERVED_DOCUMENT_TYPES } from './types.js';

// ---------------------------------------------------------------------------
// type — VD-ENUM-TYPE
// ---------------------------------------------------------------------------

/** The established vocabulary of `external/02-value-domains.md`. */
export const ENTRY_TYPES = [
  'guitarist',
  'musician',
  'composer',
  'conductor',
  'luthier',
  'guitar-historian',
  'publisher',
  'hidden',
] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

/**
 * Words that name one of the crafts, in the languages this corpus is written
 * and translated in. Matched against a folded, hyphen-collapsed form, so
 * `"Guitar Player"` and `"guitar-player"` are the same key.
 */
const TYPE_SYNONYMS: Record<string, EntryType> = {
  // guitarist
  guitarist: 'guitarist',
  'guitar-player': 'guitarist',
  guitar: 'guitarist',
  guitarrista: 'guitarist',
  guitariste: 'guitarist',
  gitarrist: 'guitarist',
  chitarrista: 'guitarist',
  гитарист: 'guitarist',
  гитаристка: 'guitarist',
  'flamenco-guitarist': 'guitarist',
  'classical-guitarist': 'guitarist',
  // composer
  composer: 'composer',
  compositor: 'composer',
  compositeur: 'composer',
  komponist: 'composer',
  compositore: 'composer',
  композитор: 'composer',
  // conductor
  conductor: 'conductor',
  dirigent: 'conductor',
  'chef-d-orchestre': 'conductor',
  дирижер: 'conductor',
  // luthier
  luthier: 'luthier',
  'guitar-maker': 'luthier',
  'instrument-maker': 'luthier',
  'guitar-builder': 'luthier',
  gitarrenbauer: 'luthier',
  лютье: 'luthier',
  'мастер-гитар': 'luthier',
  'гитарный-мастер': 'luthier',
  // guitar historian
  'guitar-historian': 'guitar-historian',
  historian: 'guitar-historian',
  musicologist: 'guitar-historian',
  'guitar-researcher': 'guitar-historian',
  историк: 'guitar-historian',
  'историк-гитары': 'guitar-historian',
  музыковед: 'guitar-historian',
  // publisher
  publisher: 'publisher',
  editor: 'publisher',
  'publishing-house': 'publisher',
  verlag: 'publisher',
  издатель: 'publisher',
  издательство: 'publisher',
  // musician (the catch-all the spec assigns to "not classified more narrowly")
  musician: 'musician',
  musico: 'musician',
  musiker: 'musician',
  musicien: 'musician',
  музыкант: 'musician',
  singer: 'musician',
  vocalist: 'musician',
  певец: 'musician',
  performer: 'musician',
  исполнитель: 'musician',
  ensemble: 'musician',
  band: 'musician',
  ансамбль: 'musician',
  коллектив: 'musician',
  arranger: 'musician',
  аранжировщик: 'musician',
  teacher: 'musician',
  pedagogue: 'musician',
  педагог: 'musician',
  // hidden
  hidden: 'hidden',
  page: 'hidden',
  technical: 'hidden',
  about: 'hidden',
  служебная: 'hidden',
};

export interface TypeResolution {
  type?: EntryType | string;
  /** Set when the answer named more than one craft, or none this table knows. */
  note?: string;
}

/**
 * `"Guitarist, Composer"` → `musician`; `"гитарист"` → `guitarist`.
 *
 * Two crafts is not an error and not a coin toss: `external/02` assigns
 * `musician` to exactly that case ("also collectives: for example both:
 * guitarist and composer"), so a multi-craft answer resolves deterministically
 * instead of taking whichever word came first.
 *
 * `allowUnknown` decides what happens to a value the table does not know. The
 * format's vocabulary is open, so `true` is conforming; `false` is the safer
 * default for machine-produced values, where an unknown token is far more often
 * a hallucinated synonym than a genuinely new craft.
 */
export function resolveEntryType(raw: string, allowUnknown = false): TypeResolution {
  const value = raw.trim();
  if (!value) return {};

  const crafts = new Set<EntryType>();
  const unmatched: string[] = [];

  // `\b` is ASCII-only in JavaScript, so a Cyrillic conjunction needs the
  // whitespace spelled out rather than a word boundary.
  for (const part of value.split(/[,;/|+]|\s+(?:and|und|и)\s+/gi)) {
    const key = tokenize(part);
    if (!key) continue;
    const craft = TYPE_SYNONYMS[key];
    if (craft) crafts.add(craft);
    else unmatched.push(key);
  }

  // `hidden` is a visibility switch, not a craft: it never competes.
  if (crafts.has('hidden')) return { type: 'hidden' };

  if (crafts.size === 1) return { type: [...crafts][0] };
  if (crafts.size > 1) {
    const named = [...crafts].join(' + ');
    return { type: 'musician', note: `Collapsed "${value}" (${named}) to type "musician".` };
  }

  const fallback = unmatched[0];
  if (!fallback) return {};
  if (allowUnknown && /^[a-z0-9][a-z0-9_-]*$/.test(fallback)) {
    return { type: fallback, note: `Kept the unrecognized craft "${fallback}" (the vocabulary is open).` };
  }
  return { note: `Ignored the unrecognized craft "${value}".` };
}

export function isEntryType(value: string): value is EntryType {
  return (ENTRY_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// gender — VD-ENUM-GENDER
// ---------------------------------------------------------------------------

const GENDER_SYNONYMS: Record<string, 'm' | 'f' | 'mixed'> = {
  m: 'm',
  male: 'm',
  man: 'm',
  masculine: 'm',
  masculino: 'm',
  mann: 'm',
  homme: 'm',
  м: 'm',
  муж: 'm',
  мужской: 'm',
  мужчина: 'm',
  f: 'f',
  female: 'f',
  woman: 'f',
  feminine: 'f',
  femenino: 'f',
  frau: 'f',
  femme: 'f',
  w: 'f',
  ж: 'f',
  жен: 'f',
  женский: 'f',
  женщина: 'f',
  mixed: 'mixed',
  group: 'mixed',
  collective: 'mixed',
  ensemble: 'mixed',
  team: 'mixed',
  band: 'mixed',
  n: 'mixed',
  other: 'mixed',
  смешанный: 'mixed',
  группа: 'mixed',
  коллектив: 'mixed',
  ансамбль: 'mixed',
};

/** `"Male"` | `"м"` | `"группа"` → `m` | `f` | `mixed`. */
export function resolveGender(raw: string): 'm' | 'f' | 'mixed' | undefined {
  return GENDER_SYNONYMS[tokenize(raw)];
}

// ---------------------------------------------------------------------------
// documents[].type — VD-ENUM-DOCTYPE
// ---------------------------------------------------------------------------

const DOCTYPE_SYNONYMS: Record<string, string> = {
  transcript: 'TRANSCRIPT',
  transcription: 'TRANSCRIPT',
  tab: 'TRANSCRIPT',
  tablature: 'TRANSCRIPT',
  score: 'TRANSCRIPT',
  ноты: 'TRANSCRIPT',
  табулатура: 'TRANSCRIPT',
  переложение: 'TRANSCRIPT',
  dossier: 'DOSSIER',
  досье: 'DOSSIER',
  article: 'ARTICLE',
  essay: 'ARTICLE',
  статья: 'ARTICLE',
  очерк: 'ARTICLE',
  reference: 'REFERENCE',
  link: 'REFERENCE',
  encyclopedia: 'REFERENCE',
  справочник: 'REFERENCE',
  ссылка: 'REFERENCE',
  scan: 'SCAN',
  photo: 'SCAN',
  programme: 'SCAN',
  program: 'SCAN',
  poster: 'SCAN',
  скан: 'SCAN',
  афиша: 'SCAN',
  программа: 'SCAN',
  discography: 'DISCOGRAPHY',
  recordings: 'DISCOGRAPHY',
  дискография: 'DISCOGRAPHY',
  записи: 'DISCOGRAPHY',
};

/**
 * `"scan"` → `SCAN`; `"concert programme"` → `PROGRAMME` when nothing matches.
 *
 * The vocabulary is genuinely open here (`external/02` requires a consumer to
 * render an unknown value rather than drop the item), so an unrecognized word
 * is upper-cased into a well-formed symbol instead of being discarded.
 */
export function resolveDocumentType(raw: string): string | undefined {
  const key = tokenize(raw);
  if (!key) return undefined;

  const known = DOCTYPE_SYNONYMS[key];
  if (known) return known;

  const symbol = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[A-Z][A-Z0-9_]*$/.test(symbol) ? symbol : undefined;
}

export function isObservedDocumentType(value: string): boolean {
  return (OBSERVED_DOCUMENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// lang — VD-LANG
// ---------------------------------------------------------------------------

/** `ch` is the classic Chinese mistake; the ISO 639-1 code is `zh`. */
const LANG_FIXES: Record<string, string> = { ch: 'zh', cn: 'zh', jp: 'ja', kr: 'ko', ua: 'uk', gr: 'el' };

/**
 * One content-language code, or `undefined`.
 *
 * `supported` is the deployment's closed set: a code outside it is dropped
 * rather than treated as an error, exactly as a conforming consumer does.
 */
export function resolveLanguage(
  raw: string,
  supported: readonly string[] = DEFAULT_SUPPORTED_LANGUAGES,
): string | undefined {
  const value = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  const fixed = LANG_FIXES[value] ?? value;
  if (!/^[a-z]{2}$/.test(fixed)) return undefined;
  return supported.includes(fixed) ? fixed : undefined;
}

// ---------------------------------------------------------------------------

/** Lowercase, diacritic-free, non-letters collapsed to single hyphens. */
function tokenize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
