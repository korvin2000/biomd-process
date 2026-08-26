# The `adaptive` routing strategy

Opt-in, registered in [container.ts](../../src/app/container.ts) and inert until a pool names it.
Lives in `src/routing/strategies/adaptive/`. Everything below is about the `translate` pool, the
only one currently using it.

Use it when several pool members could all serve a request and differ in ways the config cannot
state: one is quick and loses track of structure, one is slower and never does, one costs nothing
until it rate-limits. `cost-optimized` and `least-busy` are each right about the one axis they
look at, and neither can express that.

## What it ranks on

Load first, score second. Occupancy is the primary sort key, so an emptier endpoint is always
preferred and nobody queues behind a full one; the score only separates targets that are equally
busy, which in practice means the ones sharing an endpoint.

| Term | Source | Unit |
|---|---|---|
| throughput | rolling window of the last 4 successes, confidence from **cumulative successes**, decaying with idleness | **generated** tokens / wall-clock second |
| health | failure rate over the **last 10 outcomes**, plus a **time-decayed** streak | 0…1, higher is better |
| cost | `context.estimatedCost(target)` for this request | USD |
| prose quality | `ModelProfile.proseQuality` — a judgement | 0…1 |
| complexity | `request.signals.complexity` × `ModelProfile.tolerance` | bends the sum, does not join it |

Plus two modifiers applied after the sum: an **exploration bonus** for targets this run has not
measured, and an **oversize penalty** for a target that declares `maxComfortableTokens` and is
handed something past it.

### Estimate and confidence are different quantities

Both measured terms keep a short **window** for the estimate and a **cumulative count** for the
confidence, and mixing them up has cost this file twice.

- Health: the window supplies the estimate because it forgets; `stats.requests` supplies the
  confidence because two hundred clean calls are better evidence than ten. Weighting by the window
  instead capped every target's certainty at ten observations, flattened the term until it
  separated nobody, and handed the decision to cost — where a free tier wins absolutely. That
  alone moved the free tier from 5% to 24%.
- Throughput had the *unfixed* version of the same bug: confidence came from `recent.length`, which
  `RECENT_WINDOW` caps at 4, so the prior kept 3/7 of the term for the whole run however much
  evidence arrived. A target sustaining 200 tok/s against a prior of 81 read as **149**, and one
  sustaining 40 against a prior of 127 read as **77** — a 5:1 speed difference scored as 1.9:1.
  Confidence is now `stats.successes`.

Both also need a way back. Health has two — the window forgets once ten newer outcomes push the old
ones out, and the streak fades over `STREAK_DECAY_MS` of not being called. Throughput had none, and
that was the sharper trap: a slow window demotes a target, and being demoted is what stops the next
measurement arriving. `THROUGHPUT_DECAY_MS` (2 minutes idle) decays the *confidence* back to zero,
so the target is scored on its profile again and gets another turn — the same shape as the circuit
breaker's half-open probe.

### Every value is rescaled in proportion, and `min / v` is not how

Min-max keeps the ordering and throws away the magnitude: two targets failing 4.7% and 1.8% of the
time get a 1 and a 0, as if one never worked. Higher-is-better terms use `v / max`.

Lower-is-better — cost — is `1 − v / max`, the **mirror** of that, and deliberately not the obvious
`min / v`. `min / v` breaks on the one case this pool always contains: when the cheapest candidate
is free, `min` is zero, every paid target collapses onto whatever floor avoids the division, and two
targets four times apart in price become indistinguishable. Measured on the real translate pool, the
deepseek-to-minimax gap on this term fell from **0.82 to 0.045** the moment a free tier joined —
an eighteen-fold change in a comparison the free tier is not part of. Anchoring on `max` keeps the
term a property of the pair being compared. Pinned by a test.

## `W_PROSE` versus `COMPLEXITY_PULL`

The two knobs most often confused, because both raise deepseek's share.

- **`W_PROSE` is a shift.** It adds the same amount to a model's score on every document. It knows
  nothing about the payload. Geometrically it moves the model's whole line up or down.
- **`COMPLEXITY_PULL` is a slope.** At complexity exactly 0.5 it does nothing; either side of that
  it grows in opposite directions. It rotates the line around the midpoint.

The weights decide **who the default is**. `COMPLEXITY_PULL` decides **how far from average a
document must be to override that default**.

Which means: **fit the level with the weights and the slope with the slope.** Fitting a share by
turning `COMPLEXITY_PULL` is how an earlier calibration arrived at a best value very near zero — the
split came out right and the complexity term, the entire reason this strategy exists, had stopped
doing anything. See "What the split can and cannot be" below.

### The crossover, which is the thing worth stating

