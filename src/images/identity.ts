/**
 * Stage 1 of `image-index-spec.md` §12: **is this the right person?**
 *
 * The specification's weight table assumes `meta.people` and `meta.title` carry
 * the answer. In the index this was built against they are empty in every
 * single record, so identity rests almost entirely on the path — and the path
 * turns out to say more than the filename alone:
 *
 * | evidence | example | strength |
 * |---|---|---|
 * | `meta.people` | `["Andrés Segovia"]` | conclusive, when present |
 * | given + family name in the filename | `paco_de_lucia.jpg` | very strong |
 * | family name alone in the filename | `segovia_a.jpg` | strong |
 * | the name unsplit | `delucia.jpg`, `pacopena.jpg` | strong |
 * | the name in the directory | `almeida_laurindo/4lalm07.jpg` | good, but album covers live there too |
 * | phonetic equality | `segoviya` ↔ `segovia` | good |
 * | edit distance | `zsapka` ↔ `sapka` | weak on its own |
 *
 * Two penalties do most of the work in practice, and both come from the shape
 * of the archive rather than from the specification:
 *
 *  - **a second surname in the filename.** `buek_segovia.jpg` is a photograph
 *    of two people. It is a *fine* picture of Segovia and a poor avatar.
 *  - **the bucket letter.** That same file sits in `photo/b/`, so the archive
 *    itself says it is filed under Buek. When the bucket letter belongs to
 *    somebody else's name in the same filename, the file is about them.
 *
 * The score is a probability-shaped number in `[0, 1]`, and the acceptance
 * threshold is applied to it directly — `tasks.portrait.minIdentity: 0.9` means
 * exactly what it says.
 */

import { fuzzyThreshold, similarity } from './similarity.js';
import { fold, isNoise, isParticle } from './tokens.js';
import type { NameQuery } from './query.js';
import type { ImageRecord } from './types.js';

/** Every weight in one table, so tuning is one edit and one diff. */
export const IDENTITY = {
  /** Base score of the strongest single piece of evidence. */
  base: {
    metaPeople: 1,
    /**
     * The article embeds this image, and embeds it **first**.
     *
     * Whoever wrote the entry chose the picture that opens it, which is the
     * closest thing to a curated answer the corpus contains. It is also the only
     * evidence that survives a name the index cannot spell: `photo/k/kag.jpg`
     * against the slug `classicalag`.
     */
    articleFirstImage: 0.95,
    /**
     * The article embeds it, further down.
     *
     * Deliberately below the default acceptance threshold. A biography's later
     * pictures are its teachers, its colleagues and its record sleeves as often
     * as they are its subject, so one of those wins only with a name match
     * behind it — which the bonuses below supply when it is genuine.
     */
    articleImage: 0.86,
    fullNameFile: 0.98,
    concatenation: 0.95,
    fullNameDir: 0.94,
    surnameFile: 0.92,
    surnameDir: 0.88,
    metaTitle: 0.9,
    phonetic: 0.86,
    metaKeywords: 0.75,
    metaText: 0.62,
    /** Fuzzy spans `fuzzyFloor … fuzzyCeiling` as similarity spans its threshold … 1. */
    fuzzyFloor: 0.62,
    fuzzyCeiling: 0.9,
  },
  bonus: {
    forename: 0.05,
    initial: 0.02,
    bucket: 0.02,
  },
  penalty: {
    /** Another person's family name in the same filename. */
    foreignName: 0.1,
    foreignNameMax: 0.25,
    /** The archive files this image under somebody else in the same filename. */
    foreignBucket: 0.3,
    jointPhoto: 0.1,
    /** The only evidence is a directory that also holds album covers. */
    directoryOnly: 0.06,
  },
} as const;

export type EvidenceKind =
  | 'article-image'
  | 'meta-people'
  | 'full-name-file'
  | 'concatenation'
  | 'full-name-dir'
  | 'surname-file'
  | 'surname-dir'
  | 'meta-title'
  | 'phonetic'
  | 'meta-keywords'
  | 'meta-text'
  | 'fuzzy';

export interface IdentityVerdict {
  /** `[0, 1]`; compared against `tasks.portrait.minIdentity`. */
  score: number;
  kind: EvidenceKind | 'none';
  /** Short machine-readable notes, in the order they were applied. */
  reasons: string[];
  /** Family names in the path that are not this person's. */
  foreign: string[];
}

const NO_MATCH: IdentityVerdict = { score: 0, kind: 'none', reasons: [], foreign: [] };

/**
 * What this deliberately does **not** try to do: tell two people with the same
 * name apart. `photo/w/john_williams/` cannot be resolved into the guitarist
 * and the film composer by any amount of filename analysis, and a heuristic
 * that guessed would be wrong silently. Where the index is genuinely ambiguous
 * the answer is a curated `img` in `index.json`, which this pipeline never
 * overwrites.
 */
