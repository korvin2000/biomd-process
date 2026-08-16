import { resolveCountry } from '../../domain/countries.js';
import type { CatalogHints, Dossier, MediaItem } from '../../domain/types.js';
import { orderDossier, sanitizeDossier, type DossierOptions } from '../../domain/dossier.js';
import { mergeCsvLists, normalizeCsvList, normalizeDate, normalizeRanking, normalizeUrl } from '../../domain/values.js';
import { resolveEntryType, resolveGender } from '../../domain/vocabulary.js';
import { toAscii } from '../catalog/romanize.js';

/**
 * The extraction wire format: **one flat table of short keys**.
 *
 * The dossier this pipeline produces is a nested document with three sections,
 * a closed date sub-object, comma-list encodings, an enumerated document type
 * and a hard rule about which identity fields may not appear in it. Describing
 * all of that to a model — which is what shipping the JSON Schema in the prompt
 * did — costs about 1200 tokens in the system message and another 1200 in
 * `response_format`, on **every call, for every document**, and buys a model
 * that reproduces a structure rather than one that reads an article.
 *
 * None of that structure is information the model has. It is information *we*
 * have. So the model is asked for the only thing it can actually contribute —
 * twenty-odd facts, as `key: value` — and the structure is assembled here, where
 * it is deterministic, free, and testable without a network call.
 *
 * What the change buys, per document:
 *
 * | | before | after |
 * |---|---|---|
 * | schema in the system prompt | ~1200 tok | ~200 tok (the field card) |
 * | schema in `response_format` | ~1200 tok | `json_object`, ~0 |
 * | shape errors possible | nesting, arrays-vs-lists, forbidden members, date format | none — the shape is not the model's to get wrong |
 *
 * The flat keys deliberately match the dossier's own member names, so the card
 * reads as the field list it is and nothing has to be translated by eye.
 */

export type FieldKind = 'text' | 'list' | 'date' | 'ranking' | 'url' | 'country' | 'gender' | 'type' | 'latin';

export interface FlatField {
  /** The wire key. Flat, no dots, identical to the dossier member where possible. */
  key: string;
  kind: FieldKind;
  /** Where the value lands: a `metadata` member, a `dates` member, or the index. */
  target: 'metadata' | 'dates' | 'catalog';
  /** Member name at that destination. */
  member: string;
  /** One short line for the prompt's field card. Billed on every call — keep it terse. */
  hint: string;
}

/**
 * The default card.
 *
 * `ranking` is **not** here. It is "a project-defined editorial score", which is
 * by definition not a fact an article contains; asking for it invites a
 * plausible number in a field a reader renders as a five-star rating. It remains
 * available through `tasks.extract.fields` for anyone who wants it, and an
 * existing dossier's `ranking` is never touched.
 */
export const DEFAULT_FIELDS: readonly FlatField[] = [
  { key: 'forename', kind: 'text', target: 'metadata', member: 'forename', hint: 'given name, spelled as the article does' },
  { key: 'surname', kind: 'text', target: 'metadata', member: 'surname', hint: 'family name' },
  { key: 'birthname', kind: 'text', target: 'metadata', member: 'birthname', hint: 'full name at birth, only if it differs' },
  { key: 'birthplace', kind: 'text', target: 'metadata', member: 'birthplace', hint: 'place of birth, e.g. "Linares, Spain"' },
  { key: 'deathplace', kind: 'text', target: 'metadata', member: 'deathplace', hint: 'place of death' },
  { key: 'born', kind: 'date', target: 'dates', member: 'born', hint: 'date of birth, DD.MM.YYYY — omit unless the exact day is stated' },
  { key: 'died', kind: 'date', target: 'dates', member: 'died', hint: 'date of death, same rule' },
  { key: 'activeFrom', kind: 'date', target: 'dates', member: 'activeFrom', hint: 'start of the documented career, same rule' },
  { key: 'activeTo', kind: 'date', target: 'dates', member: 'activeTo', hint: 'end of the documented career, same rule' },
  { key: 'relatives', kind: 'list', target: 'metadata', member: 'relatives', hint: 'related people, comma-separated' },
  { key: 'instruments', kind: 'list', target: 'metadata', member: 'instruments', hint: 'instruments played' },
  { key: 'genres', kind: 'list', target: 'metadata', member: 'genres', hint: 'musical genres' },
  { key: 'bands', kind: 'list', target: 'metadata', member: 'bands', hint: 'bands, ensembles, orchestras' },
  { key: 'awards', kind: 'list', target: 'metadata', member: 'awards', hint: 'awards and distinctions' },
  { key: 'teachers', kind: 'list', target: 'metadata', member: 'teachers', hint: 'teachers and mentors' },
  { key: 'disciples', kind: 'list', target: 'metadata', member: 'disciples', hint: 'notable students' },
  { key: 'jobs', kind: 'list', target: 'metadata', member: 'jobs', hint: 'professions and professional roles' },
  { key: 'url', kind: 'url', target: 'metadata', member: 'url', hint: 'the single best external source URL the article names' },
];

