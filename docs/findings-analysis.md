# Analysis of `docs/findings.md` — what was actually wrong

Investigated **2026-08-23** against `input/ru` (50 articles) and
`translation/examples` (8 articles). All translation and extraction work ran on
the free local `local-small` (`gemma4-31b-local`); the search comparison used the
declared search targets. Every number below was measured on this machine.

**The headline: most of the regression was not a prompt problem.** Seven harness
or configuration defects account for the lost metadata, the failed `albert`
translation and the untranslated poems. The prompts did need work — but a
different kind of work than the symptoms suggested, and several of the
"stylistic regressions" turn out to be the sampler rather than the prompt.

| # | Defect | Effect | Status |
|---|---|---|---|
| 1 | `omniroute` gateway coalesces concurrent requests | one guitarist's facts published into another's dossier | fixed (`maxConcurrent: 1`) |
| 2 | `or-osearch` 400s on `response_format` | the paid search fallback served 0 of its requests | fixed (capability gating) |
| 3 | `or-search-quality` has no web search but answers anyway | fabricated dates with plausible citations | fixed (kept out of the pool) |
| 4 | `deathplace` had no liveness gate | a place of death published for a living guitarist | fixed |
| 5 | fenced blocks always treated as code | 44% of a poem-bearing article never translated | fixed |
| 6 | five copies of a link regex, none handling an escaped label | `albert → en` failed; anchors sent to the model | fixed |
| 7 | dual-calendar dates unparseable | `aleksandrov` published no dates at all | fixed |
| 8 | `local-small` runs at the server's default temperature | run-to-run wording churn read as prompt regression | reported below |

---

## Part 1 — the search models

### The hypothesis

> `or-osearch` and `or-search-quality` may return more results, while
> `or-search`, `or-search2`, `or-search3` return identical results of lower
> quality and quantity.

**Half right, and the interesting half is backwards.** The three omniroute
targets are genuinely different models giving genuinely different answers. The
two "better" candidates were, as configured, one dead and one dangerous.

### Method

Twelve documents (`abiton, aguado, alais, albeniz, albert, aleksandrov, almeida,
amigo, anido, arcas, armik, aussel`) extracted once with `local-small` into a
shared baseline; the baseline copied six times and `websearch` run over each copy
with a single-target pool. The measure is *fields filled or changed on top of the
baseline*.

### Result

| target | model | endpoint | fields | verdict |
|---|---|---|---:|---|
| `or-search` | `cx/gpt-5.6-luna` | omniroute, free | 7 | works; cites Wikipedia |
| `or-search2` | `cx/gpt-5.6-luna-medium` | omniroute, free | 8 | works; published one uncorroborated date |
| `or-search3` | `cx/gpt-5.6-terra-low` | omniroute, free | 6 | **best judgement** — recorded a date conflict rather than overwriting |
| `or-osearch` | `openai/gpt-5.6-luna:online` | openrouter, paid | **0** → 10 | was failing 100%; best coverage and the most varied real sources once repaired |
| `or-search-quality` | `google/gemini-3.7-flash` | openrouter, paid | 9 | **cannot search** — invents |
| `or-search-quality` + web plugin | same | openrouter, paid | 0 | reasoning eats the output budget; `content: null` |

They do not agree. On `abiton` they cite three different pages; on `armik` one
overwrote the record, one recorded a conflict, one declined.

### 1. The omniroute gateway returns one answer to concurrent requests

This is the big one, and it explains most of "less metadata is being extracted".

Three `websearch` calls issued within 9 ms of each other, with payloads of 793,
1078 and 1088 bytes, received the **byte-identical** response:

```
SENT : name: Дионисио Агуадо      GOT: deathplace "Мадрид, Испания", source es.wikipedia.org/wiki/Dionisio_Aguado
SENT : name: Мария Луиза Анидо    GOT: deathplace "Мадрид, Испания", source es.wikipedia.org/wiki/Dionisio_Aguado
SENT : name: Висенте Амиго        GOT: deathplace "Мадрид, Испания", source es.wikipedia.org/wiki/Dionisio_Aguado
```

A fourth request eighteen seconds later got its own correct answer. With
`maxConcurrent: 1`, all four were correct.

The minimal reproduction takes five seconds — four concurrent one-line questions
with obviously different answers:

