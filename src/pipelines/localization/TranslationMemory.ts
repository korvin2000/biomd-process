export interface MemoryStats {
  hits: number;
  misses: number;
  entries: number;
}

/**
 * Cache of translated strings, keyed by (target language, content hash).
 *
 * Catalogue field values repeat heavily across a corpus — every guitarist is a
 * `Гитарист`, half of them play `фламенко`. Because {@link collectUnits} keys by
 * content hash, the second occurrence anywhere is free.
 *
 * The trade-off is deliberate: one source string gets one translation per
 * language. For short catalogue values that is the *desired* property — the
 * format guide wants editions to agree — but it does mean a homograph whose
 * correct rendering depends on context is resolved once.
 *
 * Lifetime is the caller's choice (see `TranslationMemoryRegistry`): a run-scoped
 * memory forgets everything at exit, a persistent one is seeded from disk and
 * reports what it learns, so a re-run over a grown corpus pays only for the
 * strings that are new.
 */
export class TranslationMemory {
  private readonly entries = new Map<string, string>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly enabled: boolean = true,
    /** Called with the newly learned entries only — never with a cache hit. */
    private readonly onLearn?: (entries: ReadonlyMap<string, string>) => void,
  ) {}

  /** Preloads entries from a previous run. Keys are `<language>:<hash>`. */
  seed(entries: ReadonlyMap<string, string>): void {
    if (!this.enabled) return;
    for (const [key, value] of entries) this.entries.set(key, value);
  }

  /**
   * Splits a batch into what is already known and what must be asked for.
   *
   * Generic over the unit so the cache knows nothing about dossiers or Markdown
   * spans — a content hash is all it needs, and both callers already have one.
   */
  partition<T extends { key: string }>(
    language: string,
    units: readonly T[],
  ): { known: Map<string, string>; unknown: T[] } {
    const known = new Map<string, string>();
    const unknown: T[] = [];

    for (const unit of units) {
      const cached = this.enabled ? this.entries.get(this.id(language, unit.key)) : undefined;
      if (cached === undefined) {
        this.misses += 1;
        unknown.push(unit);
      } else {
        this.hits += 1;
        known.set(unit.key, cached);
      }
    }
    return { known, unknown };
  }

  remember(language: string, translations: ReadonlyMap<string, string>): void {
    if (!this.enabled) return;

    const learned = new Map<string, string>();
    for (const [key, value] of translations) {
      const id = this.id(language, key);
      if (this.entries.get(id) === value) continue;
      this.entries.set(id, value);
      learned.set(id, value);
    }
    if (learned.size > 0) this.onLearn?.(learned);
  }

  stats(): MemoryStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size };
  }

  private id(language: string, key: string): string {
    return `${language}:${key}`;
  }
}
