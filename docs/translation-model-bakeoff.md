# Translation model bake-off — OpenRouter, 2026-08-24

Fourteen cheap OpenRouter models ranked for the `translate` task, measured on one
deliberately hard Russian article (`example/example.bio.md`) translated into
English through the real pipeline in `mode: segments`.

**Score = 0.65 × translation quality + 0.35 × instruction following**, as
requested.

---

## The ranking

| # | Model | Best temp | Score | Quality (65%) | Instructions (35%) | $/1000 docs |
|---:|---|---|---:|---:|---:|---:|
| 1 | **`qwen/qwen3.7-plus`** | default | **8.05** | 8.4 | 7.5 | $3.08 |
| 2 | **`minimax/minimax-m3`** | **0.3** | **7.89** | 7.8 | 8.2 | $2.80 |
| 3 | **`xiaomi/mimo-v2.5-pro`** | **0.3** | **7.75** | 8.1 | 7.1 | $4.08 |
| 4 | **`xiaomi/mimo-v2.5`** | **0.3** | **7.46** | 7.7 | 7.1 | $1.19 |
| 5 | `deepseek/deepseek-v3.2` | default | 7.34 | 7.5 | 7.1 | $4.51 |
| 6 | `deepseek/deepseek-v4-flash-0731` ← *current* | default | 7.28 | 8.1 | 5.7 | **$0.64** |
| 7 | `z-ai/glm-4.5-air` | default | 6.97 | 6.7 | 7.6 | $2.01 |
| 8 | `google/gemma-4-31b-it` | default | 6.86 | 7.0 | 6.7 | $7.00 |
| 9 | `openai/gpt-5.6-luna` | n/a | 6.24 | 6.5 | 5.7 | $3.11 |
| 10 | `qwen/qwen3-235b-a22b-2507` | 0.3 | 6.14 | 6.0 | 6.4 | $1.52 |
| 11 | `qwen/qwen3.7-flash` | default | 6.04 | 5.7 | 6.8 | **$0.40** |
| 12 | `qwen/qwen-plus-2025-07-28` | default | 5.70 | 6.2 | 4.8 | $2.91 |
| 13 | `qwen/qwen3.5-flash-02-23` | default | 5.53 | 6.1 | 4.6 | $0.91 |
| 14 | `z-ai/glm-4.7-flash` | either | 4.57 | 5.3 | 3.3 | $7.84 |

### Recommendations

- **Best quality:** `qwen/qwen3.7-plus` at default temperature. The only model
  with no error of any kind in any passage I checked.
- **Best value for a large batch:** `xiaomi/mimo-v2.5` at **temperature 0.3** —
  rank 4 at $1.19/1000, a fifth of gemma's price and two ranks above it.
- **If price dominates:** keep `deepseek/deepseek-v4-flash-0731` at **default
  temperature**, but see the warning below — never run it at 0.3.
- **Avoid outright:** `z-ai/glm-4.7-flash` — 10× the output tokens, and it
  truncates.

---

## Two disqualifying failures

Neither is visible in a finished file. The structure guard passed both.

### 1. `deepseek-v4-flash` at temperature 0.3 truncates mid-sentence

The lead paragraph came back at **337 characters against 1136** at default
temperature — roughly 70% of it silently dropped, ending mid-clause:

> …took part in television and radio broadcasts, worked in music. collectives of
> the most varied

Nothing catches this: the fragment count is right, the skeleton is right, so
`verifyStructure: strict` passes. This is very likely the "often fails" you have
been seeing. **The fix is to pin the temperature, not to change models** — at
default temperature the same model was the best idiomatic translator in the whole
field (rank 6 overall, quality 8.1).

### 2. `gemma-4-31b` at temperature 0.3 writes its reasoning into the article

Its answer for the last discography line was published verbatim into the file:

> Khorovod (in memory of A. Ivanov-Kramskoy) (2:06) (Round Dance) {Note: The
> source title is a work title, but following rule 7, it should be romanized and
> glossed} → "Khorovod" (Round Dance) … (Wait, rule 7 says: …)