With `d` the score gap at complexity 0.5 (positive = the tolerant model is ahead) and `Δt` the
tolerance difference, the complexity at which preference flips is

```text
c* = 0.5 − d / (2 · COMPLEXITY_PULL · Δt)
```

Three consequences that are not obvious and were all got wrong here:

- **If the tolerant model loses at the midpoint, `c*` is above 0.5, always.** No value of
  `COMPLEXITY_PULL` brings it below. Only ~7% of this corpus scores above 0.5, so the tolerant
  model's ceiling is that 7% until a *weight or a profile* changes.
- **Which way `COMPLEXITY_PULL` moves a share depends on the sign of `d`.** With `d < 0` a larger
  pull drags `c*` down towards 0.5 and the tolerant model gains; with `d > 0` it drags `c*` up
  towards 0.5 and the tolerant model loses. The doc used to state the second as if it were a
  property of the constant. It is a property of the constant *and* the weights.
- **A very low `COMPLEXITY_PULL` does not hand it the corpus — it flattens the score.** All three
  openrouter candidates end up within a hair of each other and the split is then decided by
  exploration, task order and endpoint timing. That reads as a share moving and is actually
  routing being replaced by a lottery. An earlier sweep here reported `complexityPull = 0.05` as the
  best fit to a 65/25/10 target for exactly that reason.

**Safety.** The reward half of the bend is multiplied by the target's health score, so a target
failing every call collects no "this document needs my tolerance" bonus. Before that,
`COMPLEXITY_PULL` had a ceiling above which a broken target started winning the hardest documents in
the corpus — the ones it answers worst. That ceiling was documented at 0.85; the arithmetic put it
at **0.658**, and it moved silently whenever any weight changed. It is now around 1.85, and
`tests/adaptive.test.ts` pins the *mechanism* rather than the number.

## The complexity scorer

`ComplexityScorer.ts`, pure, no dependencies. Eight features, every one a **density** per thousand
characters, each divided by a saturation point and clamped.

**Length is deliberately not a feature.** Across the documents this repo's runs broke on, the
median broken document was 2899 characters against 2910 for the clean ones — a ratio of 1.00. What
did separate them, holding target language fixed, was container metadata (`containerKv`, elevated
in 3 of 3 languages), Latin-script fragments inside Cyrillic, and non-sentence punctuation.

A consequence worth knowing before reading any per-document report: because every feature is a
density, complexity is **negatively correlated with length** — r = −0.39 on `input/ru`, −0.26 on
`out/ru`. Short documents score high. So a distribution counted per *document* is not the
distribution the run serves, which is counted per *call*.

> **Score the document, never the batch.** `translate` runs in `segments` mode: containers, `src:`
> / `caption:` lines, tables and links are lifted out before the call and spliced back locally, so
> a batch carries prose and nothing else. Whole documents average 0.265; the prose drawn from them
> averages 0.082, and not one of 196 exceeds 0.5. Scoring the batch reports "simple" for the entire
> corpus. `TranslationPipeline` therefore passes `complexity: complexityOf(document.content)` into
> `StringBatchSpec`, and the batch-derived value survives only as a floor for a caller with no
> document.

## Throughput is generated tokens over wall clock

`RecentCall.completionTokens`, never `totalTokens`. Counting the prompt measures how much text was
*sent* — which the model did not generate and which is processed at a different rate — so the
number stops being a speed and becomes a function of prompt size. It overstated deepseek 3.7-fold
and minimax-m3 4.8-fold: a reordering, not a rescaling.

Wall-clock latency in the denominator, so routing overhead and time-to-first-token count. That
makes it a different quantity from the `tok/s` an OpenRouter activity log reports, which times
generation alone — 80.9 here against their 90.5 for the same deepseek traffic. Wall clock is the
right one: a run costs delivery time, not generation time.

**A throughput prior for an openrouter model is a mixture, not a property.** `local` and `omniroute`
each front one deployment. An openrouter model id does not: dozens of providers serve it at once,
one managing ten tokens a second while another does a hundred, and which answers is not ours to
choose; the whole population drifts with the time of day besides. So the openrouter priors are the
mean of a wide, moving distribution, and the durable fact is the **ratio** — minimax-m3 runs about
30% faster than deepseek, a property of the models rather than of the hosts. `minimax-m3` is
therefore `81 × 1.3 ≈ 105` and not the 127 that twelve calls through one afternoon's providers
suggested. It is also why the measurement has to be able to win, and to go stale.

## Five defects this went through, and the invariant each left behind

Each of the first four was found by a live run and cost money to find. The fifth was found by
checking the arithmetic against real numbers, and was the largest.

