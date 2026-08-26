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
| throughput | rolling window of the last 4 successes | **generated** tokens / wall-clock second |
| health | failure rate over the **last 10 outcomes**, plus a **time-decayed** streak | 0…1, higher is better |
| cost | `context.estimatedCost(target)` for this request | USD |
| prose quality | `ModelProfile.proseQuality` — a judgement | 0…1 |
| complexity | `request.signals.complexity` × `ModelProfile.tolerance` | bends the sum, does not join it |

Plus two modifiers applied after the sum: an **exploration bonus** for targets this run has not
measured, and an **oversize penalty** for a target that declares `maxComfortableTokens` and is
handed something past it.

Health has two separate recovery paths, because a target scored to the bottom never gets the
request that would clear it. The **window** forgets old failures once ten newer outcomes have
pushed them out; the **streak** fades over `STREAK_DECAY_MS` of not being called, since a streak is
a claim about now. Note which quantity feeds which: the window supplies the *estimate* and the
cumulative request count supplies the *confidence*. Using the window for both caps every target's
certainty at ten observations, flattens the term until it separates nobody, and hands the decision
to cost — where a free tier wins absolutely. That alone moved the free tier from 5% to 24%.

Every raw value is rescaled **in proportion** (`v/max`, or `min/v` for cost), never min-max.
Min-max keeps the ordering and throws away the magnitude: two targets failing 4.7% and 1.8% of
the time get a 1 and a 0, as if one never worked. See `proportional()`.

## `W_PROSE` versus `COMPLEXITY_PULL`

The two knobs most often confused, because both raise deepseek's share.

- **`W_PROSE` is a shift.** It adds the same amount to a model's score on every document. It knows
  nothing about the payload. Geometrically it moves the model's whole line up or down.
- **`COMPLEXITY_PULL` is a slope.** At complexity exactly 0.5 it does nothing; either side of that
  it grows in opposite directions. It rotates the line around the midpoint.

The weights decide **who the default is**. `COMPLEXITY_PULL` decides **how far from average a
document must be to override that default**.

Raising `COMPLEXITY_PULL` *reduces* minimax-m3's share, which is the opposite of the obvious
guess. The corpus median complexity is 0.240 and only ~7% of documents exceed 0.5, so for 93% of
them `(complexity − 0.5)` is negative and the highest-tolerance model takes the largest penalty.
Measured on 196 documents:

| PULL | deepseek | minimax-m3 | m3-free | | W_PROSE | deepseek | minimax-m3 | m3-free |
|---|---|---|---|---|---|---|---|---|
| 0.00 | 0.0% | 100.0% | 0.0% | | 0.00 | 15.3% | 28.6% | 56.1% |
| 0.30 | 42.3% | 37.8% | 19.9% | | 0.35 | 36.7% | 26.0% | 37.2% |
| 0.50 | 70.4% | 23.0% | 6.6% | | 0.50 | 70.4% | 23.0% | 6.6% |
| 0.90 | 81.1% | 15.3% | 3.6% | | 1.00 | 87.2% | 12.8% | 0.0% |

| Want | Turn | Why |
|---|---|---|
| more minimax-m3, free tier untouched | `COMPLEXITY_PULL` **down** | works through `tolerance`, where those two are furthest apart |
| deepseek over the free tier | `W_PROSE` **up** | the two minimax entries share `proseQuality`; only price separates them |

**`COMPLEXITY_PULL` has a hard ceiling at 0.85.** Above it the bend outvotes a target whose last
six calls all failed — health driven to literally 0 — and a broken target starts collecting the
hardest documents in the corpus. Pinned by a test.

## The complexity scorer

`ComplexityScorer.ts`, pure, no dependencies. Eight features, every one a **density** per thousand
characters, each divided by a saturation point and clamped.

**Length is deliberately not a feature.** Across the documents this repo's runs broke on, the
median broken document was 2899 characters against 2910 for the clean ones — a ratio of 1.00. What
did separate them, holding target language fixed, was container metadata (`containerKv`, elevated
in 3 of 3 languages), Latin-script fragments inside Cyrillic, and non-sentence punctuation.

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

## Four defects this went through, and the invariant each left behind

Each was found by a live run and each cost money to find. They are listed so a future change does
not reintroduce one.

