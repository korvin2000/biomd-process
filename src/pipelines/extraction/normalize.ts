import type { JsonObject, JsonValue } from '../../shared/json.js';
import type { MetadataDocument } from './MetadataContract.js';

/**
 * Brings a model's answer into the shape `docs/MetaData.md` actually specifies.
 *
 * A schema can say "this is a string"; it cannot say that `1893-02-21` and
 * `21.02.1893` are the same date written two ways, that `rock, pop , rock` is a
 * three-item list with a duplicate, or that `country` is not allowed to be here
 * at all. Those are the rules of the format, and they belong on this side of the
 * wire: a normalizer costs nothing and is deterministic, while asking a model to
 * be consistent costs a retry and usually is not.
 *
 * Everything it changes is reported, because a silent rewrite of extracted data
 * is indistinguishable from a bug.
 */

export interface NormalizeOptions {
  /** Dot paths whose value is a comma-separated list (`metadata.genres`, …). */
  listFields: readonly string[];
  /** Malformed dates: drop the value, or reject the whole answer. */
  onInvalidDate: 'drop' | 'reject';
}

export interface NormalizeResult {
  document: MetadataDocument;
  /** What was changed, in the pipeline's own words. */
  notes: string[];
  /** Set only when `onInvalidDate: 'reject'` and a date could not be read. */
  rejection?: string;
}

export interface LiftResult {
  document: MetadataDocument;
  notes: string[];
  /** Classification the dossier may not keep — routed to the catalogue instead. */
  hints: CatalogHints;
}

/**
 * Facts `Catalog-Index.md` §1 assigns to `index.json`, which a model reading a
 * biography is nonetheless well placed to notice. They are stripped out of the
 * dossier — `lint:content` rejects them there — and handed to the catalogue.
 */
export interface CatalogHints {
  type?: string;
  gender?: string;
  country?: string;
  title?: string;
}

/** Fields that moved to `index.json` in v2 and are errors inside a dossier. */
const INDEX_OWNED = ['id', 'title', 'gender', 'type', 'country', 'bio', 'dataStatus'] as const;

const GENDERS = new Set(['m', 'f', 'mixed']);

/**
 * Value-level normalization, run on **each chunk inside the call**.
 *
 * It happens there rather than once at the end for two reasons: `onInvalidDate:
 * reject` can only turn into a retry while the call is still in flight, and the
 * chunk merge unions list fields, which only agrees with itself if every chunk's
 * lists are punctuated the same way first.
 */
export function normalizeValues(raw: MetadataDocument, options: NormalizeOptions): NormalizeResult {
  const notes: string[] = [];
  const document = structuredClone(raw) as MetadataDocument;
  const metadata = document.metadata as JsonObject;

  const rejection = normalizeDates(metadata, options, notes);
  normalizeLists(document, options.listFields, notes);
  normalizeRanking(metadata, notes);
  normalizeDocumentTypes(document, notes);

  return { document, notes, ...(rejection ? { rejection } : {}) };
}

/** Both halves at once. Convenient for tests and for a single-shot extraction. */
export function normalizeMetadata(raw: MetadataDocument, options: NormalizeOptions): NormalizeResult & LiftResult {
  const normalized = normalizeValues(raw, options);
  const lifted = liftCatalogHints(normalized.document);
  return {
    document: lifted.document,
    notes: [...normalized.notes, ...lifted.notes],
    hints: lifted.hints,
    ...(normalized.rejection ? { rejection: normalized.rejection } : {}),
  };
}

/**
 * Moves the index-owned fields out of the dossier, **once, after the merge**.
 *
 * Not dropped: a model that read the article and concluded "Spanish, male,
 * guitarist" did real work, and the catalogue has nowhere else to get that from.
 * It just cannot live in `*.bio.json`, where `lint:content` rejects it.
 */
export function liftCatalogHints(raw: MetadataDocument): LiftResult {
  const document = structuredClone(raw) as MetadataDocument;
  const metadata = document.metadata as JsonObject;
  const notes: string[] = [];
  const hints: CatalogHints = {};
  const found: string[] = [];

  const root = document as unknown as JsonObject;
  // `catalog` is where the prompt asks for these; `metadata` and the root are
  // where a model puts them anyway. All three are swept, so the dossier comes
  // out clean whichever the model chose.
  const catalog = root['catalog'];
  const containers = [metadata, root, ...(isObject(catalog) ? [catalog] : [])];

  for (const field of INDEX_OWNED) {
    for (const container of containers) {
      const value = container[field];
      if (value === undefined) continue;

      delete container[field];
      if (container !== catalog) found.push(field);
      assignHint(hints, field, value);
    }
  }
  delete root['catalog'];

  if (found.length > 0) {
    notes.push(
      `Moved ${[...new Set(found)].join(', ')} out of the dossier: Catalog-Index.md §1 puts them in index.json.`,
    );
  }
  return { document, notes, hints };
}

function assignHint(hints: CatalogHints, field: string, value: JsonValue): void {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return;

  switch (field) {
    case 'type':
      hints.type = text.toLowerCase();
      break;
    case 'gender': {
      const gender = text.toLowerCase();
      if (GENDERS.has(gender)) hints.gender = gender;
      break;
    }
    case 'country':
      // ISO 3166-1 alpha-2, authored lowercase (§2.1).
      if (/^[A-Za-z]{2}$/.test(text)) hints.country = text.toLowerCase();
      break;
    case 'title':
      hints.title = text;
      break;
    default:
      break;
  }
}

