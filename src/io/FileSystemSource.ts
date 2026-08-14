import fastGlob from 'fast-glob';
import { basename, relative, resolve, sep } from 'node:path';

import type { ProjectPaths } from '../config/paths.js';
import type { InputConfig } from '../config/schema.js';
import type { SourceDocument } from '../documents/types.js';
import type { TokenEstimator } from '../llm/TokenEstimator.js';
import { PlanningError } from '../shared/errors.js';
import { readTextFile } from '../shared/fs.js';
import { shortHash } from '../shared/hash.js';
import type { SourceProvider } from './types.js';

/**
 * Discovers the corpus with glob patterns.
 *
 * Documents are read eagerly: the whole point of fingerprint-based resume is
 * that we hash content before deciding whether a task needs to run, and a
 * corpus of Markdown articles is small enough that this costs milliseconds.
 */
export class FileSystemSource implements SourceProvider {
  constructor(
    private readonly config: InputConfig,
    private readonly paths: ProjectPaths,
    private readonly estimator: TokenEstimator,
  ) {}

  async discover(): Promise<SourceDocument[]> {
    const baseDir = this.paths.resolve(this.config.baseDir);
    const matches = await fastGlob(this.config.include, {
      cwd: baseDir,
      ignore: this.config.exclude,
      onlyFiles: true,
      absolute: true,
      dot: false,
      unique: true,
    });

    if (matches.length === 0) {
      throw new PlanningError(
        `No input documents matched ${this.config.include.join(', ')} under ${baseDir}`,
        { details: { baseDir, include: this.config.include, exclude: this.config.exclude } },
      );
    }

    const ordered = matches.sort((a, b) => a.localeCompare(b));
    const limited = this.config.limit > 0 ? ordered.slice(0, this.config.limit) : ordered;

    return Promise.all(limited.map((file) => this.read(file, baseDir)));
  }

  private async read(absolutePath: string, baseDir: string): Promise<SourceDocument> {
    const content = await readTextFile(absolutePath);
    const relativePath = relative(baseDir, absolutePath).split(sep).join('/');
    const slug = this.slugOf(absolutePath);
    const language = this.languageOf(relativePath);

    return {
      id: `${language}/${slug}`,
      slug,
      language,
      absolutePath: resolve(absolutePath),
      relativePath,
      content,
      contentHash: shortHash(content, 16),
      bytes: Buffer.byteLength(content, 'utf8'),
      estimatedTokens: this.estimator.estimateText(content),
    };
  }

  private slugOf(absolutePath: string): string {
    const name = basename(absolutePath);
    return name.endsWith(this.config.slugSuffix) ? name.slice(0, -this.config.slugSuffix.length) : name;
  }

  /** `auto` reads the first path segment: `ru/paco.bio.md` → `ru`. */
  private languageOf(relativePath: string): string {
    if (this.config.sourceLanguage !== 'auto') return this.config.sourceLanguage;

    const [first, ...rest] = relativePath.split('/');
    if (rest.length > 0 && first && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(first)) return first;

    throw new PlanningError(
      `Cannot infer the language of "${relativePath}". Expected a language directory under ` +
        `input.baseDir, or set input.sourceLanguage explicitly.`,
      { details: { relativePath } },
    );
  }
}
