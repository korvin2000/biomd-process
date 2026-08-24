# Gemma4-31B sampling bake-off — Russian → German translation

**Endpoint** `local` — `http://192.168.1.26:8080/v1` · **Model** `gemma4-31b-local`
**Task** `translate`, `mode: segments`, `ru → de` · **Document** `example/example.bio.md`
**Date** 2026-08-24 · **Runs** 2 independent passes × 16 combinations = 32 translations

---

## 1. Verdict

| # | temperature | top_p | top_k | **Score** | Quality (70%) | Instruction (30%) |
|---|---|---|---|---|---|---|
| **1** | **0.75** | **0.9** | **64** | **98.3** | 100.0 | 94.4 |
| 2 | 1.0 | 0.95 | 64 | 77.8 | 70.6 | 94.4 |
| 3 | 0.5 | 0.9 | 48 | 76.9 | 67.0 | 100.0 |
| 4 | 0.5 | 0.9 | 64 | 73.5 | 67.0 | 88.9 |
| 5 | 0.3 | 0.95 | 48 | 66.3 | 85.2 | 22.2 |
| 6 | 1.0 | 0.95 | 48 | 61.8 | 47.9 | 94.4 |
| 7 | 1.0 | 0.9 | 48 | 61.6 | 78.5 | 22.2 |
| 8 | 1.0 | 0.9 | 64 | 60.8 | 77.3 | 22.2 |
| 9 | 0.3 | 0.9 | 48 | 59.9 | 76.1 | 22.2 |
| 10 | 0.3 | 0.95 | 64 | 58.2 | 57.0 | 61.1 |
| 11 | 0.75 | 0.95 | 64 | 55.9 | 70.3 | 22.2 |
| 12 | 0.3 | 0.9 | 64 | 54.2 | 51.2 | 61.1 |
| 13 | 0.75 | 0.9 | 48 | 52.7 | 65.8 | 22.2 |
| 14 | 0.5 | 0.95 | 48 | 52.5 | 48.8 | 61.1 |
| 15 | 0.75 | 0.95 | 48 | 49.5 | 44.5 | 61.1 |
| 16 | 0.5 | 0.95 | 64 | 48.7 | 43.3 | 61.1 |

**Use `temperature: 0.75`, `top_p: 0.9`, `top_k: 64`.** It is the only combination that
came out near-clean in **both** independent runs — 2 severity points of defect out of a
possible 22, and 17 of 18 on the romanisation rule. Every other cell failed at least one
whole class of check in at least one run.

```yaml
# biomd.config.yaml — llm.models
- id: local-small
  endpoint: local
  model: gemma4-31b-local
  contextWindow: 65536
  maxOutputTokens: 18432
  capabilities: [json_schema, json_object, prompt_cache]
  pricing: { inputPer1M: 0, outputPer1M: 0 }
  params:
    temperature: 0.75
    topP: 0.9
    extra: { top_k: 64 }   # top_k is NOT an OpenAI field - see section 3
  tags: [local, cheap]
```

Read section 6 before trusting the ranks below the top four: much of the spread between
ranks 5 and 16 is sampling noise, and the report says exactly how much.

---

## 2. The parameters really are applied

Asserted rather than assumed. The server is **llama.cpp** (`llama-server`), serving
`gemma-4-31B-it-qat-UD-Q4_K_XL` (Q4_0 ftype, 30.7 B params), `n_ctx` 65536, **1 slot**.
Its own defaults are `temperature 0.75, top_k 64, top_p 0.95, min_p 0.05`.

Post-sampling probabilities are collapsed by this build (`backend_sampling: true`), so
the proof is behavioural: each parameter has a setting that *forces* greedy decoding if
it is honoured. Five samples per row, different seeds:

| Test | Settings | Distinct answers | Reads as |
|---|---|---|---|
| control | `temp 2.0, top_k 200, top_p 1.0` | **2 / 5** | sampling is live |
| `top_k` | `temp 2.0, top_k 1, top_p 1.0` | 1 / 5 | **applied** |
| `temperature` | `temp 0.0, top_k 200, top_p 1.0` | 1 / 5 | **applied** |
| `top_p` | `temp 2.0, top_k 200, top_p 0.001` | 1 / 5 | **applied** |

All three collapse the output to a single answer while the control varies, so each one
reaches the sampler independently.

