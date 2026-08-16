/**
 * Everything that turns "a JSON file someone wrote" into a conforming dossier.
 *
 * Three jobs live here, and they are the same job seen from three directions:
 *
 *  - {@link sanitizeDossier} — read anything, emit a conforming document. It
 *    performs the version 1 → version 2 migration in passing: the identity
 *    members `external/05` §5.3 forbids (`title`, `type`, `gender`, `country`,
 *    `img`) are not deleted but *lifted* onto the catalogue-hint channel, which
 *    is exactly where the migration table of `external/07` §7.7 sends them.
 *  - {@link mergeDossier} — complete an existing dossier without overwriting it.
 *  - {@link orderDossier} — emit members in the house order, so a re-run of an
 *    unchanged corpus produces a byte-identical file and an empty diff.
 *
 * None of it calls a model. Every rule implemented here is a rule that would
 * otherwise have to be stated in a prompt, obeyed by a model, and paid for on
 * every document — and would still be wrong some of the time.
 */

import { resolveCountry } from './countries.js';
import {
  DATE_KEYS,
  FORBIDDEN_DOSSIER_MEMBERS,
  LIST_KEYS,
  METADATA_ORDER,
  PROSE_KEYS,
  type CatalogHints,
  type DocumentItem,
  type Dossier,
  type EntryMeta,
  type MediaItem,
} from './types.js';
import {
  mergeCsvLists,
  normalizeAssetPath,
  normalizeCsvList,
  normalizeDate,
  normalizeRanking,
  normalizeTarget,
  normalizeUrl,
  refinesDate,
  text,
  type DatePrecision,
} from './values.js';
import { resolveDocumentType, resolveEntryType, resolveGender } from './vocabulary.js';

export interface DossierOptions {
  /** The deployment's content languages, used to spot a localized target. */
  supportedLanguages: readonly string[];
  /** Keep a craft the vocabulary does not know, rather than dropping it. */
  allowUnknownTypes?: boolean;
  /**
   * The coarsest date this catalogue publishes (`catalogue.datePrecision`).
   * Defaults to the specification's own floor, so a caller that says nothing
   * still gets `external/02` behaviour.
   */
  datePrecision?: DatePrecision;
}

export interface SanitizeResult {
  dossier: Dossier;
  /** Identity facts lifted out; they belong to `index.json`. */
  hints: CatalogHints;
  /** Everything that was changed — a silent rewrite is indistinguishable from a bug. */
  notes: string[];
}

/** Metadata members that betray a document whose `metadata` wrapper went missing. */
const METADATA_MARKERS = new Set<string>([...METADATA_ORDER]);

export function emptyDossier(): Dossier {
  return { metadata: {}, media: { photos: [], music: [] }, documents: [] };
}

/**
 * Reads any JSON value and returns a conforming dossier plus what had to change.
 *
 * Deliberately never throws. The worst input — a string, an array, a version 1
 * document with its metadata at the root — yields an empty-but-valid dossier and
 * a note saying so, because a run over a corpus must not die on one bad file.
 */
export function sanitizeDossier(raw: unknown, options: DossierOptions): SanitizeResult {
  const notes: string[] = [];
  const hints: CatalogHints = {};

  if (!isObject(raw)) {
    return { dossier: emptyDossier(), hints, notes: ['Input was not a JSON object; produced an empty dossier.'] };
  }

  const root = structuredClone(raw) as Record<string, unknown>;
  liftIdentity(root, hints, notes);

  const metadata = recoverMetadata(root, notes);
  const clean: Dossier = {
    metadata: sanitizeMetadata(metadata, options, notes),
    media: sanitizeMedia(root['media'], options, notes),
    documents: sanitizeDocuments(root['documents'], options, notes),
  };

  // Unknown root members are preserved: that is what lets the format grow
  // additively without a version marker (`external/README` §6).
  for (const [key, value] of Object.entries(root)) {
    if (key === 'metadata' || key === 'media' || key === 'documents') continue;
    if (value === null || value === undefined) continue;
    clean[key] = value as never;
  }

  return { dossier: orderDossier(clean), hints, notes };
}

/**
 * Moves `title` / `type` / `gender` / `country` / `img` out of the document and
 * onto the hint channel, and drops the members version 2 withdrew outright.
 *
 * Swept from three places, because that is where they actually turn up: the
 * root (a version 1 document), `metadata` (a model that ignored the
 * instruction), and a `catalog` object (a model that followed it).
 */
