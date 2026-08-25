# DeepSeek V4 Flash 0731 — sampling bake-off, Russian → German

**Endpoint** `openrouter` — `https://openrouter.ai/api/v1` · **Model** `deepseek/deepseek-v4-flash-0731`
**Task** `translate`, `mode: segments`, `ru → de` · **Document** `example/example.bio.md`
**Provider** pinned to `ambient/fp4` · **Reasoning** off (verified: 0 reasoning tokens in 72 of 72 calls)
**Date** 2026-08-24 · **Runs** 36 combinations × 2 independent passes = 72 translations, plus a 9-run control
**Cost** $0.0356 for the 72 graded runs · **Median** 29 s per article, one LLM call each

---

## 1. Verdict

**Use `temperature: 0.6`, `top_p: 0.95`, `top_k: 40`, `min_p: 0.02` — and do not expect it to
matter.** That phrasing is the finding; section 6 is the reason for it.

```yaml
# biomd.config.yaml — llm.models
- id: or-cheap
  endpoint: openrouter
  model: deepseek/deepseek-v4-flash-0731
  capabilities: [json_schema, json_object, tools, prompt_cache]
  pricing: { inputPer1M: 0.08, outputPer1M: 0.18, cachedInputPer1M: 0.016 }
  provider:
    order: [ambient/fp4, together, phala, deepinfra/fp8, morph/bf16]
    requireParameters: true        # <- the line that makes the rest of this file true
  reasoning: { enabled: false, dialect: reasoning }
  params:
    temperature: 0.6
    topP: 0.95
    topK: 40
    minP: 0.02
```

This is applied in `biomd.config.yaml` as of this report. Three of the four values are also the
best *marginal* level for their parameter (section 5), so the recommendation is at least
internally consistent — but no parameter's effect is distinguishable from chance.

**The two settings in that block that genuinely change what you get are `provider` and
`reasoning`, not the samplers.** If you read one section, read section 3.

---

## 2. The parameters really are applied — three separate proofs

Asserted rather than assumed, because on OpenRouter this is precisely the thing that is
silently untrue.

### (a) They reach the wire

All 72 runs went through a logging reverse proxy (`bakeoff/ds/proxy.py`) that records the
request body and the usage block. Every record carries all four fields, and each pass contains
**36 distinct `(temperature, top_p, top_k, min_p)` quadruples** — one per cell, none merged,
none dropped:

```json
{"model":"deepseek/deepseek-v4-flash-0731","temperature":0.5,"top_p":0.95,"top_k":40,
 "min_p":0.02,"reasoning":{"enabled":false},
 "provider":{"only":["ambient/fp4"],"allow_fallbacks":false,"require_parameters":true},
 "response_format":"json_object","http":200,"served_by":"Ambient",
 "prompt_tokens":3958,"completion_tokens":2258,"reasoning_tokens":0,"finish_reason":"stop"}
```

### (b) The gateway parses and validates them

| sent | answer |
|---|---|
| `top_k: -5` | `400 Expected top_k to be at least 0` |
| `min_p: 3` | `400 Expected min_p to be at most 1, received 3` |
| `top_k: 1, min_p: 0.5` to a provider that supports neither | **`200`, silently ignored** |
| the same, plus `require_parameters: true` | `404 No endpoints found that can handle the requested parameters` |

The last two rows are the pair that matters: **the same request is honoured or ignored
depending on who serves it, and only `require_parameters` tells the two apart.**

### (c) They change the sampler's behaviour

Acceptance is not application, so this is the decisive test. Four repeats of an open-ended
continuation at `temperature: 2.0`, pinned to one provider:

| condition | result |
|---|---|
| temp 2.0, no truncation (control) | degenerates into word salad: *"eyes defiant on her pulpit rec rütt elsewhere cob461 obstacles Ihr loverλη"* |
| temp 2.0 + `top_k: 1` | fluent English, near-identical openings across all four |
| temp 2.0 + `min_p: 0.95` | fluent English |
| temp 2.0 + `top_p: 0.01` | fluent English |

At temperature 2 an unconstrained sampler produces nonsense. Each truncation filter, applied on
its own, pulls it back to coherent prose. That is the filter working.

### What is *not* provable: reproducibility

Even `temperature: 0` with a fixed `seed` returns four different texts (mean common prefix
71 characters). This is a batched mixture-of-experts endpoint; run-to-run determinism is not on
offer, and section 6 is the consequence.

