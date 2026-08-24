# OpenAI models on the `omniroute` gateway — a translation bake-off (ru → de)

**Endpoint** `http://192.168.1.26:20129/v1` · **date** 2026-08-24 · **document**
`example/example.bio.md` (Chudinov, 11 870 bytes) · **task** `translate`,
`mode: segments`, `verifyStructure: strict` · **20 combinations** = 5 model
configurations × 4 temperature settings (0.35, 0.5, 0.75, model default).

Score = **0.70 × translation quality + 0.30 × instruction following**, both read
by hand against the Russian source and against the ten rules in
`prompts/translation/segments-system.md`.

---

## 1. Summary

1. **All five models work.** They are present in `/v1/models`, they serve
   `chat/completions`, and all 20 runs completed with the structure guard
   satisfied — 26 of 26 blocks, every link intact, every number preserved.
2. **Temperature is accepted and has no effect.** The gateway validates the
   range (`temperature: 3.5` → `must be between 0 and 2`) and the value reaches
   the wire, but it changes nothing: at `temperature: 0` the same prompt returns
   three different texts, and across the bake-off the four samples of a model
   show no similarity ordering by temperature distance. **Treat the four
   temperature rows as four samples of one configuration.**
3. **Reasoning is real, controllable and verifiable.** `reasoning_effort: none`
   gives exactly 0 reasoning tokens; the effort suffixes are monotone
   (terra-low 14 % → luna-medium 20 % → luna-high 86 % of output tokens).
4. **`cx/gpt-5.6-luna` — what you use today — is the right choice**, and the
   ranking says so twice: it is second overall and **first on translation
   quality alone**. `cx/gpt-5.6-luna-high` scores higher overall on the
   strength of rule-following, but costs **7× the output tokens and 7× the wall
   clock**, and spelled the subject's surname two or three different ways in
   two of its four runs.
5. **Neither terra model belongs in a German pool.** Both transliterate Russian
   names the English way (`Chudinov`, not `Tschudinow`) and both write straight
   `"…"` instead of German `„…“` — a systematic defect on every page, not a
   sampling accident.

---

## 2. What was verified before measuring anything

| Question | Answer | How it was established |
|---|---|---|
| Do the five models exist? | Yes | `/v1/models`: all five listed, `api_format: responses`, `context_length: 272000`, `max_output_tokens: 128000` |
| Is `temperature` applied? | **No** | see §3 |
| Is reasoning applied? | **Yes** | `completion_tokens_details.reasoning_tokens` > 0, and `reasoning_content` deltas on the stream |
| Can reasoning be turned off? | **Yes**, and it must be asked for | bare `cx/gpt-5.6-luna` spends 184 reasoning tokens on a control question with no parameter; `reasoning_effort: none` → 0 |
| `json_object`? | Yes, all five | probe returned a JSON object under `response_format` |
| `json_schema`? | Yes, all five | strict schema accepted and honoured |
| `prompt_cache`? | Yes | `prompt_tokens_details.cached_tokens: 2816` on repeat calls, across separate runs |
| `web_search`? | Not offered by these entries | absent from the model record's capability block |

Two corrections to `biomd.config.yaml` fall out of this: the `or-luna` target
declares `contextWindow: 127000` / `maxOutputTokens: 4096` where the gateway
reports **272000 / 128000**, and its capability list omits `json_schema` and
`prompt_cache`, both of which work. The narrow `maxOutputTokens` is the one that
costs something — it is what `onOverflow: skip` uses to decide the model cannot
finish a long article.

**Reasoning is only disabled when you say so.** The bare model ids are *not*
non-reasoning models; they reason by default. `reasoning: { enabled: false,
dialect: reasoning_effort }` is what makes `cx/gpt-5.6-luna` behave the way the
current config assumes it already does.

---

## 3. Temperature does nothing on this gateway

Three independent observations, none of which is a caching artefact — every
response below carries `x-omniroute-cache-hit=false`:

**a. `temperature: 0` is not deterministic.** The same 35-word prompt, three
times, differing only by trailing whitespace:

> …Each chord brightened puddles, softened sirens, and drew strangers closer…
>
> …Each chord rippled through puddles, guiding strangers home…
>
> …Each chord gathered strangers under awnings, until the storm softened…

