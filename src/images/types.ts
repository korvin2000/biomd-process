/**
 * The image index format of `images/image-index-spec.md`, as TypeScript.
 *
 * This is an **input** format, not the published one — it belongs beside
 * `src/documents` rather than in `src/domain`. Everything here is read
 * defensively: §18 of that document requires a consumer to tolerate missing
 * optional data, and the real index does exercise that clause (`meta.people`,
 * `meta.title` and `ocr` are empty in every record of the corpus this was built
 * against, and `meta.description` holds an XMP dump rather than a description).
 */

import type { Marker, NameToken } from './tokens.js';

export const SUPPORTED_SCHEMA_VERSION = 1;

/** `ai.class` — the semantic classification of the picture. */
export type ImageClass =
  | 'portrait'
  | 'upper_body'
  | 'full_body'
  | 'group'
  | 'sheet_music'
  | 'other'
  | 'unknown';

export type Orientation = 'portrait' | 'landscape' | 'square';
export type ColorMode = 'color' | 'bw' | 'unknown';

/** One `images[]` entry, exactly as the file carries it. */
export interface RawImageRecord {
  relPath?: string;
  fileName?: string;
  nameTokens?: string[];
  nameTokensRu?: string[];
  image?: { width?: number; height?: number; aspect?: string; orientation?: string; mp?: number };
  color?: { mode?: string; count?: number };
  meta?: {
    title?: string;
    description?: string;
    keywords?: string[];
    people?: string[];
    ocr?: string;
  };
  ai?: { class?: string; confidence?: number; faceCount?: number; faceCoverage?: number };
}

/** Textual metadata, after the junk guard has had its say. */
export interface ImageMeta {
  people: string[];
  title?: string;
  keywords: string[];
  description?: string;
  ocr?: string;
}

/** A record with everything the matcher needs precomputed once. */
export interface ImageRecord {
  relPath: string;
  fileName: string;
  /** `photo/<letter>/` — the initial of the subject the file is filed under. */
  bucket?: string;
  /** Name tokens from the path *and* the index's own `nameTokens`/`nameTokensRu`. */
  tokens: NameToken[];
  /** Unsplit spellings of the basename and its directory: `delucia`, `pacopena`. */
  concatenations: string[];
  /** Given-name initials the index drops as too short: `f_sor` → `f`. */
  initials: string[];
  markers: Marker[];
  meta: ImageMeta;
  width: number;
  height: number;
  orientation: Orientation;
  megapixels: number;
  color: ColorMode;
  ai: {
    class: ImageClass;
    confidence: number;
    faceCount: number;
    faceCoverage: number;
  };
}

export interface ImageIndex {
  schemaVersion: number;
  records: readonly ImageRecord[];
  /** token text → records carrying it, over both scripts and both sources. */
  byToken: ReadonlyMap<string, readonly ImageRecord[]>;
  /** phonetic key → records, for the spelling-insensitive stage. */
  byPhonetic: ReadonlyMap<string, readonly ImageRecord[]>;
  /** Unsplit basename → records, for `delucia` against "de Lucía". */
  byConcatenation: ReadonlyMap<string, readonly ImageRecord[]>;
  /** Word from `meta.people` / `meta.title` / `meta.keywords` → records. */
  byMetaName: ReadonlyMap<string, readonly ImageRecord[]>;
  /** Every distinct token, so a fuzzy pass can scan the vocabulary, not the corpus. */
  vocabulary: readonly string[];
  /** Where the index was read from; carried for diagnostics. */
  source: string;
  /** Records dropped as unreadable, so a silent load failure is still visible. */
  skipped: number;
}