// --- dates -----------------------------------------------------------------

const DATE_KEYS = ['born', 'died', 'activeFrom', 'activeTo'] as const;

function normalizeDates(metadata: JsonObject, options: NormalizeOptions, notes: string[]): string | undefined {
  const dates = metadata['dates'];
  if (!isObject(dates)) return undefined;

  const invalid: string[] = [];

  for (const key of DATE_KEYS) {
    const value = dates[key];
    if (value === undefined || value === null) continue;

    const original = typeof value === 'string' ? value.trim() : String(value);
    if (original === '') {
      delete dates[key];
      continue;
    }

    const normalized = normalizeDate(original);
    if (!normalized) {
      invalid.push(`${key}="${original}"`);
      if (options.onInvalidDate === 'drop') delete dates[key];
      continue;
    }
    if (normalized !== original) {
      notes.push(`Rewrote dates.${key} "${original}" as "${normalized}" (MetaData.md rule 7: DD.MM.YYYY).`);
    }
    dates[key] = normalized;
  }

  if (Object.keys(dates).length === 0) delete metadata['dates'];

  if (invalid.length === 0) return undefined;
  if (options.onInvalidDate === 'reject') {
    return `unreadable date(s): ${invalid.join(', ')} — MetaData.md rule 7 wants DD.MM.YYYY`;
  }
  notes.push(`Dropped unreadable date(s): ${invalid.join(', ')}.`);
  return undefined;
}

/**
 * `DD.MM.YYYY`, and the partial forms a biography genuinely has.
 *
 * Wider than the format guide on input and exactly as narrow as it on output:
 * models emit ISO dates constantly, and rewriting one is free while re-asking
 * for it costs a round trip. A year or a month+year is kept as such rather than
 * invented up to a full date — `MetaData.md` allows an absent date, so a guessed
 * day is strictly worse than a shorter one.
 */
export function normalizeDate(raw: string): string | undefined {
  const value = raw.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) return dmy(iso[3], iso[2], iso[1]);

  const isoMonth = /^(\d{4})-(\d{1,2})$/.exec(value);
  if (isoMonth) return my(isoMonth[2], isoMonth[1]);

  const dotted = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(value);
  if (dotted) return dmy(dotted[1], dotted[2], dotted[3]);

  const monthYear = /^(\d{1,2})[.\/-](\d{4})$/.exec(value);
  if (monthYear) return my(monthYear[1], monthYear[2]);

  if (/^\d{4}$/.test(value)) return value;

  return undefined;
}

function dmy(day = '', month = '', year = ''): string | undefined {
  const d = Number(day);
  const m = Number(month);
  if (!inRange(d, 1, 31) || !inRange(m, 1, 12)) return undefined;
  return `${pad(d)}.${pad(m)}.${year}`;
}

function my(month = '', year = ''): string | undefined {
  const m = Number(month);
  if (!inRange(m, 1, 12)) return undefined;
  return `${pad(m)}.${year}`;
}

// --- lists, ranking, document types ----------------------------------------

/**
 * `"rock, Pop , rock"` → `"rock,Pop"`.
 *
 * The guide's parsing rule is "split by comma → trim → drop empties"; applying
 * it here means every edition of every entry is punctuated identically, which is
 * what makes the localized editions comparable at all. Duplicates go too,
 * compared case-insensitively — the first spelling wins, because it is the one
 * the article used.
 */
export function normalizeList(value: string): string {
  const seen = new Set<string>();
  const items: string[] = [];

  for (const item of value.split(',')) {
    const trimmed = item.trim();
    if (trimmed === '') continue;
    const fold = trimmed.toLocaleLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    items.push(trimmed);
  }
  return items.join(',');
}

function normalizeLists(document: MetadataDocument, listFields: readonly string[], notes: string[]): void {
  let changed = 0;

  for (const path of listFields) {
    const parts = path.split('.');
    const key = parts.at(-1);
    const parent = resolve(document as unknown as JsonValue, parts.slice(0, -1));
    if (!key || !isObject(parent)) continue;

    const value = parent[key];
    if (typeof value !== 'string') continue;

    const normalized = normalizeList(value);
    if (normalized === value) continue;

    if (normalized === '') delete parent[key];
    else parent[key] = normalized;
    changed += 1;
  }

  if (changed > 0) notes.push(`Normalized ${changed} comma-separated list field(s).`);
}

function normalizeRanking(metadata: JsonObject, notes: string[]): void {
  const value = metadata['ranking'];
  if (value === undefined) return;

  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) {
    delete metadata['ranking'];
    notes.push('Dropped a non-numeric ranking.');
    return;
  }

  const clamped = Math.min(100, Math.max(0, Math.round(numeric)));
  if (clamped !== value) notes.push(`Clamped ranking ${String(value)} to ${clamped} (0–100).`);
  metadata['ranking'] = clamped;
}

/** The guide asks for "an uppercase symbolic value" — `article` → `ARTICLE`. */
function normalizeDocumentTypes(document: MetadataDocument, notes: string[]): void {
  let changed = 0;

  for (const entry of document.documents) {
    const type = entry.type;
    if (typeof type !== 'string') continue;

    const upper = type.trim().toUpperCase().replace(/\s+/g, '_');
    if (upper === type) continue;
    entry.type = upper;
    changed += 1;
  }

  if (changed > 0) notes.push(`Upper-cased ${changed} document type(s).`);
}

// --- helpers ---------------------------------------------------------------

function resolve(node: JsonValue, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = node;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