**b. `temperature: 2` is not degenerate.** At the top of the range the model
still writes clean, well-formed prose — which a real sampling temperature of 2
never does.

**c. The bake-off outputs show no ordering by temperature.** If temperature were
applied, 0.35 and 0.5 would resemble each other more than 0.35 and the default.
They do not:

| model | most similar pair | least similar pair |
|---|---|---|
| luna (no reasoning) | **t75 vs default** 0.842 | t35 vs default 0.747 |
| terra (no reasoning) | **t5 vs default** 0.840 | t35 vs t5 0.694 |
| luna-medium | t35 vs t5 0.788 | t5 vs default 0.678 |
| luna-high | t35 vs t5 0.647 | t75 vs default 0.552 |
| terra-low | t75 vs default 0.735 | t5 vs default 0.680 |

The run-to-run spread within one configuration (0.55–0.84 similarity) is large
in absolute terms — these models rewrite a good deal of the article between
identical requests. That variance, not temperature, is what the four rows per
model measure.

---

## 4. Ranking — all 20 combinations

| # | combination | model | temp | **total** | translation (70 %) | instruction (30 %) |
|---:|---|---|---|---:|---:|---:|
| 1 | `luna-high__t35` | cx/gpt-5.6-luna-high | 0.35 | **8.96** | 8.90 | 9.10 |
| 2 | `luna-noreas__t35` | cx/gpt-5.6-luna | 0.35 | **8.41** | 8.80 | 7.50 |
| 3 | `luna-medium__t5` | cx/gpt-5.6-luna-medium | 0.5 | **8.36** | 8.30 | 8.50 |
| 4 | `luna-high__t75` | cx/gpt-5.6-luna-high | 0.75 | **8.35** | 8.50 | 8.00 |
| 5 | `luna-high__t5` | cx/gpt-5.6-luna-high | 0.5 | **8.33** | 8.00 | 9.10 |
| 6 | `luna-noreas__t75` | cx/gpt-5.6-luna | 0.75 | **8.20** | 8.50 | 7.50 |
| 7 | `luna-noreas__t5` | cx/gpt-5.6-luna | 0.5 | **8.20** | 8.50 | 7.50 |
| 8 | `luna-high__default` | cx/gpt-5.6-luna-high | default | **7.98** | 8.10 | 7.70 |
| 9 | `terra-low__t35` | cx/gpt-5.6-terra-low | 0.35 | **7.95** | 8.10 | 7.60 |
| 10 | `luna-noreas__default` | cx/gpt-5.6-luna | default | **7.88** | 8.30 | 6.90 |
| 11 | `luna-medium__t35` | cx/gpt-5.6-luna-medium | 0.35 | **7.74** | 8.10 | 6.90 |
| 12 | `luna-medium__t75` | cx/gpt-5.6-luna-medium | 0.75 | **7.64** | 8.00 | 6.80 |
| 13 | `terra-noreas__t5` | cx/gpt-5.6-terra | 0.5 | **7.63** | 8.20 | 6.30 |
| 14 | `terra-noreas__t35` | cx/gpt-5.6-terra | 0.35 | **7.63** | 8.20 | 6.30 |
| 15 | `terra-noreas__default` | cx/gpt-5.6-terra | default | **7.63** | 8.20 | 6.30 |
| 16 | `terra-low__t5` | cx/gpt-5.6-terra-low | 0.5 | **7.63** | 8.20 | 6.30 |
| 17 | `terra-noreas__t75` | cx/gpt-5.6-terra | 0.75 | **7.56** | 8.10 | 6.30 |
| 18 | `luna-medium__default` | cx/gpt-5.6-luna-medium | default | **7.53** | 7.80 | 6.90 |
| 19 | `terra-low__t75` | cx/gpt-5.6-terra-low | 0.75 | **7.52** | 8.30 | 5.70 |
| 20 | `terra-low__default` | cx/gpt-5.6-terra-low | default | **7.50** | 8.10 | 6.10 |

Because temperature is inert, the actionable table is the aggregate:

| model | **total** | translation | instruction | spread across 4 samples |
|---|---:|---:|---:|---|
| **cx/gpt-5.6-luna-high** | **8.40** | 8.38 | **8.47** | 7.98 – 8.96 (widest) |
| **cx/gpt-5.6-luna** (no reasoning) | **8.17** | **8.53** | 7.35 | 7.88 – 8.41 |
| cx/gpt-5.6-luna-medium | 7.82 | 8.05 | 7.28 | 7.53 – 8.36 |
| cx/gpt-5.6-terra-low | 7.65 | 8.18 | 6.42 | 7.50 – 7.95 |
| cx/gpt-5.6-terra (no reasoning) | 7.61 | 8.17 | 6.30 | 7.56 – 7.63 (narrowest) |

---

## 5. Tokens and time

Per combination, from a logging proxy in front of the gateway, so these are wire
figures rather than estimates. "Visible out" is output minus reasoning — the
part that becomes German.

| combination | calls | input | of it cached | output | reasoning | visible out | wall |
|---|---:|---:|---:|---:|---:|---:|---:|
| luna-noreas__t35 | 2 | 5 295 | 2 816 | 2 079 | 0 | 2 079 | 41 s |
| luna-noreas__t5 | 2 | 5 295 | 2 816 | 2 062 | 0 | 2 062 | 42 s |
| luna-noreas__t75 | 2 | 5 295 | 2 816 | 2 067 | 0 | 2 067 | 41 s |
| luna-noreas__default | 2 | 5 295 | 0 | 2 092 | 0 | 2 092 | 41 s |
| terra-noreas__t35 | 1 | 3 704 | 0 | 2 004 | 0 | 2 004 | 40 s |
| terra-noreas__t5 | 1 | 3 704 | 2 816 | 2 008 | 0 | 2 008 | 39 s |
| terra-noreas__t75 | 1 | 3 704 | 2 816 | 1 979 | 0 | 1 979 | 38 s |
| terra-noreas__default | 1 | 3 704 | 0 | 2 001 | 0 | 2 001 | 39 s |
| luna-medium__t35 | 2 | 5 295 | 0 | 2 490 | 295 | 2 195 | 48 s |
| luna-medium__t5 | 2 | 5 295 | 2 816 | 2 682 | 564 | 2 118 | 53 s |
| luna-medium__t75 | 1 | 3 704 | 2 816 | 2 413 | 334 | 2 079 | 46 s |
| luna-medium__default | 2 | 5 295 | 2 816 | 3 222 | 1 015 | 2 207 | 64 s |
| luna-high__t35 | 2 | 5 295 | 0 | 14 216 | 11 983 | 2 233 | 259 s |
| luna-high__t5 | 2 | 5 295 | 2 816 | 15 200 | 12 959 | 2 241 | 280 s |
| luna-high__t75 | 2 | 5 295 | 2 816 | 18 194 | 15 966 | 2 228 | 335 s |
| luna-high__default | 2 | 5 295 | 0 | 15 173 | 12 949 | 2 224 | 278 s |
| terra-low__t35 | 1 | 3 704 | 0 | 2 773 | 623 | 2 150 | 52 s |
| terra-low__t5 | 1 | 3 704 | 2 816 | 2 357 | 231 | 2 126 | 46 s |
| terra-low__t75 | 1 | 3 704 | 2 816 | 2 506 | 360 | 2 146 | 48 s |
| terra-low__default | 1 | 3 704 | 2 816 | 2 258 | 140 | 2 118 | 47 s |

Per model, over its four runs:

| model | calls | input | output | reasoning | reasoning share | mean wall |
|---|---:|---:|---:|---:|---:|---:|
| cx/gpt-5.6-luna | 8 | 21 180 | 8 300 | 0 | 0 % | 41 s |
| cx/gpt-5.6-terra | 4 | 14 816 | 7 992 | 0 | 0 % | 39 s |
| cx/gpt-5.6-luna-medium | 7 | 19 589 | 10 807 | 2 208 | 20 % | 53 s |
| cx/gpt-5.6-luna-high | 8 | 21 180 | **62 783** | 53 857 | **86 %** | **288 s** |
| cx/gpt-5.6-terra-low | 4 | 14 816 | 9 894 | 1 354 | 14 % | 48 s |

Three things in that table are worth acting on.

**The visible output is a constant ≈ 2 000–2 250 tokens.** All five produce the
same amount of German. Everything above that line is deliberation, and on
`luna-high` deliberation is **86 %** of what you pay for and **7× the wall
clock** — 288 s against 41 s per article. Over a thousand-article corpus that is
the difference between eleven hours and eighty.

