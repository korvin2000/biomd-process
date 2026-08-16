/**
 * Stages 2 and 3 of `image-index-spec.md` §12: **is this picture usable as one
 * person's avatar?** — asked only after identity, never instead of it.
 *
 * The tier structure is the specification's, unchanged. The numbers are not:
 * they are calibrated against the actual distribution of the index this runs
 * on, where
 *
 *  - `ai.confidence` is low across the board (median 0.54 for `portrait`, 0.41
 *    for `upper_body`), so an absolute confidence gate would reject nearly
 *    everything. Confidence modulates trust in the class, exactly as §8 says,
 *    and never stands on its own;
 *  - the images are small (median 0.04 MP, 90th percentile 0.17 MP), so a
 *    resolution term scaled for modern photographs would be a constant;
 *  - `sheet_music` fires with a face detected 235 times out of 701, which means
 *    a *confident* `sheet_music` is a hard exclusion but a hesitant one with a
 *    face in it is merely a bad candidate.
 */

import type { Marker } from './tokens.js';
import type { ImageClass, ImageRecord } from './types.js';

export type VisualTier = 1 | 2 | 3 | 4;

export interface SuitabilityVerdict {
  /** §12 tier. 1 is preferred, 4 is "only if nothing else exists". */
  tier: VisualTier;
  /** The §15 hybrid score, normalized into `[0, 1]`. */
  score: number;
  /** Set when the record must not be used at all. */
  excluded?: string;
  reasons: string[];
}

export interface SuitabilityOptions {
  /** Classes rejected outright. Defaults to `sheet_music`. */
  excludeClasses?: readonly ImageClass[];
  /** Below this, a picture is too small to crop into an avatar. */
  minPixels?: number;
  /**
   * Treat an album/CD cover as unusable rather than merely poor. **On by
   * default**: a release cover is artwork with the artist's name printed on it,
   * and the archive is full of them (`pena_cd05_1993.jpg` classifies as a
   * clean single-face portrait and is a record sleeve). What is wanted is a
   * photograph of the person.
   */
  excludeReleaseCovers?: boolean;
}

const CLASS_SCORE: Record<ImageClass, number> = {
  portrait: 40,
  upper_body: 32,
  full_body: 22,
  group: 2,
  other: 0,
  unknown: 0,
  sheet_music: -100,
};

/** §14's class ranking, used for the lexicographic tie-break. */
export const CLASS_RANK: Record<ImageClass, number> = {
  portrait: 5,
  upper_body: 4,
  full_body: 3,
  group: 2,
  other: 1,
  unknown: 0,
  sheet_music: -100,
};

const PERSON_CLASSES = new Set<ImageClass>(['portrait', 'upper_body', 'full_body']);

const MARKER_PENALTY: Record<Marker, number> = {
  'release-cover': 20,
  'joint-photo': 6,
  unused: 6,
  illustration: 12,
  'sheet-directory': 60,
  'article-directory': 4,
};

/** The window inside which a face fills a useful part of the frame. */
const COVERAGE = { floor: 0.04, ideal: 0.3, tight: 0.62 };

export function scoreSuitability(record: ImageRecord, options: SuitabilityOptions = {}): SuitabilityVerdict {
  const excluded = exclusionOf(record, options);
  if (excluded) return { tier: 4, score: 0, excluded, reasons: [excluded] };

  const reasons: string[] = [];
  const { class: klass, confidence, faceCount, faceCoverage } = record.ai;

  // §8: confidence adjusts trust in the class, it is not a quality of its own.
  // A `portrait @ 0.99` keeps its whole bonus; a `group @ 0.35` keeps little of
  // its penalty, because the classifier is not sure it is a group either.
  const trust = 0.6 + 0.4 * confidence;
  let score = CLASS_SCORE[klass] * trust;
  reasons.push(`${klass} (confidence ${confidence.toFixed(2)})`);

  if (faceCount === 1) {
    score += 40;
    reasons.push('exactly one face');
  } else if (faceCount > 1) {
    score -= 25;
    reasons.push(`${faceCount} faces`);
  } else {
    // §18: no face detected is not proof that no person is present.
    reasons.push('no face detected');
  }

  score += coverageBonus(faceCoverage);
  score += record.orientation === 'portrait' ? 8 : record.orientation === 'square' ? 4 : 0;
  score += record.color === 'color' ? 4 : record.color === 'bw' ? 0 : -1;
  score += resolutionBonus(record.megapixels);

  for (const marker of record.markers) {
    const penalty = MARKER_PENALTY[marker];
    if (!penalty) continue;
    score -= penalty;
    reasons.push(`marked as ${marker}`);
  }

  return { tier: tierOf(record), score: normalize(score), reasons };
}

function exclusionOf(record: ImageRecord, options: SuitabilityOptions): string | undefined {
  const excludeClasses = options.excludeClasses ?? ['sheet_music'];
  const minPixels = options.minPixels ?? 80;

  if (record.markers.includes('sheet-directory')) return 'lives in the sheet-music tree';
  if (excludeClasses.includes(record.ai.class)) {
    // A hesitant `sheet_music` with a face in it is the classifier's mistake
    // often enough to be worth keeping in the bottom tier.
    if (record.ai.class === 'sheet_music' && record.ai.faceCount === 1 && record.ai.confidence < 0.6) {
      return undefined;
    }
    return `classified ${record.ai.class}`;
  }
  if (options.excludeReleaseCovers !== false && record.markers.includes('release-cover')) {
    return 'a release cover, not a portrait';
  }
  if (record.width > 0 && Math.min(record.width, record.height) < minPixels) {
    return `too small (${record.width}×${record.height})`;
  }
  return undefined;
}

/** §12's tiers, with the `sheet_music` survivor from `exclusionOf` landing in 4. */
export function tierOf(record: ImageRecord): VisualTier {
  const { class: klass, faceCount } = record.ai;

  if (PERSON_CLASSES.has(klass) && faceCount === 1) return 1;
  if (PERSON_CLASSES.has(klass) && faceCount === 0) return 2;
  if (faceCount === 1 && (klass === 'group' || klass === 'other' || klass === 'unknown')) return 2;
  if (klass === 'sheet_music') return 4;
  return 3;
}

/** §14's face ranking. */
export function faceRank(faceCount: number): number {
  if (faceCount === 1) return 3;
  if (faceCount === 0) return 1;
  return 0;
}

/**
 * §9: prefer a larger face, but do not maximize it — very high coverage is a
 * crop so tight the frame has nothing else in it. Rises to `ideal`, holds, then
 * falls away past `tight`.
 */
function coverageBonus(coverage: number): number {
  if (coverage <= 0) return 0;
  if (coverage < COVERAGE.ideal) {
    return (15 * Math.max(0, coverage - COVERAGE.floor)) / (COVERAGE.ideal - COVERAGE.floor);
  }
  if (coverage <= COVERAGE.tight) return 15;
  return Math.max(4, 15 - (coverage - COVERAGE.tight) * 30);
}

/** Bounded and log-shaped, so a big group photo cannot outrank a small portrait. */
function resolutionBonus(megapixels: number): number {
  if (megapixels <= 0) return 0;
  const value = Math.log10(megapixels / 0.01) * 3;
  return Math.max(0, Math.min(8, value));
}

/** The raw §15 score runs about −30…110; map it onto `[0, 1]` for reporting. */
function normalize(score: number): number {
  return Math.max(0, Math.min(1, (score + 30) / 140));
}

/** Coarse bands, so a hair's difference cannot reorder the lexicographic key. */
export function band(value: number, step: number): number {
  return Math.round(value / step);
}
