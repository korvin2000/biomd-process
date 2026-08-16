/**
 * String distance, for the last stage of name matching.
 *
 * Optimal string alignment (Damerau–Levenshtein without the full transposition
 * table) rather than plain Levenshtein: the errors this data actually contains
 * are single-letter substitutions from transliteration and adjacent
 * transpositions from typing, and OSA charges 1 for a swap where Levenshtein
 * charges 2. It is bounded early, because the only question ever asked is "is
 * this within a couple of edits", never "how far apart exactly".
 */

/** Edit distance, giving up as soon as it is known to exceed `limit`. */
export function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  let beforePrevious = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let best = current[0] as number;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (beforePrevious[j - 2] as number) + 1);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;

    [beforePrevious, previous, current] = [previous, current, beforePrevious];
  }
  return previous[b.length] as number;
}

/**
 * `1 - distance / length`, on a scale where 1 is identity.
 *
 * Short strings are deliberately harsh: one edit in a four-letter surname is a
 * quarter of it and very often a different name (`sanz` / `sainz`, both of
 * which exist in this index), while one edit in `illarionov` is a
 * transliteration habit.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const longest = Math.max(a.length, b.length);
  // Two edits is the most that can ever be interesting; beyond that the exact
  // value is never used, so the computation stops there.
  const distance = editDistance(a, b, 3);
  return distance > 3 ? 0 : Math.max(0, 1 - distance / longest);
}

/** The minimum similarity at which a name of this length may be called a match. */
export function fuzzyThreshold(length: number): number {
  if (length <= 4) return 1; // no fuzz at all: `sanz` and `sainz` are two people
  if (length <= 6) return 0.83; // one edit in six
  return 0.86;
}
