import { join } from 'node:path';

import type { Logger } from '../../observability/Logger.js';
import { LineAppender, pathExists, readTextFile } from '../../shared/fs.js';
import { safeJsonParse } from '../../shared/json.js';
import { TranslationMemory } from './TranslationMemory.js';

export type MemoryLifetime = 'off' | 'run' | 'persistent';

interface MemoryEntry {
  k: string;
  v: string;
}

/**
 * Owns the lifetime of every {@link TranslationMemory} in a run.
 *
 * Pipelines used to new one up themselves, which made the *scope* of the cache a
 * private detail of a pipeline rather than a configurable property of the run.
 * Here it is one place, which is also the only place that has to know how a
 * persistent memory is stored.
 *
 * **Namespacing is the whole design.** A memory file is keyed by pipeline *and*
 * prompt version, so editing a translation prompt starts a fresh one. Without
 * that, a prompt edit would correctly invalidate every task fingerprint, the
 * corpus would be re-translated — and the cache would hand back the exact
 * strings the edit was meant to change, silently making the edit a no-op.
 *
 * A persistent memory is a cache, not a record: an entry that fails to write
 * costs one re-translation next time, so appends are logged and never fatal.
 */
export class TranslationMemoryRegistry {
  private readonly memories = new Map<string, Promise<TranslationMemory>>();
  private readonly appenders = new Map<string, LineAppender>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
    /** Off in a dry run: planning must not leave anything behind. */
    private readonly readOnly = false,
  ) {}

  /**
   * The memory for one pipeline and prompt version. Repeated calls with the same
   * namespace return the same instance, so every task of a pipeline shares it.
   */
  async acquire(namespace: string, lifetime: MemoryLifetime): Promise<TranslationMemory> {
    if (lifetime === 'off') return new TranslationMemory(false);

    const key = `${namespace}:${lifetime}`;
    let memory = this.memories.get(key);
    if (!memory) {
      memory = this.open(namespace, lifetime);
      this.memories.set(key, memory);
    }
    return memory;
  }

  async close(): Promise<void> {
    await Promise.all([...this.appenders.values()].map((appender) => appender.close()));
    this.appenders.clear();
  }

  private async open(namespace: string, lifetime: MemoryLifetime): Promise<TranslationMemory> {
    if (lifetime === 'run') return new TranslationMemory(true);

    const file = join(this.dir, `${sanitize(namespace)}.jsonl`);
    const memory = new TranslationMemory(true, (entries) => this.persist(file, entries));
    memory.seed(await this.read(file));
    return memory;
  }

  private async read(file: string): Promise<Map<string, string>> {
    const entries = new Map<string, string>();
    if (!(await pathExists(file))) return entries;

    const raw = await readTextFile(file).catch(() => '');
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const parsed = safeJsonParse<MemoryEntry>(line);
      // A half-written last line is the normal cost of an append-only cache.
      if (parsed.ok && typeof parsed.value?.k === 'string' && typeof parsed.value.v === 'string') {
        entries.set(parsed.value.k, parsed.value.v);
      }
    }
    return entries;
  }

  private persist(file: string, entries: ReadonlyMap<string, string>): void {
    if (this.readOnly) return;

    let appender = this.appenders.get(file);
    if (!appender) {
      appender = new LineAppender(file);
      this.appenders.set(file, appender);
    }

    for (const [k, v] of entries) {
      void appender.append(JSON.stringify({ k, v } satisfies MemoryEntry)).catch((error: unknown) => {
        this.logger.debug('Could not persist a translation memory entry', { file, error: String(error) });
      });
    }
  }
}

function sanitize(namespace: string): string {
  return namespace.replace(/[^a-zA-Z0-9._-]+/g, '-');
}