function liftIdentity(root: Record<string, unknown>, hints: CatalogHints, notes: string[]): void {
  const metadata = isObject(root['metadata']) ? (root['metadata'] as Record<string, unknown>) : undefined;
  const catalog = isObject(root['catalog']) ? (root['catalog'] as Record<string, unknown>) : undefined;
  const containers = [metadata, root, catalog].filter(Boolean) as Array<Record<string, unknown>>;
  const removed: string[] = [];

  for (const field of FORBIDDEN_DOSSIER_MEMBERS) {
    for (const container of containers) {
      if (!(field in container)) continue;
      const value = container[field];
      delete container[field];
      if (container !== catalog) removed.push(field);
      assignHint(hints, field, value);
    }
  }
  delete root['catalog'];

  if (removed.length > 0) {
    notes.push(
      `Moved ${[...new Set(removed)].join(', ')} out of the dossier: version 2 puts identity in index.json (INV-7).`,
    );
  }
}

function assignHint(hints: CatalogHints, field: string, value: unknown): void {
  const raw = text(value);
  if (!raw) return;

  switch (field) {
    case 'title':
      hints.title = raw;
      break;
    case 'type': {
      const resolved = resolveEntryType(raw, true);
      if (resolved.type) hints.type = resolved.type;
      break;
    }
    case 'gender': {
      const gender = resolveGender(raw);
      if (gender) hints.gender = gender;
      break;
    }
    case 'country': {
      const country = resolveCountry(raw);
      if (country) hints.country = country;
      break;
    }
    case 'img': {
      const img = normalizeAssetPath(raw);
      if (img) hints.img = img;
      break;
    }
    default:
      // `id`, `bio` and `dataStatus` have no destination: an id is the index's
      // to assign, the prose belongs in the article, and `dataStatus` was
      // withdrawn with no replacement.
      break;
  }
}

/**
 * A document with no top-level `metadata` is not a dossier and a consumer
 * discards it whole. A *producer* that can see the metadata members sitting at
 * the root is in a better position: it re-wraps them, which is strictly better
 * than publishing a file the reader will throw away.
 */
function recoverMetadata(root: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  const declared = root['metadata'];
  if (isObject(declared)) return declared as Record<string, unknown>;

  const stray = Object.keys(root).filter((key) => METADATA_MARKERS.has(key));
  if (stray.length === 0) {
    if (declared !== undefined) notes.push('Replaced a non-object `metadata` member with an empty one.');
    return {};
  }

  const recovered: Record<string, unknown> = {};
  for (const key of stray) {
    recovered[key] = root[key];
    delete root[key];
  }
  notes.push(`Wrapped ${stray.length} stray root member(s) in \`metadata\` (INV-19): ${stray.join(', ')}.`);
  return recovered;
}

function sanitizeMetadata(
  raw: Record<string, unknown>,
  options: DossierOptions,
  notes: string[],
): EntryMeta {
  const meta: EntryMeta = {};

  for (const key of PROSE_KEYS) {
    const value = text(raw[key]);
    if (value) meta[key] = value;
  }

  for (const key of LIST_KEYS) {
    const value = normalizeListValue(raw[key], key, notes);
    if (value) meta[key] = value;
  }

  const dates = sanitizeDates(raw['dates'], options.datePrecision ?? 'day', notes);
  if (dates) meta.dates = dates;

  if (raw['ranking'] !== undefined && raw['ranking'] !== null) {
    const ranking = normalizeRanking(raw['ranking']);
    if (ranking === undefined) notes.push('Dropped a non-numeric ranking (INV-20).');
    else {
      if (ranking !== raw['ranking']) notes.push(`Normalized ranking ${String(raw['ranking'])} to ${ranking} (0–100).`);
      meta.ranking = ranking;
    }
  }

  const url = text(raw['url']);
  if (url) {
    const normalized = normalizeUrl(url);
    if (normalized) meta.url = normalized;
    else notes.push(`Dropped a non-absolute metadata.url "${url}" (VD-URL wants an absolute http(s) URL).`);
  }

  // Unknown members are retained and preserved on edit; only `null` is removed,
  // because the format has no nullable field.
  const known = new Set<string>([...METADATA_ORDER]);
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key) || value === null || value === undefined) continue;
    meta[key] = value;
  }

  void options;
  return meta;
}

/**
 * A list field is a comma-separated **string**. A JSON array is the single most
 * common way a model gets this wrong, and joining it is free and lossless.
 */
function normalizeListValue(value: unknown, key: string, notes: string[]): string | undefined {
  if (Array.isArray(value)) {
    const joined = value.filter((item): item is string => typeof item === 'string').join(',');
    const list = normalizeCsvList(joined);
    if (list) notes.push(`Joined the array in metadata.${key} into a comma list (VD-CSV-LIST).`);
    return list || undefined;
  }
  const raw = text(value);
  if (!raw) return undefined;
  return normalizeCsvList(raw) || undefined;
}

