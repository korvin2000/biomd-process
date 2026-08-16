/**
 * The value domains of `external/02-value-domains.md`, one function each.
 *
 * Every one of them is *narrow on output and wide on input*: it emits exactly
 * the canonical authored form the specification names, and accepts every
 * plausible spelling of it, because the alternative to accepting `1893-02-21`
 * is spending a retry on a model that will very likely answer `1893-02-21`
 * again.
 *
 * They return `undefined` for a value that cannot be read, never a guess.
 * `external/07` §7.2 rule 5 is explicit: an absent field is correct, an invented
 * one is not — and every field of a dossier is optional, so dropping degrades
 * gracefully while guessing publishes a fabricated fact.
 */

import { resolveDocumentType } from './vocabulary.js';

// ---------------------------------------------------------------------------
// VD-DATE
// ---------------------------------------------------------------------------

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * `"1893-02-21"` | `"21.2.1893"` | `"21/02/1893"` → `"21.02.1893"`.
 *
 * Partial dates are **not representable** in this format: `external/02`
 * requires a date not known to the day to be omitted rather than approximated,
 * and `external/05` §5.11 lists `"born": "1885"` as an anti-pattern. So a bare
 * year, a month-and-year, `"c. 1885"` and every qualified form return
 * `undefined` — the prose belongs in the article.
 *
 * The calendar is checked as well as the grammar. A consumer only validates day
 * 1–31 and month 1–12 and must not crash on `31.02.1900`, but a *producer* that
 * writes it has published a date that does not exist.
 */
export function normalizeDate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  const iso = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/.exec(value);
  if (iso) return assemble(iso[3], iso[2], iso[1]);

  const dotted = /^(\d{1,2})[.\-/\s](\d{1,2})[.\-/\s](\d{4})$/.exec(value);
  if (dotted) return assemble(dotted[1], dotted[2], dotted[3]);

  return undefined;
}