```
✔ country whose capital is Madrid    expected Spain,  got "Spain"
✖ country whose capital is Paris     expected France, got "Spain"
✖ country whose capital is Rome      expected Italy,  got "Spain"
✖ country whose capital is Tokyo     expected Japan,  got "Spain"

or-search  on omniroute  : 4 concurrent requests → 1 distinct answer,  3 wrong
or-osearch on openrouter : 4 concurrent requests → 4 distinct answers, 0 wrong
```

So the fault is the gateway at `192.168.1.26:20129`, not the models behind it
and not OpenRouter.

This is worse than losing a field: it **publishes one person's facts into
another's dossier**, well-formed, sourced and confident, with a citation naming
the wrong person. With `onDateConflict: prefer-precise` it can also *overwrite* a
correct value — which is what happened to Armik, who received Vicente Amigo's
`25.03.1967`.

**Fix:** `llm.endpoints[omniroute].maxConcurrent: 1`. It is a correctness
setting, not a throughput one, and it should not be raised without re-running
that experiment.

### 2. `or-osearch` failed every single call

The error surfaced as `400 Provider returned error`. Calling the API directly
recovered the provider's own message:

> Web Search cannot be used with JSON mode.

`tasks.websearch` always sends `response_format: {type: json_object}`, so the
pool's paid fallback served **0 of its requests** while looking like an ordinary
provider error.

The transport now sends `response_format` only to a target that **declares** the
matching capability, which turns the capability list from documentation into
behaviour. Removing `json_object` from that entry makes it work: it answers JSON
because the prompt asks for it, and every parser here strips a fence anyway.
After the fix it filled **10 fields** — the most of any real search model —
citing an *El País* obituary for Anido and `hayazg.info` for Armik rather than
Wikipedia every time.

### 3. `or-search-quality` cannot search, and answers anyway

Two separate problems:

- it failed `models --probe` outright — `400 Reasoning is mandatory for this
  endpoint and cannot be disabled`, caused by `reasoning.enabled: false`;
- it has no `web_search` capability, so `requireWebSearchCapability` would never
  route to it. Forced to answer regardless, it produced the **highest field count
  in the test** — by inventing.

Asked for Gérard Abiton's date of birth it returned `18.06.1954`, confidence
0.95, sourced to `https://data.bnf.fr/fr/13934335/gerard_abiton/`. That URL 303s
to a BnF record for a different person and carries no date at all. Wikipedia,
Wikidata and Abiton's own publishers all give **only the year**.

**More fields is not better.** This is the clearest result of the whole
investigation, and the reason the capability gate must stay honest.

### 4. Nobody should be asked where a living person died

`findGaps` asked for `deathplace` whenever the field was empty — which is every
living guitarist in the corpus. `died` has had a liveness gate since it was
written; `deathplace` did not. Asked "where did Roberto Aussel die?",
`or-osearch` answered `Сен-Эрблен, Франция` at confidence 0.95, and it was
published into the dossier of a man who is alive and playing.

Both fields are now gated on both sides: not asked unless a death is on record or
the liveness check is running, and dropped together unless the answer explicitly
says `dead`.

### 5. `upgradePrecision` manufactures precision

Asking "what is the exact day?" of a person whose birth *year* is all anyone
records gets you a day. Four distinct precision upgrades were observed:

| entry | on record | returned | corroborated? |
|---|---|---|---|
| `amigo` | `1967` | `25.03.1967` | **yes** — all five working targets agreed |
| `abiton` | `1954` | `18.06.1954` (gemini, `data.bnf.fr`) | no — that URL carries no date |
| `abiton` | `1954` | `27.05.1954` (`or-osearch`, citing a Vietnamese government decree about a Saigon guitar festival) | no |
| `armik` | `1950` | `02.06.1950` (`or-search2`) | no — Wikidata says 25.07.1949, everything else "c. 1950s" |

`onDateConflict` does not help: these agree with the recorded *year*, so
`mergeDossier` treats them as one fact read more closely and accepts them
whatever the setting. The only levers are `upgradePrecision: false` and review.
Note that the one correct upgrade is the one where five independent targets
agreed — which is the shape a real corroboration rule would take.

**Recommendation:** leave `upgradePrecision: true`, and make
`biomd report --notes Sharpened` part of the QA pass. Every upgrade is already
reported; nobody was reading it.

### Recommended pool

```yaml
websearch: [or-search, or-search2, or-search3, or-osearch]
```

Three free targets that really search, a paid one behind them for when omniroute
is down, and `or-search-quality` deliberately absent.