/** Asked for only when the catalogue-hint channel is on. */
export const CATALOG_FIELDS: readonly FlatField[] = [
  {
    key: 'type',
    kind: 'type',
    target: 'catalog',
    member: 'type',
    hint: 'craft: guitarist, musician, composer, conductor, luthier, guitar-historian or publisher',
  },
  { key: 'gender', kind: 'gender', target: 'catalog', member: 'gender', hint: 'm, f, or mixed for a group' },
  {
    key: 'country',
    kind: 'country',
    target: 'catalog',
    member: 'country',
    hint: 'principal nationality as an ISO 3166-1 alpha-2 code, lowercase — not the birthplace',
  },
  {
    key: 'latin',
    kind: 'latin',
    target: 'catalog',
    member: 'title',
    hint: 'the full name in plain ASCII Latin letters, no accents ("Andres Segovia")',
  },
];

/** Fields available but not in the default card, addressable by `tasks.extract.fields`. */
export const OPTIONAL_FIELDS: readonly FlatField[] = [
  {
    key: 'ranking',
    kind: 'ranking',
    target: 'metadata',
    member: 'ranking',
    hint: 'editorial score 0–100, only if the article itself states one',
  },
];

const ALL_FIELDS = [...DEFAULT_FIELDS, ...CATALOG_FIELDS, ...OPTIONAL_FIELDS];

/** The card for one task: the configured selection, plus the catalogue fields. */
export function fieldsFor(options: { include?: readonly string[]; catalogHints: boolean }): FlatField[] {
  const base = options.include?.length
    ? options.include
        .map((key) => ALL_FIELDS.find((field) => field.key === key))
        .filter((field): field is FlatField => Boolean(field))
    : [...DEFAULT_FIELDS];

  if (!options.catalogHints) return base.filter((field) => field.target !== 'catalog');

  const merged = [...base];
  for (const field of CATALOG_FIELDS) {
    if (!merged.some((existing) => existing.key === field.key)) merged.push(field);
  }
  return merged;
}

/** A model's answer after parsing: flat, string-valued, keys from the card. */
export type FlatRecord = Record<string, string>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParseFlatResult {
  ok: boolean;
  record: FlatRecord;
  reason?: string;
}

/**
 * Values that mean "not recorded" and are the single most common thing a model
 * writes instead of omitting a key. Dropping them here is what keeps
 * `"birthplace": "unknown"` from being published as a fact.
 */
const NULLISH = new Set([
  '',
  '-',
  '--',
  '—',
  '–',
  '?',
  'n/a',
  'na',
  'none',
  'null',
  'nil',
  'undefined',
  'unknown',
  'unspecified',
  'not stated',
  'not specified',
  'not mentioned',
  'not available',
  'tbd',
  'нет',
  'нет данных',
  'не указано',
  'не указан',
  'не указана',
  'неизвестно',
  'отсутствует',
  'unbekannt',
  'desconocido',
  'inconnu',
]);

