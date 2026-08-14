import { compareSkeletons, type SkeletonMode } from '../../documents/markdown/skeleton.js';

export interface StructureVerdict {
  ok: boolean;
  reason?: string;
}

/** `off` skips the check entirely; the other two are {@link SkeletonMode}. */
export type StructureStrictness = 'off' | SkeletonMode;

/**
 * Checks that a translation is the same document with different words.
 *
 * Models drop `:::` containers, promote paragraphs to headings and rewrite URLs;
 * none of that shows up in a fluency check but all of it breaks the renderer.
 * Comparing structural skeletons catches it for the price of a regex pass, and
 * because the failure is reported to the gateway as a validation error, the
 * usual retry-then-fall-back-to-a-stronger-model machinery handles it.
 *
 * Strictness is a per-project decision because the two translation modes differ
 * in what the guard is *for*. In `segments` mode the skeleton was never sent, so
 * it cannot legitimately change and `strict` is free — a failure there means the
 * span extractor missed something, which is worth knowing. In `document` mode
 * the model holds the markup, and joining two short paragraphs is a defensible
 * translator's choice that `lenient` tolerates while still refusing a lost
 * heading, container, table or URL.
 */
export class StructureGuard {
  private readonly strictness: StructureStrictness;

  constructor(strictness: StructureStrictness | boolean) {
    this.strictness = typeof strictness === 'boolean' ? (strictness ? 'strict' : 'off') : strictness;
  }

  verify(source: string, translation: string): StructureVerdict {
    if (this.strictness === 'off') return { ok: true };

    const comparison = compareSkeletons(source, translation, { mode: this.strictness });
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
