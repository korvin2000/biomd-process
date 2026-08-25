/**
 * What this deployment knows about its own models, hard-coded on purpose.
 *
 * These are not settings. A `tolerance` is a claim about how a specific model
 * behaves on a specific corpus, earned by reading that corpus's failures; it
 * belongs next to the strategy that acts on it, where it can be read together
 * with the reasoning, rather than in a config file where it would look like a
 * dial and get turned. The strategy is opt-in — no pool names it, nothing
 * changes — so the cost of being wrong here is bounded.
 *
 * `prior` values come from this repo's own run history (13 runs, 2691 attempts
 * in `.biomd/runs/*​/events.jsonl`), and exist to answer the cold-start
 * question: before a target has served anything in *this* run, what should we
 * assume? They are a starting point that live measurements overwrite, not a
 * verdict — see `shrink()` in the strategy.
 *
 * Failure rates are Laplace-smoothed — `(failures + 1) / (attempts + 2)` — and
 * not the raw ratio. Two targets in this table went 0-for-53 and 0-for-52, and
 * writing that down as `0.0` would claim a model that cannot fail from fifty
 * observations. Smoothing turns those into ~1.8%, which is roughly what fifty
 * clean calls actually license, and leaves the target with 420 attempts behind
 * it correspondingly more certain.
 */

export interface ModelProfile {
  /**
   * How well this model holds a structure together as the payload gets
   * tangled, from 0 (falls apart) to 1 (unbothered).
   *
   * The only genuinely subjective number here. It is what tilts a document with
   * heavy container metadata and mixed scripts towards one model and a clean
   * article towards another.
   */
  readonly tolerance: number;
  /** Cold-start throughput, tokens/sec, from historical runs. */
  readonly priorThroughput: number;
  /** Cold-start failure rate, 0…1, from historical runs. */
  readonly priorFailureRate: number;
}

/**
 * Keyed by `ModelTarget.modelId` — the `id:` from `llm.models`, not the
 * provider's model string, so re-pointing an id at a different upstream keeps
 * the profile that was measured for that slot.
 *
 * A model with no entry is not excluded. It scores on live measurements alone
 * and sits at neutral tolerance, which is the honest position for something
 * nobody has characterised.
 */
const PROFILES: Readonly<Record<string, ModelProfile>> = {
  /**
   * 748 attempts across the run history, 38 of them `response_format`:
   * translation tables returned with keys missing or placeholders not
   * preserved. Every other target in the same runs is at or near zero. It
   * translates clean prose well and loses track of bookkeeping when the
   * document carries a lot of it, which is exactly what `tolerance` encodes.
   *
   * The 4.7% prior is its rate under the current pinned-provider config, where
   * the failures are timeouts rather than malformed tables.
   */
  deepseek: { tolerance: 0.25, priorThroughput: 120, priorFailureRate: 0.0495 },

  /** 53 attempts, 0 failures. Follows instructions; renders prose less well. */
  'minimax-m3': { tolerance: 0.95, priorThroughput: 169, priorFailureRate: 0.0182 },

  /** Same model, free tier: same behaviour, no bill, tighter upstream limits. */
  'minimax-m3-free': { tolerance: 0.6, priorThroughput: 120, priorFailureRate: 0.03 },

  /** 420 attempts, 1 failure. The reliable generalist of this deployment. */
  'gpt-luna': { tolerance: 0.85, priorThroughput: 221, priorFailureRate: 0.0047 },

  /** 52 attempts, 0 failures, but one concurrent slot — the queue, not the model, is the risk. */
  'gemma-local': { tolerance: 0.7, priorThroughput: 174, priorFailureRate: 0.0185 },

  /** No `response_format` support at all; JSON is prompt-only, so structure is fragile. */
  nemotron: { tolerance: 0.35, priorThroughput: 150, priorFailureRate: 0.05 },
};

/** Neutral stance for a model nobody has characterised. */
export const DEFAULT_PROFILE: ModelProfile = {
  tolerance: 0.5,
  priorThroughput: 120,
  priorFailureRate: 0.03,
};

export function profileFor(modelId: string): ModelProfile {
  return PROFILES[modelId] ?? DEFAULT_PROFILE;
}

/** Every characterised model id — for tests and for `biomd models` output. */
export function profiledModelIds(): string[] {
  return Object.keys(PROFILES).sort();
}