export function scoreIdentity(record: ImageRecord, query: NameQuery): IdentityVerdict {
  const surnames = new Set(query.surnames);
  const forenames = new Set(query.forenames);
  const fileTokens = record.tokens.filter((token) => token.source === 'file');
  const dirTokens = record.tokens.filter((token) => token.source === 'dir');

  const surnameInFile = fileTokens.some((token) => surnames.has(token.text));
  const surnameInDir = dirTokens.some((token) => surnames.has(token.text));
  const forenameInFile = fileTokens.some((token) => forenames.has(token.text));
  const forenameInDir = dirTokens.some((token) => forenames.has(token.text));

  // Held in an object rather than in two `let`s: `consider` writes to them from
  // a closure, which is exactly the case narrowing gets wrong.
  const best: { score: number; kind: EvidenceKind | 'none'; reason: string } = {
    score: 0,
    kind: 'none',
    reason: '',
  };
  const consider = (candidate: number, candidateKind: EvidenceKind, reason: string): void => {
    if (candidate <= best.score) return;
    best.score = candidate;
    best.kind = candidateKind;
    best.reason = reason;
  };

  const embedded = articleImageRank(record, query);
  if (embedded !== undefined) {
    consider(
      embedded === 0 ? IDENTITY.base.articleFirstImage : IDENTITY.base.articleImage,
      'article-image',
      embedded === 0 ? 'the article opens with this image' : `the article embeds this image (#${embedded + 1})`,
    );
  }
  if (matchesMetaPeople(record, query)) {
    consider(IDENTITY.base.metaPeople, 'meta-people', 'meta.people names this person');
  }
  if (surnameInFile && forenameInFile) {
    consider(IDENTITY.base.fullNameFile, 'full-name-file', 'given and family name in the filename');
  } else if (surnameInFile) {
    consider(IDENTITY.base.surnameFile, 'surname-file', 'family name in the filename');
  }
  if (record.concatenations.some((value) => query.concatenations.includes(value))) {
    consider(IDENTITY.base.concatenation, 'concatenation', 'the whole name, written unsplit');
  }
  if (surnameInDir && forenameInDir) {
    consider(IDENTITY.base.fullNameDir, 'full-name-dir', 'given and family name in the directory');
  } else if (surnameInDir) {
    consider(IDENTITY.base.surnameDir, 'surname-dir', 'family name in the directory');
  }
  if (record.meta.title && containsName(record.meta.title, surnames)) {
    consider(IDENTITY.base.metaTitle, 'meta-title', 'meta.title names this person');
  }
  if (!surnameInFile && !surnameInDir && fileTokens.some((token) => query.surnamePhonetics.includes(token.phonetic))) {
    consider(IDENTITY.base.phonetic, 'phonetic', 'family name matches once spelling differences are collapsed');
  }
  if (record.meta.keywords.some((keyword) => containsName(keyword, surnames))) {
    consider(IDENTITY.base.metaKeywords, 'meta-keywords', 'meta.keywords names this person');
  }
  if (
    (record.meta.description && containsName(record.meta.description, surnames)) ||
    (record.meta.ocr && containsName(record.meta.ocr, surnames))
  ) {
    consider(IDENTITY.base.metaText, 'meta-text', 'the family name appears in the description or OCR text');
  }

  if (best.score === 0) {
    const fuzzy = bestFuzzy(record, query);
    if (!fuzzy) return NO_MATCH;
    consider(fuzzy.score, 'fuzzy', `family name within one or two edits of "${fuzzy.token}"`);
  }

  const reasons = [best.reason];
  let score = best.score;

  // --- corroboration ------------------------------------------------------

  if ((forenameInFile || forenameInDir) && best.kind !== 'full-name-file' && best.kind !== 'full-name-dir') {
    score += IDENTITY.bonus.forename;
    reasons.push('given name also present');
  }
  if (!forenameInFile && record.initials.some((initial) => query.forenames.some((name) => name.startsWith(initial)))) {
    score += IDENTITY.bonus.initial;
    reasons.push('given-name initial matches');
  }
  if (record.bucket && query.initials.includes(record.bucket)) {
    score += IDENTITY.bonus.bucket;
    reasons.push(`filed under "${record.bucket}", which is this person's initial`);
  }

  // --- competing subjects -------------------------------------------------

  const foreign = foreignNames(record, query);
  if (foreign.length > 0) {
    const cost = Math.min(IDENTITY.penalty.foreignNameMax, foreign.length * IDENTITY.penalty.foreignName);
    score -= cost;
    reasons.push(`another name in the path: ${foreign.join(', ')}`);
  }
  const bucket = record.bucket;
  if (bucket && !query.initials.includes(bucket) && foreign.some((name) => name.startsWith(bucket))) {
    score -= IDENTITY.penalty.foreignBucket;
    reasons.push(`the archive files this under "${bucket}" — somebody else in the same filename`);
  }
  if (record.markers.includes('joint-photo')) {
    score -= IDENTITY.penalty.jointPhoto;
    reasons.push('filename says the photograph is shared');
  }
  if ((best.kind === 'surname-dir' || best.kind === 'full-name-dir') && !surnameInFile) {
    score -= IDENTITY.penalty.directoryOnly;
    reasons.push('named only by its directory, which also holds release covers');
  }

  // Rounded before it leaves: the score is a sum of two-decimal constants and
  // is compared against a threshold, so `0.94 - 0.06 + 0.02 = 0.8999…` must not
  // be the reason a portrait is rejected.
  const rounded = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
  return { score: rounded, kind: best.kind, reasons, foreign };
}

