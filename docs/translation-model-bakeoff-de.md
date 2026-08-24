# Translation model bake-off — Russian → German, 2026-08-24

Seven OpenRouter models × four temperatures (default, 0.3, 0.5, 0.7) = 28 runs,
measured on the same hard Russian article (`example/example.bio.md`) through the
real pipeline in `mode: segments`. Same methodology as the
[English bake-off](translation-model-bakeoff.md).

**Score = 0.65 × translation quality + 0.35 × instruction following.**

---

## The ranking (best temperature per model)

| # | Model | Best temp | Score | Quality (65%) | Instructions (35%) | $/1000 docs |
|---:|---|---|---:|---:|---:|---:|
| 1 | **`minimax/minimax-m3`** | **0.3** | **8.29** | 8.0 | 8.8 | $2.55 |
| 2 | **`deepseek/deepseek-v4-pro-0813`** | **0.7** | **8.07** | 8.5 | 7.4 | $8.20 |
| 3 | **`qwen/qwen3.7-plus`** | default / 0.3 | **7.98** | 8.1 | 7.8 | $3.16 |
| 4 | **`deepseek/deepseek-v4-flash-0731`** | **0.7** | **7.54** | 8.1 | 6.5 | **$0.51** |
| 5 | `xiaomi/mimo-v2.5` | 0.3 | 6.99 | 7.1 | 6.7 | $1.09 |
| 6 | `minimax/minimax-m2.7` | 0.5 | 6.68 | 7.0 | 6.2 | $18.90 |
| 7 | `z-ai/glm-4.5-air` | default | 5.73 | 5.9 | 5.5 | $2.33 |

### The full temperature matrix

Scores per variant. **Bold** = that model's best; ✗ marks a run with a
disqualifying defect.

| Model | default | 0.3 | 0.5 | 0.7 | Spread |
|---|---:|---:|---:|---:|---:|
| `minimax/minimax-m3` | 8.00 | **8.29** | 7.28 | 7.41 ✗ | 1.01 |
| `deepseek/deepseek-v4-pro-0813` | 7.54 | 7.85 | 8.00 | **8.07** | 0.53 |
| `qwen/qwen3.7-plus` | **7.98** | **7.98** | 7.89 | 7.79 | 0.19 |
| `deepseek/deepseek-v4-flash-0731` | 7.30 | 6.89 | 7.33 | **7.54** | 0.65 |
| `xiaomi/mimo-v2.5` | 5.33 ✗ | **6.99** | 6.58 | 5.99 | 1.66 |
| `minimax/minimax-m2.7` | 4.63 ✗ | 5.15 ✗ | **6.68** | 5.32 | 2.05 |
| `z-ai/glm-4.5-air` | **5.73** | 5.55 | 5.03 | 5.03 | 0.70 |

### Recommendations

- **Best quality:** `minimax/minimax-m3` at **0.3** — $2.55/1000. Also the
  rule-7 champion in *both* languages, which is a consistency worth having.
- **Best value:** `deepseek/deepseek-v4-flash-0731` at **0.7** — rank 4 at
  **$0.51/1000**, five times cheaper than the winner for 0.75 of a point.
- **Safest if you cannot pin a temperature:** `qwen/qwen3.7-plus`. Its spread
  across all four settings is **0.19** — it simply does not have a bad
  temperature, and no run of it truncated, leaked or produced nonsense.
- **`deepseek-v4-pro-0813` is not worth its price here.** It is second at 8.07,
  but at $8.20/1000 it costs 16× the flash model for +0.53.
- **Avoid:** `z-ai/glm-4.5-air` (invented idioms, English leakage) and
  `minimax/minimax-m2.7` (truncation at two temperatures, escape leaks, and
  $8–19/1000 because reasoning cannot be switched off).

---

## Two findings that change how you should configure this

### 1. Default temperature is the most dangerous setting

**Two of seven models truncated at default temperature and at no other.**
`minimax-m2.7` cut the lead paragraph to 199 characters of 1132, and also lost
the trio's entire personnel list and most of the sources paragraph;
`xiaomi/mimo-v2.5` dropped more than half the musicology paragraph.

Both cut at the *same* place in the trio header — immediately after the opening
German quotation mark:

```
**Vokal-instrumentales Trio „Mistral        ← m2.7 default (36 chars)
**Vokal-Instrumental-Trio „Mistral          ← mimo default (34 chars)
**Vokal-instrumentales Trio „Mistral“ (Inna Subbotina – Gesang, …):**   ← correct
```

`verifyStructure: strict` cannot see any of this — the fragment count and the
skeleton are intact, only the content inside a fragment is gone. **Pin a
temperature explicitly rather than leaving it unset**; that single change
removes the worst failure in this test.

