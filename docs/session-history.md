# AdaptiveStrategy — Compressed Engineering Session History

> English, LLM-oriented condensation of `session-history.md`. Chronology is preserved; repeated dialogue, transient debugging narration, obsolete assumptions, and low-value context are removed. Superseded conclusions are retained only when they explain later design changes.

## 1. Initial goal and empirical baseline

Goal: build an optional, isolated `adaptive` routing strategy for translation/localization that selects models using:

1. recent throughput;
2. failure/health rate;
3. cost;
4. document/content complexity.

Initial model intuition: `deepseek` gives stronger prose translation but weaker instruction/format adherence; `minimax-m3` follows structure better but translates prose slightly worse. Complex BioMD documents should therefore bias toward robust models; simpler documents toward cheaper/faster models. Model-specific profiles were intentionally hard-coded to keep `biomd.config.yaml` simple.

Historical analysis used 13 runs / 2,691 `llm.attempt` events. Old target `or-cheap` was confirmed to be `deepseek/deepseek-v4-flash-0731` (748 combined attempts).

Important findings:

- Historical DeepSeek failures were mostly `response_format` errors: missing/malformed keys or lost placeholders.
- Failure rates appeared language-dependent (`es > it > fr >> de=en`), but exposure was strongly imbalanced; treat this as directional, not proof.
- Within-language comparisons did **not** support raw file size as a useful complexity predictor. More plausible signals were metadata/KV density, script mixing, special characters, and container density, with small failure samples.
- On the then-current pinned provider configuration DeepSeek had **0 `response_format` failures in 362 attempts**; older failures came from a previous provider setup. Current DeepSeek failures were mainly timeouts.
- Initial throughput statistics later proved to use the wrong metric; see §6.

Two architectural gaps blocked a purely additive strategy:

- `TargetStatsRegistry` had no recent-token window; `recordSuccess()` did not receive usage.
- `RoutingRequest` did not expose document-level signals.

Minimal core seams were therefore approved:

- `RoutingRequest.signals?` / `GatewayCallOptions.signals?`, propagated through routing.
- Recent per-target observations in `TargetStatsRegistry`, including token usage.

Design constraints identified early and retained throughout:

- avoid self-reinforcing routing where a penalized/untested model never receives traffic again;
- compare throughput in tokens/s, not raw request latency;
- shrink sparse observations toward priors;
- keep load/busy state as a routing gate or strong term;
- keep strategy selection pure; state belongs in stats registries;
- preserve deterministic regression testing where possible.

## 2. First implementation

Created:

- `src/routing/strategies/adaptive/ComplexityScorer.ts` — pure text → `[0,1]` complexity score;
- `src/routing/strategies/adaptive/ModelProfiles.ts` — hard-coded priors and model traits;
- `src/routing/strategies/adaptive/AdaptiveStrategy.ts` — registered `adaptive` strategy;
- `tests/adaptive.test.ts`;
- `tools/simulate-adaptive.ts`.

Core additions were optional/backward-compatible: `signals`, recent stats, token-aware success recording, and strategy registration.

The first test pass exposed two real formula defects:

1. **Min-max normalization exaggerated tiny differences.** Example: a few percentage points of failure-rate difference became `0` vs `1`. It was replaced by proportional normalization (`v/max`, `min/v`) so magnitude survives.
2. **Complexity bias was one-sided.** Scaling directly from `complexity` gave no bias for very simple documents. It changed to a centered term using `(complexity - 0.5) * 2`.

Additional safeguards:

- throughput outlier cap: recent observations cannot claim >3× historical prior;
- Laplace smoothing: `0/N` failures is not interpreted as zero risk.

Initial corpus simulation on 196 documents showed useful complexity spread: min `0.036`, median `0.240`, p95 `0.547`, max `0.697`. Strong contributors included container density, script mixing, and container KV metadata.

With only paid `minimax-m3`, early calibration heavily favored DeepSeek because paid M3 cost much more. Adding free M3 caused the opposite: the free model dominated on cost.

## 3. Target split 65/25/10 and the fifth axis

Desired approximate workload split:

- DeepSeek: 60%-65%
- `minimax-m3`: 25%
- `minimax-m3-free`: 10-15%

This was impossible with only throughput, health, cost, and complexity because `minimax-m3-free` could dominate DeepSeek on all modeled axes. The strategy lacked the actual reason to prefer DeepSeek: translation prose quality.

Added fifth model trait: `proseQuality`.

Initial subjective values:

- DeepSeek: `0.95`
- M3 variants: `0.70`

This was explicitly recognized as a hypothesis, not a measured metric.

A separate defect was found in complexity bending: a fragile model could be indirectly rewarded for low `tolerance`. The bend was clamped so fragility is never a positive feature.

A safety boundary was established for `COMPLEXITY_PULL`: values above roughly `0.85` could let a model with effectively zero recent health win on difficult documents. `0.9` was therefore unsafe; `0.5` became the working value and the failure case was covered by tests.

Working weights after this first phase:

```text
W_THROUGHPUT = 1.0
W_HEALTH     = 1.5
W_COST       = 0.2
W_PROSE      = 0.5
COMPLEXITY_PULL = 0.5
```

Key interpretation:

- `W_PROSE` is a **vertical shift**: it changes a model's baseline score on every document.
- `COMPLEXITY_PULL` is a **slope** around complexity `0.5`: it controls how strongly model preference changes with document complexity.

Practical rule:

> `W_*` terms decide the default winner; `COMPLEXITY_PULL` decides how strongly document complexity can overturn that default.

Because corpus median complexity is only ~`0.24` and >`0.5` documents are rare, increasing `COMPLEXITY_PULL` actually penalized high-tolerance M3 on most documents and increased DeepSeek share. Therefore, to increase paid M3 share, reduce `COMPLEXITY_PULL`; to increase DeepSeek against the free model, raise `W_PROSE`.

A calibration utility was added:

