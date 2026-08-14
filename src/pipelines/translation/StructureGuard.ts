import { compareSkeletons } from '../../documents/markdown/skeleton.js';

export interface StructureVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Checks that a translation is the same document with different words.
 *
 * Models drop `:::` containers, promote paragraphs to headings and rewrite URLs;
 * none of that shows up in a fluency check but all of it breaks the renderer.
 * Comparing structural skeletons catches it for the price of a regex pass, and
 * because the failure is reported to the gateway as a validation error, the
 * usual retry-then-fall-back-to-a-stronger-model machinery handles it.
 *
 * TODO(domain): decide which divergences are tolerable (a translator legitimately
 * merging two sentences into one paragraph is currently reported as a mismatch)
 * and make the strictness configurable per project.
 */
export class StructureGuard {
  constructor(private readonly enabled: boolean) {}

  verify(source: string, translation: string): StructureVerdict {
    if (!this.enabled) return { ok: true };

    const comparison = compareSkeletons(source, translation);
    if (comparison.ok) return { ok: true };

    const scale =
      comparison.sourceLength === comparison.targetLength
        ? ''
        : ` (${comparison.sourceLength} source elements vs ${comparison.targetLength})`;
    return {
      ok: false,
      reason: `Markdown structure diverged${scale}: ${comparison.differences.join('; ')}`,
    };
  }
}