Every one of the 32 pipeline runs was additionally captured through a logging reverse
proxy in front of the endpoint. All 32 request bodies carried exactly their intended
`temperature` / `top_p` / `top_k` — 16 distinct parameter sets, one request each, no
retries, no fallbacks.

> **`min_p: 0.05` is a server-side default and was active in every cell.** It truncates
> the tail before `top_p` sees it, which is part of why `top_p` 0.95 vs 0.9 moves so
> little here. It is constant across all 16, so the comparison is fair, but a different
> `min_p` would shift the whole grid.

### Required modes

| Capability | Verified | Evidence |
|---|---|---|
| `json_object` | yes | `response_format: {type: json_object}` returned `{"a": 1}` |
| `json_schema` | yes | strict schema honoured, returned `{"capital": "Paris"}` |
| `prompt_cache` | yes | identical prefix re-sent: `cached_tokens` 6 then **1817 / 1818** |

In the real runs the cache reported **3.7k in (3.7k cached)** on every single call — the
stable `[system][instructions]` prefix hits 100% across the corpus, so mechanism 1 in
`CLAUDE.md` is working as designed. The declared `capabilities` list is accurate.

---

## 3. `top_k` needs `params.extra`

`temperature` and `topP` are first-class in `src/config/schema.ts` and map to
`temperature` / `top_p` on the wire. **`top_k` is not an OpenAI parameter and has no
schema field.** A `topK:` key written under `params` is silently dropped by Zod and
never reaches the server — the run looks fine and the parameter was never set.

It must ride in the escape hatch, which `OpenAiCompatibleClient.buildBody` spreads onto
the body verbatim:

```yaml
params:
  temperature: 0.75
  topP: 0.9
  extra: { top_k: 64 }
```

---

## 4. Method

The 70/30 weighting was applied as asked: **0.70 × translation quality + 0.30 ×
instruction following**.

Each of the 32 German documents was read against the Russian by hand. The defects below
were *found* by reading; they were then restated as mechanical tests
(`bakeoff/defects.py`) so that all 32 documents are judged by an identical yardstick and
run 1 cannot be scored more harshly than run 2. Severity weights reflect how much damage
each does to a published catalogue entry:

| Defect | Weight | Why |
|---|---|---|
| `не стоит ли` read as a negation | 3 | inverts the meaning of a sentence |
| `Марафон мира` rendered "Marathon der **Welt**" | 2 | wrong sense of a polysemous word in a title |
| "versetzte … Freude" / "führte … glücklich" | 2 | not German; meaningless to a reader |
| "dass Kollegen die Hände sanken" | 2 | ungrammatical (missing dative) |
| "zum/unserem **Schande**" | 1 | wrong gender |
| "Bunden" for "Bünden" | 1 | typo |

Pooled frequency across all 32 documents, and how often each flipped between the two
runs of the *same* cell — the second column is the measure of how much of this is
sampling noise rather than a parameter effect:

| Defect | Documents affected | Flipped between runs |
|---|---|---|
| `не стоит ли` inverted | 15 / 32 | 9 / 16 cells |
| `Марафон мира` → "Welt" | 16 / 32 | 8 / 16 cells |
| "versetzte/führte …" broken | 12 / 32 | 6 / 16 cells |
| "zum/unserem Schande" | 8 / 32 | 6 / 16 cells |
| "die Hände sanken" | 4 / 32 | 4 / 16 cells |
| "Bunden" typo | 3 / 32 | 3 / 16 cells |

Instruction following is scored on the romanise-and-gloss rule (prompt rule 3) across
the nine Russian-only track titles, pooled over both runs (max 18).

The remainder of the reading — idiom richness, terminology choice, verse faithfulness —
is carried as a manual grade of ±3 per cell, because no regex sees the difference between
"Publikum sofort begeistert" and "der Saal war sofort Feuer und Flamme".

**Test isolation.** The base config routes German to `or-luna`
(`llm.routing.pools.translate.prefer.de`), so the pool was reduced to `local-small`
alone with `strategy: sequential`; otherwise the experiment would have measured routing.
Each cell ran with its own output tree, state dir and progress log, `resume: off`,
`skipExistingOutputs: false`, `onExisting: overwrite`, `concurrency: 1`.

---

## 5. What separated the configurations

### 5.1 The meaning inversion — `не стоит ли обратиться`

> `Друзья даже начали подумывать, что у него "не все дома" и **не стоит ли обратиться**
> к "людям в белых халатах".`

