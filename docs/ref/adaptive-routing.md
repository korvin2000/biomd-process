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
| throughput | rolling window of the last 4 successes, confidence from **cumulative successes**, decaying with idleness, scored **through a knee** | **generated** tokens / wall-clock second |
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

### Speed is scored through a knee, because it is not a property of the model

The other three terms compare properties of a *model*. Speed on openrouter is not one: a model id
there is served by dozens of providers at once, one managing ten tokens a second while another does
a hundred, and the population drifts with the clock — faster in the evening, slower through a
working day. Two identical models measured over four calls each can differ threefold for no reason
that will still be true in a minute.

`v / max` has the response backwards for that job. It is steepest exactly where the measurement is
least trustworthy: a 2.5× reading spent 0.6 of the term, and going on to 3.5× cost only 0.11 more.
The strategy reacted hardest to the differences most likely to be noise and had almost nothing left
to say about the ones that were not.

So the term is piecewise-linear in **octaves** — "twice as slow" is one step whether it happens at
40 tok/s or 400 — with a gentle slope inside the noise band and a steep one outside it:

| constant | means |
|---|---|
| `SPEED_TOLERANCE` 3.0 | ratio still plausibly the provider lottery |
| `SPEED_TOLERANCE_PENALTY` 0.06 | what a target exactly that much slower gives up |
| `SPEED_FULL_PENALTY_RATIO` 8 | ratio at which the term is spent entirely |

The band is set from the measurement's own noise floor: the harness models ±55% per call on an
openrouter id, so two identical targets can read as far apart as 3.4× on a bad pair of draws.
Measured at the median document, deepseek's score falls 0.008 going from parity to 2.5× slower and
0.035 more going on to 3.5× — flat inside the band, decisive outside it. Pinned by two tests, which
assert the *ratio* between those two drops rather than either number.

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

### `COMPLEXITY_MIDPOINT` is where "hard" starts, and it is not 0.5

The bend is centred here, and this was hard-coded to 0.5 for most of the strategy's life — the
midpoint of the 0…1 *scale*, chosen because it is the midpoint of the scale. That is not a fact
about any corpus, and on this one it was quietly wrong: measuring "above average" from 0.5 made
roughly 93% of the corpus below average and handed the tolerant model a penalty on nearly every
document it saw. The complexity term was not discriminating between documents. It was a blanket levy
with a rebate for the top 7%.

**Current value: 0.23, the median of `manual/`** — 736 real documents, this deployment's own corpus
and the largest sample measured so far. It went through two versions before that, and the difference
between them is worth keeping:

1. hard-coded to **0.5**, wrong for the reason above;
2. fitted to **0.19** by a grid search on a 196-document slice, chosen for its effect on the
   *openrouter split* rather than measured as a property of the corpus. This is the same mistake
   `COMPLEXITY_PULL` is documented against below: a structural constant tuned to hit a share is a
   share fitted through the back door, and it moves again the moment any weight does. It also made
   the constant's name a lie — 0.19 is not where this corpus's documents are actually split in half.
3. **measured at 0.23** from the 736-document corpus. Honest, and it costs something: the split
   shifts from 72/24/4 to **76/20/4** on `out/ru`, because the midpoint is no longer artificially
   handing the tolerant model a bend on documents that are not, by this corpus's own median, hard.
   That shift is not a defect. If a share needs recovering, the level knobs — `W_PROSE`, `W_COST` —
   are where to take it from, not this one.

It is the constant to re-measure when the corpus changes materially, and `tools/simulate-adaptive.ts`
prints the distribution to set it from.

Note it is **not** the same quantity as `DEFAULT_PROFILE.tolerance`, which is 0.5 and is the neutral
point of a different axis. They were the same number by coincidence at an earlier version of this
file, and a missing `signals.complexity` is treated as "exactly on the midpoint" — `bend = 0` — not
as zero.

### The crossover, which is the thing worth stating

With `d` the score gap at the midpoint (positive = the tolerant model is ahead) and `Δt` the
tolerance difference, the complexity at which preference flips is

```text
c* = COMPLEXITY_MIDPOINT − d / (2 · COMPLEXITY_PULL · Δt)
```

Three consequences that are not obvious and were all got wrong here:

- **If the tolerant model loses at the midpoint, `c*` is above it, always.** No value of
  `COMPLEXITY_PULL` brings it below. With the midpoint at 0.5, only ~7% of this corpus scored above
  it, so the tolerant model's ceiling was that 7% until a *weight or a profile* changed — which is
  why every attempt to fit a 25% share by turning the slope failed.