| Defect | Symptom | Invariant now |
|---|---|---|
| complexity measured on stripped prose | the term discriminated nothing; corpus collapsed to ~0.08 | score the document; test asserts spread > 0.2 |
| the not-least-loaded remainder sorted by **cost**, bypassing the score | models sharing an endpoint ranked on price alone | load is the sort key, score is the tie-break, applied at every level |
| no exploration | first call decided the run — 51-0-0 across three models | `EXPLORATION_BONUS`, decaying as `1/(1+requests)`; test asserts every pool member serves work |
| throughput counted prompt tokens | uneven 3.7–6.4× overstatement, so the ranking was wrong | `completionTokens` only |
| **the harness never spent wall clock** | the gateway times `Date.now() - startedAt` and ignores the `latencyMs` a response declares, so every call read as instant; measured throughput was whatever `OUTLIER_CEILING` clamped it to, for whichever target answered first | the fake sleeps; `tests/adaptive.simulation.test.ts` asserts measured tok/s lands within 25% of what the fake was asked to model |

That fifth one is worth dwelling on, because everything downstream of it was wrong. The throughput
term was a **first-mover bonus**: the first target to answer was pinned at 3× its profile prior and
stayed there, because the window only refills for a target that is being called. minimax-m3's share
ranged from 0.8% to 25.4% between *identical* runs, and every constant in `AdaptiveStrategy.ts` had
been fitted against that. With the fake spending real time, the same measurement's spread fell from
σ 8.7 to σ 2.0.

## Tools

```bash
npx vitest run tests/adaptive.simulation.test.ts               # whole scheduler, fake provider
npx tsx tools/split-adaptive.ts 10 196 out/ru                  # mean and spread over 10 real runs
npx tsx tools/calibrate-adaptive.ts complexityPull 0.2,0.3,0.43 --fix=prose=0.35 --corpus=out/ru
npx tsx tools/simulate-adaptive.ts out/ru <model-ids>          # complexity distribution, static map
```

**Use the harness, not a live run.** A live run reports the split it produced and nothing about
why, so every hypothesis costs another one. Four consecutive live runs came back "deepseek took
everything" for four unrelated reasons.

Three things about the instruments:

- `split-adaptive.ts` and `calibrate-adaptive.ts` both drive `runJob` through
  `tests/helpers/adaptiveHarness.ts` — the same module the simulation test uses — and
  `calibrate-adaptive.ts` calls the real `scoreTargets` through `AdaptiveTuning`. It used to keep
  its own transcription of the arithmetic, which had drifted: it modelled neither the oversize
  penalty nor the exploration bonus.
- `split-adaptive.ts` prints measured tok/s next to each prior. **That row is the instrument
  checking itself** — if those figures are not near the priors, nothing else in the output means
  anything.
- `simulate-adaptive.ts` answers a *different* question: which model wins each **document**, with
  empty stats and no learning. Because complexity is negatively correlated with length, a
  per-document map systematically over-reports the tolerant model against a per-call run. Use it to
  read the complexity distribution and to sanity-check a preference; never to fit a share.

## What the split can and cannot be

Current constants: `W_THROUGHPUT 1.0 · W_HEALTH 1.5 · W_COST 0.2 · W_PROSE 0.5 · COMPLEXITY_PULL 0.43`.

Measured over 5 runs of the **whole 196-document corpus** (`split-adaptive.ts 5 196 out/ru`), as a
share of the openrouter calls:

| | deepseek | minimax-m3 | minimax-m3-free |
|---|---:|---:|---:|
| `proseQuality 0.70` (before) | 91.4 ± 0.8 | 6.7 ± 0.5 | 1.9 ± 0.7 |
| **`proseQuality 0.85` (shipped)** | **88.5 ± 0.6** | **9.8 ± 0.8** | **1.7 ± 0.3** |

At 0.85 minimax-m3 leads by 0.004 at complexity 0.5, so `c*` is **0.489** — a shade under the
midpoint, which is where ~9% of this corpus sits. Theory and measurement agree to within the
exploration bonus, which is the first time they have.

> **State the split as a distribution, never as a point.** It is not a function of the constants.
> The strategy learns during a run and task order under `run.concurrency` varies, so a single run is
> one sample. Average over at least five; `split-adaptive.ts` reports the spread so two candidates
> inside each other's noise can be recognised as the same candidate.

It also depends on the corpus. The 16-, 24- and 196-document slices of this repo's own articles give
materially different splits because their complexity distributions differ — quote which corpus a
number came from.

