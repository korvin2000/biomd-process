import { createHash } from 'node:crypto';

/** Full sha256 hex digest of a string. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Short, collision-resistant-enough digest for ids that humans read
 * (task ids, fingerprints, config hashes).
 */
export function shortHash(input: string, length = 12): string {
  return sha256(input).slice(0, length);
}

/**
 * Hash of a structured value with key order normalized, so that
 * semantically identical objects always produce the same digest.
 */
export function hashStructure(value: unknown, length = 12): string {
  return shortHash(stableStringify(value), length);
}

/** Deterministic JSON: object keys sorted, arrays kept in order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const normalized = normalize(source[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}