```bash
npx tsx tools/calibrate-adaptive.ts input/ru \
  "--target=deepseek=65,minimax-m3=25,minimax-m3-free=10"
```

However, later testing showed that single-run split calibration was not statistically reliable; see §9.

## 4. Free-tier size heuristic and structured-output clarification

`minimax-m3-free` was confirmed to support `json_object` but not `structured_outputs/json_schema`. Biomd pipelines request `json_object`, so lack of `json_schema` does **not** currently explain failures.

A `maxComfortableTokens` profile field was added to discourage the free tier on larger requests without removing it from fallback routing. The threshold eventually settled at `2600`.

Corpus-wide real `translate` request sizes (`n=1504`):

| metric | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|
| tokens | 1616 | 2134 | **2502** | 2978 | 3912 | 7944 |

`2600` is ~57th percentile, so it is representative of the full corpus, not the small test subset.

Later evidence weakened the rationale for this heuristic:

- historical `response_format` failures did not correlate with large batch size;
- OpenRouter free limits are request-count based, not token-count based.

Therefore `maxComfortableTokens` remains an **unproven policy heuristic**, not an empirically validated reliability rule. Lowering it would also push free-tier share below the desired ~10%.

## 5. First live API validation exposed three routing defects

After enabling `strategy: adaptive`, real API tests confirmed `minimax-m3-free` worked, but initial runs routed no work to either M3 variant.

Three independent implementation defects were found:

1. **Complexity was computed from stripped prose, not the full BioMD document.** Containers, metadata, tables, captions, etc. had already been removed. Mean complexity collapsed from ~`0.265` to ~`0.082`; no document exceeded `0.5`. Fixed by scoring `document.content`.
2. **Busy candidates were sorted by price instead of adaptive score.** Models sharing the same OpenRouter endpoint also shared load, so the scoring model was effectively bypassed. Fixed.
3. **No exploration/cold-start recovery.** One early fast DeepSeek observation could make untested models permanently noncompetitive. An exploration mechanism was added.

A separate operational clarification: `models --probe` calls **every declared model**, not only pool members. This explained isolated API calls to `nemotron-free` and GPT-5.6 Luna (`paid-search`); neither participated in the translation pool.

## 6. Throughput metric was fundamentally wrong

The most important measurement bug: throughput used `totalTokens / latency`, counting prompt tokens as if the model generated them. This made large prompts with short completions look artificially fast and distorted models by different factors.

Comparison against OpenRouter:

| model | OpenRouter tok/s | old internal metric | inflation |
|---|---:|---:|---:|
| DeepSeek | 90.5 | 302.3 | 3.7× |
| M3 paid | 154.5 | 611.7 | 4.8× |
| M3 free | 81.9 | 501.3 | 6.4× |

The metric changed to **completion tokens / wall-clock latency**. Wall-clock intentionally includes routing/provider overhead because it reflects actual job completion time.

Updated throughput priors:

```text
deepseek          81 tok/s
minimax-m3       127 tok/s
minimax-m3-free   78 tok/s
gpt-luna          51 tok/s
gemma-local       53 tok/s
```

earlier historical observations showing more moderate (and most likely more realistic) numbers:
```text
deepseek         15-90 tok/s (average 30 tok/sec)
minimax-m3       30-80 tok/s (average 50-60 tok/sec)
minimax-m3-free   50 tok/s  
gpt-luna          50-100 tok/s (average 70 tok/sec)
gemma-local       90-120 tok/s (average 100 tok/sec, nur 1 concurrency)
```

This invalidated earlier split calibration based on the old throughput units.

## 7. Simulation harness became the primary test method

Repeated paid live runs were inefficient and obscured logic defects. A full local harness was added:

- `tests/adaptive.simulation.test.ts`
- real `runJob`;
- real `Router`;
- real concurrency/limits/gateway behavior;
- `FakeClient` reproducing measured model speeds;
- no network or API cost.

Runtime: ~2 seconds instead of several minutes.

The harness reproduced a live OpenRouter split closely:

| source | DeepSeek | M3 paid | M3 free |
|---|---:|---:|---:|
| simulation | 71.6% | 23.0% | 5.4% |
| live run | 68% | 24% | 8% |

New invariants specifically prevent regressions found during live testing, including:

- every eligible pool member must receive exploratory work;
- complexity must retain meaningful corpus spread;
- routing must not bypass adaptive scoring through busy/price ordering.

General lesson adopted for future work:

> Validate routing logic in the deterministic/local harness first; use live APIs only to validate assumptions that simulation cannot establish.

## 8. Documentation and open issues checkpoint

Detailed documentation was added at `docs/ref/adaptive-routing.md`, linked from:

- `docs/ref/INDEX.md`;
- `CLAUDE.md`;
- `.claude/rules/llm-routing.md`.

It records formula inputs, `W_PROSE` vs `COMPLEXITY_PULL`, the `0.85` safety ceiling, complexity semantics, throughput units, known defects/invariants, tools, calibration, and open gaps.

Memory/reference files were also updated: `biomd-adaptive-strategy.md`, `biomd-live-run-discipline.md`, and `biomd-llm-endpoints.md`.

At this checkpoint the important unresolved items were:

1. `localize` used batch-level rather than document-level complexity;
2. behavior under actual failures was untested;
3. 429/rate-limit recovery was unmodeled;
4. `tolerance` and `proseQuality` were subjective;
5. `EXPLORATION_BONUS = 0.3` was not tuned;
6. cache-aware cost estimation was inaccurate but deprioritized;
7. `extract` was not migrated to adaptive;
8. `nemotron-free` profile key mismatch was irrelevant while outside pools;
9. health had no time decay.

The next work explicitly prioritized 1, 4, then failure/rate-limit recovery and health decay.

## 9. Quality A/B, localize fix, health recovery, and calibration noise

### 9.1 `localize` complexity fixed

