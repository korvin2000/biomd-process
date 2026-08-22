/**
 * The staged selection of `image-index-spec.md` §12, and its §16 ordering:
 *
 * ```
 * IDENTITY  →  VISUAL PERSON SUITABILITY  →  PRESENTATION QUALITY
 * ```
 *
 * The two halves never trade against each other. Identity decides *whether*
 * there is an answer at all — a beautiful portrait of the wrong person is not a
 * candidate — and only then does the picture's own quality decide *which*
 * answer. That is why the final key is lexicographic (§14) rather than one
 * weighted sum: a sum lets three small presentation advantages outvote the fact
 * that another file actually has one face in it.
 *
 * Identity is banded before it enters the key. Two candidates whose scores
 * differ by 0.01 are "the same identity quality" in §13's sense, and the
 * picture should decide between them; without banding, an accidental 0.02 from
 * a matching bucket letter would silently override every visual signal.
 */

import { articleImageRank, scoreIdentity, type IdentityVerdict } from './identity.js';
import type { NameQuery } from './query.js';
import { fuzzyThreshold, similarity } from './similarity.js';
import type { SubjectShape } from './subject.js';
import {
  band,
  classRankFor,
  faceRank,
  scoreSuitability,
  type SuitabilityOptions,
  type SuitabilityVerdict,
} from './suitability.js';
import type { ImageIndex, ImageRecord, Orientation } from './types.js';

export interface Candidate {
  record: ImageRecord;
  identity: IdentityVerdict;
  suitability: SuitabilityVerdict;
  /** Sort key, highest first. Exposed so a diagnostic listing can show it. */
  key: number[];
}

export interface SelectOptions extends SuitabilityOptions {
  /** Minimum identity score to publish a portrait at all. */
  minIdentity?: number;
  /** Worst visual tier still allowed to win. */
  maxTier?: number;
  /** How many candidates to keep for diagnostics. */
  keep?: number;
  /**
   * Orientation preference, best first. Defaults to portrait > square >
   * landscape for one person, and the reverse for a collective — a line-up is a
   * wide photograph.
   */
  orientationOrder?: readonly Orientation[];
}

export interface Selection {
  /** The winner, when identity cleared the threshold. */
  chosen?: Candidate;
  /** Everything that matched at all, best first, truncated to `keep`. */
  candidates: Candidate[];
  /** Why nothing was chosen; empty when something was. */
  declined?: string;
}

/** How far down an article's gallery still counts as "earlier than the rest". */
const EMBEDDED_RANKS = 20;

const DEFAULTS = {
  minIdentity: 0.9,
  maxTier: 2,
  keep: 8,
  orientationOrder: ['portrait', 'square', 'landscape'] as const,
  groupOrientationOrder: ['landscape', 'square', 'portrait'] as const,
};

export function selectPortrait(index: ImageIndex, query: NameQuery, options: SelectOptions = {}): Selection {
  const minIdentity = options.minIdentity ?? DEFAULTS.minIdentity;
  const maxTier = options.maxTier ?? DEFAULTS.maxTier;
  const keep = options.keep ?? DEFAULTS.keep;
  const subject = options.subject;
  const orientationOrder =
    options.orientationOrder ??
    (subject?.kind === 'group' ? DEFAULTS.groupOrientationOrder : DEFAULTS.orientationOrder);

  const candidates: Candidate[] = [];
  for (const record of shortlist(index, query)) {
    const identity = scoreIdentity(record, query);
    if (identity.score <= 0) continue;

    const suitability = scoreSuitability(record, options);
    candidates.push({
      record,
      identity,
      suitability,
      key: sortKey(record, identity, suitability, orientationOrder, subject, articleImageRank(record, query)),
    });
  }

  candidates.sort((a, b) => compareKeys(b.key, a.key));

  const usable = candidates.filter(
    (candidate) => !candidate.suitability.excluded && candidate.suitability.tier <= maxTier,
  );
  const chosen = usable.find((candidate) => candidate.identity.score >= minIdentity);
  const trimmed = candidates.slice(0, keep);

  if (chosen) return { chosen, candidates: trimmed };
  return { candidates: trimmed, declined: declineReason(candidates, usable, minIdentity, maxTier) };
}

/**
 * The records worth scoring at all.
 *
 * Three exact lookups against the inverted maps, then — only if they found
 * nothing — a fuzzy pass over the *vocabulary* rather than the corpus. The
 * index has about 1100 distinct tokens against 2000 records, and the fuzzy pass
 * is the expensive one, so it runs last and over the smaller set.
 */
