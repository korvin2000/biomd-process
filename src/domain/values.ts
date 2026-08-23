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
 * How much of a date is known.
 *
 * `external/02` says a date not known to the day is not representable and must
 * be omitted. That rule loses real information — a biography that says "born in
 * 1885" then publishes nothing at all — so this deployment lowers the floor
 * instead of dropping the fact, and the floor is a setting
 * (`catalogue.datePrecision`) rather than a constant.
 *
 * The published form is the canonical `DD.MM.YYYY` **truncated from the left**:
 *
 * | precision | value |
 * |---|---|
 * | `day` | `"21.02.1893"` |
 * | `month` | `"02.1893"` |
 * | `year` | `"1893"` |
 *
 * That shape is deliberate. VD-DATE requires a consumer to treat a value that
 * does not match `\d{1,2}\.\d{1,2}\.\d{4}` as **absent**, so a strict reader
 * silently ignores `"1893"` and behaves exactly as it would have if the field
 * had been dropped — while a reader that wants the year can have it.
 */
export type DatePrecision = 'day' | 'month' | 'year';

const PRECISION_RANK: Record<DatePrecision, number> = { day: 3, month: 2, year: 1 };

/** Month names in the corpus languages, so a spelled-out month costs no retry. */
const MONTH_NAMES: Record<string, number> = {};
{
  const table: Record<string, string[]> = {
    // Russian, nominative and genitive — an article writes "21 февраля 1893".
    ru: [
      'январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр',
    ],
    en: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
    es: ['ener', 'febrer', 'marz', 'abril', 'may', 'juni', 'juli', 'agost', 'septiembr', 'octubr', 'noviembr', 'diciembr'],
    de: ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
    pt: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
  };
  for (const stems of Object.values(table)) {
    stems.forEach((stem, index) => {
      MONTH_NAMES[stem] = index + 1;
    });
  }
}

/** Qualifiers that mean "about". The year survives them; the hedge does not. */
const APPROXIMATE = /^(?:c\.?|ca\.?|circa|about|around|~|ок\.?|около|прибл\.?|примерно|etwa|vers|hacia)\s+/i;

/**
 * `"1893-02-21"` | `"21.2.1893"` | `"21 февраля 1893"` → `"21.02.1893"`.
 * `"05.1885"` | `"May 1885"` → `"05.1885"`. `"c. 1885"` → `"1885"`.
 *
 * Wide on input, narrow on output, and never a guess: a date whose day is not
 * stated is emitted as the month or the year it *is* known to, not padded to
 * the first of the month. `minPrecision` is the floor — anything coarser than
 * it returns `undefined`, so passing `'day'` restores the specification's own
 * behaviour exactly.
 *
 * The calendar is checked as well as the grammar. A consumer only validates day
 * 1–31 and month 1–12 and must not crash on `31.02.1900`, but a *producer* that
 * writes it has published a date that does not exist.
 */
export function normalizeDate(raw: string, minPrecision: DatePrecision = 'day'): string | undefined {
  const parsed = parseDate(raw);
  if (!parsed) return undefined;
  if (PRECISION_RANK[parsed.precision] < PRECISION_RANK[minPrecision]) return undefined;
  return parsed.value;
}

export interface ParsedDate {
  value: string;
  precision: DatePrecision;
  year: number;
  month?: number;
  day?: number;
}

/** The reading of a date value, whatever its precision. */
export function parseDate(raw: string): ParsedDate | undefined {
  const trimmed = raw.trim().replace(/[,;]+$/, '').replace(APPROXIMATE, '').trim();
  if (!trimmed) return undefined;

  // Ranges and open-ended forms name two dates; neither is *the* date.
  if (/[–—]|\s-\s|\d{4}\s*[-–—/]\s*\d{4}/.test(trimmed)) return undefined;

  const value = singleCalendar(trimmed);

  const iso = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/.exec(value);
  if (iso) return assemble(iso[3], iso[2], iso[1]);

  const dotted = /^(\d{1,2})[.\-/\s](\d{1,2})[.\-/\s](\d{4})$/.exec(value);
  if (dotted) return assemble(dotted[1], dotted[2], dotted[3]);

  const isoMonth = /^(\d{4})[-.](\d{1,2})$/.exec(value);
  if (isoMonth) return assemble(undefined, isoMonth[2], isoMonth[1]);

  const dottedMonth = /^(\d{1,2})[.\-/](\d{4})$/.exec(value);
  if (dottedMonth) return assemble(undefined, dottedMonth[1], dottedMonth[2]);

  const spelled = spelledOut(value);
  if (spelled) return spelled;

  const year = /^(\d{4})(?:\s*(?:г\.?|года|year))?$/i.exec(value);
  if (year) return assemble(undefined, undefined, year[1]);

  return undefined;
}

/**
 * The same day, printed twice.
 *
 * Russian reference writing dates the nineteenth century in both calendars, and
 * this corpus does it in two shapes: `11(23).12.1818` puts the New Style day in
 * brackets, and `24.12.1884 / 05.01.1885` writes the alternative out in full.
 * Neither parses, so `aleksandrov` published **no dates at all** while the
 * article states both his birth and his death — a fact lost to a punctuation
 * convention, which is exactly what "wide on input" exists to prevent. The
 * first form printed is the one kept: the article leads with it, and choosing
 * it is reading rather than guessing.
 *
 * A genuine range is a different claim and must still be refused. A dash is
 * already rejected before this runs; a slash survives it only when both sides
 * are full dates within a fortnight of each other, which a range never is.
 */
