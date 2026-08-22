/**
 * The invariant catalogue of `external/07-authoring-and-validation.md` §7.3,
 * implemented as a pure function over a snapshot of the published files.
 *
 * Why this exists at all: almost every way this format breaks is **silent**. A
 * renumbered id does not raise an error — the localized names simply fall back
 * to the Latin title. A duplicate slug does not raise an error — one of the two
 * entries becomes unreachable while both files sit on disk. A declared edition
 * with no file on disk looks available right up to the moment a reader clicks
 * it. None of these can be caught by the schema, and none of them will be caught
 * by looking at the output, so they have to be checked.
 *
 * The function is pure and takes everything it needs as data, which keeps the
 * three passes `external/08` §8.5 describes — schema, cross-document, filesystem
 * — in one place and testable without a directory.
 */

import { countryCodes } from './countries.js';
import {
  DEFAULT_SUPPORTED_LANGUAGES,
  FORBIDDEN_DOSSIER_MEMBERS,
  type EntryRow,
} from './types.js';
import {
  isValidDate,
  isValidSlug,
  normalizeId,
  slugOf,
  text,
  type DatePrecision,
} from './values.js';
import { foldName, splitLanguages } from './catalog.js';

export type Severity = 'error' | 'warning';

export interface Finding {
  severity: Severity;
  /** `INV-3`, or `SCHEMA` for a structural defect that precedes the invariants. */
  invariant: string;
  /** Catalogue-relative file the finding is about. */
  file: string;
  message: string;
}

/** One file as it was read: parsed when possible, plus the bytes for what parsing loses. */
export interface LoadedFile {
  value: unknown;
  /** Needed for the checks a parser destroys: duplicate keys, literal `null`. */
  raw?: string;
}

export interface CatalogueSnapshot {
  /** `index.json`. */
  index: LoadedFile;
  /** `index-<lang>.json`, keyed by language code. */
  names: ReadonlyMap<string, LoadedFile>;
  /** Dossiers keyed by their catalogue-relative path, e.g. `ru/x.bio.json`. */
  dossiers: ReadonlyMap<string, LoadedFile>;
  /** Every catalogue-relative file path that exists, for the existence checks. */
  files: ReadonlySet<string>;
}

export interface ValidateOptions {
  supportedLanguages?: readonly string[];
  /** Skip the checks that need the filesystem, when the snapshot has no file list. */
  checkFiles?: boolean;
  /**
   * The coarsest date this catalogue publishes. `day` is `external/02` as
   * written; anything looser accepts `"02.1893"` and `"1893"` as well, because
   * this deployment chose to keep a partial date rather than lose the fact.
   */
  datePrecision?: DatePrecision;
}

const LATIN_SCRIPT_LANGUAGES = new Set(['en', 'es', 'de', 'fr', 'it', 'pt']);
const NON_LATIN_LANGUAGES = new Set(['ru', 'zh', 'ja', 'ko']);

export function validateCatalogue(snapshot: CatalogueSnapshot, options: ValidateOptions = {}): Finding[] {
  const supported = options.supportedLanguages ?? DEFAULT_SUPPORTED_LANGUAGES;
  const findings: Finding[] = [];
  const add = (severity: Severity, invariant: string, file: string, message: string): void => {
    findings.push({ severity, invariant, file, message });
  };

  const rows = checkIndex(snapshot.index, supported, add);
  const ids = new Set(rows.map((row) => row.id));
  const titles = new Map(rows.map((row) => [row.id, text(row.title) ?? '']));

  checkNameIndices(snapshot, ids, titles, add);
  checkDossiers(snapshot, supported, options.datePrecision ?? 'day', add);
  checkEditions(snapshot, rows, supported, options.checkFiles !== false, add);
  checkCrossEdition(snapshot, rows, add);

  return findings;
}

// ---------------------------------------------------------------------------
// index.json
// ---------------------------------------------------------------------------

type Emit = (severity: Severity, invariant: string, file: string, message: string) => void;

