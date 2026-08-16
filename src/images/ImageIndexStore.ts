/**
 * Reads `artists.json` once and hands out a queryable index.
 *
 * One load per run, cached by absolute path: the file is ~900 KB of JSON and
 * every document in the corpus asks it the same question. The inverted maps are
 * built at load time for the same reason — a corpus of 2000 entries against an
 * index of 2000 images is four million comparisons if each query scans.
 */

import { ConfigError } from '../shared/errors.js';
import { pathExists, readJsonFile } from '../shared/fs.js';
import {
  analysePath,
  fold,
  isNoise,
  phoneticKey,
  scriptOf,
  type NameToken,
} from './tokens.js';
import {
  SUPPORTED_SCHEMA_VERSION,
  type ColorMode,
  type ImageClass,
  type ImageIndex,
  type ImageMeta,
  type ImageRecord,
  type Orientation,
  type RawImageRecord,
} from './types.js';

const IMAGE_CLASSES = new Set<ImageClass>([
  'portrait',
  'upper_body',
  'full_body',
  'group',
  'sheet_music',
  'other',
  'unknown',
]);

/**
 * `meta.description` in the wild is an XMP/EXIF dump, not a description, and
 * `meta.keywords` is often a pair of EXIF rationals. Feeding either into a name
 * match produces confident nonsense, so anything shaped like a serialized
 * property bag is discarded before it can score.
 */
function usableText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length < 2 || text.length > 400) return undefined;
  if (/^[{[]/.test(text) || /'\w+':/.test(text) || /\b(?:uuid|xmp|exif|ProcessVersion|ColorSpace)\b/i.test(text)) {
    return undefined;
  }
  return text;
}

function usableList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => usableText(item))
    .filter((item): item is string => Boolean(item))
    // A "keyword" of `282/100` is an EXIF rational, not a tag.
    .filter((item) => /\p{L}{2}/u.test(item));
}

export class ImageIndexStore {
  private readonly cache = new Map<string, Promise<ImageIndex>>();

  /** Takes the project paths so a caller can pass the config value verbatim. */
  constructor(private readonly paths: { resolve(...segments: string[]): string }) {}

  /**
   * Loads and caches. A missing file is a configuration error rather than an
   * empty index: silently matching nothing would look exactly like "this corpus
   * has no photographs", which is the one diagnosis that must not be guessed.
   */
  async load(file: string): Promise<ImageIndex> {
    const resolved = this.paths.resolve(file);
    const cached = this.cache.get(resolved);
    if (cached) return cached;

    const pending = this.read(resolved);
    this.cache.set(resolved, pending);
    return pending;
  }

  private async read(file: string): Promise<ImageIndex> {
    if (!(await pathExists(file))) {
      throw new ConfigError(`Image index not found: ${file}`, {
        details: { hint: 'Set tasks.portrait.indexFile, or disable tasks.portrait.' },
      });
    }

    const raw = await readJsonFile<{ schemaVersion?: unknown; images?: unknown }>(file).catch((error: unknown) => {
      throw new ConfigError(`Image index at ${file} is not readable JSON`, { cause: error });
    });

    const schemaVersion = typeof raw?.schemaVersion === 'number' ? raw.schemaVersion : 0;
    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      throw new ConfigError(
        `Image index at ${file} declares schemaVersion ${schemaVersion}; this build understands ` +
          `${SUPPORTED_SCHEMA_VERSION}.`,
      );
    }
    if (!Array.isArray(raw.images)) {
      throw new ConfigError(`Image index at ${file} has no \`images\` array.`);
    }

    return buildIndex(raw.images as RawImageRecord[], file);
  }
}