`не стоит ли` is a tentative question — *whether they ought to call in the men in white
coats* — not a negation. Read as a negation it says the opposite.

| | |
|---|---|
| correct, `t0.75/0.9/64` | "…und man sich **vielleicht** an 'Leute in weißen Kitteln' wenden sollte." |
| wrong, `t0.5/0.95/48` | "…und man sich **nicht** an 'Leute in weißen Kitteln' wenden sollte." |

**15 of 32 documents inverted it.** It is the single most damaging error found, it
occurs at every temperature, and it flipped between runs in 9 of 16 cells — so it is a
model/prompt weakness, not a sampling one. `temperature 0.75` was least affected
(2 of 8 runs, versus 5, 5 and 3 for 0.3, 0.5 and 1.0), which is part of why it wins.

### 5.2 The polysemy trap — `Марафон мира`

`мир` is both *peace* and *world*. The cultural programme is the **Peace Marathon**;
"Marathon der Welt" is not a thing.

| | |
|---|---|
| best, `t0.75/0.9/64` run 1 | `"Marafon mira" (Friedensmarathon)` — correct transliteration (ф→f), correct sense, glossed |
| partial | "Marathon des Friedens" — right sense, romanisation dropped |
| wrong | "Marathon der Welt" / "Weltmarathon" — **wrong sense** |

16 of 32 chose "Welt", and the choice flipped between runs in 8 of 16 cells. Only one document in the whole matrix produced the fully correct
form, and it was the winning cell.

### 5.3 Broken German

Three constructions a reader would stumble over — the "meaningless phrase" failure mode:

- **"dass selbst erfahrene Kollegen die Hände sanken"** (4 documents) — `руки опускались`
  needs a dative subject; as written the clause has none.
- **"versetzte er die Menschen … Freude"** — *versetzen* does not take `Freude`.
  Correct: "bereitete/machte … Freude".
- **"führte er die Menschen mit seinem Spiel weiterhin glücklich"** (`t0.75/0.9/48`) —
  not German at all.

Those last two together account for **12 of 32** documents — the most frequent broken
construction in the matrix, and the one a reader would notice first.

Against which the winner produced **"schenkte er den Menschen weiterhin Freude"** — the
best rendering of that clause anywhere in the matrix.

### 5.4 Guitar terminology

The folk paragraph is dense with terms that have a common non-musical reading. Almost
everything was handled correctly, with one exception:

| Russian | Correct German | Result |
|---|---|---|
| `проигрыш` (instrumental break, *not* "loss") | Zwischenspiel | **32 / 32** correct |
| `строй` (tuning) | Stimmung | 32 / 32 correct |
| `лады` (frets) | Bünde | 32 / 32 (3 typo'd "Bunden") |
| `переборы` | Arpeggios / Fingerpicking | all acceptable |
| `гриф` (neck) | Hals / Griffbrett | 31 / 32 — `t0.75/0.95/48` wrote **"Der Griff"** (grip) |
| `бой` (strumming) | Anschlag / Schlagstil | all acceptable; **Anschlag** (best) only at `t≥0.75` |

### 5.5 Context understanding across the document

`Впечатление (Ч. Аткинс)` in the trio list is Chet Atkins's **"Impression"**, which is
printed *in Latin* in the guitar-duo list higher up the same article. Prompt rule 1 says
a title already printed in another language is that name.

- correct in most cells: `"Vpechatlenie" (Impression)`
- wrong at `t0.3/0.9/64`: `Vpechatlenie (**Eindruck**)` — translated the word instead of
  recognising the piece. The same document also mangled `Э. Гранадос` into **"Ö. Granados"**.

`Девушка из Ипанемы` — all 32 recognised the Jobim standard. The richest renderings
(`"Dewuschka iz Ipanemy" (Girl from Ipanema)`) came from the `top_p 0.9` cells at
temperature 0.5.

### 5.6 Verse

The four-line poem stayed four blockquote lines in **32 / 32**. The discriminator is
invented filler added to force a rhyme:

- faithful, `t0.3/0.95/48`: "Ich hör', der Wind hat sich im Laub verfangen, / Dort am Zweige schwankt der Mond."
- invented, `t1.0/0.9/64`: "Kann man die Liebe nicht erkennen, **wenn sie klingt**?"
- bent to rhyme, `t1.0/0.95/48`: "der Wind **weht**" / "der Mond sich **dreht**"

Higher temperature buys fluency in the verse and pays for it in fidelity.

---

## 6. What did **not** separate them — and the honest caveat

**Structure was perfect in all 32 documents**: skeleton identical to the source, 14/14
Latin discography lines byte-identical, poem 4/4 lines, `::: image` attributes intact,
the masked link `[http://alexmuz.al.ru](…)` survived, zero Cyrillic left in the prose.
`mode: segments` makes structure a non-issue at every sampling setting. No run needed a
repair round, a retry or a fallback.

**Source defects were absorbed everywhere.** The article contains three traps and all 32
handled them:

- `разраха` (typo for *разруха*) rendered "Zerstörung" / "Verfall" / "Verwüstung"
- `Литера-тура` (OCR hyphenation) rendered "Literatur"
- `Аксенов` — the 1821 quote names a **different person** than the surrounding text.
  **No run silently "corrected" it to Chudinov.** Fidelity to a flawed source held.

### The caveat: the romanisation rule is bimodal and unstable

The instruction-following axis is dominated by one behaviour that is close to a coin
flip. A cell either romanises the Russian track titles (8–9 of 9) or collapses to
translating them outright (2 of 9) — there is almost nothing in between:

| Behaviour | Cells |
|---|---|
| Complied in **both** runs | 5 of 16 |
| Failed in **both** runs | 6 of 16 |
| **Flipped** between runs | 5 of 16 |

An early reading of the first four cells suggested "k64 romanises, k48 does not". **The
full grid refutes that** — `t0.75/0.95/48` scored 9/9 while `t0.75/0.95/64` scored 2/9,
the exact reverse. Pooled, `top_k` 64 complied 9/16 and `top_k` 48 complied 6/16, which
at this sample size is not a difference.

**Consequences for reading this report:**

- The gap between rank 1 (98.3) and rank 2 (77.8) is real: the winner was best in both
  runs independently.
- Ranks 5–16 are heavily influenced by which side of that coin each cell landed on.
  Treat them as three tiers, not as a strict ordering.
- **`top_k` 64 vs 48 is not separable at n=2.** Neither is `top_p` 0.95 vs 0.9 on its own,
  though 0.9 holds 3 of the top 4 places.
- The one clear temperature finding is negative and counter-intuitive: **0.3 is not the
  safe choice.** It scored worst on romanisation (2 of 8 runs compliant) and still
  produced gender errors and broken clauses. Low temperature bought no extra obedience.

If the romanisation rule matters for the catalogue, the durable fix is a prompt change
plus a post-check, not a sampling setting. No cell in this matrix made it reliable.

---

## 7. Two findings outside the brief

**This build reasons on every call.** Responses carry a separate `reasoning_content`
(`"*   Task: … *   Selection: …"`). `local-small` sets no reasoning dialect, so nothing
is sent and the model thinks by default. Output ran **5.4k – 12.8k tokens** for the same
3.7k-token input, and the variance is almost entirely reasoning. On this endpoint it is
free, but it is wall-clock on a one-slot server: 54 s to 229 s per document across the
32 runs. Worth a deliberate decision before a large batch.

**`foreignFragments: keep` did real work.** Every run logged *"14 fragment(s) had no
words in the source language and were kept verbatim"* — the Latin discography. Those 14
lines came back byte-identical in all 32 documents because they were never sent.

---

## 8. Reproducing

```bash
node bakeoff/gen.mjs && bash bakeoff/run_all.sh
```

```bash
node bakeoff/gen_rep.mjs && bash bakeoff/run_all2.sh
```

```bash
python bakeoff/defects.py bakeoff/out && python bakeoff/score.py
```

| Artefact | Contents |
|---|---|
| `bakeoff/cfg/`, `bakeoff/cfg2/` | the 32 generated configs |
| `bakeoff/out/`, `bakeoff/out2/` | the 32 German translations |
| `bakeoff/logs/wire.jsonl` | every request body's sampling parameters, as sent |
| `bakeoff/proxy.py` | the logging reverse proxy used to capture them |
| `bakeoff/structcheck.py` | skeleton / discography / poem / link integrity |
| `bakeoff/glosscheck.py` | the romanise-and-gloss rule, per cell |
| `bakeoff/defects.py` | the seven defect tests of section 4 |
| `bakeoff/score.py` | the weighted 70/30 ranking |
| `bakeoff/cmp.py` | one line of all 16 translations, side by side |
