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
 * `priorThroughput` is **generated** tokens per second of wall clock, the unit
 * {@link RecentCall} defines — not the prompt-inclusive figure an earlier
 * version of this file carried, which overstated every entry by three- to
 * five-fold and unevenly. Other `prior` values come from this repo's own run
 * history (13 runs, 2691 attempts
 * in `.biomd/runs/*​/events.jsonl`), and exist to answer the cold-start
 * question: before a target has served anything in *this* run, what should we
 * assume? They are a starting point that live measurements overwrite, not a
 * verdict — see `shrink()` in the strategy.
 *
 * ### A throughput prior for an openrouter model is a mixture, not a property
 *
 * `local` and `omniroute` each front one deployment, so a number measured there
 * describes a thing. An openrouter model id does not: it is served by dozens of
 * providers at once, one of which will do ten tokens a second while another does
 * a hundred, and which one answers is not ours to choose. On top of that the
 * whole population moves with the clock — faster in the evening, slower through
 * a working day.
 *
 * So the openrouter entries below are the **mean of a distribution that is wide
 * and that drifts**, and the honest thing to take from them is the *ratio*
 * rather than either absolute: minimax-m3 runs about 30% faster than deepseek,
 * which holds across providers because it is a property of the models. Two
 * consequences, both already in the strategy:
 *
 *  - the measurement has to be able to win. Confidence comes from the cumulative
 *    success count, so after a few dozen calls this file is barely consulted;
 *  - and it has to be able to go stale. `THROUGHPUT_DECAY_MS` exists because
 *    tonight's provider is not this afternoon's.
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
  /**
   * How well this model renders prose, 0…1 — separate from `tolerance` and
   * frequently its opposite.
   *
   * Added because without it the model cannot express the thing this
   * deployment actually believes: that deepseek translates better and follows
   * instructions worse. Speed, health and cost are all silent about
   * translation quality, so with only those four axes the sole way for a
   * fragile-but-good model to win was to be rewarded *for* its fragility — a
   * low `tolerance` scoring as a positive on clean documents. That worked for
   * deepseek against minimax by coincidence, and immediately misfired
   * elsewhere: it also floated deepseek above `gpt-luna`, which is free,
   * faster and healthier, on nothing but the claim that it breaks more easily.
   *
   * Like `tolerance` this is a judgement and not a measurement. There is no
   * automated scorer for "reads well in Spanish" anywhere in this repo, and
   * `npm run score` compares invariants rather than register.
   */
  readonly proseQuality: number;
  /** Cold-start throughput, tokens/sec, from historical runs. */
  readonly priorThroughput: number;
  /** Cold-start failure rate, 0…1, from historical runs. */
  readonly priorFailureRate: number;
  /**
   * Input tokens beyond which this target stops being a good use of itself.
   * Absent for a target with no such ceiling, which is most of them.
   *
   * This is about a **budget**, not a context window — fitting is checked
   * separately and much earlier. A free tier is metered in requests and tokens
   * per day, so every large document it answers is several small ones it will
   * refuse later; the ceiling is what keeps a scarce allowance pointed at the
   * work it goes furthest on. The penalty ramps rather than cutting off, and
   * never removes the target from the chain.
   */
  readonly maxComfortableTokens?: number;
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
   * 81 generated tokens per second of wall clock, over 181 calls in four live
   * runs. Independently corroborated: OpenRouter's own activity log for the same
   * traffic reports a median of 85.5 tok/s across 54 records, all served by
   * Together. The small gap is routing overhead, which their figure excludes and
   * this one includes on purpose — see {@link RecentCall}.
   *
   * Failure rate is Laplace-smoothed over the combined history: 17 failures in
   * 509 attempts.
   */
  deepseek: { tolerance: 0.25, proseQuality: 0.95, priorThroughput: 81, priorFailureRate: 0.035 },

  /**
   * Follows instructions; renders prose less well. The fastest generator in this
   * pool.
   *
   * 105 rather than the 127 this file carried, and derived rather than measured:
   * 127 came off twelve calls through whichever providers openrouter happened to
   * pick that hour, which is a sample of a mixture and not a speed. The durable
   * fact is the ratio — about 30% faster than deepseek — so this is deepseek's
   * 81 times 1.3. It is a starting point and the run overwrites it.
   *
   * `proseQuality` was 0.7, and the evidence for that number has since been
   * superseded by evidence this repo produced itself. 0.7 recorded a Spanish A/B
   * in which this model left proper names untransliterated in headings and
   * captions — 19 occurrences over 20 documents against deepseek's zero. That
   * defect was then fixed at the prompt level: with the override in
   * `prompts/translation/minimax-m3/`, it scored 20/20 structurally clean with
   * **zero** Cyrillic leakage in two separate 20-document runs, matching
   * deepseek. What is still measured between them is `dashΔ` (50 against 18) and
   * one work title in twenty-one, and the session that measured those found them
   * inside single-run noise.
   *
   * So 0.85 rather than 0.95: the gap that was demonstrated has closed, and what
   * is left is a smaller preference that has not been demonstrated either way.
   * See `docs/ref/adaptive-routing.md`.
   */
  'minimax-m3': { tolerance: 0.95, proseQuality: 0.85, priorThroughput: 105, priorFailureRate: 0.0182 },

  /**
   * Not the same deployment as the paid entry despite the shared name: a single
   * GMICloud host at fp8, and a free-tier allowance metered per day.
   *
   * The lower tolerance is about the quantization, **not** about
   * `structured_outputs`. The free variant does lack it — verified against
   * OpenRouter's own model list — but no pipeline in this repo has ever asked
   * for it: `extract`, `translate` and `websearch` all send
   * `responseFormat: { type: 'json_object' }`, and `response_format` is
   * supported here. The missing capability costs this target nothing today. It
   * would start to matter the moment a pipeline asked for a schema.
   *
   * `maxComfortableTokens` is the real constraint. At 2400 it sits just above
   * the median translate prompt this corpus produces (2347 tokens over 1177
   * recorded calls), so the free allowance is spent on the smaller half of the
   * work and the long articles go to something that is paid for anyway.
   */
  'minimax-m3-free': {
    // **Below deepseek's 0.25, not above it.** This was 0.6 — placed between
    // deepseek and the paid minimax on the theory that the model is the same
    // and only the quantization differs. The deployment's own account of it is
    // the opposite: on large and structurally busy requests this variant fails
    // *more often than deepseek does*, and it is the one member of the pool
    // with no `structured_outputs` to fall back on if a pipeline ever asks.
    //
    // Below the neutral 0.5 the fragility clamp in `scoreTargets` engages, and
    // that is the point: a tangled document can only ever cost this target
    // something. At 0.6 it collected a small *bonus* on exactly the payloads it
    // is least able to hold together, which is not a preference anybody holds.
    // Size is handled separately by `maxComfortableTokens`; this is the other
    // half of "large and complex".
    tolerance: 0.2,
    proseQuality: 0.7,
    // Not derived from the paid entry's ratio, and deliberately: this one is a
    // single named host rather than a mixture, so 78 is a measurement of a
    // thing rather than an average over providers that vary tenfold.
    priorThroughput: 78,
    // Higher than a plain quality estimate would justify, and deliberately: a
    // metered free tier's characteristic failure is a 429, not a bad answer,
    // and 5% is what it looks like before the allowance runs out rather than
    // across a whole corpus.
    priorFailureRate: 0.08,
    maxComfortableTokens: 2600,
  },

  /** 420 attempts, 1 failure. The reliable generalist of this deployment. */
  'gpt-luna': { tolerance: 0.85, proseQuality: 0.85, priorThroughput: 51, priorFailureRate: 0.0047 },

  /**
   * One concurrent slot, so the queue rather than the model is the risk — and
   * that queue is inside this number, which is wall-clock delivery rather than
   * raw generation.
   */
  'gemma-local': { tolerance: 0.7, proseQuality: 0.7, priorThroughput: 53, priorFailureRate: 0.0185 },

  /**
   * No `response_format` support at all; JSON is prompt-only, so structure is
   * fragile.
   *
   * Keyed as `nemotron-free`, which is the `id:` `biomd.config.yaml` actually
   * declares. It was keyed `nemotron` and therefore matched nothing — harmless
   * only for as long as no pool names it, and the kind of thing that is
   * discovered by a target quietly scoring at `DEFAULT_PROFILE` in a run nobody
   * is watching.
   */
  'nemotron-free': { tolerance: 0.35, proseQuality: 0.7, priorThroughput: 60, priorFailureRate: 0.05 },
};

/** Neutral stance for a model nobody has characterised. */
export const DEFAULT_PROFILE: ModelProfile = {
  tolerance: 0.5,
  proseQuality: 0.7,
  priorThroughput: 60,
  priorFailureRate: 0.03,
};

export function profileFor(modelId: string): ModelProfile {
  return PROFILES[modelId] ?? DEFAULT_PROFILE;
}

/** Every characterised model id — for tests and for `biomd models` output. */
export function profiledModelIds(): string[] {
  return Object.keys(PROFILES).sort();
}
