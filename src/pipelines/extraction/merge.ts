import type { MetadataDocument } from './MetadataContract.js';
import { emptyMetadata } from './MetadataContract.js';
import { normalizeList } from './normalize.js';

/**
 * Combines the per-chunk results of a chunked extraction.
 *
 * Two rules, because the fields fall into two kinds:
 *
 *  - **Scalars** — first non-empty value wins. Chunks arrive in document order,
 *    so that means "the earliest mention wins", which is what you want for an
 *    identity field a later passage may restate loosely.
 *  - **List fields** (`genres`, `instruments`, `bands`, … — the comma-separated
 *    ones the format guide describes) — **unioned**. First-wins is simply wrong
 *    here: the chunk that first mentions an instrument is not the chunk that
 *    mentions them all, and taking one chunk's list silently discards the rest
 *    of the article's.
 *
 * Arrays of media and documents are concatenated and de-duplicated by `target`.
 */
export function mergeMetadata(
  parts: readonly MetadataDocument[],
  listFields: readonly string[] = [],
): MetadataDocument {
  if (parts.length === 0) return emptyMetadata();
  if (parts.length === 1) return parts[0] ?? emptyMetadata();

  const result = emptyMetadata();
  const unionKeys = new Set(
    listFields
      .filter((path) => path.startsWith('metadata.'))
      .map((path) => path.slice('metadata.'.length))
      .filter((key) => !key.includes('.')),
  );

  for (const part of parts) {
    mergeScalars(result.metadata as Record<string, unknown>, part.metadata as Record<string, unknown>, unionKeys);
    result.media.photos = dedupeByTarget([...result.media.photos, ...(part.media?.photos ?? [])]);
    result.media.music = dedupeByTarget([...result.media.music, ...(part.media?.music ?? [])]);
    result.documents = dedupeByTarget([...result.documents, ...(part.documents ?? [])]);
  }
  return result;
}

function mergeScalars(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  unionKeys: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (isEmpty(value)) continue;

    const current = target[key];
    if (unionKeys.has(key) && typeof value === 'string') {
      target[key] = normalizeList(typeof current === 'string' && current ? `${current},${value}` : value);
      continue;
    }
    if (isEmpty(current)) {
      target[key] = value;
      continue;
    }
    if (isPlainObject(current) && isPlainObject(value)) {
      mergeScalars(current, value, unionKeys);
    }
  }
}

function dedupeByTarget<T extends { target: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.target)) return false;
    seen.add(item.target);
    return true;
  });
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Dot-path lookup used by `tasks.extract.requiredFields`. */
export function hasField(document: MetadataDocument, path: string): boolean {
  const value = path.split('.').reduce<unknown>((node, key) => {
    if (!isPlainObject(node)) return undefined;
    return node[key];
  }, document as unknown);
  return !isEmpty(value);
}
