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
// how many people the entry is about
// ---------------------------------------------------------------------------

export interface EnsembleResolution {
  /** True when the name describes a collective rather than one person. */
  group: boolean;
  /** How many people, when the word names a number: duo → 2, quartet → 4. */
  size?: number;
  /** The word that decided it, for the diagnostic note. */
  word?: string;
}

const SOLO: EnsembleResolution = { group: false };

/**
 * Words that name a collective, and how many people each implies.
 *
 * The Cyrillic entries are *stems*, because Russian declines them (`дуэта`,
 * `квартетом`, `ансамбля`) and a whole-word table would miss most real titles.
 * The Latin ones are whole words on purpose: `^band[\p{L}]*$` also matches
 * `Bandini` and `bandurria`, and this is a corpus of Spanish and Italian names.
 * Dutch and German write these words as the tail of a compound (`Gitaartrio`,
 * `Gitarrenquartett`), which {@link COMPOUND_TAILS} covers from the other end.
 *
 * Kept beside `type` and `gender` because it answers the same kind of question
 * — a multilingual word to a canonical value — and because the answer feeds two
 * of them: a collective is `gender: mixed` (`external/02`), and the size is what
 * tells the portrait matcher that a photograph with three faces in it is the
 * *right* photograph rather than a group shot to be avoided.
 */
const ENSEMBLE_WORDS: ReadonlyArray<{ match: RegExp; size?: number }> = [
  { match: /^(?:duo|duos|duet|duett|duetto|dueto|d[uú]o)$/u, size: 2 },
  { match: /^(?:дуэт|дуо|дует)[а-яё]*$/u, size: 2 },
  { match: /^(?:trio|trios|tr[ií]o)$/u, size: 3 },
  { match: /^трио$/u, size: 3 },
  { match: /^(?:quartet|quartets|quartett|quartetto|cuarteto|quatuor|kwartet|kvartet)$/u, size: 4 },
  { match: /^квартет[а-яё]*$/u, size: 4 },
  { match: /^(?:quintet|quintets|quintett|quintetto|quinteto|kwintet|kvintet)$/u, size: 5 },
  { match: /^квинтет[а-яё]*$/u, size: 5 },
  { match: /^(?:sextet|sextett|sextetto|sexteto)$/u, size: 6 },
  { match: /^секстет[а-яё]*$/u, size: 6 },
  { match: /^(?:septet|septett|septetto|septeto)$/u, size: 7 },
  { match: /^септет[а-яё]*$/u, size: 7 },
  { match: /^(?:octet|octets|oktett|octeto)$/u, size: 8 },
  { match: /^октет[а-яё]*$/u, size: 8 },
  { match: /^(?:ensemble|ensembles|ensamble|conjunto|ansambl)$/u },
  { match: /^(?:ансамбл|колектив|коллектив)[а-яё]*$/u },
  { match: /^(?:orchestra|orchestras|orquesta|orchester|orchestre)$/u },
  { match: /^оркестр[а-яё]*$/u },
  { match: /^(?:band|bands|group|groups|grupo|gruppe|groupe)$/u },
  { match: /^групп[а-яё]*$/u },
  { match: /^(?:choir|chorus|coro|chor)$/u },
  { match: /^хор$/u },
];

/**
 * The same words as the tail of a compound: `Gitaartrio`, `Gitarrenquartett`,
 * `Blockflötenduo`.
 *
 * Two guards, and both are load-bearing. The word must be **long**, and the
 * letter before the tail must be a **consonant** — which is what separates a
 * Germanic compound (`gitaa|r|trio`, `gitarre|n|quartett`, `zupf|quintett`) from
 * a Romance name or noun that merely ends the same way. Without the second
 * guard, `Demetrio` is a trio and `individuo` is a duo, and this is a corpus
 * full of Spanish and Italian names.
 */
const COMPOUND_TAILS: ReadonlyArray<{ match: RegExp; size?: number }> = [
  { match: /[^aeiouаеёиоуыэюяй](?:trio)$/u, size: 3 },
  { match: /[^aeiouаеёиоуыэюяй](?:duo|duett?)$/u, size: 2 },
  { match: /[^aeiouаеёиоуыэюяй](?:quartett?|kwartet|kvartet)$/u, size: 4 },
  { match: /[^aeiouаеёиоуыэюяй](?:quintett?|kwintet)$/u, size: 5 },
  { match: /[^aeiouаеёиоуыэюяй](?:ensemble|orkest|orchester)$/u },
];

const COMPOUND_MIN_LENGTH = 8;

/**
 * `"Гитарный дуэт 'Торнадо'"` → `{ group: true, size: 2 }`.
 *
 * Ask this of a **name** — a title, a heading, a slug, the roster's own entry —
 * never of the article's prose. "Played in a band for ten years" is a sentence
 * about one guitarist, and the same table that reads `ГРАН-дуэт` correctly would
 * read that as a collective.
 *
 * The largest number wins when several words appear: `"Трио гитаристов Урала"`
 * inside a page that also mentions a `дуэт` is still a trio, and a
 * `"квартет"` in a title that also says `"ансамбль"` is a quartet, because the
 * numbered word is the more specific claim.
 */
export function resolveEnsemble(name: string): EnsembleResolution {
  const words = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  let best: EnsembleResolution | undefined;
  const consider = (entry: { size?: number }, word: string): void => {
    const candidate: EnsembleResolution = {
      group: true,
      ...(entry.size === undefined ? {} : { size: entry.size }),
      word,
    };
    if (!best || (candidate.size ?? 0) > (best.size ?? 0)) best = candidate;
  };

  for (const word of words) {
    for (const entry of ENSEMBLE_WORDS) {
      if (entry.match.test(word)) consider(entry, word);
    }
    if (word.length < COMPOUND_MIN_LENGTH) continue;
    for (const entry of COMPOUND_TAILS) {
      if (entry.match.test(word)) consider(entry, word);
    }
  }
  return best ?? SOLO;
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

/**
 * `"ru"` → `"Russian"`; `("ru", "de")` → `"Russisch"`.
 *
 * For prompts, mostly. A two-letter code is unambiguous to a program and merely
 * probable to a language model — `"pt"` is Portuguese to one reader and a
 * typo to another — and the name costs one token more than the code. Falls back
 * to the code itself where the runtime has no name for it.
 */
export function languageName(code: string, inLanguage = 'en'): string {
  const normalized = code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (!normalized) return code;

  try {
    const display = new Intl.DisplayNames([inLanguage], { type: 'language' });
    return display.of(normalized) ?? code;
  } catch {
    return code;
  }
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
