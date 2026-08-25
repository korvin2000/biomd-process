/**
 * How hard a payload is to *reproduce*, on a 0…1 scale.
 *
 * Not how hard it is to translate. The failure this predicts is the one the run
 * logs actually contain — `response_format`: a table came back with keys
 * missing, or with the inline placeholders `⟦n⟧` renamed, dropped or reordered.
 * That is a bookkeeping failure, and what drives it is how much bookkeeping the
 * payload demands, not how literary it is.
 *
 * Which is why **length is not one of the features**. It was the obvious first
 * guess and the corpus says no: across the documents this repo's own runs broke
 * on, the median length of a broken document was 2899 characters against 2910
 * for the ones that came back clean — a ratio of 1.00. What did separate them,
 * in the same comparison and holding the target language fixed, was the density
 * of container metadata, of Latin-script fragments inside Cyrillic prose, and
 * of punctuation that is neither a letter nor a full stop.
 *
 * Every feature is a **density** — per thousand characters — so a long clean
 * article is not penalised for being long, and a short knot of markup is not
 * excused for being short. Each is then divided by the point where it stops
 * telling us anything new (`saturation`) and clamped, which keeps one runaway
 * count from swamping the rest: a table with two hundred rows is not twenty
 * times more dangerous than one with ten.
 *
 * The weights are a judgement, informed by that comparison and no stronger than
 * it: n was 2…4 documents per language, which is a direction, not a
 * measurement. They are deliberately flat rather than fitted — with samples
 * that size, fitting would be fitting noise.
 */

/** One measurable property of a payload, and how much of it is already too much. */
interface Feature {
  readonly id: string;
  /** Weight in the final score; the set is normalised, so only ratios matter. */
  readonly weight: number;
  /** Density per 1000 chars at which this feature is considered maxed out. */
  readonly saturation: number;
  count(text: string): number;
}

const CYRILLIC = /[Ѐ-ӿ]/g;
const LATIN = /[A-Za-z]/g;

/**
 * `key: value` lines inside `::: container` blocks — `src:`, `position:`,
 * `size:`, `caption:`. The one feature that was elevated on broken documents in
 * all three languages examined, and the one with an obvious mechanism: each is
 * a line the model must copy across untouched while translating the line under
 * it.
 */
const CONTAINER_KV = /^[ \t]*[a-z][a-z0-9_-]*:[ \t]+\S/gm;
const CONTAINER_FENCE = /^[ \t]*:::/gm;
const INLINE_LINK = /\[[^\]]*\]\([^)]*\)/g;
const EMPHASIS = /\*\*|__|==|~~|\*\S/g;
const TABLE_ROW = /^[ \t]*\|/gm;
/** Placeholders the segmenter substitutes for inline markup before a call. */
const PLACEHOLDER = /⟦\d+⟧/g;
/** Anything that is not a letter, digit, space, or ordinary sentence punctuation. */
const EXOTIC_PUNCT = /[^\p{L}\p{N}\s.,!?;:'"()\-]/gu;

function countOf(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

const FEATURES: readonly Feature[] = [
  { id: 'containerKv', weight: 1.4, saturation: 6, count: (t) => countOf(t, CONTAINER_KV) },
  { id: 'containers', weight: 1.0, saturation: 5, count: (t) => countOf(t, CONTAINER_FENCE) },
  { id: 'links', weight: 1.2, saturation: 4, count: (t) => countOf(t, INLINE_LINK) },
  { id: 'placeholders', weight: 1.3, saturation: 8, count: (t) => countOf(t, PLACEHOLDER) },
  { id: 'emphasis', weight: 0.8, saturation: 6, count: (t) => countOf(t, EMPHASIS) },
  { id: 'tableRows', weight: 1.0, saturation: 5, count: (t) => countOf(t, TABLE_ROW) },
  { id: 'exotic', weight: 0.9, saturation: 40, count: (t) => countOf(t, EXOTIC_PUNCT) },
];

const TOTAL_FEATURE_WEIGHT = FEATURES.reduce((sum, feature) => sum + feature.weight, 0);

/**
 * Weight of the script-mixing term, which is scored differently from the rest:
 * it is already a ratio rather than a count, so it needs no saturation.
 */
const SCRIPT_MIX_WEIGHT = 1.2;

/** Latin letters as a share of all letters, rescaled so ~35% counts as saturated. */
function scriptMix(text: string): number {
  const latin = countOf(text, LATIN);
  const cyrillic = countOf(text, CYRILLIC);
  const letters = latin + cyrillic;
  if (letters === 0) return 0;
  const minority = Math.min(latin, cyrillic) / letters;
  return clamp01(minority / 0.35);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export interface ComplexityBreakdown {
  score: number;
  parts: Record<string, number>;
}

/**
 * The score, plus the per-feature contributions behind it.
 *
 * The breakdown exists because a single opaque number is untunable: when a
 * document routes somewhere surprising, the only useful question is which
 * feature carried it there.
 */
export function scoreComplexity(text: string): ComplexityBreakdown {
  const parts: Record<string, number> = {};
  if (text.length === 0) return { score: 0, parts };

  const perThousand = 1000 / text.length;
  let weighted = 0;

  for (const feature of FEATURES) {
    const density = feature.count(text) * perThousand;
    const value = clamp01(density / feature.saturation);
    parts[feature.id] = value;
    weighted += value * feature.weight;
  }

  const mix = scriptMix(text);
  parts['scriptMix'] = mix;
  weighted += mix * SCRIPT_MIX_WEIGHT;

  return { score: clamp01(weighted / (TOTAL_FEATURE_WEIGHT + SCRIPT_MIX_WEIGHT)), parts };
}

/** The score alone, for callers that only need the number. */
export function complexityOf(text: string): number {
  return scoreComplexity(text).score;
}