function checkIndex(file: LoadedFile, supported: readonly string[], add: Emit): EntryRow[] {
  const where = 'index.json';
  checkJsonHygiene(file, where, add);

  if (!Array.isArray(file.value)) {
    add('error', 'SCHEMA', where, 'Root value is not an array — the catalogue cannot be built.');
    return [];
  }

  const rows: EntryRow[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  const codes = countryCodes();
  /** Portrait path -> the rows carrying it, for the shared-picture check below. */
  const imgOwners = new Map<string, string[]>();

  for (const [position, entry] of file.value.entries()) {
    const at = `${where} [${position}]`;
    if (!isObject(entry)) {
      add('error', 'SCHEMA', where, `Row ${position} is not an object.`);
      continue;
    }
    const row = entry as EntryRow;

    for (const member of ['born', 'died', 'dates', 'forename', 'surname']) {
      if (member in row) add('error', 'INV-6', where, `${at}: carries "${member}" — that fact belongs to the dossier.`);
    }

    const rawId = row['id'];
    const id = normalizeId(rawId);
    if (!id) {
      add('error', 'INV-2', where, `${at}: id ${JSON.stringify(rawId)} is not a decimal string without leading zeroes.`);
      continue;
    }
    if (typeof rawId !== 'string') {
      add('error', 'INV-2', where, `${at}: id must be a JSON string ("${id}"), not a number.`);
    }
    if (seenIds.has(id)) {
      add('error', 'INV-1', where, `${at}: duplicate id "${id}" — this row is invisible to a reader.`);
      continue;
    }
    seenIds.add(id);

    const md = text(row.md);
    if (!md) {
      add('error', 'INV-5', where, `${at}: no md path — the row can be neither routed nor rendered.`);
      continue;
    }
    if (!text(row.title)) add('error', 'INV-5', where, `${at}: no title — the card would display the bare id.`);
    if (!text(row.type)) add('error', 'INV-5', where, `${at}: no type — invisible to every craft filter.`);

    const slug = slugOf(md);
    if (!isValidSlug(slug)) add('error', 'INV-4', where, `${at}: slug "${slug}" is not [A-Za-z0-9_.-]+.`);
    if (seenSlugs.has(slug)) {
      add('error', 'INV-3', where, `${at}: duplicate slug "${slug}" — one of the two entries is unreachable.`);
      continue;
    }
    seenSlugs.add(slug);

    if (/^\/?[a-z]{2}\//.test(md) && supported.includes(md.replace(/^\//, '').slice(0, 2))) {
      add('error', 'INV-5', where, `${at}: md "${md}" contains a language directory; it is injected by the reader.`);
    }

    const country = text(row.country);
    if (country && !codes.has(country.toLowerCase())) {
      add('error', 'INV-9', where, `${at}: country "${country}" is not an ISO 3166-1 alpha-2 code.`);
    }
    if (country && country !== country.toLowerCase()) {
      add('warning', 'INV-25', where, `${at}: country "${country}" should be authored lowercase.`);
    }

    const gender = text(row.gender);
    if (gender && !['m', 'f', 'mixed'].includes(gender.toLowerCase())) {
      add('error', 'INV-10', where, `${at}: gender "${gender}" is outside {m, f, mixed}.`);
    }

    const declared = text(row.lang);
    if (declared) {
      const parts = declared.split(',').map((code) => code.trim().toLowerCase());
      const unique = new Set(parts);
      if (unique.size !== parts.length) add('error', 'INV-11', where, `${at}: lang "${declared}" repeats a code.`);
      for (const code of parts) {
        if (!supported.includes(code)) {
          add('error', 'INV-11', where, `${at}: lang code "${code}" is not a supported ISO 639-1 code.`);
        }
      }
      if (declared !== declared.toLowerCase()) {
        add('warning', 'INV-25', where, `${at}: lang "${declared}" should be authored lowercase.`);
      }
    }

    const type = text(row.type);
    if (type && type !== type.toLowerCase()) {
      add('warning', 'INV-25', where, `${at}: type "${type}" should be authored lowercase.`);
    }
    if (type?.toLowerCase() === 'hidden') {
      if (text(row.img)) add('warning', 'INV-24', where, `${at}: a hidden row is never carded; img is unused.`);
      if (text(row.gender)) add('warning', 'INV-24', where, `${at}: a hidden row is never carded; gender is unused.`);
    }

    const img = text(row.img);
    if (img?.startsWith('/pages/')) {
      add('warning', 'INV-25', where, `${at}: img "${img}" resolves against the catalogue root, not the resource base.`);
    }
    // A traversal segment is never a legitimate asset path — `VD-PATH-ASSET`
    // has no `..` in it. It is what a mis-set `tasks.portrait.assetPrefix`
    // leaves behind, and because the catalogue merge never overwrites an `img`
    // that is already there, the wrong value survives every later run. Nothing
    // else in the pipeline would ever mention it again.
    if (img && /(^|\/)\.\.(\/|$)/.test(img)) {
      add('error', 'INV-25', where, `${at}: img "${img}" contains a ".." segment; VD-PATH-ASSET has none.`);
    }
    if (img) {
      const seen = imgOwners.get(img);
      if (seen) seen.push(at);
      else imgOwners.set(img, [at]);
    }

    rows.push({ ...row, id, md });
  }

  // The same photograph on two entries is nearly always a matcher error rather
  // than a shared picture: `photo/a/abreu1.jpg` cannot be both Antonio Abreu
  // and Zequinha de Abreu, and the identity score that put it on both was the
  // family name doing all the work. Published, it is two people wearing one
  // face — visible to every reader and invisible to every other check here.
  for (const [path, owners] of imgOwners) {
    if (owners.length < 2) continue;
    add(
      'warning',
      'INV-24',
      where,
      `img "${path}" is shared by ${owners.length} rows (${owners.join(', ')}); at most one of them is right.`,
    );
  }

  return rows;
}

// ---------------------------------------------------------------------------
// index-<lang>.json
// ---------------------------------------------------------------------------

function checkNameIndices(
  snapshot: CatalogueSnapshot,
  ids: ReadonlySet<string>,
  titles: ReadonlyMap<string, string>,
  add: Emit,
): void {
  for (const [lang, file] of snapshot.names) {
    const where = `index-${lang}.json`;
    checkJsonHygiene(file, where, add);

    if (!isObject(file.value)) {
      add('error', 'INV-13', where, 'Root value is not an object; the whole file is ignored by a reader.');
      continue;
    }

    for (const [key, value] of Object.entries(file.value as Record<string, unknown>)) {
      if (!normalizeId(key) || normalizeId(key) !== key) {
        add('error', 'INV-2', where, `Key "${key}" is not a plain decimal id; the join silently fails.`);
        continue;
      }
      if (!ids.has(key)) {
        add('error', 'INV-12', where, `Key "${key}" matches no id in index.json — usually a renumbered or deleted row.`);
      }
      if (!Array.isArray(value)) {
        add('error', 'INV-13', where, `Value for "${key}" is not an array.`);
        continue;
      }
      const names = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
      if (names.length === 0) {
        add('error', 'INV-13', where, `Entry "${key}" has no usable name.`);
        continue;
      }
      if (names.length !== value.length) {
        add('error', 'INV-13', where, `Entry "${key}" contains an element that is not a non-empty string.`);
      }

      const display = names[0] ?? '';
      const title = titles.get(key) ?? '';
      if (names.length === 1 && title && foldName(display) === foldName(title)) {
        add('warning', 'INV-14', where, `Entry "${key}" repeats the Latin title and carries no alias — omit it.`);
      }

      const seen = new Set([foldName(display)]);
      for (const alias of names.slice(1)) {
        if (alias.trim().length < 3) {
          add('warning', 'INV-28', where, `Entry "${key}": alias "${alias}" is too short and degrades ranking.`);
        }
        const fold = foldName(alias);
        if (seen.has(fold)) {
          add('warning', 'INV-28', where, `Entry "${key}": alias "${alias}" duplicates an earlier name.`);
        }
        seen.add(fold);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// dossiers
// ---------------------------------------------------------------------------

function checkDossiers(
  snapshot: CatalogueSnapshot,
  supported: readonly string[],
  precision: DatePrecision,
  add: Emit,
): void {
  for (const [path, file] of snapshot.dossiers) {
    checkJsonHygiene(file, path, add);

    if (!isObject(file.value)) {
      add('error', 'INV-19', path, 'Root value is not an object; treated as absent.');
      continue;
    }
    const root = file.value as Record<string, unknown>;
    const metadata = root['metadata'];
    if (!isObject(metadata)) {
      add('error', 'INV-19', path, 'No top-level `metadata` object — a reader discards the whole document.');
      continue;
    }
    const meta = metadata as Record<string, unknown>;

    for (const member of FORBIDDEN_DOSSIER_MEMBERS) {
      if (member in root) add('error', 'INV-7', path, `Root carries "${member}" — withdrawn in version 2.`);
      if (member in meta) add('error', 'INV-7', path, `metadata carries "${member}" — withdrawn in version 2.`);
    }

    const ranking = meta['ranking'];
    if (ranking !== undefined) {
      if (typeof ranking !== 'number' || !Number.isFinite(ranking) || ranking < 0 || ranking > 100) {
        add('error', 'INV-20', path, `ranking ${JSON.stringify(ranking)} is not a number in 0–100.`);
      }
    }

    const dates = meta['dates'];
    if (isObject(dates)) {
      for (const [key, value] of Object.entries(dates as Record<string, unknown>)) {
        if (typeof value !== 'string' || !isValidDate(value, precision)) {
          const wanted = precision === 'day' ? 'DD.MM.YYYY' : `DD.MM.YYYY, MM.YYYY or YYYY (${precision} precision)`;
          add('error', 'INV-21', path, `dates.${key} = ${JSON.stringify(value)} is not ${wanted}.`);
        }
        // A partial date raises nothing further. `catalogue.datePrecision` is
        // this catalogue's statement of intent, and a validator that warned on
        // every deliberate value would make `--strict` unusable — the cost of
        // the choice (a strict VD-DATE reader treats `"1893"` as absent) is
        // documented where the setting is, not repeated per row.
      }
    }

    const url = text(meta['url']);
    checkItems(root['media'], root['documents'], path, url, add);
    checkScript(path, meta, supported, add);
  }
}

function checkItems(media: unknown, documents: unknown, path: string, url: string | undefined, add: Emit): void {
  const lists: Array<[string, unknown]> = [];
  if (isObject(media)) {
    lists.push(['media.photos', (media as Record<string, unknown>)['photos']]);
    lists.push(['media.music', (media as Record<string, unknown>)['music']]);
  }
  lists.push(['documents', documents]);

  for (const [where, list] of lists) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      add('error', 'SCHEMA', path, `${where} is not an array.`);
      continue;
    }
    for (const [index, item] of list.entries()) {
      if (!isObject(item)) {
        add('error', 'INV-22', path, `${where}[${index}] is not an object.`);
        continue;
      }
      const record = item as Record<string, unknown>;
      if (!text(record['label'])) add('error', 'INV-22', path, `${where}[${index}] has no label.`);
      const target = text(record['target']);
      if (!target) {
        add('error', 'INV-22', path, `${where}[${index}] has no target.`);
        continue;
      }
      if (target.toLowerCase() === 'embedded' && target !== 'embedded') {
        add('error', 'INV-22', path, `${where}[${index}]: the sentinel is matched exactly — write "embedded".`);
      }
      if (where === 'documents' && url && target === url) {
        add('warning', 'INV-27', path, `${where}[${index}] duplicates metadata.url; the source row is synthesized.`);
      }
      const type = record['type'];
      if (where === 'documents' && type !== undefined && (typeof type !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(type))) {
        add('error', 'SCHEMA', path, `${where}[${index}].type ${JSON.stringify(type)} is not an uppercase symbol.`);
      }
    }
  }
}

/**
 * The one heuristic in the list: an edition whose prose is in the wrong script
 * is almost always a copy that was never translated. It is a warning because a
 * genuinely ASCII Russian dossier is conceivable — a person whose every name is
 * a Latin proper noun — just very unlikely.
 */
function checkScript(path: string, meta: Record<string, unknown>, supported: readonly string[], add: Emit): void {
  const lang = path.split('/')[0] ?? '';
  if (!supported.includes(lang)) return;

  const prose = ['forename', 'surname', 'birthname', 'birthplace', 'deathplace', 'jobs', 'genres']
    .map((key) => text(meta[key]))
    .filter((value): value is string => Boolean(value))
    .join(' ');
  if (prose.length < 8) return;

  if (NON_LATIN_LANGUAGES.has(lang) && /^[\x20-\x7E]+$/.test(prose)) {
    add('warning', 'INV-18', path, `A ${lang} edition whose prose is pure ASCII — probably an untranslated copy.`);
  }
  if (LATIN_SCRIPT_LANGUAGES.has(lang) && /\p{Script=Cyrillic}/u.test(prose)) {
    add('warning', 'INV-18', path, `A ${lang} edition holding Cyrillic — probably an untranslated copy.`);
  }
}

// ---------------------------------------------------------------------------
// filesystem and cross-edition
// ---------------------------------------------------------------------------

function checkEditions(
  snapshot: CatalogueSnapshot,
  rows: readonly EntryRow[],
  supported: readonly string[],
  checkFiles: boolean,
  add: Emit,
): void {
  if (!checkFiles) return;

  for (const row of rows) {
    const languages = splitLanguages(text(row.lang) ?? '', supported);
    for (const lang of languages) {
      const article = `${lang}/${stripLeadingSlash(text(row.md) ?? '')}`;
      if (!snapshot.files.has(article)) {
        add('error', 'INV-8', 'index.json', `Row ${row.id} declares edition "${lang}" but ${article} does not exist.`);
      }
      const json = text(row.json);
      if (!json) continue;
      const dossier = `${lang}/${stripLeadingSlash(json)}`;
      if (!snapshot.files.has(dossier)) {
        add('error', 'INV-8', 'index.json', `Row ${row.id} declares a dossier but ${dossier} does not exist.`);
      }
    }
  }

  for (const file of snapshot.files) {
    const [lang, ...rest] = file.split('/');
    if (!lang || rest.length === 0 || !supported.includes(lang)) continue;
    const name = rest.join('/').toLowerCase();
    if (name.endsWith('.md') || name.endsWith('.json')) continue;
    add('error', 'INV-23', file, 'A language directory holds only articles and dossiers; media is shared.');
  }
}

/** `INV-17`: the L0 values must be byte-identical in every edition of an entry. */
function checkCrossEdition(snapshot: CatalogueSnapshot, rows: readonly EntryRow[], add: Emit): void {
  for (const row of rows) {
    const json = text(row.json);
    if (!json) continue;

    const editions = [...snapshot.dossiers.entries()].filter(([path]) =>
      path.endsWith(`/${stripLeadingSlash(json)}`),
    );
    if (editions.length < 2) continue;

    const fingerprints = new Map<string, string[]>();
    for (const [path, file] of editions) {
      fingerprints.set(path, [invariantFingerprint(file.value)]);
    }
    const distinct = new Set([...fingerprints.values()].map((value) => value[0] ?? ''));
    if (distinct.size > 1) {
      add(
        'warning',
        'INV-17',
        json,
        `Editions disagree on a language-invariant value (dates, ranking, url, targets, documents[].type): ` +
          `${[...fingerprints.keys()].join(', ')}.`,
      );
    }
  }
}

/** Everything L0 in a dossier, in a stable order. */
function invariantFingerprint(value: unknown): string {
  if (!isObject(value)) return '';
  const root = value as Record<string, unknown>;
  const meta = isObject(root['metadata']) ? (root['metadata'] as Record<string, unknown>) : {};
  const media = isObject(root['media']) ? (root['media'] as Record<string, unknown>) : {};

  const targets = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.map((item) => (isObject(item) ? String((item as Record<string, unknown>)['target'] ?? '') : ''))
      : [];

  const documents = Array.isArray(root['documents']) ? root['documents'] : [];
  return JSON.stringify({
    dates: meta['dates'] ?? null,
    ranking: meta['ranking'] ?? null,
    url: meta['url'] ?? null,
    photos: targets(media['photos']),
    music: targets(media['music']),
    documents: documents.map((item) =>
      isObject(item)
        ? [
            String((item as Record<string, unknown>)['target'] ?? ''),
            String((item as Record<string, unknown>)['type'] ?? ''),
          ]
        : ['', ''],
    ),
  });
}

// ---------------------------------------------------------------------------

/**
 * `INV-26`: no `null` anywhere, no duplicate object key.
 *
 * A duplicate key cannot be seen after parsing — the parser keeps the last
 * occurrence and the earlier value vanishes without a trace — so it is detected
 * by counting keys in the source text against keys in the parsed value.
 */
function checkJsonHygiene(file: LoadedFile, where: string, add: Emit): void {
  if (containsNull(file.value)) {
    add('error', 'INV-26', where, 'Contains a `null` value; no field in this format is nullable — omit the key.');
  }
  if (!file.raw) return;

  const duplicates = duplicateKeys(file.raw);
  for (const key of duplicates) {
    add('error', 'INV-26', where, `Duplicate object key "${key}" — a parser keeps the last, the earlier value is lost.`);
  }
}

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (isObject(value)) return Object.values(value as Record<string, unknown>).some(containsNull);
  return false;
}

/**
 * Keys that appear twice inside the same object literal.
 *
 * A brace-depth scan rather than a parser: the information is destroyed by
 * `JSON.parse`, and re-implementing a parser to recover one warning is not worth
 * it. Strings are tracked so a brace inside a value cannot desynchronize it.
 */
function duplicateKeys(raw: string): string[] {
  const stack: Array<Set<string>> = [];
  const found = new Set<string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = '';
  let capturing = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] as string;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        if (capturing) {
          // A string is a key only when the next non-space character is a colon.
          const next = raw.slice(i + 1).match(/^\s*(.)/)?.[1];
          const keys = stack[depth - 1];
          if (next === ':' && keys) {
            if (keys.has(current)) found.add(current);
            keys.add(current);
          }
        }
        capturing = false;
        current = '';
      } else if (capturing) current += char;
      continue;
    }

    if (char === '"') {
      inString = true;
      capturing = depth > 0;
      current = '';
    } else if (char === '{') {
      depth += 1;
      stack[depth - 1] = new Set<string>();
    } else if (char === '}') {
      if (depth > 0) stack.length = depth - 1;
      depth = Math.max(0, depth - 1);
    }
  }
  return [...found];
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
