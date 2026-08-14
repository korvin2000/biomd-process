import type { SourceDocument } from '../documents/types.js';
import type { JsonValue } from '../shared/json.js';
import type { PathVars } from './PathTemplate.js';

export interface SourceProvider {
  /** Discovers the corpus. Order is stable so runs are reproducible. */
  discover(): Promise<SourceDocument[]>;
}

export type ArtifactFormat = 'markdown' | 'json' | 'text';

/**
 * A result a pipeline produced. Pipelines build artifacts; they never touch the
 * filesystem — that keeps them testable and makes `--dry-run` free.
 */
export interface Artifact {
  /** Output channel name; the config maps it to a path template. */
  channel: string;
  format: ArtifactFormat;
  /** Serialized by the writer: JSON objects honour `output.jsonIndent`. */
  body: string | JsonValue;
  /** Substituted into the channel's path template. */
  pathVars: PathVars;
}

export interface WrittenArtifact {
  channel: string;
  /** Absolute path. */
  path: string;
  /** Path relative to the output base dir; what the UI and journal show. */
  relativePath: string;
  bytes: number;
  /** True when `output.onExisting: skip` prevented the write. */
  skipped: boolean;
}

export interface ArtifactWriter {
  resolvePath(artifact: Artifact, extraVars?: PathVars): string;
  write(artifact: Artifact, extraVars?: PathVars): Promise<WrittenArtifact>;
}