`LocalizePipeline.ts` now passes document complexity using the full source article:

```text
complexity: complexityOf(item.content)
```

`WorkItem = SourceDocument`, so the full content was already available.

### 9.2 Measured translation quality: DeepSeek vs paid M3

A controlled A/B test used 20 real `manual/` BioMD documents, stratified by complexity `0.039–0.585`, translated to Spanish with one-model pools. The `manual/` distribution matched the main corpus reasonably well (median complexity ~`0.228` vs `0.240`).

Actual cost: ~$0.034.

Results:

| model | structurally clean | Cyrillic leakage | `dashΔ` |
|---|---:|---:|---:|
| **DeepSeek** | **20/20** | **0** | 18 |
| M3 paid | 15/20 | 273 chars / 19 cases | 45 |

Leak analysis refined the conclusion:

- 12 cases / 216 chars: Cyrillic person names in headings/captions — real publication defect;
- 7 cases / 75 chars: original work titles preserved with translated gloss — arguably valid bibliography, though the scorer flags it;
- **0 untranslated prose sentences**.

Thus M3 did not broadly fail translation; its concrete defect was transliteration/localization of proper names in headings/captions. This provides evidence for a DeepSeek `proseQuality` advantage but does **not** validate `tolerance`: neither model had protocol/`response_format` failures in this A/B.

A second-language A/B is required before changing subjective profile values aggressively.

### 9.3 Health decay and failure/rate-limit simulation

Health recovery gained two independent mechanisms because a penalized target may stop receiving traffic:

- a window of the last 10 outcomes forgets old failures;
- failure streak penalty decays after `STREAK_DECAY_MS` even without new calls.

Important implementation correction: the outcome window is used for the **health estimate**, while confidence uses cumulative sample count. Using window size for both collapsed confidence and made price dominate, causing the free model to jump excessively.

The simulation harness added tests for:

- a target that fails every call: corpus still completes and traffic moves elsewhere;
- free-tier quota exhaustion / HTTP 429: target stops being hammered;
- recovery after the rate-limit period;
- failure-streak decay;
- old failures disappearing from the rolling window.

### 9.4 Single-run workload calibration was invalid

While tuning `W_PROSE`, identical constants produced very different splits because the adaptive strategy learns online and `concurrency: 8` changes which model receives early observations.

Ten repeated runs with unchanged constants showed:

| model | mean | σ | min | max |
|---|---:|---:|---:|---:|
| DeepSeek | 84.4% | 3.6 | 73.7% | 85.9% |
| M3 paid | 13.1% | 0.3 | 12.8% | 13.7% |
| M3 free | 2.5% | 3.6 | 1.3% | 13.2% |

Therefore the earlier exact-looking `65/25/10`, `66/26/8`, etc. results were **single-run noise**, not stable deterministic properties of the constants.

Calibration was redone using averages over five runs per candidate. Best tested combination:

```text
W_PROSE = 0.50
minimax-m3-free priorFailureRate = 0.08
```

Average split: approximately **63 / 21 / 16** versus the desired 65/25/10.

This split must be reported as a distribution/range, not a precise point. Work allocation depends on concurrency, exploration, early observations, document order, measured speed, and runtime failures.

`EXPLORATION_BONUS = 0.3` was intentionally left untuned because its effect is concentrated in the first few requests, where variance is highest; a meaningful sweep requires repeated runs per point.


Current model-trait snapshot discussed by the end of the session:

| model | throughput prior | tolerance | proseQuality | notable profile setting |
|---|---:|---:|---:|---|
| DeepSeek | 81 tok/s | 0.25 | 0.95 | stronger prose hypothesis, lower structural tolerance |
| `minimax-m3` | 127 tok/s | 0.95 | 0.70 | highest structural tolerance; `0.95` remains weakly validated |
| `minimax-m3-free` | 78 tok/s | 0.60 | 0.70 | `priorFailureRate=0.08`, `maxComfortableTokens=2600` |
| `gpt-luna` | 51 tok/s | — | — | throughput prior only noted here |
| `gemma-local` | 53 tok/s | 0.70 | — | historical structure-failure rate was low |

## 10. Current state and next work

Current validated state at the end of the session:

- **593 tests pass; typecheck clean.**
- `adaptive` is implemented and isolated.
- document complexity is computed from full source content for both `translate` and `localize`;
- throughput uses completion tokens/s, with wall-clock latency;
- adaptive scoring is not bypassed by shared-endpoint busy sorting;
- cold-start exploration exists;
- health can recover through rolling outcomes and time-based streak decay;
- failure and 429/recovery behavior are covered by simulation;
- DeepSeek's translation-quality advantage has one controlled Spanish A/B supporting it;
- exact workload ratios are known to be stochastic, not deterministic;
- `maxComfortableTokens = 2600` remains a policy heuristic, not a validated reliability predictor.

Primary next steps:

1. **Repeat the controlled A/B on a second target language** using the same stratified corpus. This is the strongest next evidence for `proseQuality` and may challenge `minimax-m3 tolerance = 0.95`.
2. If tuning workload ratios further, **optimize on repeated-run means/variance**, never one simulation.
3. Evaluate whether `EXPLORATION_BONUS = 0.3` is worth a repeated-run sweep.
4. Keep `maxComfortableTokens` explicitly labeled heuristic unless real free-tier reliability or quota data supports it.
5. Live-test actual provider failures/rate limits only after simulation coverage; use live API primarily to validate external assumptions.
6. `extract` migration to `adaptive`, cache-aware price correction, and Nemotron profile cleanup remain intentionally deferred unless their priority changes.

Generated A/B artifacts were placed under `.ab/` during testing (`out-minimax/es`, `out-deepseek/es`, `corpus/ru`); `.ab/` was added to `.gitignore`.

## Compact tuning reference