- **Which way `COMPLEXITY_PULL` moves a share depends on the sign of `d`.** With `d < 0` a larger
  pull drags `c*` down towards the midpoint and the tolerant model gains; with `d > 0` it drags
  `c*` up and the tolerant model loses. The doc used to state the second as if it were a property
  of the constant. It is a property of the constant *and* the weights.
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
npx tsx tools/split-adaptive.ts 5 196 out/ru                   # mean and spread over real runs
npx tsx tools/matrix-adaptive.ts --corpus=out/ru --docs=196    # grid search, three speed scenarios
npx tsx tools/calibrate-adaptive.ts prose 0.5,0.65,0.8 --corpus=out/ru --docs=196 --runs=5
npx tsx tools/simulate-adaptive.ts out/ru <model-ids>          # complexity distribution, static map
```

**Use the harness, not a live run.** A live run reports the split it produced and nothing about
why, so every hypothesis costs another one. Four consecutive live runs came back "deepseek took
everything" for four unrelated reasons.

`matrix-adaptive.ts` is the coarse pass and `calibrate-adaptive.ts` the fine one, and the division of
labour is a cost thing: a real run over the full corpus takes ~40 seconds, so a thousand-point grid
is a week. The matrix **records one real run's routing decisions** — every `complexity`,
`estimatedInputTokens` and `expectedOutputTokens` the pipelines actually posed — and replays them
against the real `scoreTargets` under each candidate. Nothing reimplements the arithmetic; nothing
invents a payload.

What replay drops is the feedback loop, and getting that right took three attempts, each of which
the tool now prints an accuracy check against:

| replay model | predicted | measured |
|---|---|---|
| one frozen snapshot of warm stats | 97.9 / 2.1 / **0.0** | 87.6 / 5.8 / 6.6 |
| sequential, updating immediately | 95.0 / 3.6 / 1.4 | 86.3 / 7.9 / 5.8 |
| sequential, lagged by `IN_FLIGHT = 4` | 65.5 / 29.9 / 4.6 | 65.0 / 29.9 / 5.1 |

The frozen version zeroed the free tier *exactly*, because on this pool the free tier's share is
almost entirely the exploration bonus. The immediate-update version concentrated, because a run
scores under concurrency: roughly four calls are outstanding at any moment, so the target that won
decision *n* has not yet recorded a success when decision *n+1* is scored. **The first line the tool
prints is replay against harness at the current constants** — if those two disagree, nothing below
it means anything.

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

Current constants:

```text
W_THROUGHPUT 1.0 · W_HEALTH 1.8 · W_COST 0.8 · W_PROSE 0.65
COMPLEXITY_PULL 0.7 · COMPLEXITY_MIDPOINT 0.23
SPEED_TOLERANCE 3.0 · SPEED_TOLERANCE_PENALTY 0.06 · SPEED_FULL_PENALTY_RATIO 8
```

Measured over 5 runs, as a share of the openrouter calls:

| corpus | deepseek | minimax-m3 | minimax-m3-free |
|---|---:|---:|---:|
| stated target | 60 | 25 | 15 |
| `out/ru`, 196 docs | 76.4 ± 0.4 | 19.7 ± 0.4 | 3.8 ± 0.2 |
| `manual/`, 736 docs | 82.3 ± 0.5 | 15.4 ± 0.2 | 2.3 ± 0.4 |

76/20/4 rather than the 72/24/4 an earlier, split-fitted `COMPLEXITY_MIDPOINT` produced — see the
midpoint section above for why the honest number is preferred over the one that hit the target more
closely.

### The split shifts with corpus length, independent of what is in the corpus

`out/ru` and `manual/` are the same kind of document — Russian biographies — with almost the same
complexity distribution: median 0.232 on `manual/`, ~0.24 on `out/ru`; mean 0.257 against ~0.265.
The four-point gap between their splits is not a property of what they contain. It is a property of
how many documents there are.

The mechanism is `EXPLORATION_BONUS`, and it decays fast: `0.3 / (1 + successes)` falls from 0.30 at
zero observations to 0.027 by the tenth success — a tenfold drop in the time it takes a target to be
tried ten times. Warming a target from 0 to 500 successes and re-scoring at each step:

```text
n=   0  explore=0.3000  free.score=1.2293
n=  10  explore=0.0273  free.score=0.9771
n=  30  explore=0.0097  free.score=0.9632
n= 500  explore=0.0006  free.score=0.9564
```

Almost the whole decline happens in the first ten calls, and after that the term is negligible. The
number of documents affected by a *meaningfully large* exploration bonus is therefore roughly
constant — bounded by how many calls it takes each target to be tried a few dozen times — while the
total corpus grows without bound. So the **fraction** of the run served under real exploration
shrinks as the corpus grows, and with it goes the lift it gives the underdogs. A short corpus
over-represents them; a long one under-represents the transient and is closer to the strategy's
*steady state*.

Practically: `manual/`'s 82/15/2 is the better estimate of what a long real run looks like once it
has settled. `out/ru`'s 76/20/4 is not wrong, but it is measuring a run that never gets past the
part where exploration still matters. Quote the corpus size next to any split, and treat
`EXPLORATION_BONUS` as more consequential than "untuned" made it sound — it does not just affect the
first few calls of a run, it determines what "the split" even converges to.

> **State the split as a distribution, never as a point.** It is not a function of the constants.
> The strategy learns during a run and task order under `run.concurrency` varies, so a single run is
> one sample. Average over at least five; `split-adaptive.ts` reports the spread so two candidates
> inside each other's noise can be recognised as the same candidate.

It also depends on the corpus. The 16-, 24- and 196-document slices of this repo's own articles give
materially different splits because their complexity distributions differ — quote which corpus a
number came from.

### A share bought with a hairline tie is not a share

The most useful thing the grid search produced was a *rejection*. Candidates that hit 60 / 25 / 15
almost exactly did exist, and they all did it the same way: `W_COST` around 1.2, which lifts the free
tier's score to within a hair of deepseek's across a wide range of documents. Measured on the real
harness, moving `W_PROSE` from 0.8 to 0.7 under one of them moved **seventeen points** of traffic
from deepseek to the free tier.

The reason is structural and worth keeping:

- deepseek against minimax-m3 is separated by a **payload-dependent** term — complexity × tolerance.
  Nudging a weight slides a threshold through document space, and the share moves in proportion to
  how many documents sit near it. That is a stable split.
- deepseek against the free tier is separated by a **constant offset** — price. Two lines a constant
  apart are either always above or always below one another, so as that constant approaches zero
  every document flips at once. The split is then a property of where the constants happen to sit
  relative to a cliff, and nothing fitted to it survives the first hour of provider drift.

`tools/matrix-adaptive.ts` therefore gates on **fragility** — the worst share swing under a 15% nudge
to any one weight — before it ranks on error. Of 3,529 candidates that met the split and speed
requirements, 340 survived that gate, and every one of them had `W_COST = 0.8`.

### The free tier is structurally capped at a few per cent, and the reason is a requirement

It carries 3.8% against a stated 15%, and the two routes to raising it are both closed:

- **By price.** That is the `W_COST 1.2` family above: unstable, rejected.
- **By size.** Raising `maxComfortableTokens` would win it the larger documents — and the deployment's
  own account of this target is that it fails *more often than deepseek* on large and complex
  requests. Sending it more of exactly that work is the opposite of what was asked.

What is capping it is the faithful encoding of that account: `tolerance 0.2`, below deepseek's 0.25,
so a document above the complexity midpoint costs it more than it costs anything else in the pool.
That penalty is now larger than its price advantage. The 15% and the "it crashes more on large and
complex files" are in direct tension, and the safety-relevant half won.

**If the share matters more**, the lever is `minimax-m3-free`'s `tolerance`, not a weight — and the
honest first step is to measure the thing nobody has: the A/B behind `proseQuality 0.7` never covered
the free variant at all, and it now has a prompt override of its own.

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
- **`EXPLORATION_BONUS = 0.3` was chosen, not fitted, and it determines more than the first few
  calls.** It decays from 0.30 to 0.027 within ten successes per target, so its effect on the
  *split* is concentrated in a roughly fixed number of early calls rather than scaling with the
  corpus — which is why `out/ru` (196 docs) and `manual/` (736 docs) measure 76/20/4 and 82/15/2
  respectively from the same constants on near-identical complexity distributions. Sweepable
  (`calibrate-adaptive.ts explorationBonus …`) but not yet swept, and a sweep should hold corpus
  size fixed while it runs, given the above.
- **`minimax-m3-free`'s `proseQuality 0.7` rests on an A/B that never tested it.** The 20-document
  Spanish comparison covered deepseek and the paid minimax-m3 only. The free variant now has a
  prompt override of its own and has never been scored against either.
- **`OUTLIER_CEILING` is relative to the prior**, so an uncharacterised model can never be measured
  as faster than 3× `DEFAULT_PROFILE.priorThroughput` however fast it is.
- **`estimatedCost` ignores prompt caching**, so a target with a warm cache is scored at list price.
- **`invalid_request` and `context_length` count against a target's health** like any other failure,
  though neither says the target is unreliable. Both are rare enough that nothing has been observed
  to turn on it.