| Defect | Symptom | Invariant now |
|---|---|---|
| complexity measured on stripped prose | the term discriminated nothing; corpus collapsed to ~0.08 | score the document; test asserts spread > 0.2 |
| the not-least-loaded remainder sorted by **cost**, bypassing the score | models sharing an endpoint ranked on price alone | load is the sort key, score is the tie-break, applied at every level |
| no exploration | first call decided the run — 51-0-0 across three models | `EXPLORATION_BONUS`, decaying as `1/(1+requests)`; test asserts every pool member serves work |
| throughput counted prompt tokens | uneven 3.7–6.4× overstatement, so the ranking was wrong | `completionTokens` only |

## Tools

```bash
npx vitest run tests/adaptive.simulation.test.ts          # whole scheduler, fake provider, ~2s
npx tsx tools/simulate-adaptive.ts input/ru <model-ids>   # complexity distribution + split
npx tsx tools/calibrate-adaptive.ts input/ru "--target=deepseek=65,minimax-m3=25,minimax-m3-free=10"
```

**Use the harness, not a live run.** A live run reports the split it produced and nothing about
why, so every hypothesis costs another one. Four consecutive live runs came back "deepseek took
everything" for four unrelated reasons; the harness reproduces the same split in two seconds.

`calibrate-adaptive.ts` **transcribes** the scoring maths rather than importing it, so it can
drift. Cross-check any fitted constant through `simulate-adaptive.ts`, which drives the real
`Router`. They currently agree exactly on both `input/ru` and `out/ru`.

## Current calibration

`W_THROUGHPUT 1.0 · W_HEALTH 1.5 · W_COST 0.2 · W_PROSE 0.5 · COMPLEXITY_PULL 0.43`

Mean over five harness runs: roughly **63 / 21 / 16**, against a stated target of 65 / 25 / 10.

> **State the split as a distribution, never as a point.** It is not a function of the constants.
> The strategy learns during a run, so whichever target draws the first requests accumulates
> measured throughput and pulls ahead, and task order under `run.concurrency` varies between runs.
> Ten harness runs at *identical* constants gave deepseek 73.7–85.9%, minimax-m3 12.8–13.7% and
> minimax-m3-free 1.3–13.2%. Fitting to one run is fitting noise; average over at least five.

It also depends on the corpus's complexity distribution, so a different set of articles moves it
again.

## Measured translation quality

The only A/B this repo has run. 20 documents stratified across the complexity range from `manual/`,
translated to Spanish by each model alone (a pool of one, so a failure could not be silently
served by something else), scored with `npm run score`. Configs in `.ab/`, cost $0.034.

| | clean | Cyrillic left in the translation | dashΔ |
|---|---|---|---|
| deepseek | **20/20** | 0 | 18 |
| minimax-m3 | 15/20 | 273 chars, 19 occurrences | 45 |

Every leak was a **proper name in a heading or caption left untransliterated** (12 occurrences,
216 chars — a Spanish page whose H1 reads `# Наталья Липницкая`) or a **work title kept in the
original with a Spanish gloss** (7 occurrences, arguably correct bibliographic practice). Not one
sentence of body prose came back untranslated.

This confirms `proseQuality` and says nothing about `tolerance`: no `response_format` failure
occurred in either arm, and protocol robustness is what `tolerance` describes. The two axes are
independent, and only one of them has ever been measured.

## Profiles are claims, not settings

`ModelProfiles.ts` is hard-coded on purpose. A `tolerance` or a `proseQuality` is a statement about
how one model behaves on one corpus; in a config file it would look like a dial and get turned.
Two of the numbers are genuinely subjective — `tolerance` and `proseQuality` — and nothing in this
repo measures either. `npm run score` compares invariants, not register.

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
- **`nemotron-free` in `biomd.config.yaml` has no profile entry** (`ModelProfiles.ts` keys it as
  `nemotron`), so it would score at neutral. Harmless while it is in no pool.
- **`EXPLORATION_BONUS = 0.3` was chosen, not fitted.** Tuning it needs the same five-run
  averaging as everything else, which has not been done.
- **`calibrate-adaptive.ts` has drifted.** It models neither the oversize penalty nor the
  exploration bonus, so it under-reports the free tier badly. Prefer the harness.
