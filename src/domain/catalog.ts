/**
 * `index.json` and `index-<lang>.json` as data structures that can be *edited*.
 *
 * The distinction matters more than it sounds. A catalogue index is not the
 * output of a run — it is a document that outlives every run, carries ids that
 * must be stable forever, and may have been hand-edited between two of them.
 * Rebuilding it from whatever the current run happened to process is the single
 * most destructive thing a producer can do to this format:
 *
 *  - a run over a subset (`--limit`, one new article) would delete every row it
 *    did not visit, and with them every id;
 *  - a renumbered id silently detaches every localized name, and nothing
 *    reports an error — the names simply fall back to the Latin `title`;
 *  - a hand-authored alias, a curated `img`, an unknown member added by a later
 *    version of the format: all gone.
 *
 * So both files are **merged**, never regenerated. Existing rows survive
 * untouched unless this run has something better to say about them; new rows are
 * appended; ids come from an allocator that only ever counts upward.
 */

import { resolveCountry } from './countries.js';
import { ROW_ORDER, type EntryRow, type NameIndex } from './types.js';
import { ID_PATTERN, isValidSlug, normalizeAssetPath, normalizeContentPath, normalizeId, slugOf, text } from './values.js';
import { resolveEntryType, resolveGender, resolveLanguage } from './vocabulary.js';

export interface CatalogOptions {
  supportedLanguages: readonly string[];
  /** `type` for an entry nothing else classified. */
  defaultType: string;
  /** `type` for an article-only entry (no dossier) nothing else classified. */
  defaultPageType: string;
  /** Keep a craft outside the established vocabulary rather than dropping it. */
  allowUnknownTypes?: boolean;
}

/** What a run has learned about one entry. Everything but `slug`/`md` is advisory. */
export interface RowUpdate {
  slug: string;
  /** VD-PATH-CONTENT, root-relative, no language directory. */
  md: string;
  /** Present ⟺ the entry is a biography. Only ever added, never removed. */
  json?: string;
  /** Editions verified to exist on disk, the original language first. */
  verifiedLanguages: readonly string[];
  /** Languages this run actually looked for; anything else is left alone. */
  checkedLanguages: readonly string[];
  /** Derived classification. Never overwrites a value the index already has. */
  title?: string;
  type?: string;
  gender?: string;
  country?: string;
  img?: string;
}

export interface UpsertResult {
  row: EntryRow;
  created: boolean;
  notes: string[];
}

/**
 * A loaded `index.json` that can be updated row by row.
 *
 * Row order is the catalogue's display order, so existing rows keep their
 * positions and new ones are appended — a re-run must not reshuffle the grid.
 */
export class CatalogIndex {
  private readonly rows: EntryRow[] = [];
  private readonly bySlug = new Map<string, EntryRow>();
  /** Every id ever seen, including one a skipped row carried: ids are never reused. */
  private readonly usedIds = new Set<string>();
  /** Ids actually attached to a surviving row — what a duplicate is measured against. */
  private readonly placedIds = new Set<string>();
  private nextId = 1;
  readonly loadNotes: string[] = [];

  private constructor(private readonly options: CatalogOptions) {}