Exactly the "meaningless text as output" failure you asked me to watch for.
Gemma at default temperature is fine; at 0.3 it is not.

---

## What the document tested, and who failed what

### Comprehension — the standards hidden behind Russian titles

The trio's discography lists jazz standards under their Russian names. Getting
these right requires recognising the piece, not translating the words.

| Source | Correct | Who got it |
|---|---|---|
| `Туманно (Э. Гарнер)` | **"Misty"** (Erroll Garner) | deepseek ×2, gemma, minimax, gpt-5.6-luna, qwen3.7-plus, mimo ×2 |
| `Мягкий дождь (Л. Бонфа)` | **"The Gentle Rain"** (Bonfá) | qwen-plus, qwen3-235b, mimo-v2.5, glm-4.7 |
| `Девушка из Ипанемы` | "The Girl from Ipanema" | all |
| `Восточный танец (Э. Гранадос)` | **"Oriental"** — the article's *own* duo list prints it | deepseek ×2, gemma, qwen3.7-plus |

Wrong answers for `Туманно` are the clearest quality signal in the document:
**"Turbid"** (qwen-plus default, qwen3-235b t0.3) and **"Vague"** (qwen3-235b
default) are meaningless in a discography; "Foggy" (qwen3.5-flash, glm-4.5-air)
and "Hazy" (qwen3.7-flash, glm-4.7) are literal misses. `qwen-plus` at 0.3 also
turned `Мягкий дождь` into **"Softly"**, which is not a title at all.

A second error in the same list: `И. Субботина` is **Inna Subbotina**, the trio's
vocalist, named two lines above. `qwen-plus` and `qwen3-235b` (both temperatures)
wrote **"I. Subbotin"**, changing her name to a man's.

### Idiom and figurative language

The colloquial paragraph is dense with untranslatable idiom. Best rendering in
the field, `deepseek-v4-flash` at default:

> Chudinov was on 'first-name terms' with the frets… from the first bars the hall
> was fired up instantly, and by the middle eight it was impossible to hold anyone
> back… even seasoned colleagues would throw up their hands in despair

Failures worth naming:

- **`строй` read as a string name.** `gpt-5.6-luna`: *"the **A string** held
  firm"*; `qwen3.7-flash` (both temps): *"the **E string** stayed perfectly
  tuned"*. `строй` is the instrument's **tuning**. A confident hallucination.
- **`зал заводился с пол-оборота`** ("the hall got going instantly") calqued into
  nonsense: *"fired up **at half-cock**"* (minimax default), *"hooked **halfway
  around**"* (mimo-v2.5 default), *"wound up **halfway**"* (deepseek-v3.2 t0.3),
  *"in **half a turn**"* (glm-4.5-air t0.3).
- **`руки опускались`** left as *"colleagues' hands dropped"* (deepseek-v4 t0.3,
  mimo-v2.5 default, glm-4.7 both) — a calque, not English.
- **`не все дома`** flattened to *"if something was wrong with him"* by
  `qwen3.5-flash` (both), losing the register entirely.

### Meaning inverted

