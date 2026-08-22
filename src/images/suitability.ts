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

import { expectedFaces, faceFit, FACE_FIT_RANK, type FaceFit, type SubjectShape } from './subject.js';
import type { Marker } from './tokens.js';
import type { ImageClass, ImageRecord, Orientation } from './types.js';

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
   * Who the picture must show: one person, or a collective of a known size.
   *
   * Defaults to a soloist, which is what the whole tier structure below was
   * calibrated for. For a duo or a quartet it changes what "one face" means —
   * from the ideal to a photograph of one member.
   */
  subject?: SubjectShape;
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

/**
 * The same table for a collective, with the ranking turned on its head.
 *
 * `group` is the classifier's word for "several people in the frame", which is
 * precisely what a photograph of a duo or a quartet is; `portrait` for such an
 * entry means the archive holds a picture of *one member*, which is the single
 * most misleading avatar available for an ensemble. `other` sits high because
 * the classifier reaches for it whenever a line-up does not look like its idea
 * of a group shot — `eos.jpg`, four faces, class `other`.
 */
const GROUP_CLASS_SCORE: Record<ImageClass, number> = {
  group: 40,
  full_body: 30,
  other: 22,
  unknown: 14,
  upper_body: 12,
  portrait: 6,
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

const GROUP_CLASS_RANK: Record<ImageClass, number> = {
  group: 5,
  full_body: 4,
  other: 3,
  unknown: 2,
  upper_body: 1,
  portrait: 0,
  sheet_music: -100,
};

/** The class ranking that applies to this subject. */
export function classRankFor(klass: ImageClass, subject?: SubjectShape): number {
  return (subject?.kind === 'group' ? GROUP_CLASS_RANK : CLASS_RANK)[klass];
}

const PERSON_CLASSES = new Set<ImageClass>(['portrait', 'upper_body', 'full_body']);
/** Classes that can legitimately hold several people. */
const GROUP_CLASSES = new Set<ImageClass>(['group', 'full_body', 'other', 'unknown', 'upper_body', 'portrait']);

const MARKER_PENALTY: Record<Marker, number> = {
  'release-cover': 20,
  'joint-photo': 6,
  unused: 6,
  illustration: 12,
  'sheet-directory': 60,
  'article-directory': 4,
};

/**
 * The window inside which a face fills a useful part of the frame.
 *
 * Calibrated for one face. A group photograph divides the same frame between
 * everybody in it, and the archive shows exactly that: the correct picture of
 * the Ural trio covers 0.026 and the Kiev quartet 0.019, both far under a floor
 * of 0.04 that was written for a head-and-shoulders portrait. The window is
 * therefore divided by the number of people expected.
 */
const COVERAGE = { floor: 0.04, ideal: 0.3, tight: 0.62 };
/** An unnumbered collective — "ансамбль" — is assumed to be about this big. */
const ASSUMED_GROUP_SIZE = 3;

export function scoreSuitability(record: ImageRecord, options: SuitabilityOptions = {}): SuitabilityVerdict {
  const excluded = exclusionOf(record, options);
  if (excluded) return { tier: 4, score: 0, excluded, reasons: [excluded] };

  const reasons: string[] = [];
  const { class: klass, confidence, faceCount, faceCoverage } = record.ai;

  // §8: confidence adjusts trust in the class, it is not a quality of its own.
  // A `portrait @ 0.99` keeps its whole bonus; a `group @ 0.35` keeps little of
  // its penalty, because the classifier is not sure it is a group either.
  const subject = options.subject;
  const group = subject?.kind === 'group';
  const trust = 0.6 + 0.4 * confidence;
  let score = (group ? GROUP_CLASS_SCORE : CLASS_SCORE)[klass] * trust;
  reasons.push(`${klass} (confidence ${confidence.toFixed(2)})`);

  const fit = faceFit(faceCount, subject);
  score += FACE_SCORE[fit];
  reasons.push(describeFaces(faceCount, fit, subject));

  score += coverageBonus(faceCoverage, subject);
  score += orientationBonus(record.orientation, group);
  score += record.color === 'color' ? 4 : record.color === 'bw' ? 0 : -1;
  score += resolutionBonus(record.megapixels);

  for (const marker of record.markers) {
    const penalty = MARKER_PENALTY[marker];
    if (!penalty) continue;
    score -= penalty;
    reasons.push(`marked as ${marker}`);
  }

  return { tier: tierOf(record, subject), score: normalize(score), reasons };
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

/**
 * §12's tiers, with the `sheet_music` survivor from `exclusionOf` landing in 4.
 *
 * For a collective the ladder is the same shape with a different rung one: the
 * right photograph is the one holding the right number of people, and a
 * single-face portrait — which is tier 1 for a soloist — is a picture of one
 * member and belongs below every group shot the archive has.
 */
export function tierOf(record: ImageRecord, subject?: SubjectShape): VisualTier {
  const { class: klass, faceCount } = record.ai;
  if (klass === 'sheet_music') return 4;

  if (subject?.kind === 'group') {
    const fit = faceFit(faceCount, subject);
    if (fit === 'exact' && GROUP_CLASSES.has(klass)) return 1;
    if (fit === 'plausible' && GROUP_CLASSES.has(klass)) return 2;
    // Nothing detected in a class that could still be the line-up: usable, but
    // only on the archive's word rather than on evidence.
    if (fit === 'unknown' && (klass === 'group' || klass === 'other' || klass === 'full_body')) return 2;
    return 3;
  }

  if (PERSON_CLASSES.has(klass) && faceCount === 1) return 1;
  if (PERSON_CLASSES.has(klass) && faceCount === 0) return 2;
  if (faceCount === 1 && (klass === 'group' || klass === 'other' || klass === 'unknown')) return 2;
  return 3;
}

/** §14's face ranking, against whatever this entry's subject expects. */
export function faceRank(faceCount: number, subject?: SubjectShape): number {
  return FACE_FIT_RANK[faceFit(faceCount, subject)];
}

/**
 * What a face count is worth, once it is known what to compare it against.
 *
 * `unknown` is deliberately neutral rather than negative: `image-index-spec.md`
 * §18 is explicit that a count of zero means the detector found nothing, not
 * that the frame is empty, and several of the archive's best line-up shots
 * detect nobody at all.
 */
const FACE_SCORE: Record<FaceFit, number> = {
  exact: 40,
  plausible: 18,
  unknown: 0,
  'wrong-count': -25,
};

function describeFaces(faceCount: number, fit: FaceFit, subject?: SubjectShape): string {
  if (fit === 'unknown') return 'no face detected';
  const expected = expectedFaces(subject);
  const wanted = expected.ideal === undefined ? `${expected.min} or more` : String(expected.ideal);
  const count = faceCount === 1 ? 'exactly one face' : `${faceCount} faces`;
  return fit === 'exact' ? count : `${count}, expected ${wanted}`;
}

/** A line-up is a wide photograph; a head is a tall one. */
function orientationBonus(orientation: Orientation, group: boolean): number {
  if (orientation === (group ? 'landscape' : 'portrait')) return 8;
  return orientation === 'square' ? 4 : 0;
}

/**
 * §9: prefer a larger face, but do not maximize it — very high coverage is a
 * crop so tight the frame has nothing else in it. Rises to `ideal`, holds, then
 * falls away past `tight`.
 */
function coverageBonus(coverage: number, subject?: SubjectShape): number {
  if (coverage <= 0) return 0;

  const people = subject?.kind === 'group' ? (subject.size ?? ASSUMED_GROUP_SIZE) : 1;
  const floor = COVERAGE.floor / people;
  const ideal = COVERAGE.ideal / people;
  const tight = COVERAGE.tight / people;

  if (coverage < ideal) return (15 * Math.max(0, coverage - floor)) / (ideal - floor);
  if (coverage <= tight) return 15;
  return Math.max(4, 15 - (coverage - tight) * 30 * people);
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
