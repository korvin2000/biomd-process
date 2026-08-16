/**
 * Reading a web-search answer, and refusing most of it.
 *
 * A model with search is a different risk profile from a model reading an
 * article: the article is the thing being catalogued, so a fact extracted from
 * it is at worst a misreading, while a fact from the open web can be about a
 * different person entirely — the wrong John Williams, a namesake, a fan page
 * that guessed. The defences, in order of how much they actually catch:
 *
 *  1. **Every value goes through the same domain normalizer as an extraction.**
 *     A date that is not a date, a country that is not a country and a URL that
 *     is not absolute never reach the dossier, regardless of how confident the
 *     answer sounded.
 *  2. **A source is required.** A claim with no URL behind it is an assertion
 *     from memory, which is precisely what this task exists to avoid.
 *  3. **Confidence is a floor, not a weight.** Below it the value is dropped
 *     whole; above it, it is treated exactly like any other.
 *  4. **Death is asked as a status, never inferred from silence.** "No evidence
 *     of death" must not become a date, and a model that answers `alive` is
 *     recorded as having answered, not as having failed.
 */

import { resolveCountry } from '../../domain/countries.js';
import { normalizeDate, normalizeUrl, refinesDate, text, type DatePrecision } from '../../domain/values.js';
import { extractJsonBlock, safeJsonParse } from '../../shared/json.js';
import type { WebField } from './gaps.js';

export type LivenessStatus = 'alive' | 'dead' | 'unknown';

export interface WebValue {
  field: WebField;
  value: string;
  source?: string;
  confidence: number;
}

export interface WebAnswer {
  values: WebValue[];
  status?: LivenessStatus;
  /** Everything dropped, and why — the run log's account of what was refused. */
  rejected: string[];
}

export interface AnswerOptions {
  asked: readonly WebField[];
  datePrecision: DatePrecision;
  requireSource: boolean;
  minConfidence: number;
  /** Values already held, so a "refinement" that contradicts them is refused. */
  current?: Partial<Record<WebField, string>>;
}

/**
 * Parses `{field: {value, source, confidence}}` — and the three other shapes a
 * model reaches for, because each one costs a whole round trip to re-ask.
 */
export function parseWebAnswer(raw: string, options: AnswerOptions): WebAnswer | undefined {
  const parsed = safeJsonParse<unknown>(extractJsonBlock(raw) ?? raw);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return undefined;
  }

  const root = parsed.value as Record<string, unknown>;
  const values: WebValue[] = [];
  const rejected: string[] = [];

  for (const field of options.asked) {
    const entry = readEntry(root, field);
    if (!entry) continue;

    const verdict = accept(field, entry, options);
    if ('reason' in verdict) {
      rejected.push(`${field}: ${verdict.reason}`);
      continue;
    }
    values.push(verdict.value);
  }

  const status = readStatus(root);
  return { values, rejected, ...(status ? { status } : {}) };
}

interface RawEntry {
  value: string;
  source?: string;
  confidence?: number;
}

/**
 * One field's answer, from a nested object, from a flat value, or from the
 * `field_source` / `field_confidence` sidecar keys models like to invent.
 */
function readEntry(root: Record<string, unknown>, field: string): RawEntry | undefined {
  const direct = root[field];

  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    const record = direct as Record<string, unknown>;
    return entry(
      text(record['value'] ?? record['answer'] ?? record['text']),
      text(record['source'] ?? record['url'] ?? record['reference']),
      numberOf(record['confidence'] ?? record['certainty']),
    );
  }

  return entry(
    text(direct),
    text(root[`${field}_source`] ?? root[`${field}Source`]),
    numberOf(root[`${field}_confidence`] ?? root[`${field}Confidence`]),
  );
}

function entry(value: string | undefined, source: string | undefined, confidence: number | undefined): RawEntry | undefined {
  if (!value) return undefined;
  return {
    value,
    ...(source ? { source } : {}),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function readStatus(root: Record<string, unknown>): LivenessStatus | undefined {
  const raw = (text(root['status']) ?? text(root['liveness']) ?? '').toLowerCase();
  if (/^(alive|living|жив)/.test(raw)) return 'alive';
  if (/^(dead|deceased|died|умер)/.test(raw)) return 'dead';
  if (raw) return 'unknown';
  return undefined;
}

type Verdict = { value: WebValue } | { reason: string };

function accept(field: WebField, entry: RawEntry, options: AnswerOptions): Verdict {
  const confidence = entry.confidence ?? 1;
  if (confidence < options.minConfidence) {
    return { reason: `confidence ${confidence.toFixed(2)} is below ${options.minConfidence.toFixed(2)}` };
  }

  const source = entry.source ? normalizeUrl(entry.source) : undefined;
  if (options.requireSource && !source) {
    return { reason: `no usable source URL (${entry.source ?? 'none given'})` };
  }

  const value = normalizeValue(field, entry.value, options.datePrecision);
  if (!value) return { reason: `"${entry.value}" is not a usable ${field}` };

  const current = options.current?.[field];
  if (current && current !== value && !refines(field, current, value)) {
    return { reason: `"${value}" contradicts the "${current}" already on record` };
  }

  return {
    value: { field, value, confidence, ...(source ? { source } : {}) },
  };
}

function normalizeValue(field: WebField, raw: string, datePrecision: DatePrecision): string | undefined {
  switch (field) {
    case 'born':
    case 'died':
      return normalizeDate(raw, datePrecision);
    case 'country':
      return resolveCountry(raw);
    case 'url':
      return normalizeUrl(raw);
    default: {
      const value = text(raw);
      // A place is two or three words; a sentence is the model explaining
      // itself into a field a reader renders as a caption.
      return value && value.length <= 120 ? value : undefined;
    }
  }
}

function refines(field: WebField, current: string, candidate: string): boolean {
  return (field === 'born' || field === 'died') && refinesDate(current, candidate);
}

function numberOf(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : undefined;
}