  /**
   * Reads an existing index, keeping every row it can and reporting the rest.
   *
   * The disposition rules are the consumer's own (`external/03` §3.5): a row
   * without a usable `id` or `md` cannot be joined or routed and is dropped; a
   * duplicate `id` or slug keeps the **first** occurrence. Applying them here
   * means the file this tool writes is one the reader will accept in full.
   */
  static load(raw: unknown, options: CatalogOptions): CatalogIndex {
    const index = new CatalogIndex(options);
    if (raw === undefined || raw === null) return index;

    if (!Array.isArray(raw)) {
      index.loadNotes.push('Existing index.json was not an array; starting a new catalogue.');
      return index;
    }

    for (const [position, entry] of raw.entries()) {
      if (!isObject(entry)) {
        index.loadNotes.push(`Row ${position} was not an object; skipped.`);
        continue;
      }
      const row = entry as EntryRow;
      const id = normalizeId(row['id']);
      const md = text(row['md']);

      if (!id) {
        index.loadNotes.push(`Row ${position} has no usable id; skipped (a consumer would skip it too).`);
        continue;
      }
      // Even a rejected row's id is retired: ids are never reused, "not even
      // after the row is deleted".
      index.reserve(id);

      if (!md) {
        index.loadNotes.push(`Row ${position} (id ${id}) has no md path; skipped.`);
        continue;
      }
      if (index.placedIds.has(id)) {
        index.loadNotes.push(`Row ${position} duplicates id ${id}; kept the first occurrence (INV-1).`);
        continue;
      }

      const slug = slugOf(md);
      if (index.bySlug.has(slug)) {
        index.loadNotes.push(`Row ${position} duplicates slug "${slug}"; kept the first occurrence (INV-3).`);
        continue;
      }

      const normalized = index.normalizeRow({ ...row, id, md }, index.loadNotes);
      index.rows.push(normalized);
      index.bySlug.set(slug, normalized);
      index.placedIds.add(id);
    }
    return index;
  }

  /** Adds or updates the row for one entry, preserving everything already there. */
  upsert(update: RowUpdate): UpsertResult {
    const notes: string[] = [];
    const existing = this.bySlug.get(update.slug);

    if (existing) {
      this.applyUpdate(existing, update, notes);
      return { row: existing, created: false, notes };
    }

    const row: EntryRow = {
      id: this.allocateId(),
      title: text(update.title) ?? update.slug,
      type: this.resolveType(update, notes),
      md: normalizeContentPath(update.md) ?? update.md,
    };
    this.applyUpdate(row, update, notes);

    this.rows.push(row);
    this.bySlug.set(update.slug, row);
    this.placedIds.add(row.id);
    return { row, created: true, notes };
  }

  /**
   * Row-level updates, all of them one-directional.
   *
   * `lang` is the only field this run is authoritative about, and even there it
   * only overrides codes it actually checked: a language outside the run's
   * configuration stays declared, because "not looked for" is not "not there".
   */
  private applyUpdate(row: EntryRow, update: RowUpdate, notes: string[]): void {
    const md = normalizeContentPath(update.md);
    if (md && row.md !== md) row.md = md;

    if (update.json) {
      const json = normalizeContentPath(update.json);
      if (json && !row.json) row.json = json;
    }

    const lang = this.mergeLanguages(row, update, notes);
    if (lang) row.lang = lang;

    // Classification: the index wins, then what this run derived. A row may
    // have been hand-edited, so nothing derived overwrites it.
    if (!text(row.title) && update.title) row.title = update.title;
    if (!text(row.type)) row.type = this.resolveType(update, notes);

    if (!text(row.gender) && update.gender) {
      const gender = resolveGender(update.gender);
      if (gender) row.gender = gender;
    }
    if (!text(row.country) && update.country) {
      const country = resolveCountry(update.country);
      if (country) row.country = country;
    }
    if (!text(row.img) && update.img) {
      const img = normalizeAssetPath(update.img);
      if (img) row.img = img;
    }
  }

  /**
   * The editions this entry declares.
   *
   * Union of what survived checking and what was never checked, with the
   * original language pinned first — order is significant, and the first code is
   * the edition every reader without their own falls back to.
   */
  private mergeLanguages(row: EntryRow, update: RowUpdate, notes: string[]): string | undefined {
    const verified = update.verifiedLanguages.filter((code) => this.options.supportedLanguages.includes(code));
    if (verified.length === 0) return text(row.lang);

    const declared = splitLanguages(text(row.lang) ?? '', this.options.supportedLanguages);
    const checked = new Set(update.checkedLanguages);
    const original = verified[0] as string;

    const kept = declared.filter((code) => code !== original && (!checked.has(code) || verified.includes(code)));
    const added = verified.filter((code) => code !== original && !declared.includes(code));
    const dropped = declared.filter((code) => checked.has(code) && !verified.includes(code));

    if (dropped.length > 0) {
      notes.push(
        `${update.slug}: dropped declared edition(s) ${dropped.join(', ')} — the files are not on disk (INV-8).`,
      );
    }
    return [original, ...kept, ...added].join(',');
  }