### Modes

From OpenRouter's own model record and confirmed on the wire: `json_object` ✔ (what
`mode: segments` sends — used on all 72 calls), `json_schema` / `structured_outputs` ✔,
`prompt_cache` ✔ — **90.3 % of input tokens came back as `cached_tokens`** across the bake-off,
which is `MessageBuilder`'s stable prefix doing its job.

---

## 3. The finding that actually matters: 20 of 29 providers would have thrown your samplers away

`deepseek/deepseek-v4-flash-0731` is one model id served by **29 providers**, and their
`supported_parameters` differ. From
`GET /api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints`:

| verdict | providers |
|---|---|
| honour `temperature` + `top_p` + `top_k` + `min_p` + `response_format` | **9** — `morph/bf16`, `deepinfra/fp8`, `ambient/fp4`, `together`, `mancer/fp8`, `phala`, `wafer/fast`, `atlas-cloud/fp4`, `cloudflare` |
| silently drop at least one | **20** — including `deepseek` (the model author's own host: no `top_k`, no `min_p`), `relace/fp4` (no `response_format`), `baidu/fp8`, `fireworks`, `novita/fp8`, `alibaba`, `siliconflow/fp8`, `parasail/fp8`, `coreweave/fp8`, `venice`, … |

Left to itself, OpenRouter routed this model to **Relace** — cheapest, and one of the twenty.
Relace implements `top_k` and `min_p` but **not `response_format`**, which is the field
`mode: segments` depends on.

So a large batch with these four parameters set and no provider block is a batch where the
sampling is applied on some requests and not on others, decided by who had capacity that
second — and it looks identical either way: same 200, same German, same bill.

`requireParameters: true` is the fix, and it is a **correctness** setting rather than a
throughput one: it restricts routing to providers implementing every field in the request,
turning an ignored `min_p` from invisible into a loud `404`.

### DeepInfra, and the pacing hypothesis

`deepinfra/fp8` is the cheapest *and* fastest qualifying host (104 tok/s measured) and is
nonetheless **fourth** in the recommended order, because on 2026-08-24 it answered
`502 Upstream error from DeepInfra: Internal server error` to a majority of real translation
payloads. Note that OpenRouter wraps this in an **HTTP 200** with an error body.

Tested directly whether spacing the requests out fixes it — strictly one at a time, five
seconds apart, eight calls:

```
1 FAIL  2 FAIL  3 FAIL  4 FAIL  5 ok  6 FAIL  7 FAIL  8 ok      => 2/8
```

**2 of 8 sequential-and-spaced, against 2 of 3 concurrent.** Pacing is not what ails it; spacing
was if anything worse. This is neither a rate limit nor a concurrency bug — the host is unwell
on this payload. It stays in the list because it recovers and is the best of them when healthy,
and `allowFallbacks` is left at its default so the router simply moves on.

Reliability and speed of every qualifying host, measured on a real 2.5 k-token translation call
(not a one-line prompt):

| provider | quant | $/M in/out | ok | tok/s | cache |
|---|---|---|---|---|---|
| `ambient/fp4` | fp4 | 0.08 / 0.18 | 3/3 | 74 | ✔ |
| `together` | — | 0.14 / 0.28 | 3/3 | 47 | ✔ |
| `phala` | — | 0.20 / 0.40 | 3/3 | 59 | ✔ |
| `cloudflare` | — | 0.44 / 1.32 | 3/3 | 93 | ✔ |
| `atlas-cloud/fp4` | fp4 | 0.44 / 1.32 | 3/3 | 66 | ✔ |
| `morph/bf16` | **bf16** | 0.079 / 0.278 | 3/3 | 16 | ✔ |
| `deepinfra/fp8` | fp8 | 0.08 / 0.18 | **2/3** | 104 | ✔ |
| `mancer/fp8` | fp8 | 0.15 / 0.45 | then `No tokens generated` on a real payload | 116 | ✘ |
| `wafer/fast` | — | 0.28 / 0.56 | status −2, 85.8 % uptime | — | ✔ |

A spot-check of the hardest paragraph across six of them found no quality difference worth
naming: `ambient/fp4` and `morph/bf16` produced equally good German, and both got `гриф`,
`строй`, `бой` and `проигрыш` right. Quantization was not the variable it looked like it would
be, which is why the cheap fp4 host leads the list.

---

## 4. Turning reasoning off

OpenRouter's record for this model says `reasoning.default_enabled: true`,
`default_effort: high` — it reasons unless told not to, and those tokens bill at the output
rate. Measured against a control question:

| sent | reasoning tokens | verdict |
|---|---|---|
| *(nothing)* | deliberates in the answer, `reasoning` field present | **on by default** |
| `{"reasoning":{"enabled":false}}` | **0** | **off** — what this repo emits for `dialect: reasoning` |
| `{"reasoning":{"effort":"none"}}` | **0** | off — the form OpenRouter's docs name |
| `{"reasoning_effort":"none"}` | **0** | off |
| `{"reasoning":{"exclude":true}}` | still reasoning | **the trap: hides the trace, still pays for it** |

The repo's existing `reasoning: { enabled: false, dialect: reasoning }` is correct and needs no
change. All 72 bake-off calls returned `reasoning_tokens: 0`.

---

## 5. The ranking

Ranked by `0.65 × quality + 0.35 × instruction-following`, each cell the mean of two independent
passes. **Read section 6 before using anything below the top few rows.**

| # | temp | top_p | top_k | min_p | **Score** | Quality (65%) | Instruction (35%) | pass 1 | pass 2 | spread |
|---|---|---|---|---|---|---|---|---|---|---|
| **1** | **0.6** | **0.95** | **40** | **0.02** | **74.7** | 81.3 | 62.5 | 66.3 | 83.1 | 16.9 |
| 2 | 0.6 | 0.95 | 40 | 0.04 | 70.3 | 81.3 | 50.0 | 66.3 | 74.4 | 8.1 |
| 3 | 0.6 | 0.9 | 40 | 0.04 | 68.9 | 65.6 | 75.0 | 91.9 | 45.9 | 45.9 |
| 4 | 0.7 | 0.95 | 40 | 0.04 | 66.3 | 75.0 | 50.0 | 62.2 | 70.3 | 8.1 |
| 5 | 0.7 | 0.95 | 56 | 0.02 | 66.3 | 75.0 | 50.0 | 66.3 | 66.3 | 0.0 |
| 6 | 0.7 | 0.9 | 48 | 0.02 | 66.3 | 75.0 | 50.0 | 66.3 | 66.3 | 0.0 |
| 7 | 0.7 | 0.95 | 56 | 0.04 | 65.9 | 81.3 | 37.5 | 78.4 | 53.4 | 25.0 |
| 8 | 0.6 | 0.95 | 48 | 0.04 | 64.8 | 59.4 | 75.0 | 45.9 | 83.8 | 37.8 |
| 9 | 0.5 | 0.9 | 40 | 0.02 | 64.2 | 71.9 | 50.0 | 66.3 | 62.2 | 4.1 |
| 10 | 0.7 | 0.9 | 56 | 0.02 | 63.9 | 78.1 | 37.5 | 57.5 | 70.3 | 12.8 |
| 11 | 0.5 | 0.95 | 40 | 0.02 | 61.9 | 75.0 | 37.5 | 49.4 | 74.4 | 25.0 |
| 12 | 0.5 | 0.9 | 56 | 0.04 | 61.9 | 75.0 | 37.5 | 74.4 | 49.4 | 25.0 |
| 13 | 0.7 | 0.9 | 56 | 0.04 | 61.9 | 75.0 | 37.5 | 58.1 | 65.6 | 7.5 |
| 14 | 0.5 | 0.9 | 48 | 0.04 | 60.2 | 65.6 | 50.0 | 54.1 | 66.3 | 12.2 |
| 15 | 0.6 | 0.95 | 56 | 0.02 | 60.2 | 65.6 | 50.0 | 50.0 | 70.3 | 20.3 |
| 16 | 0.7 | 0.9 | 48 | 0.04 | 60.2 | 65.6 | 50.0 | 70.3 | 50.0 | 20.3 |
| 17 | 0.7 | 0.95 | 48 | 0.02 | 59.5 | 78.1 | 25.0 | 57.5 | 61.6 | 4.1 |
| 18 | 0.5 | 0.9 | 48 | 0.02 | 58.1 | 62.5 | 50.0 | 41.9 | 74.4 | 32.5 |
| 19 | 0.6 | 0.95 | 56 | 0.04 | 58.1 | 62.5 | 50.0 | 62.2 | 54.1 | 8.1 |
| 20 | 0.6 | 0.9 | 48 | 0.04 | 58.1 | 62.5 | 50.0 | 66.3 | 50.0 | 16.3 |
| 21 | 0.7 | 0.95 | 40 | 0.02 | 57.8 | 68.8 | 37.5 | 70.3 | 45.3 | 25.0 |
| 22 | 0.7 | 0.95 | 48 | 0.04 | 57.8 | 68.8 | 37.5 | 45.3 | 70.3 | 25.0 |
| 23 | 0.6 | 0.95 | 48 | 0.02 | 56.7 | 46.9 | 75.0 | 67.5 | 45.9 | 21.6 |
| 24 | 0.5 | 0.95 | 48 | 0.02 | 56.1 | 59.4 | 50.0 | 74.4 | 37.8 | 36.6 |
| 25 | 0.5 | 0.9 | 40 | 0.04 | 56.1 | 59.4 | 50.0 | 66.3 | 45.9 | 20.3 |
| 26 | 0.6 | 0.9 | 48 | 0.02 | 56.1 | 59.4 | 50.0 | 66.3 | 45.9 | 20.3 |
| 27 | 0.6 | 0.9 | 56 | 0.02 | 56.1 | 59.4 | 50.0 | 58.1 | 54.1 | 4.1 |
| 28 | 0.6 | 0.9 | 56 | 0.04 | 54.4 | 50.0 | 62.5 | 41.9 | 66.9 | 25.0 |
| 29 | 0.5 | 0.95 | 56 | 0.02 | 54.1 | 56.3 | 50.0 | 58.1 | 50.0 | 8.1 |
| 30 | 0.5 | 0.95 | 56 | 0.04 | 54.1 | 56.3 | 50.0 | 62.2 | 45.9 | 16.3 |
| 31 | 0.5 | 0.95 | 40 | 0.04 | 52.7 | 40.6 | 75.0 | 45.9 | 59.4 | 13.4 |
| 32 | 0.7 | 0.9 | 40 | 0.04 | 52.7 | 40.6 | 75.0 | 63.4 | 41.9 | 21.6 |
| 33 | 0.5 | 0.9 | 56 | 0.02 | 52.0 | 53.1 | 50.0 | 54.1 | 50.0 | 4.1 |
| 34 | 0.6 | 0.9 | 40 | 0.02 | 52.0 | 53.1 | 50.0 | 54.1 | 50.0 | 4.1 |
| 35 | 0.5 | 0.95 | 48 | 0.04 | 48.0 | 46.9 | 50.0 | 54.1 | 41.9 | 12.2 |
| 36 | 0.7 | 0.9 | 40 | 0.02 | 35.8 | 28.1 | 50.0 | 29.7 | 41.9 | 12.2 |

### Marginal effect of each parameter (72 observations, both passes pooled)

This is the honest place to look for an effect: 24–36 observations per level instead of two.

| parameter | level | n | score | quality | instruction |
|---|---|---|---|---|---|
| **temperature** | 0.5 | 24 | 56.6 | 60.2 | 50.0 |
| | **0.6** | 24 | **60.9** | 62.2 | **58.3** |
| | 0.7 | 24 | 59.5 | **67.4** | 44.8 |
| **top_p** | 0.9 | 36 | 57.7 | 61.1 | 51.4 |
| | **0.95** | 36 | **60.3** | **65.5** | 50.7 |
| **top_k** | **40** | 24 | **59.4** | 61.7 | **55.2** |
| | 48 | 24 | 58.5 | 62.5 | 51.0 |
| | 56 | 24 | 59.1 | **65.6** | 46.9 |
| **min_p** | 0.02 | 36 | 58.4 | **63.7** | 48.6 |
| | **0.04** | 36 | **59.6** | 62.8 | **53.5** |

There is a *shape* here worth naming even though it is not significant: **temperature 0.7 and
top_k 56 buy the best raw translation quality and pay for it in instruction-following**, which
is the trade-off you would predict — a wider sampler writes more freely and follows the letter
of a rule less closely. `temperature: 0.6` and `top_k: 40` sit at the point where the two
sub-scores are jointly best.

---

## 6. What the ranking is worth: less than the noise

The bake-off's most useful number is not in the table.

| | points |
|---|---|
| mean \|pass 1 − pass 2\| **for the same cell, same parameters** | **16.7** |
| largest spread between levels of any parameter (temperature) | 4.3 |
| top_p | 2.6 |
| min_p | 1.1 |
| top_k | 1.0 |

**Running the same combination twice moves the score about four times as much as changing any
parameter does.** A permutation test (20 000 shuffles, level means re-computed each time) puts
numbers on it:

| parameter | observed spread | p |
|---|---|---|
| temperature | 4.3 | 0.452 |
| top_p | 2.6 | 0.377 |
| min_p | 1.1 | 0.692 |
| top_k | 1.0 | 0.963 |

None of them is distinguishable from chance. The same conclusion arrives from a second
direction — pass-to-pass agreement on the individual decisions I graded:

| locus | agreement between the two passes | chance |
|---|---|---|
| `Дипломант` → *Diplomat* vs *Preisträger* (binary) | 44 % | ~50 % |
| `зажечь` → *anheizen* vs *entzünden* (3 outcomes) | 44 % | ~40 % |
| `не все дома` (5 outcomes) | 31 % | ~30 % |
| `хоть ты тресни` (6 outcomes) | 28 % | ~25 % |
| `гриф` / `бой` / `проигрыш` (the hard musical polysemy) | **100 %** | — |
| `Аксенов` preserved inside the 1821 quotation | 97 % | — |

Every locus that varies at all varies **at chance**, and every locus the model reliably gets
right it gets right regardless of the sampler. In other words: within
`temperature 0.5–0.7 × top_p 0.9–0.95 × top_k 40–56 × min_p 0.02–0.04`, these parameters are
not a quality lever for this task on this model. Ranks 4–36 above are a re-ranking of noise;
even rank 1 owes some of its lead to a lucky second pass.

### Does going *below* the tested range help?

A supplementary control, same everything else, three runs per temperature:

| temperature | n | score | quality | instruction | individual runs |
|---|---|---|---|---|---|
| 0.0 | 3 | 48.6 | 47.9 | 50.0 | 41.9 · 45.9 · 58.1 |
| 0.2 | 3 | 55.4 | 58.3 | 50.0 | 58.1 · 50.0 · 58.1 |
| 0.35 | 3 | 52.7 | 54.2 | 50.0 | 58.1 · 58.1 · 41.9 |

No. All three sit inside the same band as the 36 (grand mean 59.0, sd 12.1), and if anything
`temperature: 0` is the worst of the lot. Note also that **temperature 0 produced three
different documents** — dropping the temperature does not buy reproducibility here, because the
non-determinism is in the endpoint, not the sampler.

**So why set the parameters at all?** Because they are then *stated*. The endpoint's own
defaults are undocumented and can change under a running batch; a written-down value is a value
you can reason about later. That is the entire benefit, and it is worth having.

---

## 7. Reading the translations: what the model gets right

Judged by reading the German against the Russian across all 72 documents. The article was built
to be hostile — idioms, figurative language, musical polysemy, abbreviations, an 1821 archaic
quotation, verse, two deliberate typos and a name inconsistency — and the model is genuinely
good at it.

**Musical polysemy: 100 %, every run.** These are the traps that destroy a translation quietly,
and none of them fired:

| Russian | the wrong reading | what it produced, 72/72 |
|---|---|---|
| `гриф` | *Geier* (vulture) | **Griffbrett** |
| `бой` | *Kampf / Schlacht* (battle) | **Anschlag** |
| `проигрыш` | *Verlust* (a loss) | **Zwischenspiel** |
| `переборы` | *Übertreibung* (excess) | **Arpeggien** |
| `строй` | the A string (a known failure of another model on this corpus) | **Stimmung** |
| `лады` | *Eintracht* (harmony) | **Bünde** |

**Idioms survive as idioms.** `не все дома` → „nicht alle Tassen im Schrank" / „eine Schraube
locker"; `злые языки` → „böse Zungen"; `руки опускались` → „die Hände sinken ließen";
`в глаза не видели` → „nie zu Gesicht bekommen" (72/72); `зал заводился с пол-оборота` → „riss
er das Publikum mit" / „heizte er den Saal ein".

**Both planted typos were read correctly.** `хаос и разраха` (for `разруха`) → „Chaos und
Zerstörung" in every run; `соч. 25 «1` (for `№ 1`) → „op. 25 Nr. 1" in 35 of 36.

**Specialist musicology is handled with real fluency:** „homophon-harmonischer Satz",
„Kontrapunkt", „unterstimmenartige Polyphonie" for `подголосочная полифония`, „Gebrauchs-,
Salon- und Unterrichtsgattungen", „Exkurse in reine Chromatik oder Modalität". The 1821
quotation is excellent throughout: „Flageoletttöne", „drei Bünde – 4, 5, 7", „Halbtöne",
„Gitarrenschule" (correctly a *method book*, not a school).

**Fidelity to a quoted source held.** The 1821 quotation names **Аксенов**, not Chudinov — an
inconsistency the article inherited from its own source. 35 of 36 preserved it as
„Aksjonow" rather than tidying it into „Tschudinow". That is the right call and not the
obvious one.

**Transliteration follows German, not English**, unprompted and consistently: `Чудинов` →
**Tschudinow** (not *Chudinov*), `Свиньин` → **Swinjin**, `Матусовский` → **Matusowski**,
`Литовчин` → **Litowtschin**. This is the difference between an entry a German reader finds and
one they do not.

## 8. …and what it gets wrong

**Consistent, sampling-independent misses** — these are prompt or model problems, and no cell
escaped them:

- **`Дипломант` → „Diplomat" in 21–22 of 36 runs.** A false friend, and the worst error in the
  document: it says the man was a diplomat. „Preisträger" is what the other ~15 produce. Which
  one you get is a coin flip.
- **`хоть ты тресни` mishandled in ~two-thirds of runs.** Best: „koste es, was es wolle" / „egal
  was kam". Common and wrong: **„dass es krachte"** — a literal reading of `тресни` (to crack)
  that leaves the German saying the tuning held *so that it cracked*, which means nothing. Two
  runs dropped the idiom entirely.
- **Rule 7 — romanise a source-script title and gloss it — failed in 72 of 72 documents.** Not
  once, anywhere. `"Отечественные записки"` became „Vaterländische Aufzeichnungen" /
  „Vaterländische Blätter" instead of `"Otetschestwennyje sapiski" (Vaterländische
  Aufzeichnungen)`; every Russian song title in the discography was translated outright
  (`Белой акации гроздья душистые` → „Duftende Akazienblütentrauben", `Хоровод` → „Reigen").
  **This is the instruction you specifically wanted tested, and sampling does not touch it.**
- **Rule 6 — a title already printed in another language *is* that title — also failed 72/72.**
  The discography lists `Impression (Chet Atkins)` in Latin and then `Впечатление (Ч. Аткинс)`
  eighteen lines later; every run rendered the second as „Eindruck (C. Atkins)" rather than
  recognising it as the same track. Likewise `Туманно (Э. Гарнер)` → „Neblig" instead of Erroll
  Garner's *Misty*.
- **Rule 8 — the target language's quotation marks — 0 of 72.** Every document uses straight
  `"` rather than German „…".
