/**
 * *Who* the picture is supposed to show — one person, or how many.
 *
 * Every threshold in `suitability.ts` was written for a soloist: one detected
 * face is the ideal, two are a penalty, and a `group` classification is close to
 * disqualifying. That is right for four fifths of this corpus and exactly wrong
 * for the rest of it, because a duo's portrait *has* two faces in it and a
 * quartet's has four. Against the real index the effect was total: the correct
 * photograph of the Ural Guitar Trio scores identity 0.97 and is then thrown
 * away as visual tier 3, so the entry gets no picture at all.
 *
 * So the expectation becomes an input. `ai.faceCount` is the index's own count
 * of the people in the frame, which makes it the single most discriminating
 * signal available for a collective — `tornado_duet.jpg` (2 faces) against
 * `kovtunov_tornado.jpg` (1 face, a portrait of one of the two players).
 *
 * The shape is read from the entry's **title**, never from its prose. See
 * {@link ../domain/vocabulary.js#resolveEnsemble}.
 */

import { resolveEnsemble } from '../domain/vocabulary.js';

export interface SubjectShape {
  kind: 'solo' | 'group';
  /** How many people a photograph of this subject should contain, when known. */
  size?: number;
  /** What decided it — carried into the hint file so a wrong answer is traceable. */
  evidence: string;
}

export const SOLO_SUBJECT: SubjectShape = { kind: 'solo', evidence: 'nothing names a collective' };

export interface SubjectInput {
  /** Title lines of the article, best evidence first. */
  titles?: readonly string[];
  /** Names from the roster — the collective's own, as the catalogue lists it. */
  names?: readonly string[];
  /** The slug: `eos_quartet`, `trio_ural`, `granduet`. */
  slug?: string;
}

/**
 * The three sources in the order they deserve to be trusted.
 *
 * The article's own title is written by whoever knew; the roster is a
 * hand-maintained list that is occasionally stale; the slug is a filename that
 * may be an abbreviation (`classicalag`) or say nothing at all (`amadeus`,
 * `tornado`). A source that names a *number* beats one that only says
 * "ensemble", whichever of them it is — `квартет` is a more specific claim than
 * `ансамбль`, and both are more specific than silence.
 */
export function detectSubject(input: SubjectInput): SubjectShape {
  const sources: Array<{ label: string; text: string }> = [
    ...(input.titles ?? []).map((text) => ({ label: 'the title', text })),
    ...(input.names ?? []).map((text) => ({ label: 'the roster name', text })),
    ...(input.slug ? [{ label: 'the slug', text: input.slug.replace(/[_-]+/g, ' ') }] : []),
  ];

  let best: SubjectShape | undefined;

  for (const source of sources) {
    const ensemble = resolveEnsemble(source.text);
    if (!ensemble.group) continue;

    const candidate: SubjectShape = {
      kind: 'group',
      ...(ensemble.size === undefined ? {} : { size: ensemble.size }),
      evidence: `${source.label} says "${ensemble.word}"`,
    };
    // First source wins at equal specificity; a number always beats none.
    if (!best || (candidate.size !== undefined && best.size === undefined)) best = candidate;
  }

  return best ?? SOLO_SUBJECT;
}

export interface FaceExpectation {
  /** Fewer faces than this and the picture cannot be of the whole subject. */
  min: number;
  /** The exact count that makes it the right photograph, when it is known. */
  ideal?: number;
}

export function expectedFaces(subject: SubjectShape | undefined): FaceExpectation {
  if (!subject || subject.kind === 'solo') return { min: 1, ideal: 1 };
  if (subject.size === undefined) return { min: 2 };
  return { min: Math.min(2, subject.size), ideal: subject.size };
}

/**
 * How well a detected face count matches the subject, as one of four bands.
 *
 * Banded rather than continuous because it feeds a lexicographic key: the
 * question at that point is "is this the right kind of photograph", and a
 * five-face shot of a quartet and a two-face shot of it are the same answer —
 * *nearly*, and the picture's own quality should decide between them.
 */
export type FaceFit = 'exact' | 'plausible' | 'wrong-count' | 'unknown';

export function faceFit(faceCount: number, subject: SubjectShape | undefined): FaceFit {
  // §18: a face count of zero is a detector that found nothing, which is not the
  // same statement as "there is nobody in this photograph".
  if (faceCount <= 0) return 'unknown';

  const { min, ideal } = expectedFaces(subject);
  if (ideal === undefined) return faceCount >= min ? 'exact' : 'wrong-count';
  if (faceCount === ideal) return 'exact';

  // One neighbour off is a line-up with a guest, or a member the detector
  // missed — still a photograph of the group, still not the ideal one. It has
  // no counterpart for a soloist: two faces in a portrait of one person is
  // somebody else in the frame, which is the original calibration and stays.
  if (ideal > 1 && faceCount >= min && Math.abs(faceCount - ideal) <= 1) return 'plausible';
  return 'wrong-count';
}

/** Highest is best; the lexicographic key uses this directly. */
export const FACE_FIT_RANK: Record<FaceFit, number> = {
  exact: 3,
  plausible: 2,
  unknown: 1,
  'wrong-count': 0,
};

export function describeSubject(subject: SubjectShape): string {
  if (subject.kind === 'solo') return 'one person';
  return subject.size === undefined ? 'a collective' : `a collective of ${subject.size}`;
}
