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

import { countryName, resolveCountry } from '../../domain/countries.js';
import { normalizeDate, normalizeUrl, refinesDate, text, type DatePrecision } from '../../domain/values.js';
import { extractJsonBlock, safeJsonParse } from '../../shared/json.js';
import type { WebField } from './gaps.js';

export type LivenessStatus = 'alive' | 'dead' | 'unknown';

export interface WebValue {
  field: WebField;
  value: string;
  source?: string;
  confidence: number;
  /**
   * The value already on record that this one disagrees with.
   *
   * Set only for a date, and only when the disagreement is real — a sharper
   * reading of the same date (`1893` → `21.02.1893`) is not a conflict and
   * arrives without it. Carrying the value instead of dropping it here is the
   * point: whether "born about 1950" or a cited `25.07.1949` wins is a question
   * about which source to trust, and this module knows nothing about that.
   * {@link WebSearchTaskConfig.onDateConflict} decides, and says so out loud.
   */
  conflictsWith?: string;
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
  /**
   * The language of the edition this answer completes.
   *
   * The dossier being written is `out/<lang>/<slug>.bio.json`, so a prose value
   * belongs in that language. The prompt asks for it; this is what the reader
   * can still repair when the answer arrives in another form.
   */
  language?: string;
  /**
   * This entry's country, when `index.json` or an earlier task already knows
   * it. Only used to disambiguate a code inside a place — see
   * {@link normalizePlace}. When it is absent the answer's own `country` is
   * used, and when that is absent too, no place is rewritten.
   */
  country?: string;
  /**
   * Provider-reported consulted URLs, already reduced with `sourceKey`. Compared
   * against the model's own citation only when `requireVerifiedSource` is on.
   */
  verifiedSources?: ReadonlySet<string>;
  /** Reject model-authored URLs absent from provider search evidence. */
  requireVerifiedSource?: boolean;
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

  // Resolved before the loop, because a place is read against it and `country`
  // comes after `birthplace` in the field order.
  const context: AnswerOptions = { ...options, country: options.country ?? countryIn(root) };