---

## Part 2 — translation

### `segments` or `document`?

Both modes were run over the same 14 articles with the same rewritten prompt, on
the same model, translation memory off:

| | `segments` | `document` |
|---|---:|---:|
| structurally exact (strict skeleton) | 14/14 | 14/14 |
| source-script text left in the prose | 0 | 0 |
| hard line breaks lost | **0** | 1 |
| dash substitutions | **35** | 60 |
| comma pulled into a quote | 2 | 2 |
| Latin titles kept | 42/42 | 42/42 |
| model calls | 20 | **15** |
| input tokens | 48 691 | **40 987** |
| output tokens | 91 387 | **68 094** |
| **total tokens** | 140 078 | **109 081** (−22%) |

Two results here are worth stating plainly because they contradict the received
wisdom in `CLAUDE.md`:

- **Document mode held the structure.** Fourteen articles including
  `garcia_lorca`'s nested `::: columns` and eleven fenced poems, all
  byte-structurally identical to their source under the *strict* comparison. On
  this model, with this prompt, whole-document translation is not the liability
  it was assumed to be.
- **Document mode is cheaper here, not dearer** — 22% fewer tokens. Segments
  mode saves on *input* exactly as designed, but pays it back on *output*: every
  fragment comes back wrapped in its own JSON key and escaping, and every batch
  repeats the system prompt. On a corpus of short fragments that costs more than
  the markup it avoids sending.

**Keep `segments` anyway.** The reasons are not visible in a 14-document test:

1. **Its structural guarantee does not depend on the model.** The skeleton is
   never sent, so it cannot come back wrong. Document mode passed *this* model
   on *these* articles — and still dropped a hard line break in
   `milovanova.bio.md`, joining two lines of a roster into one, which is exactly
   the failure the trailing-backslash rule exists to prevent. Swap in a smaller
   or cheaper model and segments mode holds while document mode is renegotiated.
2. **A failure costs one fragment.** `repairAttempts` re-asks for the keys that
   came back missing or malformed; `displacedMasks` re-asks for the one fragment
   whose link broke. In document mode every failure retries — or loses — the
   whole article.
3. **`useTranslationMemory: persistent` only works there.** Over ~1000 articles
   with heavily repeated boilerplate, translating each distinct string once
   dominates any per-call saving. The 22% measured above is a first-run number.
4. **Dash and punctuation drift is half.** 35 substitutions against 60, on
   identical input with identical instructions.

The honest summary: document mode is a reasonable option on this model if
maximum surrounding context matters, and `verifyStructure: lenient` is the right
setting for it. Segments mode is the better *system*.

### One thing document mode gets right that segments mode does not

`evers.bio.md` mixes Russian prose with a German discography. `foreignFragments:
keep` never sends a fragment with no Cyrillic in it, so segments mode leaves
**all** of it German — the album titles (right) and the catalogue descriptions
(arguably wrong):

```
### Gitarrenmusik des 20. Jahrhunderts
Doppel-LP mit Werken von de Falla, Martin, Smith-Brindle, Henze, …
```

Document mode, which sees everything, made the distinction on meaning:

```
### Gitarrenmusik des 20. Jahrhunderts          ← title kept
Double LP with works by de Falla, Martin, …     ← description translated
```

Setting `tasks.translate.foreignFragments: translate` gets segments mode to the
same place — the rewritten rules 4/6/7 make the same call — at 3× the tokens on
that document (23 169 against 7 892), because every German fragment is now sent
and answered. It is a real choice, not a bug: `keep` is right when the foreign
text is titles, `translate` when it is prose. This corpus has both.

### The poems were never translated at all

