import type { MetadataDocument } from './MetadataContract.js';
import { emptyMetadata } from './MetadataContract.js';

/**
 * Combines the per-chunk results of a chunked extraction.
 *
 * Rule: first non-empty value wins for scalars, arrays are concatenated and
 * de-duplicated by `target`. Chunks are processed in document order, so "first
 * wins" means "the earliest mention in the article wins" — which is what you
 * want for identity fields that a later passage may restate loosely.
 *
 * TODO(domain): the format guide treats several fields as comma-separated lists
 * (`genres`, `instruments`, `bands`, …). Those should be *unioned* across
 * chunks rather than taken from the first chunk that mentions any of them.
 */
export function mergeMetadata(parts: readonly MetadataDocument[]): MetadataDocument {
  if (parts.length === 0) return emptyMetadata();
  if (parts.length === 1) return parts[0] ?? emptyMetadata();

  const result = emptyMetadata();

  for (const part of parts) {
    mergeScalars(result.metadata as Record<string, unknown>, part.metadata as Record<string, unknown>);
    result.media.photos = dedupeByTarget([...result.media.photos, ...(part.media?.photos ?? [])]);
    result.media.music = dedupeByTarget([...result.media.music, ...(part.media?.music ?? [])]);
    result.documents = dedupeByTarget([...result.documents, ...(part.documents ?? [])]);
  }
  return result;
}

function mergeScalars(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isEmpty(value)) continue;

    const current = target[key];
    if (isEmpty(current)) {
      target[key] = value;
      continue;
    }
    if (isPlainObject(current) && isPlainObject(value)) {
      mergeScalars(current, value);
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