| Parameter / signal | Meaning | Increase tends to |
|---|---|---|
| `W_THROUGHPUT` | importance of measured completion speed | favor faster endpoints |
| `W_HEALTH` | importance of recent reliability | favor low-failure targets |
| `W_COST` | price sensitivity | favor cheaper/free targets |
| `W_PROSE` | trust in model-specific prose quality | favor high-`proseQuality` models, especially DeepSeek |
| `COMPLEXITY_PULL` | specialization slope vs document complexity | strengthen simple-vs-complex specialization; on this low-complexity corpus, raising it usually increases DeepSeek share and reduces paid M3 |
| `tolerance` | robustness trait used by complexity bend | determines which models gain on complex documents |
| `maxComfortableTokens` | soft size preference, currently heuristic | lower values restrict free M3 to smaller requests |
| `EXPLORATION_BONUS` | cold-start opportunity | gives under-observed targets early traffic; currently `0.3`, untuned |

Core formula intuition:

```text
base score = weighted throughput + health + cost + prose quality
complexity bend ∝ COMPLEXITY_PULL × (complexity - 0.5) × 2 × (tolerance - 0.5)
```

with safeguards preventing low tolerance from becoming a reward and preventing complexity bias from overriding catastrophic health.

# !!Additonally implemented to improve minimax-m3 proseQuality (fix an issue with untranslated names / headings):
## Model-Specific Prompts and Untranslated-Text Gate

## 1. Goal

Two safeguards were introduced for Russian → target-language translation/localization:

1. **Model-dependent prompts:** fix model-specific failure modes without changing a stable shared prompt. `minimax-m3` uniquely left names untranslated in headings/captions (12 observed cases; 7 quoted work titles were considered non-critical).
2. **Untranslated-text detection:** structural JSON validation did not verify that returned values were translated. Short values such as `Наталья Липницкая (2003)` or mixed-script artifacts such as `Debussи` could pass.

## 2. Model-dependent prompts

Convention:

```text
prompts/<task>/<modelId>/<same filename>
```

No new config keys. If an override exists, it is used; otherwise the default prompt remains active.

```bash
biomd prompts list
biomd prompts show <task> --model <id>
```

### Architecture

- **Override, not fork.** A model-specific prompt receives the rendered common prompt as `sharedSystem` and appends only the delta. Full replacement remains an emergency option; duplicating `segments-system.md` would cause prompt drift.
- **Gateway selects variants.** Routing happens after pipelines build requests, and fallback may choose another model. Therefore prompt variants travel in `CompletionRequest.variants` and are selected at send time. Each variant needs its own prompt-cache key.
- **Fingerprint cost.** Overrides participate in the task-version hash. Adding/changing one can replan tasks for all models because planning precedes model selection. This avoids silently reusing results from obsolete prompts. Use `--skip-existing` when recomputation is undesirable.

## 3. Untranslated-value gate

Live tests showed that one Cyrillic-only rule was insufficient. Validation now combines:

| Detector | Catches |
|---|---|
| returned value == source fragment byte-for-byte | unchanged sentences/prose |
| every returned letter belongs to source alphabet | unchanged short names/headings |

Reason: one Spanish `kulikovskaja` run preserved **8 complete Russian prose lines**. Latin insertions inside those lines bypassed a pure-script detector, but all 8 values exactly matched the source.

Strictness is intentional:

- unchanged values are rejected even on strict/final attempts because fallback exists to recover them;
- mixed-script anomalies such as `Debussи` are rejected only on non-strict attempts; one foreign-script letter prevents classifying the whole value as certainly untranslated.

## 4. First live test: 20 documents, ru → es

| configuration | clean | Cyrillic residue | requests | retries | failed | `dashΔ` |
|---|---:|---:|---:|---:|---:|---:|
| shared prompt, no gate | 15/20 | 273 chars | — | — | — | 45 |
| shared prompt + gate | 17/19 | 874 chars | 28 | 3 | 1 | 39 |
| + initial M3 override | **20/20** | **0** | **22** | **0** | **0** | 56 |
| DeepSeek, shared prompt | 20/20 | 0 | — | — | — | 18 |

Cost: **$0.043** for the measured gate/override runs.

The weaker gate-only result coincided with four timeouts and was treated as a stochastic bad run, not proof that validation degraded quality. It did expose the unchanged-prose failure that justified the equality detector.

### M3 failure mechanism

The shared prompt already had the necessary rules and M3 followed them inside prose. The problem was an ambiguity:

- untranslatable fragment → return unchanged;
- names → transliterate/translate appropriately.

A fragment consisting only of a name matched both rules. M3 resolved this incorrectly in 12/20 observed cases, always in headings/captions. The override therefore clarifies this edge case rather than adding broad translation rules.

## 5. Test-infrastructure defect

`echoTable` returned input unchanged as the "translation", so the test double could not represent the main real failure: structurally valid but untranslated output. The new gate broke 29 tests; `echoTable` was changed to transliterate.

After implementation: typecheck clean; **614 tests** passing (previously 593; +21 in `tests/scriptgate.test.ts` and `tests/modelprompts.test.ts`). Documentation was updated in `prompts/README.md`, `docs/ref/prompts.md`, `.claude/rules/`, `CLAUDE.md`, and the silent-failure catalog.

**Still not live-verified:** the equality detector did not trigger in the tuned API run because no value came back verbatim. A unit test covers the real `kulikovskaja` example.

## 6. Prompt audit and rewrite

The initial M3 override itself contained unnecessary model-visible text:

1. measurement/audit history (`12 of 20`, etc.);
2. routing metadata such as `One correction, for this model only`;
3. broad self-review: `Before you answer, read your own values back`.

These tokens were non-actionable and the broad self-review could encourage unnecessary rewriting (`dashΔ`). The override was reduced to **one rule, two examples, one narrow final check**: no value may remain entirely in the source alphabet; do not change anything else because of that check.

Maintainer rationale moved into a non-rendered Eta comment. Eta 3 gotcha:

