import { relative, resolve, sep } from 'node:path';

import type { ProjectPaths } from '../config/paths.js';
import type { OutputConfig } from '../config/schema.js';
import { IoError } from '../shared/errors.js';
import { pathExists, writeFileAtomic } from '../shared/fs.js';
import { renderPathTemplate, type PathVars } from './PathTemplate.js';
import type { Artifact, ArtifactWriter, WrittenArtifact } from './types.js';

/**
 * Writes artifacts to disk through the channel's path template.
 *
 * Writes are atomic (write-then-rename): interrupting a run never leaves a
 * half-written JSON file that a later pass would happily read.
 */
export class FileArtifactWriter implements ArtifactWriter {
  private readonly baseDir: string;

  constructor(
    private readonly config: OutputConfig,
    paths: ProjectPaths,
    /** When true, paths are resolved and reported but nothing is written. */
    private readonly dryRun = false,
  ) {
    this.baseDir = paths.resolve(config.baseDir);
  }

  resolvePath(artifact: Artifact, extraVars: PathVars = {}): string {
    const template = this.config.channels[artifact.channel];
    if (!template) {
      throw new IoError(`No path template for output channel "${artifact.channel}"`, {
        details: { channel: artifact.channel, channels: Object.keys(this.config.channels) },
      });
    }
    return resolve(this.baseDir, renderPathTemplate(template, { ...extraVars, ...artifact.pathVars }));
  }

  async write(artifact: Artifact, extraVars: PathVars = {}): Promise<WrittenArtifact> {
    const path = this.resolvePath(artifact, extraVars);
    const body = this.serialize(artifact);
    const result: WrittenArtifact = {
      channel: artifact.channel,
      path,
      relativePath: relative(this.baseDir, path).split(sep).join('/'),
      bytes: Buffer.byteLength(body, 'utf8'),
      skipped: false,
    };

    if (this.dryRun) return { ...result, skipped: true };

    if (!artifact.overwrite && this.config.onExisting !== 'overwrite' && (await pathExists(path))) {
      if (this.config.onExisting === 'skip') return { ...result, skipped: true };
      throw new IoError(`Output already exists: ${path} (output.onExisting = "fail")`, { details: { path } });
    }

    await writeFileAtomic(path, body);
    return result;
  }

  private serialize(artifact: Artifact): string {
    const text =
      typeof artifact.body === 'string'
        ? artifact.body
        : JSON.stringify(artifact.body, null, this.config.jsonIndent);

    const trimmed = artifact.format === 'json' ? text.trimEnd() : text.replace(/\s+$/, '');
    return this.config.finalNewline ? `${trimmed}\n` : trimmed;
  }
}