- **Rule 10 — verse as verse — not attempted.** The quatrain is translated accurately and
  literally, with no rhyme and no metre, identically in every run.
- **Dash substitution in 31 of 36 runs.** The source's two em dashes `—` come back as en dashes
  `–`. This is the one instruction signal that varies at all between cells, and it is the main
  thing separating the instruction sub-scores in the table.
- **`авторские свидетельства` → „Urheberzertifikate" in 35 of 36.** A coinage; the Soviet
  inventor's certificate is „Urheberschein" / „Erfinderschein".

**One-off slips**, each in a single run — the long tail that a large batch will contain:
„op. 25 «1" left unrepaired, „salonfähigen" for `салонных` (means *fit for polite company*, not
*salon genre*), „Axjonow" for Aksjonow, „Svinin" in the English scheme inside an otherwise
German document, and a plural-agreement slip („Chaos und Zerstörung **herrschte**") in 6 of 36.

**Nothing structural ever broke.** Across all 72 documents: skeletons byte-aligned with the
source (62 non-empty lines each), the Latin discography untouched line for line, the source link
intact, zero Cyrillic characters left behind, zero repair rounds, zero retries, zero fallbacks,
and length within +12–14 % of the source everywhere — the normal Russian→German expansion, with
no cell padding or dropping content.

---

## 9. What would actually improve the output

Since the samplers will not:

1. **The prompt, for rules 6, 7 and 8.** Three whole classes of instruction fail on 100 % of
   runs, which is the signature of a rule the model is not acting on rather than one it
   sometimes forgets. `prompts/translation/segments-system.md` rule 7 is stated abstractly and
   its one worked example is a *collection* title; the discography case — a bare list item that
   is a song title — never appears. An example of the exact shape that fails is the cheapest
   fix available, and it is worth ~10 lines of the document.
2. **A glossary entry for `Дипломант`.** `segments-user.md` already supports
   `it.glossary`; one pair (`Дипломант` → `Preisträger`) removes the single worst error in this
   document deterministically, for no tokens.
3. **`provider.requireParameters: true`** — already applied. Without it, everything above is a
   statement about whichever host answered.
4. **Leave reasoning off.** It was measured to *manufacture* an error on this corpus for another
   model (the `да и а строй` typo becoming "die A-Saite"), and here it only costs money.

---

## 10. Code and config changes made for this

`params.topK` / `params.minP` and a `provider` block are now first-class config, so none of this
has to ride in `params.extra`:

```yaml
provider:
  order: [deepinfra/fp8, ambient/fp4]   # preference, best first
  only: []                              # hard whitelist
  ignore: []                            # never route here
  allowFallbacks: false                 # pin to order/only (default: true)
  requireParameters: true               # only providers supporting every field in the request
  sort: throughput                      # price | throughput | latency
  quantizations: [bf16, fp8]            # exclude the fp4 hosts outright
```

- `src/config/schema.ts` — `providerRoutingSchema`, plus `topK` / `minP` on `params`. A slug
  listed in both `order`/`only` and `ignore` is a config error, and `minP: 3` / `topK: -5` are
  rejected before a run spends anything.
- `src/llm/OpenAiCompatibleClient.ts` — `buildRequestBody` is now a module-level exported pure
  function (so a test can assert what goes on the wire without a socket), emitting `top_k`,
  `min_p` and the snake_case `provider` block. Every field is omitted when empty, so an endpoint
  that has never heard of `provider` receives nothing — not even an empty object.
- `src/llm/types.ts`, `src/llm/ModelRegistry.ts` — `ModelTarget` carries the provider block.
- `tests/providerrouting.test.ts` — 12 tests. Full suite: **505 passing**, `typecheck` clean.

`params.extra` still overrides the block, so the escape hatch is intact.

---

## 11. Reproducing this

```bash
node bakeoff/ds/gen.mjs                 # write the 36 cell configs
python bakeoff/ds/proxy.py &            # logging proxy on 127.0.0.1:8111
bash  bakeoff/ds/run_all.sh 1           # pass 1  (36 runs, 3 at a time, ~7 min)
bash  bakeoff/ds/run_all.sh 2           # pass 2
node  bakeoff/ds/collect.mjs            # pull the graded loci from both passes
node  bakeoff/ds/score.mjs              # ranking, marginals, permutation test
```

Supporting probes, each answering one question:
`probe_reasoning.mjs` (how to switch reasoning off), `probe_params.mjs` (accepted vs applied),
`probe_applied.mjs` (does the sampler behave differently), `probe_seed.mjs` (is it
reproducible — no), `probe_providers.mjs` (who is reliable), `probe_spacing.mjs` (is DeepInfra a
pacing problem — no), `probe_hosts.mjs` (does the host change the German).

**On method.** The comparison was made by reading. `align.mjs`, `variance.mjs`, `phrase.mjs` and
`loci.mjs` only *display* the 36 renderings of one passage side by side and group the identical
ones; the grades in `score.mjs` are the judgements I formed reading that output, written down so
that both passes are graded by the same yardstick. `variance.mjs` was used to find where the
cells disagree at all — all of it in the seven long prose paragraphs — so the reading went where
the differences were.

The quality axis grades seven loci (max penalty 8): `хоть ты тресни`, `Дипломант`, `не все дома`,
`зажечь`, subject–verb agreement, the `op. 25` typo, and `салонных`. The instruction axis grades
three (max penalty 2): em-dash fidelity, and the two transliteration-scheme slips. Every other
rule was at ceiling (structure, Latin fragments, link masks, no Cyrillic left, no repairs) or at
floor (rules 6, 7, 8, 10 — uniformly failed) in all 72 documents, and a locus that never varies
cannot rank anything.