/** Exposed for tests and for the CLI, which builds an index from a literal. */
export function buildIndex(images: readonly RawImageRecord[], source: string): ImageIndex {
  const records: ImageRecord[] = [];
  let skipped = 0;

  for (const raw of images) {
    const record = toRecord(raw);
    if (record) records.push(record);
    else skipped += 1;
  }

  const byToken = new Map<string, ImageRecord[]>();
  const byPhonetic = new Map<string, ImageRecord[]>();
  const byConcatenation = new Map<string, ImageRecord[]>();
  const byMetaName = new Map<string, ImageRecord[]>();
  const add = (map: Map<string, ImageRecord[]>, key: string, record: ImageRecord): void => {
    if (!key) return;
    const bucket = map.get(key);
    if (bucket) {
      if (bucket.at(-1) !== record) bucket.push(record);
    } else map.set(key, [record]);
  };

  for (const record of records) {
    for (const token of record.tokens) {
      add(byToken, token.text, record);
      add(byPhonetic, token.phonetic, record);
    }
    for (const concatenation of record.concatenations) add(byConcatenation, concatenation, record);

    // Textual metadata is indexed separately from the path: it is stronger
    // evidence when it exists, and it must not be mistaken for a filename token.
    for (const text of [...record.meta.people, record.meta.title ?? '', ...record.meta.keywords]) {
      for (const word of text.split(/[^\p{L}]+/u)) {
        const folded = fold(word);
        if (folded.length >= 3 && !isNoise(folded)) add(byMetaName, folded, record);
      }
    }
  }

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    records,
    byToken,
    byPhonetic,
    byConcatenation,
    byMetaName,
    vocabulary: [...byToken.keys()],
    source,
    skipped,
  };
}

function toRecord(raw: RawImageRecord): ImageRecord | undefined {
  const relPath = typeof raw.relPath === 'string' ? raw.relPath.replace(/\\/g, '/').replace(/^\/+/, '') : '';
  if (!relPath) return undefined;

  const path = analysePath(relPath);
  const meta = toMeta(raw.meta);

  // The index's own tokens are merged in rather than trusted alone: they are
  // the same split of the same filename, but they also carry `nameTokensRu`,
  // which is the only Cyrillic spelling available and the one a Russian article
  // matches against directly.
  const tokens = [...path.tokens];
  const seen = new Set(tokens.map((token) => `${token.source}:${token.text}`));
  const merge = (values: unknown, source: NameToken['source']): void => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const text = fold(value);
      if (!text || isNoise(text) || seen.has(`${source}:${text}`)) continue;
      seen.add(`${source}:${text}`);
      tokens.push({ text, source, script: scriptOf(value), phonetic: phoneticKey(value) });
    }
  };
  merge(raw.nameTokens, 'file');
  merge(raw.nameTokensRu, 'file');

  const width = numberOr(raw.image?.width, 0);
  const height = numberOr(raw.image?.height, 0);

  return {
    relPath,
    fileName: typeof raw.fileName === 'string' && raw.fileName ? raw.fileName : (relPath.split('/').pop() ?? relPath),
    ...(path.bucket ? { bucket: path.bucket } : {}),
    tokens,
    concatenations: path.concatenations,
    initials: path.initials,
    markers: path.markers,
    meta,
    width,
    height,
    orientation: toOrientation(raw.image?.orientation, width, height),
    megapixels: numberOr(raw.image?.mp, (width * height) / 1_000_000),
    color: toColor(raw.color?.mode),
    ai: {
      class: IMAGE_CLASSES.has(raw.ai?.class as ImageClass) ? (raw.ai?.class as ImageClass) : 'unknown',
      confidence: clamp(numberOr(raw.ai?.confidence, 0), 0, 1),
      faceCount: Math.max(0, Math.round(numberOr(raw.ai?.faceCount, 0))),
      faceCoverage: clamp(numberOr(raw.ai?.faceCoverage, 0), 0, 1),
    },
  };
}

function toMeta(raw: RawImageRecord['meta']): ImageMeta {
  const title = usableText(raw?.title);
  const description = usableText(raw?.description);
  const ocr = usableText(raw?.ocr);
  return {
    people: usableList(raw?.people),
    keywords: usableList(raw?.keywords),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(ocr ? { ocr } : {}),
  };
}

function toOrientation(value: unknown, width: number, height: number): Orientation {
  if (value === 'portrait' || value === 'landscape' || value === 'square') return value;
  if (width > 0 && height > 0) {
    if (height > width * 1.05) return 'portrait';
    if (width > height * 1.05) return 'landscape';
    return 'square';
  }
  return 'square';
}

function toColor(value: unknown): ColorMode {
  return value === 'color' || value === 'bw' ? value : 'unknown';
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
