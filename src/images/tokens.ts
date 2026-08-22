/**
 * Turning a path into name evidence.
 *
 * `image-index-spec.md` treats `nameTokens` as the filename split on separators
 * and leaves it there. Real indexes carry more than that, and the difference
 * decides whether a match is a portrait of the right person:
 *
 *  - **the bucket letter.** `photo/<letter>/` is the initial of the *subject the
 *    file is filed under*. `photo/b/buek_segovia.jpg` is Buek's photo, in which
 *    Segovia also appears — a fine picture, and the wrong avatar for Segovia.
 *  - **the directory.** `photo/a/almeida_laurindo/4lalm07.jpg` has no usable
 *    filename tokens at all; the person's name is one level up. But the same
 *    shape holds album covers (`photo/p/paco_de_lucia/siroco.jpg`), so a
 *    directory match is evidence of a weaker kind than a filename match.
 *  - **the markers.** `pena_cd07_2000`, `pena_lp16_1978`, `unused/`,
 *    `with_pacopena`, `segovia_tech/` — a release cover, a discarded file, a
 *    joint photograph, a technique illustration. All of them name the person
 *    correctly and none of them is a portrait.
 *
 * Nothing here is specific to guitarists; it is specific to how a filesystem of
 * scanned photographs is habitually organized.
 */

import { foldToAscii } from '../domain/romanize.js';

export type TokenSource = 'file' | 'dir';
export type TokenScript = 'latin' | 'cyrillic';

export interface NameToken {
  /** Folded, lower-case, digits stripped. */
  text: string;
  source: TokenSource;
  script: TokenScript;
  /** Collision key for spellings that differ only by transliteration habit. */
  phonetic: string;
}

/**
 * Why a candidate is something other than a portrait of one person.
 *
 * Kept separate from the score so a diagnostic listing can say *which* problem
 * the file has, rather than showing a number that mysteriously sank.
 */
export type Marker =
  | 'release-cover'
  | 'joint-photo'
  | 'unused'
  | 'illustration'
  | 'sheet-directory'
  | 'article-directory';