/**
 * Reads the answer, tolerating every shape a model reaches for.
 *
 * Three are accepted: the flat JSON object that was asked for, a nested object
 * (a model that pattern-matched on "dossier" and produced `metadata`/`dates`
 * anyway), and `key: value` lines. All three are free to accept and each one
 * removes a retry that would otherwise cost a full round trip.
 */
export function parseFlatAnswer(text: string, fields: readonly FlatField[]): ParseFlatResult {
  const known = new Map(fields.map((field) => [field.key.toLowerCase(), field.key]));
  const record: FlatRecord = {};

  const json = readJsonObject(text);
  if (json) {
    collect(json, known, record, 0);
    return { ok: true, record };
  }

  const lines = readKeyValueLines(text, known);
  if (Object.keys(lines).length > 0) return { ok: true, record: lines };

  return { ok: false, record, reason: 'response contained neither a JSON object nor any "key: value" line' };
}

function readJsonObject(text: string): Record<string, unknown> | undefined {
  const block = extractJsonObject(text);
  if (!block) return undefined;
  try {
    const value: unknown = JSON.parse(block);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Walks one or two levels: a nested `metadata`/`dates`/`catalog` answer flattens. */
function collect(
  source: Record<string, unknown>,
  known: ReadonlyMap<string, string>,
  record: FlatRecord,
  depth: number,
): void {
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = known.get(rawKey.toLowerCase().split('.').pop() ?? '');
    if (key) {
      if (record[key] !== undefined) continue;
      const value = stringify(rawValue);
      if (value) record[key] = value;
      continue;
    }
    if (depth < 2 && isObject(rawValue)) collect(rawValue, known, record, depth + 1);
  }
}

function readKeyValueLines(text: string, known: ReadonlyMap<string, string>): FlatRecord {
  const record: FlatRecord = {};

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]?\s*["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*[:=]\s*(.+)$/.exec(line);
    const key = known.get((match?.[1] ?? '').toLowerCase());
    if (!key || record[key] !== undefined) continue;

    const value = stringify((match?.[2] ?? '').trim().replace(/^["'`]|["'`],?$/g, ''));
    if (value) record[key] = value;
  }
  return record;
}

/** Anything the model might put in a value position, as the string we want. */
function stringify(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const joined = value.map((item) => stringify(item) ?? '').filter(Boolean).join(',');
    return joined || undefined;
  }
  if (typeof value === 'object') return undefined;

  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text || NULLISH.has(text.toLowerCase())) return undefined;
  return text;
}

// ---------------------------------------------------------------------------
// Normalization and merging
// ---------------------------------------------------------------------------

export interface NormalizeFlatResult {
  record: FlatRecord;
  notes: string[];
}

/**
 * Brings each value into its domain's canonical form, or drops it.
 *
 * Runs per chunk rather than once at the end, for the same reason the previous
 * implementation did: the chunk merge unions list fields, and a union only
 * agrees with itself when every side is punctuated identically first.
 */
export function normalizeFlat(record: FlatRecord, fields: readonly FlatField[]): NormalizeFlatResult {
  const notes: string[] = [];
  const result: FlatRecord = {};

  for (const field of fields) {
    const raw = record[field.key];
    if (raw === undefined) continue;

    const value = normalizeValue(raw, field, notes);
    if (value) result[field.key] = value;
  }
  return { record: result, notes };
}

function normalizeValue(raw: string, field: FlatField, notes: string[]): string | undefined {
  switch (field.kind) {
    case 'list':
      return normalizeCsvList(raw) || undefined;

    case 'date': {
      const date = normalizeDate(raw);
      if (!date) {
        notes.push(`Dropped ${field.key} "${raw}": a date not known to the day has no representation (VD-DATE).`);
        return undefined;
      }
      if (date !== raw) notes.push(`Rewrote ${field.key} "${raw}" as "${date}".`);
      return date;
    }

    case 'ranking': {
      const ranking = normalizeRanking(raw);
      return ranking === undefined ? undefined : String(ranking);
    }

    case 'url': {
      const url = normalizeUrl(raw);
      if (!url) notes.push(`Dropped url "${raw}": VD-URL wants an absolute http(s) URL.`);
      return url;
    }

    case 'country': {
      const country = resolveCountry(raw);
      if (!country) notes.push(`Dropped country "${raw}": not resolvable to an ISO 3166-1 alpha-2 code.`);
      else if (country !== raw) notes.push(`Resolved country "${raw}" to "${country}".`);
      return country;
    }

    case 'gender':
      return resolveGender(raw);

    case 'type': {
      const resolved = resolveEntryType(raw);
      if (resolved.note) notes.push(resolved.note);
      return resolved.type;
    }

    case 'latin': {
      const ascii = toAscii(raw);
      if (ascii && ascii !== raw) notes.push(`Folded the Latin title "${raw}" to ASCII "${ascii}".`);
      return ascii;
    }

    default:
      return raw.trim() || undefined;
  }
}

/**
 * Combines the per-chunk answers of a chunked extraction.
 *
 * Scalars: the earliest mention wins — chunks arrive in document order, and an
 * identity fact stated in the lead is more reliable than a later restatement.
 * Lists: unioned, because the chunk that first names an instrument is not the
 * chunk that names them all, and first-wins would discard the rest of the
 * article.
 */
export function mergeFlat(parts: readonly FlatRecord[], fields: readonly FlatField[]): FlatRecord {
  const lists = new Set(fields.filter((field) => field.kind === 'list').map((field) => field.key));
  const merged: FlatRecord = {};

  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (!value) continue;
      const current = merged[key];
      if (current === undefined) merged[key] = value;
      else if (lists.has(key)) merged[key] = mergeCsvLists(current, value);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface BuildResult {
  dossier: Dossier;
  hints: CatalogHints;
  notes: string[];
}

export interface BuildOptions extends DossierOptions {
  /** Media parsed out of the article; the model is never asked for it. */
  media?: { photos?: MediaItem[]; music?: MediaItem[] };
}

/**
 * Assembles the dossier the format specifies from the flat answer.
 *
 * This is the half of the contract the model no longer has to know about: the
 * three sections, the nested `dates`, the comma-list encoding, and the rule that
 * `type`/`gender`/`country`/`title` belong to `index.json` and are therefore
 * routed to the hint channel instead of written here.
 */
export function buildDossier(
  record: FlatRecord,
  fields: readonly FlatField[],
  options: BuildOptions,
): BuildResult {
  const metadata: Record<string, unknown> = {};
  const dates: Record<string, string> = {};
  const hints: CatalogHints = {};

  for (const field of fields) {
    const value = record[field.key];
    if (!value) continue;

    switch (field.target) {
      case 'dates':
        dates[field.member] = value;
        break;
      case 'catalog':
        (hints as Record<string, string>)[field.member] = value;
        break;
      default:
        metadata[field.member] = field.kind === 'ranking' ? Number(value) : value;
    }
  }
  if (Object.keys(dates).length > 0) metadata['dates'] = dates;

  const draft: Dossier = {
    metadata,
    media: { photos: options.media?.photos ?? [], music: options.media?.music ?? [] },
    documents: [],
  };

  // One pass through the same sanitizer that reads a hand-authored file, so a
  // freshly built dossier and an existing one are held to identical rules.
  const sanitized = sanitizeDossier(draft, options);
  return { dossier: orderDossier(sanitized.dossier), hints, notes: sanitized.notes };
}

/** Which card keys a record actually answered — the input to `requiredFields`. */
export function answeredKeys(record: FlatRecord): Set<string> {
  return new Set(Object.entries(record).filter(([, value]) => Boolean(value)).map(([key]) => key));
}

/**
 * Accepts a `requiredFields` entry written either way.
 *
 * The configuration used to name dossier paths (`metadata.forename`,
 * `dates.born`) because that is what the model produced. The card is flat now,
 * and silently ignoring an existing config would turn a required field into an
 * unchecked one.
 */
export function toCardKey(path: string): string {
  const last = path.split('.').pop() ?? path;
  return last === 'title' ? 'latin' : last;
}

// ---------------------------------------------------------------------------

function extractJsonObject(raw: string): string | undefined {
  const text = raw.trim().replace(/^```(?:json|jsonc)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const start = text.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