`extractTextSpans` skipped every fenced block on the assumption that a fence
means code. This corpus uses a bare ``` fence to set **verse**.

On `garcia_lorca.bio.md`, **44% of the Russian text was never sent to a
translator** — eleven poems, the Lorca and the Dolmatovsky among them. Nothing
caught it: the structure guard ignores fenced content, so the article passed every
check with half of it still in Russian.

| | Russian text sent for translation |
|---|---:|
| before | 55.7% |
| after | 100% |

`src/documents/markdown/fences.ts` now classifies each block by what is in it —
an info string naming a language, tablature and ASCII rules are code; lines of
words are verse — and verse is lifted **one span per line**, so the shape of the
poem is restored by the splice rather than asked of the model. Stanza breaks and
line counts survive by construction.

**This was a harness bug, not a prompt bug.** Every prompt version tested
translates the poems equally well once the lines reach them, and the resulting
verse is decent: metre is kept where it can be, rhyme mostly is not, and nothing
is lost. The prompt's only remaining job is to grant the licence to recast a line,
which rule 10 does. Before assuming a translation defect is a prompt defect,
check whether the text reached the model at all.

### Why `albert → en` failed

Five modules carried their own copy of the same link regex, `\[[^\]]*\]\(…\)`. It
cannot cross an escaped bracket, and `albert.bio.md` uses this corpus's footnote
marker:

```
[\[ \* \]](#1) По вопросу о том, кто в действительности основал…
```

Neither the masker nor the skeleton guard saw that as a link. So:

1. the anchor `(#1)` was **sent to the model** — in the one mode whose premise is
   that a URL never reaches one;
2. the model simplified the label to `[\*](#1)`, which *is* a link by the same
   regex;
3. the rebuilt document therefore carried one structural token the source did
   not, the strict guard rejected it, and **no English edition of `albert` was
   ever published**.

The pattern now lives in `src/documents/markdown/inline.ts` and reads an escape
as one unit. The same recorded model answer that used to fail now rebuilds with
an identical skeleton, and `albert → en` is produced by every variant tested
since.

**Exposure:** 5 of the 50 articles in `input/ru` (`abreu`, `alais`, `albeniz`,
`albert`, `bach`) carry a link with an escaped label. Only `albert` actually
broke; the other four had their unmasked targets copied through correctly by
luck, and no URL was lost in the published output.

### The prompt A/B

Four segment-mode prompts over the same 14 articles, same model, translation
memory off so every variant really called the model. All metrics are model-free
facts about the source and its translation (`npm run score`):

| prompt | words | clean | source-script leak | dash drift | comma pulled into a quote | Latin titles kept |
|---|---:|---:|---:|---:|---:|---:|
| `segments-system.old.md` | 686 | 14/14 | 0 | 89 | 4 | 41/42 |
| `segments-system.md` (current) | 694 | 14/14 | 0 | 97 | 8 | 40/42 |
| first new draft | 739 | 13/14 | 0 | 35 | 8 | 36/42 |
| **final** | 853 | **14/14** | **0** | **35** | **2** | **42/42** |

The final prompt is the only one that keeps every released title, and it halves
the punctuation drift of the old prompt while cutting dash substitution by nearly
two thirds against the current one. It costs about 160 words more than the
current prompt — roughly 200 tokens per call, cached across the corpus after the
first — and every added rule closes a failure that was measured, not imagined.

The first draft is the instructive one: it scored *worse* than what it replaced,
for a single over-broad rule. See below.

### Names and titles — the rule that had to be got right

Four rules, in precedence order:

1. **A name or title the article already prints in another language *is* that
   name.**
2. **A personal or place name is rendered, never translated**, from the source
   spelling and never from the subject's nationality.
3. **A title that appears only in the source script is romanized and glossed
   once** — ordinary bibliographic practice (CMOS 11.9), and what the reader
   needs: the romanized form is what a search finds, the gloss is what a reader
   understands. It applies to an ensemble too, and not to a name that merely
   describes.
4. **The gloss never nests and never splits a link.**

`krylov`'s bilingual discography is the whole argument in one line:

| | `"Craft Of Emptiness" (Магия Пустоты. Музыкальная Медитация)` |
|---|---|
| source | released title + Russian gloss |
| old prompt | `"Craft Of Emptiness" (Musical Meditation)` — half the gloss lost |
| current prompt | `"Craft Of Emptiness"` — gloss dropped entirely |
| first new draft | `"Magiya Pustoty. Muzikal'naya Meditatsiya" (Magic of Emptiness…)` — **the released title destroyed** |
| final prompt | `"Craft Of Emptiness" (Magic of Emptiness. Musical Meditation)` — complete |

The first draft said only "a source-script title is romanized and glossed", which
is right for `"Загадки на святки"` and catastrophic for a record released as
*Craft Of Emptiness*. It rewrote eleven of `krylov`'s thirteen albums.

Rule 4 came from the same over-reach. Asked to gloss a title that was also a
link's label, the model answered

```
["Istoriya gitary v litsakh"] (History of the Guitar in Faces) (⟦1⟧)
```

— every character accounted for, the placeholder present, and the link
destroyed. That failure cost `agapov` its English edition in the first draft.
`displacedMasks` now catches it deterministically, so it costs one repaired
fragment instead of a whole document, and the final prompt produces

```
["Istoriya gitary v litsakh"](…/agapov.htm) (History of the Guitar in Faces)
```

The three cases `findings.md` named, under the final prompt:

| case | result |
|---|---|
| `"Консонанс"` (milovanova) | `the "Konsonans" (Consonance) chamber guitar orchestra` |
| `(кровотечения)` (presti) | `internal hemorrhage (bleeding)` — the source's own gloss survives |
| `"Загадки на святки"` (alferiev) | `"Zagadki na svyatki" (Riddles for the Yuletide)` |
| `«Золотые гитары мира»,` (abiton) | `"Zolotye gitary mira" (Golden Guitars of the World),` |

### The punctuation complaints, measured

`findings.md` examples (7) and (16) report a comma appearing *inside* a closing
quotation mark where the source has it outside. Counted across the whole
published corpus:

| | comma inside the closing quote | outside |
|---|---:|---:|
| `input/ru` (50 source articles) | **0** of 23 | 23 |
| `out/en` (25 published editions) | **19** of 61 | 42 |

The source is perfectly consistent — Russian never puts the comma inside `«»` —
and roughly a third of translated quotations move it in. It is the American
convention asserting itself, and it stops only when the prompt says which side
the mark belongs on rather than "use the target language's punctuation".

The same check reports **90 dash substitutions** in the published corpus (`–`
silently becoming `—`), which reflows every line of an interview and is invisible
to the structure guard.

### Several "stylistic regressions" are the sampler, not the prompt

`local-small` is the only declared target in `biomd.config.yaml` with **no
`params`** — no temperature, no seed — so it runs at whatever the server defaults
to, while every other target is pinned at `0.1`.

Running the *current* prompt twice over `albeniz` gives:

| | production `out/en` | fresh run, same prompt |
|---|---|---|
| teachers | "A pupil of A. Marmontel, L. Brasseur…" | "Student of A. Marmontel, L. Brassen…" |
| place | "Cambio-le-Ben" | "Cambo-les-Bains" |
| age | "his too-young age" | "his very young age" |

Those are exactly the differences `findings.md` examples (7.2), (8), (9) and (11)
attribute to the prompt change — and two of the three land on the *old*
generation's wording without any prompt edit at all. Comparing single samples
from a model sampling at default temperature reads causality into noise.

For the terminology complaints specifically (*magazine* vs *journal*), there is
already a mechanism and it needs no code: `tasks.translate.promptVariables.glossary`
is picked up by both translation user templates and rides in the cache-stable
half of the message. A commented example is now in the config.

---

## Part 3 — metadata

### Dual-calendar dates

`aleksandrov.bio.md` states both dates in both calendars:

```
род. 11(23).12.1818, ум. 24.12.1884 / 05.01.1885
```

Neither form parsed, so the entry published **no dates at all** while the old
generation had `11.12.1818` and `24.12.1884` — a fact lost to a punctuation
convention, which is exactly what "wide on input" exists to prevent. `parseDate`
now reduces a bracketed or slashed alternative to the form printed first:
reading, not guessing. A genuine range is still refused (a dash was already
rejected; a slash survives only when both sides are full dates within a fortnight
of each other).

### `Авель Карлеvaro`

`abiton`'s dossier published a name written half in Cyrillic and half in Latin —
a model transliterating Abel Carlevaro and stopping in the middle. It is always a
machine's slip, no source contains it, and it reaches the catalogue as a name no
reader can search for. `mixedScriptWords` now reports it per word (a *sentence*
mixing alphabets is ordinary here) rather than repairing it: which half is right
is not knowable from the dossier, and dropping the field would lose a teacher the
article really names. `biomd report --notes alphabets` lists them.

### Not every lost field was a loss

`findings.md` example (1) reports `abiton` losing `birthplace`, `genres` and
`url`. Two of those are worth looking at before restoring them:

- **`birthplace: "Париж, Франция"`** — the article never says where Abiton was
  born. It says he entered the *Paris* Conservatoire at sixteen. The old value
  was an inference from the wrong sentence; the new absence is correct.
- **`genres: "музыка начала XX века, современная музыка"`** — derived from
  "В репертуаре – сочинения композиторов начала XX века", a statement about
  repertoire rather than genre.

`url` is a genuine loss and returns with the search pool fixed. The overall count
(313 fields old, 294 new across 27 documents) overstates the regression: `url`,
`deathplace` and `birthplace` — the three most-lost fields — are exactly
`tasks.websearch.fields` plus `recordSources: url`. One broken pipeline, not a
worse extraction.

### A counterexample to "the old generation was better"

`biomd validate` on the two directories:

```
out/                       no index.json (the catalog task never completed here)
C:\work.ai\gestern\out     38 errors, 2 warnings
```

Every one of the 38 is `INV-25`: an `img` value like
`"/../pages/photo/a/abiton.jpg"`, which `VD-PATH-ASSET` does not allow — the
`tasks.portrait.assetPrefix` trap that `tasks.catalog.refresh` exists for. The
old output also has one `INV-18` warning: `en/authors.bio.json` is an English
edition still holding Cyrillic.

Neither generation is simply better. The old one has better prose in places and a
broken `img` on every row; the new one has correct paths and a working title
policy, and — until today — no `albert`, no poems and a half-dead search pool.

---

## What changed in the code

| File | Change |
|---|---|
| `src/documents/markdown/inline.ts` | **new** — the one definition of a link/image pattern, reading an escape as one unit. Five modules import it |
| `src/documents/markdown/fences.ts` | **new** — classifies a fenced block as code or verse |
| `src/documents/markdown/textSpans.ts` | holds a fence's lines until the block is read whole, then lifts verse one span per line; `displacedMasks` reports a placeholder that survived but stopped being a link |
| `src/documents/markdown/skeleton.ts`, `media.ts`, `title.ts` | use the shared pattern instead of local copies |
| `src/domain/values.ts` | `parseDate` reduces a dual-calendar date to the form printed first |
| `src/domain/validate.ts` | says "no index.json" instead of "root value is not an array" when the file is absent |
| `src/llm/OpenAiCompatibleClient.ts` | `response_format` is sent only to a target that declares the matching capability |
| `src/pipelines/websearch/gaps.ts` | `deathplace` is gated by the same liveness rule as `died` |
| `src/pipelines/websearch/WebSearchPipeline.ts` | `filterLiveness` drops `deathplace` alongside `died` |
| `src/pipelines/shared/script.ts` | `mixedScriptWords` — a word written in two alphabets |
| `src/pipelines/extraction/ExtractionPipeline.ts` | reports half-transliterated values in the run notes |
| `src/pipelines/translation/TranslationPipeline.ts` | passes `fencedBlocks` through; verifies masks are still link targets |
| `src/config/schema.ts` | `tasks.translate.fencedBlocks: auto \| code \| text` |
| `tools/score-translations.ts` | **new** — `npm run score`, the model-free regression suite |
| `prompts/translation/*` | the rewritten translation prompts; the counter moved out of the cache prefix |
| `prompts/localization/*` | name/transliteration precedence resolved; same counter fix |
| `biomd.config.yaml` | `omniroute.maxConcurrent: 1`; `or-osearch` and `or-search-quality` corrected and documented; websearch pool widened; `fencedBlocks`; a commented glossary example |

Tests: 18 files, 401 passing, including new cases for fenced verse, displaced
placeholders, dual-calendar dates and the death gate.

---

## Reproducing any of this

```bash
npm run biomd -- models --probe                  # which targets actually answer
npm run score -- input/ru out                    # the hard translation metrics
npm run biomd -- report --notes Sharpened        # every date the web made more precise
npm run biomd -- report --notes alphabets        # every half-transliterated value
npm run biomd -- validate out --strict           # the published catalogue against INV-1…28
```

`npm run score` is model-free: it compares a translated corpus against its source
and reports leftover source-script text, a changed Markdown skeleton, a lost link
target, dropped hard breaks, substituted dashes, punctuation pulled inside a
quotation mark, and Latin-script titles the translation replaced. Those are the
"hard metrics — should be near 100%" that `translation/IMPROVE_SUGGESTIONS.md`
asked for.

Two operational habits would have caught nearly all of this, and cost nothing:

- **`models --probe` before every corpus run.** It found the dead
  `or-search-quality` in one call. It would *not* have found the `or-osearch`
  failure, because a bare completion succeeds there and only a `json_object`
  request fails — an argument for probing with the response format each pool's
  task actually uses.
- **`biomd report --notes` after every run.** Every finding in Part 1 was
  already being reported. Nobody was reading it.
