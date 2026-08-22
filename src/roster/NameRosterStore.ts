/**
 * Reads the roster once and hands out a slug-keyed index.
 *
 * One load per run, cached by absolute path, exactly like {@link
 * ../images/ImageIndexStore.ts}: three pipelines ask it the same question for
 * every document in the corpus.
 */

import { ConfigError } from '../shared/errors.js';
import { pathExists, readJsonFile } from '../shared/fs.js';
import { toRosterEntry } from './entry.js';
import { EMPTY_ROSTER, type NameRoster, type RawRosterRecord, type RosterEntry } from './types.js';

export interface RosterLoadOptions {
  /** Stripped from a record's `url` to produce the slug. */
  slugSuffix: string;
  /** The language the roster is written in. */
  language: string;
}

export class NameRosterStore {
  private readonly cache = new Map<string, Promise<NameRoster>>();

  constructor(private readonly paths: { resolve(...segments: string[]): string }) {}

  /**
   * Loads and caches. An empty `file` means the feature is off and yields the
   * empty roster; a *configured* file that is missing is an error, because a
   * mistyped path and a deliberately absent roster must not look the same.
   */
  async load(file: string, options: RosterLoadOptions): Promise<NameRoster> {
    if (!file.trim()) return EMPTY_ROSTER;

    const resolved = this.paths.resolve(file);
    const cached = this.cache.get(resolved);
    if (cached) return cached;

    const pending = this.read(resolved, options);
    this.cache.set(resolved, pending);
    return pending;
  }

  private async read(file: string, options: RosterLoadOptions): Promise<NameRoster> {
    if (!(await pathExists(file))) {
      throw new ConfigError(`Name roster not found: ${file}`, {
        details: { hint: 'Set roster.file to the extracted name index, or clear it to run without one.' },
      });
    }

    const raw = await readJsonFile<unknown>(file).catch((error: unknown) => {
      throw new ConfigError(`Name roster at ${file} is not readable JSON`, { cause: error });
    });

    // Both shapes are accepted: the bare array the extractor produces, and the
    // wrapped `{ names: [...] }` a later version may grow.
    const records = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { names?: unknown })?.names)
        ? ((raw as { names: unknown[] }).names)
        : undefined;

    if (!records) {
      throw new ConfigError(`Name roster at ${file} is neither an array nor an object with a \`names\` array.`);
    }

    return buildRoster(records as RawRosterRecord[], file, options);
  }
}

/** Exposed for tests and for anything that already holds the parsed records. */
export function buildRoster(
  records: readonly RawRosterRecord[],
  source: string,
  options: RosterLoadOptions,
): NameRoster {
  const entries: RosterEntry[] = [];
  const bySlug = new Map<string, RosterEntry>();
  let skipped = 0;
  let nonNameRecords = 0;

  for (const record of records) {
    const entry = toRosterEntry(record, { slugSuffix: options.slugSuffix });
    if (!entry) {
      skipped += 1;
      continue;
    }
    if (!entry.personName && !entry.ensemble.group) nonNameRecords += 1;

    entries.push(entry);
    // First wins: a duplicated slug is a data defect, and the later record is
    // as likely to be the wrong one as the earlier.
    if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, entry);
  }

  return { entries, bySlug, language: options.language, source, skipped, nonNameRecords };
}