function singleCalendar(value: string): string {
  const bracketed = value.replace(/(\d{1,2})\s*[([]\s*\d{1,2}\s*[)\]]/g, '$1');

  const alternates = /^(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})\s*[/(]\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4})\)?$/.exec(bracketed);
  if (!alternates) return bracketed;

  const [first, second] = [alternates[1], alternates[2]].map((part) => {
    const [day, month, year] = (part ?? '').split(/[.\-/]/).map(Number);
    return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  });
  const apart = Math.abs((first ?? 0) - (second ?? 0)) / 86_400_000;
  return apart <= 15 ? (alternates[1] ?? bracketed) : bracketed;
}

/** Grammar glue between the parts of a spelled-out date, in the corpus languages. */
const DATE_FILLER = /^(?:г|гг|года|году|of|the|de|del|dell|dello|di|der|des|el|le|la|em|no|nel|en)$/;

/** `"21 февраля 1893"`, `"February 1893"`, `"Feb 21, 1893"`, `"21 de marzo de 1893"`. */
function spelledOut(value: string): ParsedDate | undefined {
  const words = value
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !DATE_FILLER.test(word));
  if (words.length < 2 || words.length > 3) return undefined;

  let day: string | undefined;
  let month: number | undefined;
  let year: string | undefined;

  for (const word of words) {
    if (/^\d{4}$/.test(word)) {
      year ??= word;
      continue;
    }
    if (/^\d{1,2}(?:st|nd|rd|th|-?(?:го|е))?$/.test(word)) {
      day ??= word.replace(/\D/g, '');
      continue;
    }
    // A word that is neither a number nor a month name means this is prose,
    // not a date — reading half of it would invent the other half.
    const named = monthOf(word);
    if (named === undefined || month !== undefined) return undefined;
    month = named;
  }

  if (!year || month === undefined) return undefined;
  return assemble(day, String(month), year);
}

function monthOf(word: string): number | undefined {
  for (const [stem, index] of Object.entries(MONTH_NAMES)) {
    if (word.startsWith(stem)) return index;
  }
  return undefined;
}

function assemble(day: string | undefined, month: string | undefined, year = ''): ParsedDate | undefined {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1000 || y > 9999) return undefined;
  if (month === undefined || month === '') return { value: year, precision: 'year', year: y };

  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return undefined;
  if (day === undefined || day === '') {
    return { value: `${pad(m)}.${year}`, precision: 'month', year: y, month: m };
  }

  const d = Number(day);
  if (!Number.isInteger(d) || d < 1) return undefined;

  const limit = m === 2 && !isLeapYear(y) ? 28 : (DAYS_IN_MONTH[m - 1] ?? 31);
  if (d > limit) return undefined;

  return { value: `${pad(d)}.${pad(m)}.${year}`, precision: 'day', year: y, month: m, day: d };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True for a value already in the canonical or tolerated authored form. */
export function isValidDate(value: string, minPrecision: DatePrecision = 'day'): boolean {
  const trimmed = value.trim();
  const precision = datePrecisionOf(trimmed);
  if (!precision || PRECISION_RANK[precision] < PRECISION_RANK[minPrecision]) return false;

  const parts = trimmed.split('.').map(Number);
  const day = precision === 'day' ? parts[0] : undefined;
  const month = precision === 'day' ? parts[1] : precision === 'month' ? parts[0] : undefined;

  if (day !== undefined && (day < 1 || day > 31)) return false;
  if (month !== undefined && (month < 1 || month > 12)) return false;
  return true;
}

/** How precise an already-canonical value is, by counting its components. */
export function datePrecisionOf(value: string): DatePrecision | undefined {
  const trimmed = value.trim();
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(trimmed)) return 'day';
  if (/^\d{1,2}\.\d{4}$/.test(trimmed)) return 'month';
  if (/^\d{4}$/.test(trimmed)) return 'year';
  return undefined;
}

/**
 * True when `candidate` is a strictly sharper reading of `current` — same year,
 * same month where both state one.
 *
 * This is the one case where a fresh reading may overwrite a value already on
 * disk: `"1893"` and `"21.02.1893"` are not two competing facts, they are one
 * fact known to two depths, and refusing the sharper one keeps a placeholder
 * forever.
 */
export function refinesDate(current: string, candidate: string): boolean {
  const from = parseDate(current);
  const to = parseDate(candidate);
  if (!from || !to) return false;
  if (PRECISION_RANK[to.precision] <= PRECISION_RANK[from.precision]) return false;

  if (from.year !== to.year) return false;
  if (from.month !== undefined && from.month !== to.month) return false;
  return true;
}

/**
 * True when `candidate` states **more** of the date than `current` does,
 * whether or not the two agree about the part they share.
 *
 * This is deliberately not {@link refinesDate}, and the difference is the whole
 * question a date conflict poses. `refinesDate` answers "is this the same fact,
 * read more closely" and requires the year to match. This answers the weaker
 * "does this answer carry more information", so `"1950"` against `"25.07.1949"`
 * is true here and false there.
 *
 * Nothing in the domain acts on it by itself — a caller has to decide that a
 * sourced day beats an unsourced year, which is a policy about *whose* claim
 * to trust and belongs to the pipeline that has both provenances in hand.
 */
export function sharpensDate(current: string, candidate: string): boolean {
  const from = parseDate(current);
  const to = parseDate(candidate);
  if (!from || !to) return false;
  return PRECISION_RANK[to.precision] > PRECISION_RANK[from.precision];
}

/** The year of a canonical value, for the arithmetic an age check needs. */
export function yearOf(value: string): number | undefined {
  return parseDate(value)?.year;
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