**Every `luna` run needed a repair round; no `terra` run did.** Eleven of the
twelve luna runs (`luna-medium__t75` excepted) came back one key short of the 34
they were asked for, which costs a second call of ~1 591 input tokens. All eight
terra runs answered every key first time. The pipeline's repair ladder makes
this invisible in the output — it is only visible in the bill.

**Prompt caching works and pays.** 2 816 of the 3 704 input tokens of a first
call are a cache hit — the stable system + instruction prefix, shared across
*different runs and different models*. That is mechanism 1 of the architecture
doing what it was built to do; nothing in the bake-off had to be arranged for
it.

*Caveat on the cached figures:* on a separate probe with a deliberately large
stable prefix, `prompt_tokens` roughly doubled on the cached call
(5 621 → 10 485 with `cached_tokens: 4 864`). The gateway's accounting for
cached prompts is not obviously self-consistent; the totals above are what it
reported, and the visible-output column is the number to trust.

---

## 6. What actually separates them

Every figure below is over the four runs of that model.

| test | luna | terra | luna-medium | luna-high | terra-low |
|---|---|---|---|---|---|
| **Rule 7** — «Марафон мира» romanised + glossed | 0/4 | 0/4 | 1/4 | **4/4** | 2/4 |
| **Rule 7** — «Отечественные записки» romanised + glossed | 0/4 | **4/4** | 1/4 | **4/4** | 2/4 |
| **Rule 5** — German transliteration (`Tschudinow`) | **4/4** | 0/4 | **4/4** | 2/4 | 1/4 |
| **Rule 5** — one spelling per document | **4/4** | **4/4** | **4/4** | 2/4 | **4/4** |
| **Rule 8** — German `„…“` quotation marks | **4/4** | 0/4 | **4/4** | **4/4** | 0/4 |
| **Rule 1** — all 34 keys in one call | 0/4 | **4/4** | 1/4 | 0/4 | **4/4** |
| Cyrillic left in the German prose | 1 run | **none** | 3 runs | **none** | **none** |
| `строй` read as "A string" (invented) | **0/4** | **0/4** | 4/4 | 2/4 | **0/4** |
| «не все дома» → a real German idiom | **4/4** | 1/4 | **4/4** | **4/4** | 0/4 |

### The trap the reasoning models fell into

The source contains a typo: `да и а строй держался намертво` — "and the *tuning*
held rock-solid". Both non-reasoning models and `terra-low` read it correctly
("die Stimmung hielt bombenfest"). `luna-medium` got it wrong in **all four**
runs and `luna-high` in **two of four**, reasoning their way from the stray `а`
to a musical key:

> …und auch **die A-Saite** hielt bombenfest… — `luna-high__t5`, `luna-high__default`, `luna-medium__t5`, `luna-medium__default`
>
> …und auch **die A-Stimmung** hielt bombenfest… — `luna-medium__t35`, `luna-medium__t75`

This is the failure mode worth naming: **reasoning did not resolve the
ambiguity, it manufactured one.** A reader of the German has no way to tell that
the article never mentioned a string.

### The rule you asked about — latinise, then gloss

The article names a journal only in Cyrillic. Rule 7 asks for the romanised name
plus a gloss in brackets. The three answers, all from the same passage:

| | rendering | verdict |
|---|---|---|
| `luna-high` (4/4), `terra` (4/4) | `„Otechestvennye zapiski“ (Vaterländische Aufzeichnungen)` | **correct** |
| `luna` no-reasoning (3/4) | `„Vaterländischen Annalen“` | name translated away — the searchable form is gone |
| `luna-noreas__default`, `luna-medium__t75` | `„Отечественные записки“` | worse: Cyrillic published in the German edition |

`luna-high` is the only model that applied the rule to *both* source-script
titles, and it did so in all four runs — including the ensemble name, which
every other configuration silently translated:

> …des Kulturprogramms **„Marafona mira“ (Marathon des Friedens)**… — `luna-high`
>
> …des Kulturprogramms **„Marathons des Friedens“**… — everyone else

One nesting slip on terra's side is worth noting, because rule 7 forbids it
explicitly: where the source already had brackets, `terra-noreas` opened another
pair inside them — `("Otechestvennye zapiski" (Vaterländische Notizen), 1821,
Nr. 1, S. 217)`.

### Names, which is where terra disqualifies itself

The whole document, German edition:

| | heading | occurrences |
|---|---|---|
| every `luna` run | `Alexei Konstantinowitsch Tschudinow` | 14 × `Tschudinow` |
| every `terra` run | `Alexei Konstantinovich Chudinov` | 14 × `Chudinov` |

`Chudinov` is the English transliteration. In a German edition of a catalogue
whose readers search for `Tschudinow`, that is not a stylistic preference — it
detaches the entry from the name its readers type. `terra-low` fixed it in one
run of four and reverted in the other three.

`luna-high` has the mirror-image problem, and it is worse because it is
*internal*: two of its four runs spelled the subject's surname more than one way
in a single document — `Chudinow` ×10 + `Chudinov` ×4 + `CHUDINOV` in
`luna-high__default`, `Chudinow` ×9 + `Tschudinow` ×5 in `luna-high__t75`.
`Chudinow` belongs to no transliteration convention at all; it is half of each.

---

## 7. The hard passage, read side by side

The article's central test is a block of colloquial reminiscence full of guitar
slang and idiom. Three terms in it are traps, because each has a common
non-musical meaning:

| source | trap reading | correct | who got it right |
|---|---|---|---|
| `бой` | "battle", "beat" | strumming pattern → *Anschlag* / *Schlagmuster* | **all 20** |
| `проигрыш` | "loss", "defeat" | instrumental break → *Zwischenspiel* | **all 20** |
| `переборы` | "excesses", "overdoing it" | fingerpicking → *Zupfmuster* / *Arpeggien* | **all 20** |

No model mistranslated any of the three — the domain framing in the system
prompt is doing its job. `luna-high__t35` produced the single most precise
reading in the set, *Schlagmuster*; `luna` prefers *Zupfmuster* for `переборы`
and `terra` uniformly *Arpeggien*, which is narrower but defensible.

The separation happens on idiom instead.

**Source:** «Друзья даже начали подумывать, что у него "не все дома"»

- `luna`, all 12 runs: **„nicht alle Tassen im Schrank“** — the exact German
  equivalent, colloquial register preserved
- `terra-noreas__t5/__t75`, `terra-low__t35/__default`: „nicht alles in Ordnung“
  — accurate and flat, the joke gone
- `terra-low__t75`: „nicht alles richtig tickte“ — a good recovery
- `terra-noreas__default`: „nicht alles richtig im Kopf“ — serviceable

**Source:** «строй держался намертво, хоть ты тресни»

- `luna-medium__t5`: „…hielt bombenfest, **und wenn du dich auf den Kopf
  stellst**“ — the best rendering in the twenty
- `luna-high__t35`: „…hielt bombenfest, koste es, was es wolle“ — subtly wrong;
  "whatever the cost" is not "whatever happens"
- most others: „komme, was wolle“ — correct and unremarkable

**Source:** «у видавших виды коллег руки опускались: мол, куда уж нам»

- `luna-noreas__t75`: „…die Hände sanken: **Na, da können wir nicht
  mithalten.**“ — idiomatic
- `luna-high__t35`: „**Wozu sollten wir da noch antreten?**“ — idiomatic
- `terra-noreas__t75`: „Was sollten wir da noch machen.“ — a question written as
  a statement
- `luna-noreas__t35`: „Wohin sollen wir da noch?“ — not German

### The 1821 quotation

The archaic inset — a period notice about a fingering discovery — is handled
well by every model: `флажиолетные звуки` → **Flageoletttöne**, `три лада`
→ **drei Bünde**, `гитарной школе` → **Gitarrenschule** (the method book, not an
institution), everywhere. More telling, **every configuration preserved the
source's own inconsistency**: the passage credits the discovery to Chudinov and
then to `Аксенов` two sentences later, and not one model silently harmonised the
names. That is rule 9 respected under real temptation.

The poem fared least well everywhere. All twenty translate the four lines
accurately and none of them rhymes, where the Russian does — rule 10 asks for
verse and gets careful prose. No model separates itself here.

### The one place the domain knowledge ran out