```eta
<% /* comment */ %>   // valid, not rendered
<%# comment %>        // invalid: Bad template syntax
```

`prompts show --model minimax-m3` confirmed the comment does not reach the model. Documentation now states that ordinary template prose is model-visible and paid on every call.

## 7. Re-test after rewrite

Changing prompt text invalidated the previous 20/20 evidence, so it was re-measured:

| configuration | clean | Cyrillic | requests | retries | `dashΔ` | titles kept |
|---|---:|---:|---:|---:|---:|---:|
| shared prompt | 15/20 | 273 | — | — | 45 | 21/21 |
| initial override | 20/20 | 0 | 22 | 0 | 56 | 21/21 |
| **rewritten override** | **20/20** | **0** | **21** | **0** | 50 | 20/21 |
| DeepSeek | 20/20 | 0 | — | — | 18 | 21/21 |

Additional cost: **$0.023**. Typecheck remained clean; all **614 tests** passed.

The robust finding is **zero Cyrillic leakage in two different 20-document override runs**. `dashΔ` (`45 → 56 → 50`) and title preservation (`21/21 → 21/21 → 20/21`) vary enough between single runs that they must not be attributed to prompt changes without repeated measurements.

## 8. Current state / next work

**Established:** model-specific overrides work as minimal deltas; gateway-level variant selection preserves fallback correctness; untranslated-text detection needs both equality and source-alphabet checks; the minimal M3 override eliminated observed Cyrillic leakage twice; Eta comments must use `<% /* ... */ %>`.

**Open:** live-trigger the equality detector on an unchanged API response; repeat stochastic secondary metrics before drawing conclusions; keep model-specific prompts minimal rather than forking the shared prompt.







---

# Session 3 — audit of the arithmetic, and the instrument that was measuring nothing

Goal: review `AdaptiveStrategy.ts` for logical, arithmetic and reliability defects; fix what is
real; make it ready for production use. Six defects were found, one of which invalidates every
calibration recorded above.

## 1. The harness never spent wall clock — everything above was fitted to an artefact

`LlmGateway` records `Date.now() - startedAt` and **ignores** the `latencyMs` a `CompletionResponse`
declares. The simulation's `FakeClient` returned synchronously, so every call was measured as taking
~0ms, and `completionTokens / 0ms` is not a throughput — it is whatever `OUTLIER_CEILING` clamps it
to. Confirmed by instrumenting a run: deepseek's measured throughput climbed to 238 tok/s against
its 81 prior and stayed there, while untouched targets sat at their priors.

Consequences:

- the throughput term was a **first-mover bonus**. Whichever target answered first was pinned at 3×
  its prior for the rest of the run, because the window only refills for a target being called;
- this is the source of the run-to-run variance recorded in §9.4. minimax-m3's share ranged 0.8% to
  25.4% between *identical* runs because it depended on whether it drew an early call;
- every constant fitted with this harness — the 63/21/16, `W_PROSE 0.50`, `COMPLEXITY_PULL 0.43` —
  was fitted against that.

Fixed by making the fake sleep. `TIME_SCALE = 80` divides both the reported completion tokens and
the sleep, so tokens/second is exact and a call costs ~100ms. After the fix, measured throughput
lands within 2–6% of what each target was asked to model, and the spread of minimax-m3's share fell
from σ 8.7 to σ 2.0. `tests/adaptive.simulation.test.ts` now asserts this **first**, because
nothing below it means anything otherwise.

## 2. Throughput confidence was capped at four observations

`shrink(measured, prior, stats.recent.length)` — and `RECENT_WINDOW` is 4, so the hand-set prior kept
3/7 of the term for the entire run however much evidence arrived. Measured: a target sustaining
200 tok/s against a prior of 81 read as **149**; one sustaining 40 against a prior of 127 read as
**77**. A 5:1 speed difference scored as 1.9:1.

This is the *same* mistake the file already documented and fixed for health — the window supplies
the estimate, the cumulative count supplies the confidence — left unfixed for throughput. Confidence
is now `stats.successes`, and the outlier ceiling is applied to the window value *before* the blend
rather than after.

## 3. Throughput had no way to go stale, and health had two

A slow window demotes a target, and being demoted is what stops the next measurement arriving. Health
recovers through the rolling window and through `STREAK_DECAY_MS`; throughput had neither, so the
first bad window a target drew was the one it was judged on for the rest of the run. Added
`THROUGHPUT_DECAY_MS = 120_000`: confidence fades with idleness, so the target reverts to its profile
and gets another turn. The same shape as the breaker's half-open probe.

## 4. The cost term collapsed whenever a free target was in the pool

`proportional(values, false)` computed `(min + floor) / (value + floor)`. With a free candidate `min`
is zero, so every paid target scored on the floor alone. Measured on the real pool: the
deepseek-to-minimax gap on this term was **0.82** without the free tier and **0.045** with it — an
eighteen-fold change in a comparison the free tier is not part of. Which is exactly the
magnitude-destroying behaviour of min-max that `proportional` was written to avoid, arriving by
another route.

Replaced with `1 − value / max`, the mirror of the higher-is-better branch. Pinned by a test that
asserts two paid targets compare identically with and without a free one present.

## 5. The `COMPLEXITY_PULL` safety ceiling was wrong, and is now a mechanism

Documented at 0.85. The arithmetic put it at **0.658** — a health-0 target was still banking the
full reward half of its complexity bend. Worse, the bound is a *consequence* of the four weights, so
it moves whenever one of them does and nothing says so.

Fixed structurally: the reward half of the bend is now multiplied by the target's health score, so a
target failing every call gets no bend at all. Margin at complexity 1.0 went from 0.16 to 0.36, the
ceiling from 0.658 to ~1.85, and the test pins the mechanism rather than the number. It costs
nothing in normal operation — `healthScores` is proportional, so a pool of working targets sits
within a percent of 1.

## 6. `tools/` was outside the typecheck gate