function sanitizeDates(
  raw: unknown,
  precision: DatePrecision,
  notes: string[],
): Record<string, string> | undefined {
  if (!isObject(raw)) return undefined;

  const dates: Record<string, string> = {};
  const dropped: string[] = [];

  for (const key of DATE_KEYS) {
    const value = text((raw as Record<string, unknown>)[key]);
    if (!value) continue;

    const normalized = normalizeDate(value, precision);
    if (!normalized) {
      dropped.push(`${key}="${value}"`);
      continue;
    }
    if (normalized !== value) {
      notes.push(`Rewrote dates.${key} "${value}" as "${normalized}" (VD-DATE, ${precision} precision).`);
    }
    dates[key] = normalized;
  }

  // `dates` has a closed member set; anything else there is not a date.
  const extra = Object.keys(raw).filter((key) => !(DATE_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) notes.push(`Dropped unknown \`dates\` member(s): ${extra.join(', ')}.`);

  if (dropped.length > 0) {
    notes.push(
      `Dropped unreadable date(s): ${dropped.join(', ')} — ` +
        `nothing at least as precise as a ${precision} could be read from them.`,
    );
  }
  return Object.keys(dates).length > 0 ? dates : undefined;
}

function sanitizeMedia(
  raw: unknown,
  options: DossierOptions,
  notes: string[],
): { photos: MediaItem[]; music: MediaItem[] } {
  const source = isObject(raw) ? (raw as Record<string, unknown>) : {};
  return {
    photos: sanitizeItems(source['photos'], options, notes, 'media.photos'),
    music: sanitizeItems(source['music'], options, notes, 'media.music'),
  };
}

function sanitizeItems(
  raw: unknown,
  options: DossierOptions,
  notes: string[],
  where: string,
): MediaItem[] {
  if (!Array.isArray(raw)) return [];

  const items: MediaItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const entry of raw) {
    if (!isObject(entry)) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const label = text(record['label']);
    const resolved = normalizeTarget(text(record['target']) ?? '', options.supportedLanguages);
    if (resolved.note) notes.push(resolved.note);

    if (!label || !resolved.target) {
      dropped += 1;
      continue;
    }
    // Array order is display order, so a duplicate target is a repeated item.
    if (seen.has(resolved.target)) continue;
    seen.add(resolved.target);

    const item: MediaItem = { label, target: resolved.target };
    for (const [key, value] of Object.entries(record)) {
      if (key === 'label' || key === 'target' || value === null || value === undefined) continue;
      item[key] = value;
    }
    items.push(item);
  }

  if (dropped > 0) notes.push(`Dropped ${dropped} ${where} item(s) missing a label or a target (INV-22).`);
  return items;
}

function sanitizeDocuments(raw: unknown, options: DossierOptions, notes: string[]): DocumentItem[] {
  if (!Array.isArray(raw)) return [];

  const items: DocumentItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const entry of raw) {
    if (!isObject(entry)) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const label = text(record['label']);
    const resolved = normalizeTarget(text(record['target']) ?? '', options.supportedLanguages);
    if (resolved.note) notes.push(resolved.note);

    if (!label || !resolved.target) {
      dropped += 1;
      continue;
    }
    if (seen.has(resolved.target)) continue;
    seen.add(resolved.target);

    const item: DocumentItem = { label, target: resolved.target };
    const type = text(record['type']);
    if (type) {
      const symbol = resolveDocumentType(type);
      if (symbol) {
        if (symbol !== type) notes.push(`Normalized documents type "${type}" to "${symbol}" (VD-ENUM-DOCTYPE).`);
        item.type = symbol;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'label' || key === 'target' || key === 'type' || value === null || value === undefined) continue;
      item[key] = value;
    }
    items.push(item);
  }

  if (dropped > 0) notes.push(`Dropped ${dropped} documents item(s) missing a label or a target (INV-22).`);
  return items;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export interface MergeResult {
  dossier: Dossier;
  /** Fields the incoming document supplied that the base did not have. */
  filled: string[];
  notes: string[];
}

/**
 * Completes `base` from `incoming` **without ever overwriting a present value**.
 *
 * That asymmetry is the point. The base is what is already on disk — hand
 * authored, or accepted in an earlier run — and `external/07` §7.2 treats it as
 * the authority. The incoming document is a fresh reading of the article, which
 * is a good source for a fact that is missing and a poor one for a fact someone
 * has already curated.
 *
 * List fields are unioned rather than skipped: a base that names two instruments
 * and an answer that names a third is not a conflict, it is an addition.
 */
