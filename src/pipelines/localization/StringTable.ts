import { shortHash } from '../../shared/hash.js';
import type { JsonValue } from '../../shared/json.js';

/**
 * Content-addressed extraction of the translatable strings in a dossier.
 *
 * The model never sees the JSON. It receives a flat `{key: text}` table and
 * returns `{key: translation}`; the document is rebuilt locally by walking the
 * original again and substituting by key. Three things fall out of that:
 *
 *  - **Cost.** Structure, invariant fields, URLs and paths are never sent.
 *    Measured on `examples/ru`, the payload is ~52% smaller than the dossier
 *    file, and deduplication removes a further ~18% across seven entries.
 *  - **Correctness by construction.** `dates`, `ranking`, `url`, every media
 *    `target` and every unknown field are copied from the source, so a model
 *    cannot rewrite them however badly it misbehaves.
 *  - **Deduplication.** The key *is* the hash of the source text, so a string
 *    that appears twice — in one dossier or across the whole corpus — is
 *    translated once. See {@link TranslationMemory}.
 */

export interface LocalizationOptions {
  /**
   * Dot-path patterns whose string values are translated. `*` matches one
   * segment, which is how array elements are addressed (`documents.*.label`).
   * Anything not matched here is copied verbatim — an allowlist, because the
   * format guide requires unknown fields to be preserved, not guessed at.
   */
  localizable: readonly string[];
  /**
   * Patterns whose value is a comma-separated list. Their items are extracted
   * individually, which both dedupes them corpus-wide (`Guitarist` occurs in
   * every dossier) and stops a model from re-punctuating the list.
   */
  listFields: readonly string[];
}

export interface LocalizationUnit {
  /** Short hash of the source text — stable across documents and runs. */
  key: string;
  text: string;
  /** Where it occurs, for diagnostics only. */
  paths: string[];
}

export function keyOf(text: string): string {
  return shortHash(text.trim(), 8);
}

/** Deduped translatable strings, in first-appearance order. */
export function collectUnits(document: JsonValue, options: LocalizationOptions): LocalizationUnit[] {
  const units = new Map<string, LocalizationUnit>();

  walk(document, [], options, (text, path) => {
    const trimmed = text.trim();
    if (trimmed === '') return;

    const key = keyOf(trimmed);
    const existing = units.get(key);
    if (existing) existing.paths.push(path);
    else units.set(key, { key, text: trimmed, paths: [path] });
  });

  return [...units.values()];
}

/**
 * Rebuilds the document with translated values.
 *
 * A key with no translation keeps its source text: a partially answered batch
 * degrades to a partially localized edition rather than to a hole.
 */
export function applyUnits(
  document: JsonValue,
  options: LocalizationOptions,
  translations: ReadonlyMap<string, string>,
): JsonValue {
  return transform(document, [], options, (text) => {
    const trimmed = text.trim();
    if (trimmed === '') return text;
    return translations.get(keyOf(trimmed)) ?? text;
  });
}

/** Keys that were requested but not answered — the validator's input. */
export function missingKeys(units: readonly LocalizationUnit[], translations: ReadonlyMap<string, string>): string[] {
  return units.filter((unit) => !translations.has(unit.key)).map((unit) => unit.key);
}

// ---------------------------------------------------------------------------

type Visitor = (text: string, path: string) => void;
type Mapper = (text: string) => string;

function walk(node: JsonValue, path: string[], options: LocalizationOptions, visit: Visitor): void {
  if (typeof node === 'string') {
    const pointer = path.join('.');
    if (!matchesAny(pointer, options.localizable)) return;

    if (matchesAny(pointer, options.listFields)) {
      for (const item of splitList(node)) visit(item, pointer);
    } else {
      visit(node, pointer);
    }
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, [...path, String(index)], options, visit));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walk(value, [...path, key], options, visit);
  }
}

function transform(node: JsonValue, path: string[], options: LocalizationOptions, map: Mapper): JsonValue {
  if (typeof node === 'string') {
    const pointer = path.join('.');
    if (!matchesAny(pointer, options.localizable)) return node;

    if (matchesAny(pointer, options.listFields)) {
      const items = splitList(node);
      return items.length > 0 ? items.map(map).join(',') : node;
    }
    return map(node);
  }

  if (Array.isArray(node)) {
    return node.map((item, index) => transform(item, [...path, String(index)], options, map));
  }
  if (node && typeof node === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = transform(value, [...path, key], options, map);
    }
    return result;
  }
  return node;
}

/** `*` matches exactly one path segment, so `documents.*.label` is array-safe. */
function matchesAny(pointer: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matches(pointer, pattern));
}

function matches(pointer: string, pattern: string): boolean {
  const target = pointer.split('.');
  const parts = pattern.split('.');
  if (target.length !== parts.length) return false;
  return parts.every((part, index) => part === '*' || part === target[index]);
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