  private resolveType(update: RowUpdate, notes: string[]): string {
    const raw = text(update.type);
    if (raw) {
      const resolved = resolveEntryType(raw, this.options.allowUnknownTypes ?? false);
      if (resolved.note) notes.push(`${update.slug}: ${resolved.note}`);
      if (resolved.type) return resolved.type;
    }
    // An article-only entry is technical content far more often than it is an
    // unclassified musician, and `hidden` keeps it out of the grid and facets.
    return update.json ? this.options.defaultType : this.options.defaultPageType;
  }

  /** Normalizes a row read from disk without discarding anything unknown. */
  private normalizeRow(row: EntryRow, notes: string[]): EntryRow {
    const clean: EntryRow = { ...row };

    clean.title = text(row.title) ?? slugOf(row.md);
    const type = text(row.type);
    if (type) {
      const resolved = resolveEntryType(type, true);
      clean.type = resolved.type ?? type.toLowerCase();
    } else {
      clean.type = row.json ? this.options.defaultType : this.options.defaultPageType;
      notes.push(`Row ${clean.id} had no type; defaulted to "${clean.type}".`);
    }

    const md = normalizeContentPath(row.md);
    if (md) clean.md = md;
    const json = text(row.json);
    if (json) {
      const normalized = normalizeContentPath(json);
      if (normalized) clean.json = normalized;
      else delete clean.json;
    } else {
      delete clean.json;
    }

    const gender = text(row.gender) ? resolveGender(String(row.gender)) : undefined;
    if (gender) clean.gender = gender;
    else delete clean.gender;

    const country = text(row.country) ? resolveCountry(String(row.country)) : undefined;
    if (country) clean.country = country;
    else delete clean.country;

    const img = text(row.img) ? normalizeAssetPath(String(row.img)) : undefined;
    if (img) clean.img = img;
    else delete clean.img;

    const lang = splitLanguages(text(row.lang) ?? '', this.options.supportedLanguages);
    if (lang.length > 0) clean.lang = lang.join(',');
    else delete clean.lang;

    return clean;
  }

  /**
   * The next id: one above the highest ever seen, never a gap left by a deleted
   * row. Gaps are correct — reusing one attaches a new entry to a retired
   * entry's localized names.
   */
  private allocateId(): string {
    while (this.usedIds.has(String(this.nextId))) this.nextId += 1;
    const id = String(this.nextId);
    this.reserve(id);
    return id;
  }

  private reserve(id: string): void {
    this.usedIds.add(id);
    if (ID_PATTERN.test(id)) {
      const numeric = Number(id);
      if (Number.isSafeInteger(numeric) && numeric >= this.nextId) this.nextId = numeric + 1;
    }
  }

  /** Every row, in display order, with members in the house order. */
  toArray(): EntryRow[] {
    return this.rows.map(orderRow);
  }

  size(): number {
    return this.rows.length;
  }

  idOf(slug: string): string | undefined {
    return this.bySlug.get(slug)?.id;
  }

  rowOf(slug: string): EntryRow | undefined {
    return this.bySlug.get(slug);
  }

  /** Every id currently in the index — the set a name index may key on. */
  ids(): Set<string> {
    return new Set(this.rows.map((row) => row.id));
  }
}

/** Identity, then classification, then paths — the order `external/03` §3.3 asks for. */
export function orderRow(row: EntryRow): EntryRow {
  const ordered: EntryRow = {} as EntryRow;
  for (const key of ROW_ORDER) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') ordered[key] = value;
  }
  for (const [key, value] of Object.entries(row)) {
    if (key in ordered || value === null || value === undefined) continue;
    ordered[key] = value;
  }
  return ordered;
}