Which is how `calibrate-adaptive.ts` drifted. `tools/simulate-adaptive.ts` had a live type error (its
fake `ModelTarget` was missing `apiFormat` and `provider`). `tsconfig.json` now includes
`tools/**/*.ts`; `tsconfig.build.json` still emits `src` only.

## 7. Throughput priors are a mixture, not a property

User correction, and it reframes what a prior is. `local` and `omniroute` each front one deployment,
but an openrouter model id is served by dozens of providers at once — one managing 10 tok/s while
another does 100 — and the population drifts with the time of day (faster in the evening, slower
through a working day). The durable fact is the **ratio**: minimax-m3 runs about 30% faster than
deepseek.

- `minimax-m3` prior 127 → **105** (= 81 × 1.3). The 127 came off twelve calls through one
  afternoon's providers, which is a sample of a mixture rather than a speed.
- `minimax-m3-free` keeps 78: one named fp8 host, so it is a measurement of a thing.
- This is independent support for §2 and §3 — a prior that is a wide moving average *must* be
  overrulable, and a measurement of it *must* expire.
- The harness gained a `SPREAD` term (±55% per call on openrouter ids, ±10–15% on the
  single-deployment ones) and a test that the pool stays in play when speeds swing between calls.
- `RECENT_WINDOW` was considered and deliberately **left at 4**: forgetting a degraded provider
  within four calls is worth the noise.

## 8. Recalibration, and what a share target can and cannot be

With the instrument honest, theory and measurement agree for the first time. At `proseQuality 0.70`
minimax-m3 was 0.02 behind deepseek at complexity 0.5, so the crossover sat at `c* = 0.553` and **no
value of `COMPLEXITY_PULL` could put its share past the ~7% of documents above that line.** A sweep
duly reported `complexityPull = 0.05` as the best fit to 65/25/10 — because at that value the three
scores are within a hair of each other and the split is decided by exploration and task order. That
is not routing; it is a lottery that happens to average correctly.

`proseQuality` for minimax-m3 raised 0.70 → **0.85**, on evidence this repo produced *after* 0.70
was set: with the model-specific prompt override, minimax-m3 scored 20/20 structurally clean with
zero Cyrillic leakage in two separate 20-document runs, matching deepseek. `minimax-m3-free` keeps
0.70 — different deployment, fp8, never measured.

Measured over 5 runs of the **whole 196-document corpus**, share of openrouter calls:

| | deepseek | minimax-m3 | minimax-m3-free |
|---|---:|---:|---:|
| `proseQuality 0.70` | 91.4 ± 0.8 | 6.7 ± 0.5 | 1.9 ± 0.7 |
| **`proseQuality 0.85` (shipped)** | **88.5 ± 0.6** | **9.8 ± 0.8** | **1.7 ± 0.3** |

`c*` is now 0.489. Standard deviations are under one point, against 8.7 before the harness fix.

**The free tier is the outstanding mismatch**: policy said 10–15%, it carries 1.7%. On merit it is
last — marginally slower than deepseek, lower tolerance, the same prose, an oversize penalty on the
larger half of the corpus, and a deliberately high `priorFailureRate`. Being free is worth at most
`W_COST / ΣW` = 6.25% of the score. `W_COST` is the lever and it has not been turned.

## 9. Tooling

- `tests/helpers/adaptiveHarness.ts` — the pool, the timing-aware fake and the run driver, shared by
  the simulation test and both tools, so a constant fitted with a tool is fitted against what the
  test asserts.
- `tools/split-adaptive.ts` (new) — mean and spread over N real runs, plus a **measured tok/s row
  next to each prior**, which is the instrument checking itself. That row is what would have caught
  §1 on day one.
- `tools/calibrate-adaptive.ts` (rewritten) — drives the real `scoreTargets` through a new
  `AdaptiveTuning` parameter instead of transcribing the arithmetic, sweeps any of the six weights,
  holds others with `--fix=`, and refuses to claim an ordering that is inside the spread.
- `tools/simulate-adaptive.ts` — header corrected. It scores **documents** with empty stats, and
  because complexity is a density it is negatively correlated with length (r = −0.39), so a
  per-document map over-reports the tolerant model against a per-call run by about two to one. Use
  it for the complexity distribution, never to fit a share.
- A test that wrote to the hardcoded absolute path `C:/work.ai/biomd-process/.ab/split.txt` was
  deleted; the tool does that job properly.
- `nemotron-free` profile key corrected (was `nemotron`, matched nothing).

## 10. Where it stands

623 tests pass, typecheck clean including `tools/`. Nine new assertions cover throughput confidence,
the outlier ceiling, cost-term pool-invariance, the health-gated bend, the oversize ramp,
exploration decay, tuning parameterisation, staleness decay, and the harness's own timing.

Open, in the order they are worth doing:

1. **`W_COST` for the free tier.** The only calibration question left, and a policy one: how much of
   a metered allowance is worth spending down.
2. **A second-language A/B.** Still the strongest evidence available about `proseQuality`, and the
   only thing that would say anything at all about `tolerance`, which has never been measured.
3. **`extract` still routes with `least-busy`** and passes no `signals.complexity`; it goes through
   `escalation.ts` rather than `stringBatch.ts`.
4. **`EXPLORATION_BONUS` is sweepable now and has not been swept.**
5. **`OUTLIER_CEILING` is relative to the prior**, so an uncharacterised model can never measure
   faster than 3× `DEFAULT_PROFILE.priorThroughput`.
6. **`estimatedCost` ignores prompt caching.** A warm target is scored at list price.
7. **`invalid_request` and `context_length` count against health** though neither says the target is
   unreliable.

---

# Session 4 — a matrix search, a speed knee, and the constant that was a scale artefact