function assemble(day = '', month = '', year = ''): string | undefined {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);

  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return undefined;
  if (m < 1 || m > 12 || d < 1 || y < 1000 || y > 9999) return undefined;

  const limit = m === 2 && !isLeapYear(y) ? 28 : (DAYS_IN_MONTH[m - 1] ?? 31);
  if (d > limit) return undefined;

  return `${pad(d)}.${pad(m)}.${year}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True for a value already in the canonical or tolerated authored form. */
export function isValidDate(value: string): boolean {
  if (!/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(value.trim())) return false;
  const [day, month] = value.trim().split('.').map(Number);
  return (day ?? 0) >= 1 && (day ?? 0) <= 31 && (month ?? 0) >= 1 && (month ?? 0) <= 12;
}

// ---------------------------------------------------------------------------
// VD-CSV-LIST
// ---------------------------------------------------------------------------

/**
 * `"rock, Pop , rock"` → `"rock,Pop"`.
 *
 * Split on comma, trim, drop empties — the specification's own algorithm — plus
 * a case-insensitive dedupe, first spelling wins. Consistent punctuation is what
 * makes two editions of an entry comparable at all; a duplicate item renders as
 * two identical chips.
 *
 * An item that itself contains a comma cannot be represented and there is no
 * escape mechanism, so nothing here tries to detect one.
 */
export function normalizeCsvList(value: string): string {
  return splitCsvList(value).join(',');
}

export function splitCsvList(value: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];

  for (const item of value.split(',')) {
    const trimmed = item.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const fold = trimmed.toLocaleLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    items.push(trimmed);
  }
  return items;
}

/** Union of two comma lists, keeping the first list's order and spelling. */
export function mergeCsvLists(first: string, second: string): string {
  return normalizeCsvList(`${first},${second}`);
}

// ---------------------------------------------------------------------------
// VD-RANKING
// ---------------------------------------------------------------------------

/** A JSON **number** in 0–100. `"96"` is non-conforming and is repaired, not kept. */
export function normalizeRanking(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

// ---------------------------------------------------------------------------
// VD-URL
// ---------------------------------------------------------------------------

/**
 * An **absolute** `http(s)` URL, or nothing.
 *
 * A relative value is not an error in the format — it is silently reinterpreted
 * as a resource path under the resource base, which for a field meaning "the
 * external source of this entry" is never what was intended. Dropping it is the
 * honest outcome.
 */
export function normalizeUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// VD-TARGET
// ---------------------------------------------------------------------------

export const EMBEDDED_SENTINEL = 'embedded';

/** ISO 639-1 codes that would mean a target had been localized (`INV-23`). */
const LANGUAGE_DIR = /^([a-z]{2})\//;

export interface TargetResolution {
  target?: string;
  note?: string;
}

/**
 * A resource target, L0 and therefore identical in every edition.
 *
 * Only two things are actually repaired: the `embedded` sentinel, which is
 * matched exactly and in lowercase (`"Embedded"` is an ordinary relative path,
 * which is nearly always a mistake), and a leading language directory, which is
 * the signature of a target that was localized when media never is.
 */
export function normalizeTarget(raw: string, supportedLanguages: readonly string[]): TargetResolution {
  const value = raw.trim();
  if (!value) return {};

  if (value.toLowerCase() === EMBEDDED_SENTINEL) {
    return value === EMBEDDED_SENTINEL
      ? { target: EMBEDDED_SENTINEL }
      : { target: EMBEDDED_SENTINEL, note: `Lower-cased the target sentinel "${value}".` };
  }

  const localized = LANGUAGE_DIR.exec(value);
  if (localized?.[1] && supportedLanguages.includes(localized[1]) && !isOpaque(value)) {
    return {
      target: value.slice(localized[0].length),
      note: `Removed the language directory from target "${value}": media is never localized (INV-23).`,
    };
  }
  return { target: value };
}

/** A URI scheme, a protocol-relative URL, or a bare query/fragment. */
export function isOpaque(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|[?#])/i.test(target);
}

/** The extension a consumer selects its presentation from. */
export function targetExtension(target: string): string {
  const path = target.split(/[?#]/)[0] ?? '';
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.mid', '.midi']);
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.bmp',
  '.apng',
  '.ico',
]);

export function isAudioTarget(target: string): boolean {
  return AUDIO_EXTENSIONS.has(targetExtension(target));
}

export function isImageTarget(target: string): boolean {
  return IMAGE_EXTENSIONS.has(targetExtension(target));
}

// ---------------------------------------------------------------------------
// VD-SLUG and VD-PATH-CONTENT
// ---------------------------------------------------------------------------

export const SLUG_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The slug of a row: the basename of `md`, minus `.bio.md`, else minus `.md`.
 *
 * Derived, never authored — and derived from `md` alone. The dossier path never
 * participates, because two rows may legitimately share one dossier while having
 * different slugs.
 */
export function slugOf(mdPath: string): string {
  const name = mdPath.split(/[/\\]/).pop() ?? mdPath;
  const lower = name.toLowerCase();
  if (lower.endsWith('.bio.md')) return name.slice(0, -'.bio.md'.length);
  if (lower.endsWith('.md')) return name.slice(0, -'.md'.length);
  return name;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** Root-relative, leading slash, no language directory, no query or fragment. */
export function normalizeContentPath(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (isOpaque(value)) return value;
  if (/[?#]/.test(value)) return undefined;

  const parts = value.split('/').filter((part) => part && part !== '.' && part !== '..');
  return parts.length > 0 ? `/${parts.join('/')}` : undefined;
}

/** Bucket-relative by house style: `img` resolves against the catalogue root. */
export function normalizeAssetPath(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (isOpaque(value)) return value;

  const parts = value.split('/').filter((part) => part && part !== '.' && part !== '..');
  return parts.length > 0 ? parts.join('/') : undefined;
}

// ---------------------------------------------------------------------------
// VD-ID
// ---------------------------------------------------------------------------

export const ID_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/**
 * `7` → `"7"`. A decimal string with no sign and no leading zeroes.
 *
 * A JSON number is coerced for tolerance only: `"7"`, `7` and `"0007"` are three
 * different object keys as far as the join to `index-<lang>.json` is concerned,
 * and the breakage when they drift apart is silent.
 */
export function normalizeId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// VD-ENUM-DOCTYPE re-export, so callers need one import for "normalize a value"
// ---------------------------------------------------------------------------

export { resolveDocumentType };

// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Trimmed, or `undefined` when the value is absent, empty or whitespace. */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