The trio's discography lists Russian renderings of international standards.
`Туманно (Э. Гарнер)` is Erroll Garner's **"Misty"** and `Мягкий дождь
(Л. Бонфа)` is Bonfá's **"Gentle Rain"**. Every model translated the Russian
words instead of recognising the record — "Nebelhaft", "Neblig", "Sanfter
Regen". One model noticed a cross-reference the others missed: `luna` rendered
`Впечатление (Ч. Аткинс)` as **"Impression"**, which is how the very same piece
is printed in the guitar-duo list higher up the page. `terra` translated it to
"Eindruck" and broke the link between the two lists.

### A factual error worth naming

`авторские свидетельства на изобретения` are Soviet **inventor's certificates**
— specifically *not* patents; they were the alternative to one.
`terra-noreas` (3 of 4 runs) and `terra-low__t35` wrote **„Erfinderpatente“**,
which states something the source does not. `luna` mostly wrote
„Urheberbescheinigungen“ / „Urheberscheine“, which is right.

---

## 8. Recommendation

**Keep `cx/gpt-5.6-luna` as the German translation model, and make its
non-reasoning mode explicit.** It is first on translation quality — the 70 %
half — at 41 s and ~2 100 output tokens per article, and it never invented
meaning. Its weakness is rule 7, and rule 7 looks like a prompt problem rather
than a model problem: the same model family applies the rule reliably at higher
effort, so the cheap experiment is to raise that rule's salience in
`prompts/translation/segments-system.md` and re-measure against this bake-off,
rather than to buy 86 % reasoning overhead.

```yaml
- id: or-luna
  endpoint: omniroute
  model: cx/gpt-5.6-luna
  contextWindow: 272000        # was 127000 — the gateway reports 272k
  maxOutputTokens: 32768       # was 4096 — the gateway allows 128k
  capabilities: [json_object, json_schema, prompt_cache, tools]
  pricing: { inputPer1M: 0, outputPer1M: 0 }
  # These models reason unless told not to. Measured here: the bare id spends
  # 184 reasoning tokens on a control question with no parameter at all, and
  # reasoning is what produced the one invented reading in this bake-off.
  reasoning: { enabled: false, dialect: reasoning_effort }
  # `temperature` is accepted and range-checked by this gateway and then has no
  # effect: at 0 the same prompt returns three different texts. Leave it out
  # rather than encoding an intention the endpoint does not honour.
  tags: [remote, cheap]
```

**Do not put `cx/gpt-5.6-luna-high` on the corpus.** It wins the combined score
and it is the only model that follows rule 7 reliably, but at 288 s and ~15 000
output tokens per article, and with a surname spelled two or three ways in half
its runs. If its rule-following is wanted, use it as a *second* opinion on the
entries that matter, never as the pool's first choice.

**Do not use either terra model for German.** English transliteration and
straight quotation marks are systematic, appear on every page, and cannot be
fixed by re-running. Their one real advantage — answering all 34 keys in a
single call, where luna always needs a repair round — is worth about 1 600 input
tokens per article and does not come close to paying for the defects. They may
still be worth testing for an *English* edition, where the transliteration
convention that sinks them here is the correct one.

`cx/gpt-5.6-luna-medium` is the one configuration to avoid outright: it carries
reasoning's cost and its risk (4 of 4 runs invented "A-Saite", 3 runs left
Cyrillic in the German) without buying luna-high's rule-following.

---

## 9. Reproducing this

```bash
node bakeoff/oa/gen.mjs
```

```bash
python bakeoff/oa/proxy.py
```

```bash
bash bakeoff/oa/run_all.sh
```

```bash
python bakeoff/oa/rules.py
```

```bash
python bakeoff/oa/defects.py
```

```bash
python bakeoff/oa/align.py 4
```

`gen.mjs` writes the 20 configs; `proxy.py` is the wire log on
`127.0.0.1:8099`; `run_all.sh` runs the 20 sequentially; `rules.py` reports how
each combination rendered the source-script titles; `defects.py` counts
Cyrillic, quotation marks, blocks and numbers; `align.py N` prints source block
N against all 20 outputs (`align.py index` lists the blocks).

Each run uses a single-model pool with `fallback.maxTargets: 1` and
`taskFallback.maxAttempts: 1`, so a bad answer is that combination's result and
never another model's. Endpoint concurrency is 1 with `stream: false`, which is
what keeps the gateway's request-coalescing bug out of the measurement.
Translations are in `bakeoff/oa/out/<combination>/de/example.bio.md`; the wire
log is `bakeoff/oa/logs/wire.jsonl`; the score sheet, with a note per
combination, is `bakeoff/oa/scores.json`.