### 2. `minimax/minimax-m2.7` cannot have reasoning disabled

Its first four runs all failed in under 200 ms:

> `400 Reasoning is mandatory for this endpoint and cannot be disabled.`

— the same behaviour `biomd.config.yaml` already documents for
`google/gemini-3.7-flash`. Re-run with `reasoning: {enabled: true, effort: low}`
it works, but **reasoning is 50–70% of its output tokens**, which is what makes
it cost $8.37–$19.00 per 1000 documents — the most expensive model in the test,
from a mid-priced listing. It also leaked literal `\"` escapes into the published
Markdown at three of four temperatures, alone among all seven models.

---

## German-specific quality: what separated the models

### The colloquial idioms

`не все дома` — the natural German is **„nicht alle Tassen im Schrank"**.

| Rendering | Who | Verdict |
|---|---|---|
| „nicht alle Tassen im Schrank" | deepseek-v4-pro (default/0.5/0.7), m2.7 @0.5 | ideal |
| „nicht ganz bei Trost" | **qwen3.7-plus, all four** | equally idiomatic |
| „nicht ganz richtig im Kopf" | deepseek-v4-flash (default/0.3), m2.7 @0.3 | good |
| „nicht alles in Ordnung" | minimax-m3 ×4, mimo ×4, deepseek-flash (0.5/0.7) | flat but correct |
| „nicht alles mit rechten Dingen zugeht" | glm-4.5-air @0.3, @0.7 | **wrong** — means "something fishy" |
| **„nicht alle Tannenzapfen sind"** | glm-4.5-air @0.5 | **pure nonsense** — no such German idiom |

`зал заводился с пол-оборота` — best in field, **minimax-m3 @0.3/@0.5**: *"war der
Saal auf Betriebstemperatur"*. Also excellent: *"ging der Saal aus dem
Häuschen"* (deepseek-v4-pro @0.7), *"das Publikum sofort Feuer und Flamme"*
(qwen3.7-plus). Calqued into meaninglessness by **`minimax-m2.7` at all four
temperatures** — *"mit halber Umdrehung in Schwung"* — and by `glm-4.5-air`
default (*"mit halbem Umdrehen"*).

`с ладами был на «ты»` — *"mit den Bünden per Du"* (qwen3.7-plus ×4,
deepseek ×several) and *"duzte sich mit den Bünden"* (deepseek-v4-pro @0.7) are
the right answers. `mimo` wrote *"mit dem Griff"* and `glm-4.5-air` *"mit den
Lagen"* — **Griff** is a chord grip and **Lagen** are positions; neither is a
fret.

`руки опускались` translates *literally* into correct German — *"die Hände sinken
ließen"* — and most models found it. `mimo` paraphrased it away (*"den Mut
verloren"*), losing the image.

### Terminology

Two traps in German that nobody fell into, worth recording: `бой` was never read
as *Kampf*, and `проигрыш` was never read as *Niederlage*. German technical
vocabulary is well covered — **every model produced „Flageolett-Töne"** for
`флажолетные звуки`, which is the correct German term of art.

`строй` was mostly *"die Stimmung"* ✓, but `glm-4.5-air` produced **„der
Stimmton"** (@0.3, a pitch reference) and **„der Halt"** (@0.7, a grip) — both
wrong.

`подголосочная полифония` → *"Unterstimmen-Polyphonie"* is the accepted
rendering and most models found it. Failures: **„dvstimmbitchiger Polyphonie"**
(mimo default — meaningless), *„Bordunpolyphonie"* (m2.7 default — a drone, not a
subsidiary voice), *„mehrstimmiger Polyphonie"* (mimo @0.5 — "polyphonic
polyphony").

`проигрыш` → *"Zwischenspiel"* ✓ (deepseek-v4-pro ×4, minimax-m3, mimo @0.3/0.5).
`deepseek-v4-flash` wrote **„Refrain"** at 0.3 and 0.5 — wrong, a refrain is not
an instrumental break — and `m2.7` wrote *„beim Durchspielen"* (@0.3, meaningless)
and *„gegen die Coda"* (@0.7, wrong).

### The standards

`Туманно (Э. Гарнер)` is Erroll Garner's **"Misty"**. In the whole German field
only **`minimax-m3` at 0.5 and 0.7** recognised it. Everyone else translated
literally — *"Neblig" / "Nebelig" / "Nebelhaft"*, which is defensible in a German
catalogue — except `mimo`, which wrote **„Stimmungsvoll"** (default, "atmospheric")
and **„Düster"** (0.5 and 0.7, "gloomy"). Both are simply wrong.

`Мягкий дождь` — nobody restored Bonfá's "The Gentle Rain"; *„Sanfter Regen"* is
the near-universal and acceptable German answer. `m2.7` alone drifted, to
*„Weicher Regen"* (@0.5) and *„Leiser Regen"* (@0.7).