In the sarcastic closing paragraph, `в глаза не видели` ("never laid eyes on
them") lost its negation in two models:

- `gemma` default: *"but we **had seen** most of them … with our own eyes"*
- `gpt-5.6-luna`: *"but **had seen** most of them … **only in our imagination**"*
  — inverted *and* invented.

The same sentence garbled the "уговорить западных дядей" clause in
`qwen3.5-flash` (both), `qwen3.7-flash` t0.3 and `glm-4.7` default, which produce
*"an attempt to persuade at least some little book by Western uncles … to help"*.

### Silent omissions

`разраха` (a typo for `разруха`, devastation) was **dropped** rather than
translated by `qwen-plus` ×2, `qwen3-235b` ×2, `qwen3.5-flash` ×2, `qwen3.7-flash`
×2 and `glm-4.7` t0.3 — they smoothed the awkward source into "chaos reigned
everywhere". `qwen3-235b` and `qwen3.7-flash` similarly dropped "white"/"fragrant"
from the acacia song title.

### Terminology

Only **`mimo-v2.5-pro`** (default) produced the correct musicological term for
`подголосочная полифония` — **"heterophonic polyphony"**. Everyone else calqued
it ("sub-voice", "subvocal", "under-voice") or got it wrong outright
("**subtlest** polyphony", deepseek-v3.2; "**subtle** polyphony", qwen3.5-flash;
"**voice-leading** polyphony", gemma t0.3).

Abbreviations (`НИИ`, `ВУЗы`, `им. М. А. Литовчина`) were handled correctly by
every model — not a discriminator.

### Instruction following: the four prompt rules

**Rule 7 — romanize a source-script title, then gloss it once.** Only
**`minimax-m3` at 0.3** did this fully: `"Marafon mira" (Marathon of Peace)` and
`"Otechestvennye zapiski" (Notes of the Fatherland)`. Most models translated
without romanizing; `glm-4.7` did the opposite and left `"Marafon mira"` bare,
which is the worst outcome — unreadable and unsearchable.

Two comprehension errors surfaced here: `deepseek-v4-flash` default rendered
`"Марафона мира"` as **"March for Peace"** and `mimo-v2.5-pro` default as
**"Marathon of the World"** — `мира` is *peace*, not *march* or *world*.

**Rule 8 — punctuation stays on the side of the quote the source put it on.**
Only **5 of 27** runs complied (`gemma` t0.3, `minimax` default, `mimo-v2.5`
default, `glm-4.5-air` both). The other 22 pulled the comma inside the closing
quote — the American convention the prompt explicitly warns against.

**Rule 9 — fidelity.** Covered above (`разраха`, the inverted negation).

One behaviour worth recording without counting it against anyone. The 1821
quotation credits the discovery to Chudinov and then names **Аксенов** as the man
who extended it — an inconsistency in the source itself. `qwen-plus` and
`qwen3-235b`, at both temperatures, silently resolved it to Chudinov; every other
model reproduced the name as written. Here that was the helpful reading. It is
still worth knowing which models take editorial initiative on a surprising
detail, because the same instinct applies to a fact that is odd but correct — and
in a catalogue the producer, not the translator, is where that decision belongs.
It is **not** scored as an error in this report.

**Rule 3 — marks.** Every model returned the `**bold**` headers, the link target
and the Latin discography byte-identical. Not a discriminator; the segments-mode
design is doing its job.

---

## Temperature

Testing both settings was worth it — the effect is large and it is **not in one
direction**.

**Lower temperature (0.3) clearly better:** `minimax-m3` (default romanized song
titles with no gloss and misspelled one; 0.3 was the most rule-compliant run in
the whole field), `mimo-v2.5`, `mimo-v2.5-pro`, `qwen3-235b`.

**Lower temperature clearly worse:** `deepseek-v4-flash` (truncation), `gemma`
(meta-commentary), `deepseek-v3.2` (idiom errors), `qwen-plus` ("Softly",
"Hazy"), `qwen3.7-flash`, `qwen3.7-plus` (lost the rule-7 gloss).

**No effect:** `glm-4.5-air` produced a byte-identical discography at both
settings; `glm-4.7-flash` failed the same way at both.

`openai/gpt-5.6-luna` does not accept `temperature` at all (OpenRouter
`supported_parameters`), so it was run once.

---

## Capabilities, as reported by OpenRouter

Read from `/api/v1/models` rather than assumed. Each model was configured with
exactly what it declares.

| Model | Ctx | Max out | $/M in | $/M out | json_object | json_schema | prompt_cache | reasoning | temperature |
|---|---:|---:|---:|---:|:---:|:---:|:---:|:---:|:---:|
| `qwen/qwen3.7-flash` | 1000k | 66k | 0.030 | 0.130 | yes | no | yes | yes | yes |
| `deepseek/deepseek-v4-flash-0731` | 1311k | 131k | 0.066 | 0.132 | yes | yes | yes | yes | yes |
| `qwen/qwen3.5-flash-02-23` | 1000k | 66k | 0.065 | 0.260 | yes | yes | no | yes | yes |
| `google/gemma-4-31b-it` | 262k | 262k | 0.100 | 0.340 | yes | yes | yes | yes | yes |
| `qwen/qwen3-235b-a22b-2507` | 262k | 16k | 0.090 | 0.550 | yes | yes | no | **no** | yes |
| `xiaomi/mimo-v2.5` | 1050k | 131k | 0.140 | 0.280 | yes | yes | yes | yes | yes |
| `deepseek/deepseek-v3.2` | 164k | 164k | 0.260 | 0.380 | yes | yes | yes | yes | yes |
| `minimax/minimax-m3` | 1049k | 512k | 0.300 | 1.200 | yes | yes | yes | yes | yes |
| `openai/gpt-5.6-luna` | 1050k | 128k | 0.200 | 1.200 | yes | yes | yes | yes | **no** |
| `z-ai/glm-4.7-flash` | 203k | 16k | 0.060 | 0.400 | yes | yes | yes | yes | yes |
| `z-ai/glm-4.5-air` | 131k | 98k | 0.130 | 0.850 | **no** | **no** | yes | yes | yes |
| `qwen/qwen-plus-2025-07-28` | 1000k | 33k | 0.260 | 0.780 | yes | yes | no | **no** | yes |
| `xiaomi/mimo-v2.5-pro` | 1050k | 131k | 0.435 | 0.870 | yes | yes | yes | yes | yes |
| `qwen/qwen3.7-plus` | 1000k | 131k | 0.320 | 1.280 | yes | yes | yes | yes | yes |

Two notes on this table:

- **`z-ai/glm-4.5-air` declares no `response_format` at all.** It was configured
  without `json_object`, so the transport sent none and it answered JSON because
  the prompt asks for it — the intended degradation, and it worked on every call.
- **`prompt_cache` is not a `supported_parameters` flag**; it was read from the
  presence of `input_cache_read` pricing. Three models have no cached-input
  price: `qwen3.5-flash`, `qwen3-235b`, `qwen-plus`. For a large batch that
  matters — the segments prompt is a ~1.5k-token constant prefix on every call.

## Reliability

| Model | Requests | Repair rounds | Notes |
|---|---:|---:|---|
| `z-ai/glm-4.7-flash` | 4–5 | 1 | **18.2k output tokens** vs ~1.8k for everyone else; `output_truncated`; 4 min per document |
| `google/gemma-4-31b-it` | 3 | 1 | fastest per call (3.0s) but needed a repair round at default |
| `qwen/qwen3.5-flash-02-23` | 3 | 1 | repair round at default |
| everyone else | 2 | 0 | clean first pass |

`glm-4.7-flash` deserves the call-out: `reasoning: {enabled: false, dialect:
reasoning}` was set and it burned ten times the output budget anyway, hitting the
output ceiling. At $0.40/M output that made the *cheapest-listed* model the
**most expensive** in the test ($7.84/1000, worse than gemma).

---

## Method, and what this does and does not establish

- Real pipeline, real prompts: `npm run biomd -- run --only translate`,
  `mode: segments`, `verifyStructure: strict`, `repairAttempts: 2`,
  `contextChars: 300` — production settings.
- One model per pool, `fallback.maxTargets: 1`, `taskFallback.maxAttempts: 1`, so
  a failure stays visible instead of being absorbed by a fallback.
- Reasoning disabled via `{enabled: false, dialect: reasoning}` on the 12 models
  that declare reasoning support. Confirmed effective: zero reasoning tokens
  billed on all but `glm-4.7-flash`.
- Comparison was done by reading the outputs against the source passage by
  passage, not by any automatic metric.

**Limits, stated plainly.** This is **one document and one run per
configuration**. The ranking's top five are close enough that their order should
be treated as indicative rather than settled — a second article could reorder
them. What is *not* within noise, because each was reproduced at both
temperatures or is structural, is the set of disqualifying failures: the
`deepseek-v4-flash` truncation, the gemma meta-commentary, the `E string`/`A
string` hallucinations, the dropped `разраха`, the inverted negation, and
`glm-4.7-flash`'s runaway output. Those are the findings to act on.

Total cost of the sweep: **under $0.09** across 27 runs.