export function mergeDossier(base: Dossier, incoming: Dossier, options: DossierOptions): MergeResult {
  const notes: string[] = [];
  const filled: string[] = [];
  const merged = structuredClone(base) as Dossier;
  merged.metadata ??= {};

  const listKeys = new Set<string>([...LIST_KEYS]);

  for (const [key, value] of Object.entries(incoming.metadata ?? {})) {
    if (value === null || value === undefined || value === '') continue;

    if (key === 'dates') {
      const before = Object.keys(merged.metadata.dates ?? {}).length;
      merged.metadata.dates = { ...(value as object), ...(merged.metadata.dates ?? {}) };
      const after = Object.keys(merged.metadata.dates).length;
      if (after > before) filled.push(`metadata.dates (+${after - before})`);

      // The one overwrite this function performs: `1893` and `21.02.1893` are
      // not two facts in conflict, they are one fact known to two depths.
      for (const [dateKey, incomingValue] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        const current = merged.metadata.dates?.[dateKey as keyof typeof merged.metadata.dates];
        if (typeof current !== 'string' || typeof incomingValue !== 'string') continue;
        if (!refinesDate(current, incomingValue)) continue;

        (merged.metadata.dates as Record<string, string>)[dateKey] = incomingValue;
        filled.push(`metadata.dates.${dateKey} (${current} → ${incomingValue})`);
        notes.push(`Sharpened dates.${dateKey} from "${current}" to "${incomingValue}".`);
      }
      continue;
    }

    const current = merged.metadata[key];
    if (listKeys.has(key) && typeof value === 'string' && typeof current === 'string' && current) {
      const union = mergeCsvLists(current, value);
      if (union !== current) filled.push(`metadata.${key}`);
      merged.metadata[key] = union;
      continue;
    }
    if (current === undefined || current === null || current === '') {
      merged.metadata[key] = value;
      filled.push(`metadata.${key}`);
    }
  }

  const photos = appendMissing(merged.media?.photos ?? [], incoming.media?.photos ?? []);
  const music = appendMissing(merged.media?.music ?? [], incoming.media?.music ?? []);
  const documents = appendMissing(merged.documents ?? [], incoming.documents ?? []);
  merged.media = { photos, music };
  merged.documents = documents;

  const added =
    photos.length +
    music.length +
    documents.length -
    ((base.media?.photos?.length ?? 0) + (base.media?.music?.length ?? 0) + (base.documents?.length ?? 0));
  if (added > 0) filled.push(`${added} media/document item(s)`);

  const sanitized = sanitizeDossier(merged, options);
  notes.push(...sanitized.notes);
  return { dossier: sanitized.dossier, filled, notes };
}

/** Appends only the items whose `target` the base does not already carry. */
function appendMissing<T extends { target: string }>(base: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(base.map((item) => item.target));
  const result = [...base];
  for (const item of incoming) {
    if (seen.has(item.target)) continue;
    seen.add(item.target);
    result.push(item);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ordering and inspection
// ---------------------------------------------------------------------------

/**
 * House member order: the three sections, then `metadata` in the order
 * `external/05` documents it. Object member order is semantically irrelevant
 * and a stable one keeps diffs legible — which matters because these files are
 * regenerated and reviewed by eye.
 */
export function orderDossier(dossier: Dossier): Dossier {
  const metadata: EntryMeta = {};
  for (const key of METADATA_ORDER) {
    const value = dossier.metadata?.[key];
    if (value !== undefined && value !== null) (metadata as Record<string, unknown>)[key] = value;
  }
  for (const [key, value] of Object.entries(dossier.metadata ?? {})) {
    if (key in metadata || value === null || value === undefined) continue;
    metadata[key] = value;
  }

  const ordered: Dossier = {
    metadata,
    media: {
      photos: dossier.media?.photos ?? [],
      music: dossier.media?.music ?? [],
    },
    documents: dossier.documents ?? [],
  };
  for (const [key, value] of Object.entries(dossier)) {
    if (key === 'metadata' || key === 'media' || key === 'documents') continue;
    if (value === null || value === undefined) continue;
    ordered[key] = value;
  }
  return ordered;
}

/** Which of the format's members a dossier actually carries, as dot paths. */
export function presentFields(dossier: Dossier): Set<string> {
  const present = new Set<string>();
  for (const [key, value] of Object.entries(dossier.metadata ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'dates' && isObject(value)) {
      for (const [dateKey, dateValue] of Object.entries(value as Record<string, unknown>)) {
        if (dateValue) present.add(`dates.${dateKey}`);
      }
      continue;
    }
    present.add(key);
  }
  if ((dossier.media?.photos?.length ?? 0) > 0) present.add('media.photos');
  if ((dossier.media?.music?.length ?? 0) > 0) present.add('media.music');
  if ((dossier.documents?.length ?? 0) > 0) present.add('documents');
  return present;
}

/** True when nothing but the empty scaffolding is left. */
export function isEmptyDossier(dossier: Dossier): boolean {
  return presentFields(dossier).size === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