### Instruction following

**Rule 7 (romanize a source-script title, then gloss it once).**
`minimax-m3` is again the clear winner — `„Marafon mira" (Friedensmarathon)` and
`„Otechestwennye sapiski" (Vaterländische Hefte)` at default, 0.3 and 0.7. Next
best is **`deepseek-v4-pro` at 0.3/0.5/0.7**, the only model to gloss `Хоровод`
properly: `Khorovod (Reigen)`. Most other runs translated without romanizing.

Two specific failures:
- **`minimax-m3` at 0.5 left `„Отечественные записки"` in Cyrillic** — 50
  Cyrillic characters in a German edition. It glossed it, so a reader is not
  lost, but the rule says romanize for a Latin-script target.
- **Transliteration quality varies a lot.** `m2.7` @0.3 produced the best German
  form, *„Otetschestwennyje sapiski"*; the same model at 0.7 produced
  **„Otschedestwennyje sapiski"**, which is not a transliteration of anything.
  `minimax-m3` misspelled `Хоровод` as **„Chorowo"** — dropping the final
  consonant — at *all four* temperatures.

**German quotation marks (`„…"`).** `qwen3.7-plus` (all four) and `minimax-m3`
(all four) use them consistently; `mimo` mostly; `deepseek-v4-flash` and
`deepseek-v4-pro` only at 0.5; **`glm-4.5-air` never**, at any temperature.

**Names.** `Свиньин` → *„Swinjin"*. `glm-4.5-air` invented a different name at
three temperatures: **„Swininin"** (@0.3), **„Swinijin"** (@0.7).

### English leaking into German

Three runs published English inside the German edition:

- `xiaomi/mimo-v2.5` @0.7 — *"in memory of A. Ivanov-Kramskoy"*
- `z-ai/glm-4.5-air` @0.5 — *"In memory of …"*
- `z-ai/glm-4.5-air` @0.7 — *"In memory of …"* **and** *"The Girl from Ipanema"*

Worth knowing why this is plausible: **the shipped `segments-system.md` ends with
a worked example whose target language is English** (`## Example (source ru,
target en)`). Every German call therefore sees an English demonstration
immediately before its own instructions. This is a prompt-side observation, not
a proven cause — but if German becomes a primary target, making that example
language-neutral (or matching it to the request) is the cheap thing to try.

---

## Cost and reliability

| Model | Temp | Requests | Retries | Reasoning share | $/1000 | Notes |
|---|---|---:|---:|---:|---:|---|
| `deepseek-v4-flash-0731` | all | 2 | 0 | none | **$0.51** | cleanest cost profile in the test |
| `xiaomi/mimo-v2.5` | 0.3–0.7 | 2 | 0 | none | $1.09–1.21 | default run needed a retry after a timeout |
| `z-ai/glm-4.5-air` | all | 2 | 0 | none | $2.33–2.40 | |
| `minimax/minimax-m3` | 0.3–0.7 | 2–3 | 0 | none | $2.51–3.23 | default run hit one timeout (8m 58s) |
| `qwen/qwen3.7-plus` | all | 2 | 0 | none | $3.16–4.44 | zero incidents at any temperature |
| `deepseek-v4-pro-0813` | all | 2 | 0 | none | $7.13–8.20 | |
| `minimax/minimax-m2.7` | all | 1–3 | 0 | **50–70%** | **$8.37–19.00** | reasoning cannot be disabled |

`deepseek-v4-flash` was slow in this sweep (~3 min/run) but that is contention —
four runs executed in parallel against OpenRouter — not a property of the model.
Wall-clock here is not a fair comparison and is excluded from scoring.

---

## Method and limits

Identical to the English run: real pipeline, production prompts,
`verifyStructure: strict`, `repairAttempts: 2`, one model per pool with
`fallback.maxTargets: 1` and `taskFallback.maxAttempts: 1` so failures stay
visible. Reasoning disabled wherever the model permits it. Comparison done by
reading the outputs against the source passage by passage.

**One document, one run per configuration.** The top three (8.29 / 8.07 / 7.98)
are close enough that their order should be read as indicative. What is more
robust — because it was reproduced across temperatures, or is structural — is:
the default-temperature truncations, `m2.7`'s mandatory reasoning and escape
leaks, `glm-4.5-air`'s invented idiom and English leakage, `mimo`'s wrong
renderings of `Туманно`, `minimax-m3`'s consistent `Хоровод` misspelling, and
`qwen3.7-plus`'s unusual stability across all four settings.

Total cost of this sweep: **under $0.13** across 28 runs (plus 4 failed
no-cost runs).