/** Words that are never a person's name, and must not be matched or penalized as one. */
const NOISE = new Set([
  // media and release vocabulary
  'cd', 'cds', 'lp', 'lps', 'ep', 'dvd', 'vhs', 'lcd', 'cdr', 'mc', 'vinyl', 'album', 'cover', 'covers',
  'disc', 'disk', 'box', 'set', 'vol', 'part', 'pt',
  // publications and events
  'book', 'books', 'poster', 'afisha', 'program', 'programme', 'magazine', 'journal', 'press', 'pub',
  'concert', 'festival', 'award', 'diplom', 'diploma', 'logo', 'banner', 'flyer', 'ticket',
  // musical content
  'guitar', 'guitars', 'gitara', 'score', 'scores', 'note', 'notes', 'noty', 'tab', 'tabs', 'tablature',
  'sheet', 'music', 'song', 'songs', 'suite', 'sonata', 'concerto', 'etude', 'etudes', 'opus', 'op',
  'trio', 'duo', 'duet', 'quartet', 'quintet', 'ensemble', 'orchestra', 'band', 'group',
  // file and variant markers
  'unused', 'old', 'new', 'copy', 'small', 'big', 'large', 'thumb', 'thumbs', 'icon', 'mini', 'preview',
  'orig', 'original', 'final', 'draft', 'temp', 'tmp', 'img', 'image', 'photo', 'photos', 'pic', 'pics',
  'picture', 'foto', 'scan', 'scans', 'tech', 'technique', 'shkola', 'school', 'lesson', 'master',
  'class', 'with', 'and', 'feat', 'featuring', 'portrait', 'young', 'old',
  // months, in the two languages these filenames use
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

/** A token that is a release marker in itself: `cd07`, `lp16`, `dvd38`, `disc03`. */
const RELEASE_TOKEN = /^(?:cd|lp|ep|dvd|vhs|lcd|cdr|mc|track|side|disc|disk|album)\d+[a-z]?$/;

/** Path segments that carry no name and must not be read as one. */
const STRUCTURAL_SEGMENTS = new Set(['photo', 'photos', 'images', 'img', 'files', 'unused', 'thumbs', 'small']);

const PARTICLES = new Set([
  'de', 'del', 'della', 'dello', 'di', 'da', 'das', 'dos', 'du', 'van', 'von', 'der', 'den', 'ter',
  'la', 'le', 'el', 'al', 'bin', 'ibn', 'ben', 'mac', 'mc', 'st', 'saint', 'san',
  // The same particles as a Russian article spells them.
  'де', 'дель', 'ди', 'да', 'дос', 'ван', 'фон', 'ла', 'ле', 'эль', 'аль', 'сан',
]);

export function isParticle(token: string): boolean {
  return PARTICLES.has(token);
}

export function isNoise(token: string): boolean {
  return NOISE.has(token) || RELEASE_TOKEN.test(token) || /^\d+$/.test(token) || token.length < 2;
}

/** `"Andres"` → `"andres"`; `"Сеговия"` → `"сеговия"`; accents folded, digits dropped. */
export function fold(value: string): string {
  return foldToAscii(value).toLowerCase().replace(/[^\p{L}]/gu, '');
}

export function scriptOf(value: string): TokenScript {
  return /\p{Script=Cyrillic}/u.test(value) ? 'cyrillic' : 'latin';
}

/**
 * A spelling-insensitive key for a name.
 *
 * Transliteration is the dominant source of variation in this data — the same
 * person is `schmidt`/`shmidt`, `kuznetsov`/`kuznecov`, `zsapka`/`sapka` — and
 * an edit-distance test alone rates those as far apart as two genuinely
 * different surnames. Collapsing the digraphs that transliteration schemes
 * disagree about turns most of that variation into an exact match, and the ones
 * it misses still reach the fuzzy stage.
 *
 * Deliberately *not* Soundex: Soundex was built for English surnames, drops
 * everything after four characters, and would merge names this index really
 * does contain side by side.
 */
export function phoneticKey(value: string): string {
  let key = fold(value);
  if (!key) return '';

  if (scriptOf(value) === 'cyrillic') return key;

  key = key
    .replace(/sch|shch/g, 'sh')
    .replace(/tsch|tsh/g, 'ch')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'kv')
    .replace(/[qk]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/[yj]/g, 'i')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');

  // Vowels are the least stable part of a transliteration, but dropping them
  // all merges too much. The first and last letters stay; the interior loses
  // its vowels, which is what turns `segovia`/`segoviya` into one key.
  if (key.length <= 2) return key;
  return key[0] + key.slice(1, -1).replace(/[aeiou]/g, '') + key.slice(-1);
}

/**
 * Splits one path component into candidate name tokens.
 *
 * Digits are stripped rather than split on, which is what the index itself does
 * (`4lalm07.jpg` → `lalm`): a number in one of these filenames is a sequence, a
 * year or a catalogue number, never part of a name.
 */
export function splitTokens(value: string): string[] {
  return value
    .split(/[\s_\-.+()[\]]+/)
    .map((part) => fold(part))
    .filter((part) => part.length > 0);
}

export interface PathAnalysis {
  /** `photo/s/…` → `s`. Absent for a tree that is not bucketed by letter. */
  bucket?: string;
  /** Name tokens from the filename, then from the directories above it. */
  tokens: NameToken[];
  /** Whole-basename spellings: `delucia`, `pacopena` — a name written unsplit. */
  concatenations: string[];
  /** Leading initials the index drops as too short: `f_sor` → `f`, `ju_smirnov` → `ju`. */
  initials: string[];
  markers: Marker[];
}

/**
 * Everything a path says about who and what the image is.
 *
 * The index's own `nameTokens` are used as well (they are the same split, and
 * agreeing with them costs nothing) but they are not enough on their own:
 * they are computed from the filename only, and they discard the one-and
 * two-letter fragments that carry the given-name initial.
 */
export function analysePath(relPath: string): PathAnalysis {
  const segments = relPath.split('/').filter(Boolean);
  const fileName = segments.at(-1) ?? '';
  const directories = segments.slice(0, -1);
  const lower = relPath.toLowerCase();

  const bucket = /^photos?\/([a-z])(?:\/|$)/i.exec(relPath)?.[1]?.toLowerCase();
  const base = fileName.replace(/\.[a-z0-9]+$/i, '');

  const markers: Marker[] = [];
  if (directories.some((segment) => segment.toLowerCase() === 'unused')) markers.push('unused');
  if (/(?:^|[_\-/])(?:with|and|feat)[_\-]/i.test(lower)) markers.push('joint-photo');
  // `\b` is useless here: `_` is a word character, so it never fires between
  // `pena` and `_cd05`. Every release marker in this archive is written that way.
  // `disc03` belongs here for the same reason `cd05` does: it is a sleeve with
  // the artist's name printed on it, and this archive numbers them both ways.
  if (
    /(?:^|[^a-z])(?:cd|lp|ep|dvd|vhs|lcd|disc|disk|album)\d/i.test(base) ||
    /(?:^|[_\-])(?:cover|obl|sleeve)(?:[_\-]|$)/i.test(base)
  ) {
    markers.push('release-cover');
  }
  if (/(?:tech|technique|shkola|school|book|notes?|scores?|tabs?)(?:$|[_\-/])/i.test(lower)) {
    markers.push('illustration');
  }
  if (lower.startsWith('music/scores')) markers.push('sheet-directory');
  if (lower.startsWith('articles/')) markers.push('article-directory');

  const tokens: NameToken[] = [];
  const seen = new Set<string>();
  const push = (raw: string, source: TokenSource): void => {
    const text = fold(raw);
    if (!text || isNoise(text)) return;
    const key = `${source}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push({ text, source, script: scriptOf(raw), phonetic: phoneticKey(raw) });
  };

  const fileParts = base.split(/[\s_\-.+()[\]]+/).filter(Boolean);
  const initials: string[] = [];
  for (const part of fileParts) {
    const folded = fold(part);
    // A fragment of one or two letters is an initial, not a name — on either
    // side of the family name: `f_sor` is Fernando Sor, `bream_j` is Julian
    // Bream, `ju_smirnov` is Yuri Smirnov. `push` drops them as noise anyway,
    // so the only place they can still count is here.
    if (folded.length > 0 && folded.length <= 2) initials.push(folded);
    push(part, 'file');
  }
  for (const directory of directories) {
    if (STRUCTURAL_SEGMENTS.has(directory.toLowerCase()) || directory.length <= 2) continue;
    for (const part of splitTokens(directory)) push(part, 'dir');
  }

  const concatenations = [fold(base)];
  const directory = directories.at(-1);
  if (directory && !STRUCTURAL_SEGMENTS.has(directory.toLowerCase())) concatenations.push(fold(directory));

  return {
    ...(bucket ? { bucket } : {}),
    tokens,
    concatenations: [...new Set(concatenations.filter((value) => value.length >= 4))],
    initials,
    markers,
  };
}