  for (const field of options.asked) {
    const entry = readEntry(root, field);
    if (!entry) continue;

    const verdict = accept(field, entry, context);
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

/** The country this same answer reports, whatever shape it reported it in. */
function countryIn(root: Record<string, unknown>): string | undefined {
  const entry = readEntry(root, 'country');
  return entry ? resolveCountry(entry.value) : undefined;
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
  if (entry.confidence === undefined) return { reason: 'confidence is missing' };
  const confidence = entry.confidence;
  if (confidence < options.minConfidence) {
    return { reason: `confidence ${confidence.toFixed(2)} is below ${options.minConfidence.toFixed(2)}` };
  }

  const source = entry.source ? normalizeUrl(entry.source) : undefined;
  if (options.requireSource && !source) {
    return { reason: `no usable source URL (${entry.source ?? 'none given'})` };
  }
  if (source && options.requireVerifiedSource && !options.verifiedSources?.has(sourceKey(source))) {
    return { reason: `source URL was not present in provider web-search evidence (${source})` };
  }

  const value = normalizeValue(field, entry.value, options);
  if (!value) return { reason: `"${entry.value}" is not a usable ${field}` };

  const current = options.current?.[field];
  const contradicts = Boolean(current && current !== value && !refines(field, current, value));

  // A date that disagrees is reported, not discarded: an article that says
  // "born about 1950" and a cited `25.07.1949` are a fact worth surfacing, and
  // the caller is the only place that knows which one this deployment trusts.
  // Every other field keeps the strict rule — a birthplace that contradicts the
  // article is a different person far more often than it is a correction.
  if (contradicts && !isDateField(field)) {
    return { reason: `"${value}" contradicts the "${String(current)}" already on record` };
  }

  return {
    value: {
      field,
      value,
      confidence,
      ...(source ? { source } : {}),
      ...(contradicts && current ? { conflictsWith: current } : {}),
    },
  };
}

function isDateField(field: WebField): boolean {
  return field === 'born' || field === 'died';
}

function normalizeValue(field: WebField, raw: string, options: AnswerOptions): string | undefined {
  switch (field) {
    case 'born':
    case 'died':
      return normalizeDate(raw, options.datePrecision);
    case 'country':
      return resolveCountry(raw);
    case 'url':
      return normalizeUrl(raw);
    default:
      return normalizePlace(raw, {
        ...(options.language ? { language: options.language } : {}),
        ...(options.country ? { country: options.country } : {}),
      });
  }
}

/** A place is two or three words; a sentence is the model explaining itself. */
const PLACE_MAX_CHARS = 120;

export interface PlaceOptions {
  /** The edition's language — the one the name is spelled back out in. */
  language?: string;
  /** This entry's country, when it is known. See {@link normalizePlace}. */
  country?: string;
}

/**
 * A place, with a country **code** inside it spelled back out as a word.
 *
 * `"Melbourne, au"` is what a search model writes once it has been told that
 * countries are ISO 3166-1 alpha-2 — the rule belongs to the `country` key, and
 * the model applies it to every country-shaped thing it produces. The result is
 * published verbatim into a prose field and then *translated* by `localize`,
 * which faithfully carries `au` into every edition.
 *
 * The repair only fires when the code is **unambiguous**, because a two-letter
 * token after a city name is very often not a country at all:
 *
 * | | | |
 * |---|---|---|
 * | `Nashville, TN` | Tennessee | not Tunisia |
 * | `Adelaide, SA`  | South Australia | not Saudi Arabia |
 * | `Recife, PE`    | Pernambuco | not Peru |
 * | `Los Angeles, CA` | California | not Canada |
 *
 * So alpha-3 (`AUS`) is expanded on sight — no subnational scheme collides with
 * it — while alpha-2 is expanded only when it agrees with the country already
 * established for this entry. Everything else is left exactly as written: a
 * value that reads oddly is a smaller defect than a birthplace in the wrong
 * hemisphere, and a country spelled as a word (`"Atlanta, Georgia"`) is never
 * touched at all.
 */
export function normalizePlace(raw: string, options: PlaceOptions = {}): string | undefined {
  const value = text(raw);
  if (!value || value.length > PLACE_MAX_CHARS) return undefined;

  // The whole value is a code: `"au"` → `"Австралия"`.
  const whole = countryOf(value, options.country);
  if (whole) return countryName(whole, options.language ?? 'en') ?? value;

  // The tail is a code: `"Melbourne, au"` → `"Melbourne, Австралия"`.
  const cut = value.lastIndexOf(',');
  if (cut <= 0) return value;

  const head = value.slice(0, cut).trim();
  const code = head ? countryOf(value.slice(cut + 1).trim(), options.country) : undefined;
  if (!code) return value;

  const name = countryName(code, options.language ?? 'en');
  return name ? `${head}, ${name}` : value;
}

/**
 * The country a bare code names, when there is no other thing it could name.
 *
 * Anything that is not a two- or three-letter token is left to the caller: a
 * country written as a word is already prose and needs no repair.
 */
function countryOf(token: string, known: string | undefined): string | undefined {
  if (!/^[A-Za-z]{2,3}$/.test(token)) return undefined;

  const code = resolveCountry(token);
  if (!code) return undefined;
  if (token.length === 3) return code;

  // Two letters: only when the entry's own country already says so.
  return known && code === known.toLowerCase() ? code : undefined;
}

function refines(field: WebField, current: string, candidate: string): boolean {
  return (field === 'born' || field === 'died') && refinesDate(current, candidate);
}

/**
 * The comparison key for "the provider consulted this page", not a published value.
 *
 * Two spellings of one page must not read as two pages. A provider reports
 * `https://en.wikipedia.org/wiki/Foo/`, the model writes
 * `http://www.en.wikipedia.org/wiki/Foo#Life`, and exact equality on the
 * normalized URL rejects a citation that is in fact verified — which, with the
 * check on, silently costs the field. So scheme, `www.`, a trailing slash, the
 * fragment and campaign parameters are all dropped here.
 *
 * Deliberately *not* `normalizeUrl`: that one produces the URL actually written
 * into a dossier and must stay faithful. This one only ever compares.
 */
export function sourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) parsed.searchParams.delete(key);
    }
    const query = parsed.searchParams.toString();
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return url;
  }
}

function numberOf(value: unknown): number | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return undefined;
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : undefined;
}