Goal: hit a stated 60 / 25 / 15 by searching a parameter matrix, and make the strategy respond to
speed the way an openrouter pool actually needs it to — tolerant of a 2.5× reading, decisive at
3.5×. Two new mechanisms, one new instrument, and one target that turned out to be unreachable for a
reason worth keeping.

## 1. `COMPLEXITY_MIDPOINT` — the largest single behaviour change in the strategy's life

The complexity bend was centred on 0.5: the midpoint of the 0…1 **scale**, chosen because it is the
midpoint of the scale. That is not a fact about any corpus, and on this one it was quietly wrong.
The median document scores 0.24 and the mean 0.265, so measuring "above average" from 0.5 made ~93%
of the corpus below average and handed the tolerant model a penalty on nearly every document it saw.
The term was not discriminating between documents; it was a blanket levy with a rebate for the top
7%.

This is also the answer to session 3's "the 25% target is not reachable from `COMPLEXITY_PULL`".
That was true, and the reason was this constant rather than the weights. Making it a parameter and
fitting it to the corpus moved minimax-m3 from **6.7% to ~24%** at otherwise identical weights.

Note it is **not** the same quantity as `DEFAULT_PROFILE.tolerance`, which is also 0.5 and is the
neutral point of a different axis. They were the same number by coincidence, and two existing tests
had been reading the neutral complexity out of the wrong one.

## 2. Speed is scored through a knee, because it is not a property of the model

User correction, and it reframes the term. The other three terms compare properties of a *model*.
Speed on openrouter is not one: dozens of providers serve one id, one managing 10 tok/s while another
does 100, and the population drifts with the clock. Two identical models measured over four calls
each can differ threefold for no reason that will still be true in a minute.

`v / max` has the response exactly backwards for that. It is steepest where the measurement is least
trustworthy: 2.5× spent 0.6 of the term and going on to 3.5× cost 0.11 more. The strategy reacted
hardest to the differences most likely to be noise and had almost nothing left for the real ones.

Replaced with a piecewise-linear response in **octaves** — "twice as slow" is one step at 40 tok/s or
at 400 — with a gentle slope inside the noise band and a steep one outside:

```text
SPEED_TOLERANCE 3.0 · SPEED_TOLERANCE_PENALTY 0.06 · SPEED_FULL_PENALTY_RATIO 8
```

The band comes from the measurement's own noise floor: ±55% per call on an openrouter id means two
identical targets can read 3.4× apart on a bad pair of draws. Measured at the median document,
deepseek's score falls 0.008 from parity to 2.5× and 0.035 more going on to 3.5×.

**Asserted on `scoreTargets`, not on a run.** The same question asked end-to-end over 24 documents
answered "48% at 2×" and "45% at 2.5×" — exploration and task order swamp the effect at that corpus
size. The requirement is a property of the scoring function, so it is pinned where it lives.

## 3. The free tier: profile corrected, and a share that is structurally out of reach

The deployment's account of `minimax-m3-free` is that it lacks `json_schema` and fails **more often
than deepseek** on large and complex requests. Its `tolerance` was 0.6 — *above* deepseek's 0.25, on
the theory that only quantization separates it from the paid variant. Corrected to **0.2**, which
puts it below the neutral 0.5 so the fragility clamp engages and a tangled document can only ever
cost it something. At 0.6 it was collecting a small *bonus* on exactly the payloads it is least able
to hold together.

That correction is also what caps its share at 3.8% against a stated 15%, and both routes to raising
it are closed:

- **by price** — the `W_COST 1.2` family, rejected for fragility (§4);
- **by size** — raising `maxComfortableTokens` wins it the larger documents, which is precisely the
  work it was just said to fail on.

The 15% and "it crashes more on large and complex files" are in direct tension and the
safety-relevant half won. The lever, if the share matters more, is its `tolerance` rather than any
weight — and the honest first step is that the A/B behind its `proseQuality 0.7` **never covered the
free variant at all**.

## 4. Fragility: the most useful thing the grid produced was a rejection

Candidates that hit 60 / 25 / 15 almost exactly did exist. They all did it the same way: `W_COST`
around 1.2, lifting the free tier to within a hair of deepseek across a wide range of documents. On
the real harness, moving `W_PROSE` from 0.8 to 0.7 under one of them moved **seventeen points** of
traffic from deepseek to the free tier.

The reason is structural:

- deepseek vs minimax-m3 are separated by a **payload-dependent** term. Nudging a weight slides a
  threshold through document space and the share moves in proportion to the document density near
  it. Stable.
- deepseek vs the free tier are separated by a **constant offset** — price. Two lines a constant
  apart are always-above or always-below, so as the constant approaches zero every document flips at
  once. Nothing fitted to that survives an hour of provider drift.

`matrix-adaptive.ts` now gates on fragility — worst share swing under a 15% nudge to any one weight —
before ranking on error. Of 3,529 candidates meeting the split and speed requirements, **340
survived, and every one had `W_COST = 0.8`**.

## 5. The instrument: replay, and the three attempts it took

A real run over the full corpus costs ~40 seconds, so a grid is a week. `matrix-adaptive.ts` records
one real run's routing decisions — every `complexity`, `estimatedInputTokens` and
`expectedOutputTokens` the pipelines actually posed — and replays them against the real
`scoreTargets`. Nothing reimplements the arithmetic; nothing invents a payload.

Getting the *feedback loop* right took three tries, and the tool now prints its own accuracy check
first:

| replay model | predicted | measured |
|---|---|---|
| one frozen snapshot of warm stats | 97.9 / 2.1 / **0.0** | 87.6 / 5.8 / 6.6 |
| sequential, updating immediately | 95.0 / 3.6 / 1.4 | 86.3 / 7.9 / 5.8 |
| sequential, lagged by `IN_FLIGHT = 4` | 65.5 / 29.9 / 4.6 | 65.0 / 29.9 / 5.1 |

