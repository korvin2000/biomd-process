/** One row of `index.json`. Unknown fields are preserved, never rejected. */
export interface CatalogRow {
  id: string;
  title: string;
  lang?: string;
  type: string;
  gender?: string;
  country?: string;
  md: string;
  json?: string;
  img?: string;
  [key: string]: unknown;
}

/**
 * Assigns catalogue ids.
 *
 * `Catalog-Index.md` §3 is emphatic: an id is a decimal string, assigned once,
 * **stable forever and never reused** — it is the join key for every
 * `index-<lang>.json`, and renumbering breaks those silently, with names simply
 * falling back to the Latin title. So an existing index is authoritative, and
 * new entries take the next number above the highest ever seen, never a gap left
 * by a deleted row.
 */
export class IdAllocator {
  private readonly bySlug = new Map<string, CatalogRow>();
  /** Ids handed out during this run, kept apart from `bySlug` so that
   *  `previous()` never invents classification fields for a new entry. */
  private readonly assigned = new Map<string, string>();
  private next: number;

  constructor(existing: readonly CatalogRow[], slugSuffix = '.bio.md') {
    let highest = 0;

    for (const row of existing) {
      if (!row || typeof row.id !== 'string' || typeof row.md !== 'string') continue;

      this.bySlug.set(slugOf(row.md, slugSuffix), row);
      const numeric = Number.parseInt(row.id, 10);
      if (Number.isFinite(numeric)) highest = Math.max(highest, numeric);
    }
    this.next = highest + 1;
  }

  /** The row this slug had in the previous index, if any. */
  previous(slug: string): CatalogRow | undefined {
    return this.bySlug.get(slug);
  }

  idFor(slug: string): string {
    const known = this.bySlug.get(slug)?.id ?? this.assigned.get(slug);
    if (known) return known;

    const id = String(this.next);
    this.next += 1;
    this.assigned.set(slug, id);
    return id;
  }
}

/** `/paco-de-lucia.bio.md` → `paco-de-lucia`. */
function slugOf(mdPath: string, slugSuffix: string): string {
  const name = mdPath.split('/').pop() ?? mdPath;
  return name.endsWith(slugSuffix) ? name.slice(0, -slugSuffix.length) : name.replace(/\.md$/, '');
}