**A share target is not always reachable, and it is worth knowing why before turning anything.**
minimax-m3 is roughly 1.3× deepseek's speed and 5.8× its price per call. At `proseQuality 0.70` it
was 0.02 behind at complexity 0.5, `c*` sat at 0.553, and no value of `COMPLEXITY_PULL` could have
brought its share past the ~7% of documents above that line. The 25% this was once calibrated
towards was never reachable from the slope; the earlier calibration reached it only because the
harness was manufacturing a throughput advantage.

Raising a share means raising a **baseline** — `proseQuality`, or a lower `W_COST` — which is a
claim about the model rather than a tuning exercise, and should be made with evidence and written
down next to the number.

**The free tier is currently the piece that does not match its policy.** It was meant to carry
10–15%; it carries 1.7%. On merit it is last: marginally slower than deepseek (78 against 81),
lower `tolerance`, the same `proseQuality`, an `oversize` penalty on the larger half of the corpus,
and a `priorFailureRate` deliberately set high because a metered free tier's characteristic failure
is a 429. Being free is worth at most `W_COST / ΣW` = 6.25% of the score, and that is not enough to
overcome the rest. Raising `W_COST` is the lever; it trades money saved against the free tier's
habit of running out.

## Measured translation quality

The A/B behind `proseQuality`. 20 documents stratified across the complexity range from `manual/`,
translated to Spanish by each model alone (a pool of one, so a failure could not be silently served
by something else), scored with `npm run score`. Configs in `.ab/`, cost $0.034.

| | clean | Cyrillic left in the translation | dashΔ |
|---|---|---|---|
| deepseek | **20/20** | 0 | 18 |
| minimax-m3 | 15/20 | 273 chars, 19 occurrences | 45 |

Every leak was a **proper name in a heading or caption left untransliterated** (12 occurrences,
216 chars — a Spanish page whose H1 reads `# Наталья Липницкая`) or a **work title kept in the
original with a Spanish gloss** (7 occurrences, arguably correct bibliographic practice). Not one
sentence of body prose came back untranslated.

**That defect has since been fixed at the prompt level.** With the model-specific override in
`prompts/translation/minimax-m3/`, minimax-m3 scored 20/20 structurally clean with **zero** Cyrillic
leakage in two separate 20-document runs — matching deepseek. What remains measured between them is
`dashΔ` (50 vs 18) and title preservation (20/21 vs 21/21), and the session that measured those
concluded they vary too much between single runs to attribute.

`proseQuality` for minimax-m3 is therefore **0.85** and not the 0.70 the table above earned it: the
gap that was demonstrated has closed, and what is left is a smaller preference that has not been
demonstrated either way. `minimax-m3-free` keeps 0.70 — it is a different deployment at fp8, the
A/B never covered it, and nothing has been measured about the quantized variant's prose.

Neither arm produced a `response_format` failure, so none of this says anything about `tolerance`.
The two axes are independent and only one of them has ever been measured.

## Profiles are claims, not settings

`ModelProfiles.ts` is hard-coded on purpose. A `tolerance` or a `proseQuality` is a statement about
how one model behaves on one corpus; in a config file it would look like a dial and get turned.
Two of the numbers are genuinely subjective — `tolerance` and `proseQuality` — and nothing in this
repo measures either. `npm run score` compares invariants, not register.

`AdaptiveTuning` is the exception that proves it: the six weights are exposed as a parameter so a
calibration tool can drive the real `scoreTargets`, and nothing in `biomd.config.yaml` reaches it.

Priors are Laplace-smoothed: two targets went 0-for-53 and 0-for-52, and writing `0.0` would claim
a model that cannot fail from fifty observations.

A model with no entry gets `DEFAULT_PROFILE` — neutral tolerance, so the complexity bend never
moves it in either direction. It is not excluded.

## Known gaps

- **`extract` does not pass `signals.complexity`.** It goes through `escalation.ts`, not
  `stringBatch.ts`, and was never wired. Its pool still uses `least-busy`.
- **`maxComfortableTokens` rests on a weak argument.** See [the note in
  ModelProfiles.ts](../../src/routing/strategies/adaptive/ModelProfiles.ts) — batch size does not
  predict failure in this corpus, and OpenRouter free tiers meter requests per day rather than
  tokens.
- **`EXPLORATION_BONUS = 0.3` was chosen, not fitted.** It is now sweepable
  (`calibrate-adaptive.ts explorationBonus …`) but has not been swept.
- **`OUTLIER_CEILING` is relative to the prior**, so an uncharacterised model can never be measured
  as faster than 3× `DEFAULT_PROFILE.priorThroughput` however fast it is.
- **`estimatedCost` ignores prompt caching**, so a target with a warm cache is scored at list price.
- **`invalid_request` and `context_length` count against a target's health** like any other failure,
  though neither says the target is unreliable. Both are rare enough that nothing has been observed
  to turn on it.