The frozen version zeroed the free tier *exactly*, because on this pool its share is almost entirely
the exploration bonus. The immediate-update version concentrated, because a run scores under
concurrency: ~4 calls are outstanding at any moment, so the winner of decision *n* has not recorded a
success when *n+1* is scored.

Replay is still a coarse instrument — it over-predicted the free tier by 4 points at the final
constants, because it replays request sizes captured under a different tuning. Shortlists get
confirmed on `split-adaptive.ts`.

## 6. Where it landed

```text
W_THROUGHPUT 1.0 · W_HEALTH 1.8 · W_COST 0.8 · W_PROSE 0.65
COMPLEXITY_PULL 0.7 · COMPLEXITY_MIDPOINT 0.19
SPEED_TOLERANCE 3.0 · SPEED_TOLERANCE_PENALTY 0.06 · SPEED_FULL_PENALTY_RATIO 8
```

5 runs, whole 196-document corpus, share of openrouter calls:

| | deepseek | minimax-m3 | minimax-m3-free |
|---|---:|---:|---:|
| stated target | 60 | 25 | 15 |
| **measured** | **72.2 ± 0.7** | **23.9 ± 0.7** | **3.8 ± 0.2** |

minimax-m3 is on target. deepseek is 12 over and the free tier 11 under, for the one reason in §3.

628 tests pass, typecheck clean including `tools/`. New coverage: the speed knee's shape and its
tolerance inside the band; the free tier's failure arc (drops within three refusals, recovers by
both routes, is never removed from the chain); and that size and complexity each cost it something
independently.

## 7. Open

1. **`minimax-m3-free`'s profile has never been measured.** `proseQuality 0.7` is inherited from an
   A/B that tested the paid variant. It now has its own prompt override. This is the gate on the
   free-tier share question and on nothing else.
2. **A second-language A/B**, still the only thing that would say anything about `tolerance`.
3. **`COMPLEXITY_MIDPOINT` is a corpus property** and wants revisiting whenever the corpus does.
4. `extract` still routes `least-busy` with no `signals.complexity`.
5. `EXPLORATION_BONUS` sweepable, unswept — and on a short corpus it is most of the free tier's
   share.
6. `estimatedCost` ignores prompt caching; `invalid_request` and `context_length` count against
   health though neither says the target is unreliable.

---

# Session 5 — measuring `COMPLEXITY_MIDPOINT` on 736 documents, and what that revealed

User instruction: leave the free-tier share and the second-language A/B as they stand; measure
`COMPLEXITY_MIDPOINT` on `manual/`, 736 real documents — by far the largest sample available and
this deployment's own corpus rather than a slice of one.

## 1. The midpoint had been fitted, not measured, and that repeated an earlier mistake

`COMPLEXITY_MIDPOINT` was 0.19 — chosen by session 4's grid search for its effect on the openrouter
*split*, not measured as a property of any corpus. That is the exact failure mode `COMPLEXITY_PULL`
is documented against one section up: a structural constant tuned to hit a share is a share fitted
through the back door, and it moves again the moment a weight does.

`manual/` measures a median of **0.232**, mean 0.257 — almost identical to `out/ru`'s ~0.24/0.265
from a 196-document slice, and a far larger sample. Set `COMPLEXITY_MIDPOINT = 0.23`.

Cost of the correction, measured on `out/ru` with the harness (not replay): the split moved from
72/24/4 to **76/20/4** — deepseek gains what the midpoint no longer artificially hands minimax-m3.
Not treated as a defect to chase back with another weight; the level knobs (`W_PROSE`, `W_COST`) are
where a share should be recovered from if it needs to be, not the midpoint.

## 2. Verifying on the corpus the constant came from surfaced a second, larger effect

Running the same constants on the full 736-document `manual/` gave **82.3 / 15.4 / 2.3** — six
points further from the target than `out/ru`'s 76.4/19.7/3.8, despite the two corpora having almost
identical complexity distributions. That gap needed an explanation before it went in the docs as a
number rather than as an unexplained discrepancy.

Isolated with a direct probe of `scoreTargets`: warming a target from 0 to 500 successes and
re-scoring at each step shows `EXPLORATION_BONUS` — `0.3 / (1 + successes)` — falling from 0.30 to
0.027 within the first ten successes, and to negligible by thirty. Almost the entire decay happens
in a roughly fixed number of early calls per target, independent of how long the run is. So the
**fraction** of total traffic served under a meaningfully large exploration bonus shrinks as the
corpus grows — a short corpus over-represents the underdogs it lifted early on; a long one is closer
to the strategy's steady state.

This means `out/ru`'s 76/20/4 and `manual/`'s 82/15/2 are not two noisy estimates of one number —
they are honest measurements of two different regimes, and `manual/`'s is the better estimate of
what a long real run settles into. Every split reported from here on should be quoted with its
corpus size.

## 3. Where it landed

`COMPLEXITY_MIDPOINT: 0.19 → 0.23`. Both `docs/ref/adaptive-routing.md` and
`biomd-adaptive-strategy.md` now report both corpus sizes side by side, with the exploration-decay
mechanism as the stated reason they differ, rather than folding them into one misleading average.
`EXPLORATION_BONUS`'s "chosen, not fitted" gap note now says why it matters more than it looks: it
does not just affect the first few calls, it determines what the split converges to. 628 tests still
pass unchanged — the two tests that read the neutral complexity point already referenced
`DEFAULT_TUNING.complexityMidpoint` rather than a literal, from session 4.

## 4. Open, updated

1. `minimax-m3-free`'s profile has never been measured (unchanged from session 4 — user said leave).
2. A second-language A/B (unchanged — user said leave).
3. `EXPLORATION_BONUS` is sweepable and unswept, and is now known to set the corpus-length
   sensitivity of the split, not just its early transient. A sweep should hold corpus size fixed and
   be run at more than one size.
4. `extract` still routes `least-busy` with no `signals.complexity`.
5. `estimatedCost` ignores prompt caching; `invalid_request`/`context_length` count against health.