/** `"ru, de,ru"` → `["ru", "de"]`, unsupported codes dropped, no repeats. */
export function splitLanguages(value: string, supported: readonly string[]): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];

  for (const part of value.split(',')) {
    const code = resolveLanguage(part, supported);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

// ---------------------------------------------------------------------------
// index-<lang>.json
// ---------------------------------------------------------------------------

export interface NameMergeOptions {
  /** `title` per id, used to drop an entry that would only repeat it (`INV-14`). */
  titles: ReadonlyMap<string, string>;
  /** Ids that exist in `index.json`; a key outside it is kept but reported. */
  knownIds: ReadonlySet<string>;
}

export interface NameMergeResult {
  index: NameIndex;
  notes: string[];
  /** True when the merge changed nothing — the file need not be rewritten. */
  unchanged: boolean;
}

/**
 * Merges derived display names into an existing `index-<lang>.json`.
 *
 * Element `[0]` of an existing entry is never replaced: it is the one string a
 * reader actually sees, it is the field an editor is most likely to have
 * corrected by hand, and a machine-composed `forename + " " + surname` is a
 * weaker source than a person. Derived aliases are appended when they are new,
 * because an alias is pure upside — it is never rendered and only ever makes the
 * entry findable.
 *
 * Nothing is ever deleted. A key this run did not visit belongs to an entry this
 * run did not process, not to an entry that stopped existing.
 */
export function mergeNameIndex(
  existing: unknown,
  derived: ReadonlyMap<string, readonly string[]>,
  options: NameMergeOptions,
): NameMergeResult {
  const notes: string[] = [];
  const index: NameIndex = {};
  let changed = false;

  const source = isObject(existing) ? (existing as Record<string, unknown>) : {};
  if (existing !== undefined && existing !== null && !isObject(existing)) {
    notes.push('Existing name index was not an object; started a new one.');
    changed = true;
  }

  for (const [key, value] of Object.entries(source)) {
    const id = normalizeId(key);
    if (!id) {
      notes.push(`Dropped name-index key "${key}": not a valid id (INV-2).`);
      changed = true;
      continue;
    }
    const names = usableNames(value);
    if (names.length === 0) {
      notes.push(`Dropped name-index entry "${key}": no usable names left (INV-13).`);
      changed = true;
      continue;
    }
    if (id !== key) changed = true;
    if (!options.knownIds.has(id) && options.knownIds.size > 0) {
      notes.push(`Name-index key "${id}" matches no row in index.json (INV-12); kept, but it is never looked up.`);
    }
    index[id] = names;
  }

  for (const [id, names] of derived) {
    const usable = usableNames(names);
    if (usable.length === 0) continue;

    const current = index[id];
    if (!current) {
      // A lone name identical to the Latin title is dead weight: the fallback
      // chain produces exactly the same string.
      if (usable.length === 1 && foldName(usable[0] ?? '') === foldName(options.titles.get(id) ?? '')) continue;
      index[id] = usable;
      changed = true;
      continue;
    }

    const merged = appendAliases(current, usable.slice(1));
    if (merged.length !== current.length) {
      index[id] = merged;
      changed = true;
    }
  }

  return { index: sortByNumericId(index), notes, unchanged: !changed };
}

/** Non-empty strings only, trimmed, deduplicated case-insensitively. */
function usableNames(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set<string>();
  const names: string[] = [];

  for (const item of items) {
    const name = text(item);
    if (!name) continue;
    const fold = foldName(name);
    if (seen.has(fold)) continue;
    seen.add(fold);
    names.push(name);
  }
  return names;
}

function appendAliases(current: readonly string[], aliases: readonly string[]): string[] {
  const seen = new Set(current.map(foldName));
  const result = [...current];
  for (const alias of aliases) {
    const fold = foldName(alias);
    // An alias of one or two characters matches nearly everything and degrades
    // ranking catalogue-wide (`INV-28`).
    if (seen.has(fold) || alias.trim().length < 3) continue;
    seen.add(fold);
    result.push(alias);
  }
  return result;
}

export function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function sortByNumericId(index: NameIndex): NameIndex {
  return Object.fromEntries(
    Object.entries(index).sort(([a], [b]) => (Number(a) || 0) - (Number(b) || 0)),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { isValidSlug };