/** Where this record appears among the article's own images, if it does. */
export function articleImageRank(record: ImageRecord, query: NameQuery): number | undefined {
  if (query.articleImages.size === 0) return undefined;

  const path = record.relPath.toLowerCase();
  const byPath = query.articleImages.get(path);
  if (byPath !== undefined) return byPath;
  return query.articleImages.get(`#${record.fileName.toLowerCase()}`);
}

/** `meta.people` is a full name; compare it whole, never by substring. */
function matchesMetaPeople(record: ImageRecord, query: NameQuery): boolean {
  if (record.meta.people.length === 0) return false;

  const wanted = new Set(query.concatenations);
  return record.meta.people.some((person) => {
    const parts = person.split(/[\s,]+/).map((part) => fold(part)).filter(Boolean);
    if (parts.length === 0) return false;
    if (wanted.has(parts.join(''))) return true;

    const surname = parts.at(-1) ?? '';
    return query.surnames.includes(surname) && parts.some((part) => query.forenames.includes(part));
  });
}

/** A whole-word test: `"Segovia Guitar Festival"` contains `segovia`, `"Segoviana"` does not. */
function containsName(text: string, names: ReadonlySet<string>): boolean {
  return text
    .split(/[^\p{L}]+/u)
    .map((word) => fold(word))
    .some((word) => names.has(word));
}

/**
 * Family names in the path that this person does not answer to.
 *
 * Three exclusions, each of which was a wrong answer before it was added:
 *
 *  - **context words.** `segovia_linares.jpg` names Segovia and the town he was
 *    born in. Reading Linares as a second person pushed a perfectly good
 *    portrait below the threshold.
 *  - **the Cyrillic list.** `nameTokensRu` is a set of *alternative spellings*
 *    of the same filename tokens — `сеговия`, `сеговиа`, `зеговия` — and
 *    counting each variant as a separate person cost 0.2 on every Russian
 *    record in the index. Only Latin filename tokens name a second subject, and
 *    a second subject always has one.
 *  - **initial-plus-stem abbreviations.** `4lalm07.jpg` in `almeida_laurindo/`
 *    is L. Almeida, not somebody called Lalm.
 */
function foreignNames(record: ImageRecord, query: NameQuery): string[] {
  // The concatenations belong here too, or the very token that produced the
  // match — `delucia`, `pacopena` — is counted as a second person.
  const mine = new Set([...query.all, ...query.concatenations]);
  const phonetics = new Set(query.surnamePhonetics);
  const out = new Set<string>();

  for (const token of record.tokens) {
    if (token.source !== 'file' || token.script !== 'latin') continue;
    if (mine.has(token.text) || phonetics.has(token.phonetic)) continue;
    if (query.context.has(token.text) || isNoise(token.text) || isParticle(token.text)) continue;
    if (token.text.length < 4) continue;
    // A near-miss of our own name is a spelling variant, not another person.
    if (query.all.some((name) => similarity(name, token.text) >= 0.75)) continue;
    if (abbreviates(token.text, query.all)) continue;
    out.add(token.text);
  }
  return [...out];
}

/**
 * True when the token reads as a shortening of one of our names.
 *
 * The archive is full of them: `lalm` (L. Almeida), `pbell` (P. Bellow),
 * `nluiz`, `capd`. The rule is deliberately narrow — a stem of at least three
 * letters, optionally behind a single-letter initial — because anything looser
 * starts absorbing genuinely different surnames.
 */
function abbreviates(token: string, names: readonly string[]): boolean {
  const stem = token.length >= 4 ? token.slice(1) : token;
  return names.some(
    (name) =>
      name.length >= 4 &&
      ((token.length >= 3 && name.startsWith(token)) || (stem.length >= 3 && name.startsWith(stem))),
  );
}

interface FuzzyHit {
  score: number;
  token: string;
}

/** The best edit-distance match, scaled into the fuzzy band of the base table. */
function bestFuzzy(record: ImageRecord, query: NameQuery): FuzzyHit | undefined {
  let best: FuzzyHit | undefined;

  for (const token of record.tokens) {
    for (const surname of query.surnames) {
      const threshold = fuzzyThreshold(Math.max(surname.length, token.text.length));
      const value = similarity(surname, token.text);
      if (value < threshold) continue;

      const span = (value - threshold) / Math.max(1e-6, 1 - threshold);
      const { fuzzyFloor, fuzzyCeiling } = IDENTITY.base;
      const scaled = fuzzyFloor + span * (fuzzyCeiling - fuzzyFloor) - (token.source === 'dir' ? 0.04 : 0);
      if (!best || scaled > best.score) best = { score: scaled, token: token.text };
    }
  }
  return best;
}
