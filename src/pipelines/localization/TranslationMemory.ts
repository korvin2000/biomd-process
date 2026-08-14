import type { LocalizationUnit } from './StringTable.js';

export interface MemoryStats {
  hits: number;
  misses: number;
  entries: number;
}

/**
 * Run-scoped cache of translated strings, keyed by (target language, content hash).
 *
 * Catalogue field values repeat heavily across a corpus — every guitarist is a
 * `Гитарист`, half of them play `фламенко`. Because {@link collectUnits} keys by
 * content hash, the second occurrence anywhere in the run is free.
 *
 * The trade-off is deliberate: one source string gets one translation per
 * language, run-wide. For short catalogue values that is the *desired* property
 * — the format guide wants editions to agree — but it does mean a homograph
 * whose correct rendering depends on context is resolved once.
 *
 * TODO: persist across runs (a JSONL sidecar keyed the same way) so a re-run
 * over a grown corpus pays only for what is new.
 */
export class TranslationMemory {
  private readonly entries = new Map<string, string>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly enabled: boolean = true) {}

  /** Splits a batch into what is already known and what must be asked for. */
  partition(
    language: string,
    units: readonly LocalizationUnit[],
  ): { known: Map<string, string>; unknown: LocalizationUnit[] } {
    const known = new Map<string, string>();
    const unknown: LocalizationUnit[] = [];

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
    for (const [key, value] of translations) this.entries.set(this.id(language, key), value);
  }

  stats(): MemoryStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size };
  }

  private id(language: string, key: string): string {
    return `${language}:${key}`;
  }
}