function shortlist(index: ImageIndex, query: NameQuery): ImageRecord[] {
  const found = new Map<string, ImageRecord>();
  const take = (records: readonly ImageRecord[] | undefined): void => {
    for (const record of records ?? []) found.set(record.relPath, record);
  };

  for (const name of query.all) take(index.byToken.get(name));
  for (const key of query.surnamePhonetics) take(index.byPhonetic.get(key));
  for (const value of query.concatenations) {
    take(index.byConcatenation.get(value));
    take(index.byToken.get(value));
  }

  // `meta.people` and friends are the strongest signal the format defines, and
  // they live outside the filename, so they get their own map.
  for (const name of query.all) take(index.byMetaName.get(name));

  // The images the article embeds are candidates whatever they are called: this
  // is the one lookup that survives a file the name index cannot spell.
  for (const key of query.articleImages.keys()) {
    if (key.startsWith('#')) take(index.byFileName.get(key.slice(1)));
    else {
      const record = index.byPath.get(key);
      if (record) take([record]);
    }
  }

  if (found.size === 0) {
    for (const token of index.vocabulary) {
      const near = query.surnames.some(
        (surname) =>
          Math.abs(surname.length - token.length) <= 2 &&
          similarity(surname, token) >= fuzzyThreshold(Math.max(surname.length, token.length)),
      );
      if (near) take(index.byToken.get(token));
    }
  }
  return [...found.values()];
}

/**
 * §14's tuple, highest-is-better in every position.
 *
 * The order is the specification's, and the two coarsenings are the reason it
 * behaves:
 *
 *  - **identity in bands of 0.1.** Above the threshold every candidate is the
 *    right person; a 0.03 difference between "the filename spells the whole
 *    name" and "the filename spells the family name" is not a reason to publish
 *    a worse photograph.
 *  - **`faceCoverage` before the hybrid score.** §14 exists precisely so that
 *    "a minor advantage such as higher megapixels" cannot outrank a bigger
 *    face, and a single weighted score reintroduces exactly that — a colour
 *    picture at 0.15 MP with a face filling 1% of the frame beat a monochrome
 *    one whose subject you can actually see.
 */
function sortKey(
  record: ImageRecord,
  identity: IdentityVerdict,
  suitability: SuitabilityVerdict,
  orientationOrder: readonly Orientation[],
  subject?: SubjectShape,
  embedded?: number,
): number[] {
  const orientationRank = orientationOrder.length - orientationOrder.indexOf(record.orientation);

  return [
    suitability.excluded ? 0 : 1,
    band(identity.score, 0.1),
    -suitability.tier,
    // The archive's own verdict on the file. `unused/` and the technique
    // illustrations are the owner having already decided this picture is not
    // the one to show, which outranks any measurement we can make of it.
    shelved(record) ? 0 : 1,
    // The article's own choice, and its order in it. Whoever wrote the entry
    // put one picture at the top of it; among candidates the matcher rates
    // equally, that is a curated answer and the alternatives are guesses.
    // It sits below the tier deliberately — a first image that is a magazine
    // scan must not outrank a photograph of the subject.
    embedded === undefined ? 0 : Math.max(1, EMBEDDED_RANKS - embedded),
    classRankFor(record.ai.class, subject),
    faceRank(record.ai.faceCount, subject),
    band(record.ai.faceCoverage, 0.05),
    orientationRank,
    band(suitability.score, 0.05),
    band(record.ai.confidence, 0.1),
    record.color === 'color' ? 1 : 0,
    band(record.megapixels, 0.05),
  ];
}

function shelved(record: ImageRecord): boolean {
  return record.markers.includes('unused') || record.markers.includes('illustration');
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Why there is no portrait — as a sentence a person can act on.
 *
 * "no candidate" and "the best candidate is a group photograph" call for
 * completely different responses, and a run that only says `img` was omitted
 * tells nobody which one happened.
 */
function declineReason(
  candidates: readonly Candidate[],
  usable: readonly Candidate[],
  minIdentity: number,
  maxTier: number,
): string {
  if (candidates.length === 0) return 'the image index holds nothing under this name';

  // Identified but unusable, and unusable but unidentified, call for opposite
  // responses — one wants a better photograph, the other a better name.
  const identified = candidates.find((candidate) => candidate.identity.score >= minIdentity);
  if (identified) {
    const why = identified.suitability.excluded ?? `visual tier ${identified.suitability.tier}, worse than ${maxTier}`;
    return (
      `every image of this person is unusable as a portrait — best was ${identified.record.relPath} ` +
      `(identity ${identified.identity.score.toFixed(2)}, ${why})`
    );
  }

  const best = usable[0] ?? candidates[0];
  if (!best) return 'the image index holds nothing under this name';
  return (
    `identity ${best.identity.score.toFixed(2)} is below ${minIdentity.toFixed(2)} — best was ` +
    `${best.record.relPath} (${best.identity.reasons[0] ?? 'weak match'})`
  );
}
