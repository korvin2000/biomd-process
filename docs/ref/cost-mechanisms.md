# The eleven cost mechanisms

Read this before touching a prompt, a pipeline, or a context strategy. Each item is a place
where an innocuous edit silently multiplies the corpus bill or the wall-clock.

## 1. Cache-friendly message order — `src/prompts/MessageBuilder.ts`

Always `[stable system][stable instructions][volatile document]`. The document body (or the
`{hash: text}` table) is **never** a template variable; it is appended last so provider caches
hit across the whole corpus.

> Putting anything document-specific — a filename, a counter, a timestamp — into a template
> breaks this for every document that follows.

## 2. Escalating context strategies — `src/documents/context/strategies.ts`, walked by `runWithEscalation`

`full` → `truncation-first` → `chunked` → `staged`, cheapest first.

On every rung but the last, acceptance is checked **after** the call, so a rejection escalates the
*context* (the cheap axis). On the last rung there is no cheaper move, so acceptance runs **inside**
the gateway's `validate`, where rejection becomes an ordinary validation failure inheriting
retry-then-fall-back-to-a-stronger-**model**.

> Getting this order backwards means either retrying forever on rung one or never escalating
> context at all.

**A truncated rung is only cheap for a task that can tell when it has found its answer.** A
*harvest* — "answer every key this article supports" — cannot: an unanswered key looks identical
whether the article is silent or the sentence was never sent. Those pipelines declare
`coverage: 'whole'`, and `runWithEscalation` drops every partial attempt **at plan time**, so the
doomed call is never billed. `extract` (`tasks.extract.readWholeDocument`, default true) and
whole-document `translate` both do this; `websearch` has no document to slice.

## 3. Send prose, not documents

`extractTextSpans` and `StringTable` pull out only translatable text. Headings, list markers,
`:::` containers and their attributes, fenced code, URLs — and for dossiers `dates`/`ranking`/
`url`/media targets/unknown fields — never leave the machine.

What crosses the wire is a flat `{contentHash: text}` table (`tasks.translate.mode: segments`,
the default). The model must return exactly the same keys, so a dropped or invented key is caught
rather than written out. Repeated strings are translated once via `TranslationMemory`;
`tasks.*.useTranslationMemory: persistent` keeps that across runs in `run.memoryDir`, namespaced
by prompt version. Link targets inside a sentence are masked as `⟦1⟧` and checked for survival.
`tasks.translate.mode: document` still exists for when surrounding context matters more than cost.

**A fragment not in the source language is not sent at all** — `tasks.translate.foreignFragments:
keep`, `src/pipelines/shared/script.ts`. A Russian article quotes the rest of the world in its own
spelling (`Plays Domenico Scarlatti`, `Allegro vivo`, `'Amadeus' Guitar Duo`, `[MP3](⟦1⟧)`). Every
prompt says not to translate it, and an instruction is obeyed on *most* calls; a fragment with no
letter of the source script cannot be a sentence of the source language, so not sending it is both
cheaper and obeyed on **all** of them. On `input/ru` that is **11%** of fragments, every one a work
title, a composer or a link label. A **mixed** fragment is always sent — "Играл на гитаре Pedro
Maldonado" is Russian prose. The rule needs a source language with an alphabet of its own, so it
does nothing for a Latin-script corpus.

**A fenced block is not evidence of code** — `src/documents/markdown/fences.ts`. These articles set
poems and lyrics in bare ``` fences. An info string naming a language, tablature and ASCII rules
are code; lines of words are verse, and verse is lifted **one span per line**, so the poem's shape
is restored by the splice rather than asked of the model. `tasks.translate.fencedBlocks: code`
restores the old behaviour.

**One definition of a link** — `src/documents/markdown/inline.ts`. Five modules once carried their
own copy of `\[[^\]]*\]\(…\)`. The pattern lives in one file and reads an escape as one unit.

**A fragment can change the shape of the line it goes back on** — `structuralDrift`,
`escapeBlockMarker`. Structure the model *invented* (a heading, a quote, a `key:` prefix on prose)
is a mistake and is reported through the per-fragment `verify` hook, inheriting the repair ladder.
A **list marker is not a mistake**: `27 марта 2002 г.` → `27. März 2002` is correct and is also
`oli` at the start of a line. CommonMark settles it, so `escapeBlockMarker` takes the backslash at
splice time rather than asking.

**What the batch loses in context it gets back in two lines** — `tasks.translate.contextChars`,
default 300. The article's title and lead opening tell the model it is translating a biography of
a flamenco guitarist rather than a company report. It rides in the *volatile* half, so
mechanism 1 is untouched.

## 4. Repair the gap, not the batch — `callBatch` / `callNarrowing` in `src/pipelines/shared/stringBatch.ts`

One missing key used to reject the whole table and re-send all of it — two identical billed calls
for one dropped fragment. The first call now accepts a **partial** answer and only the
missing/malformed keys are re-asked; the **last** repair round is strict, so a surviving gap still
becomes a validation failure on a payload of the few keys that need it.
`tasks.*.repairAttempts: 0` restores all-or-nothing. A response unusable as a whole (no JSON, not
an object) skips the ladder. Fragments with no letters are never sent.

**A batch cut off by the output limit is narrowed, not escalated.** `output_truncated` is neither
a broken model nor a broken response: the payload was accepted and the answer had nowhere to go,
so retrying buys the identical cut and falling back to a wider model pays for what the caller can
fix for free — half a table needs half the output. The batch is halved and re-asked on the model
already chosen. A *single* fragment that still does not fit has no cheaper axis and propagates.

> Keep `tasks.*.max{Segments,Strings}PerCall` sized so the **answer** fits the smallest model in
> the pool. Narrowing is a correction; every oversized call is one cut-off answer paid for first.

## 5. Reasoning is a cost setting

`reasoning.dialect: none` (the default) sends no reasoning parameter and leaves the model alone.
**Any other dialect states the intent in both directions**, so `enabled: false` emits an explicit
"do not reason" — the only way to quiet a model that reasons unless told otherwise. `exclude`
hides traces but does not make them free. The run summary reports reasoning share of output tokens.

## 6. Ask for facts, not for a schema — `src/pipelines/extraction/FlatFields.ts`

Extraction sends a flat card of ~22 short keys plus `response_format: json_object`, and assembles
the dossier locally. The previous contract shipped the dossier's JSON Schema **twice** per call —
system prompt and `response_format` — for **≈2450 input tokens per document**, all of it about
nesting, `dates`, comma lists and forbidden members: information the model does not have.

Adding a field to the card costs one line. Adding it to `metadata` costs nothing, because
`buildDossier` owns the shape.

## 7. Parse what you can instead of asking for it

- the gallery comes out of the article's own `::: image` containers and tablature tables
  (`src/documents/markdown/media.ts`) — and the `target` is the path the article contains rather
  than one a model retyped;
- country names, demonyms and alpha-3 codes resolve to ISO 3166-1 alpha-2 locally
  (`src/domain/countries.ts`, via `Intl.DisplayNames`);
- crafts and genders map from any corpus language (`src/domain/vocabulary.ts`);
- a title saying `дуэт`, `квартет` or `Gitaartrio` settles both `gender: mixed` and how many faces
  the portrait matcher should expect;
- `"unknown"` / `"н/д"` / `"—"` are dropped rather than published.

Every one is a rule that would otherwise be stated in a prompt, obeyed by a model, and paid for on
every call.

## 8. The cheapest call is the one not made — three settings, all read at *plan* time

| Setting | Means |
|---|---|
| `output.onExisting: skip` | a promise the **writer** makes, so running the task changes nothing. `overwrite` and `fail` are untouched — one intends to replace, the other to stop loudly |
| `run.skipExistingOutputs: true` | the file is on disk |
| `tasks.extract.onExistingDossier: reuse` (default) | re-emit an **authored** `<slug>.bio.json` beside the article, normalized and migrated to v2, for **zero tokens**. `complete` asks only for the keys it lacks |

A task that declares `mergesOutput` is exempt from the first two: its file exists from the end of
run 1 and says nothing about whether *this* run's work is in it.

This tool's **own** previous output deliberately does not count as authored input
(`findSourceDossier`) — a task treating its own product as input would re-plan itself every run.
The dry-run cost preview knows the difference: `usesLlm: false` is declarable per **task**, not
only per pipeline.

## 9. Stop asking the document for what it does not contain

An article that never states a birthplace does not start stating one on the third context rung.
That is only true once the *first* rung carried the whole article (mechanism 2). `websearch` takes
over and asks a **different source**; its questions are computed from the dossier, so no gaps means
no call, no artifact, no cost. What it sends is an identity card of ~8 short lines plus, optionally,
the lead paragraph for telling namesakes apart — **never the article**.

## 10. A picture is data, not a generation problem

The portrait is chosen from `images/artists.json` by name matching, the index's own `ai` block, and
**the images the article itself embeds** — the article having already answered the question, for
nothing. No model, no vision call, and the `img` that lands in `index.json` points at a file that
exists.

## 11. A second opinion is cheaper than a second call

`data/names.json` already knows the family name behind a byline of initials, the pseudonym a reader
will type, and a collective's title. One JSON parse per run removes three classes of failure: an
extraction that produced no name (and would have been retried and escalated over it), an ensemble
with no display name in `index-<lang>.json`, and a portrait search with nothing but a slug.

---

## Measured numbers, for calibration

| Change | Effect |
|---|---|
| flat card vs. shipping the JSON Schema twice | ≈2450 input tokens saved **per document** |
| `least-busy` + lanes + `prefer`, 3 articles → English at `run.concurrency: 3` | **1m 43s → 34s**, same output, $0.00012 paid (2026-08-23) |
| `foreignFragments: keep` on `input/ru` | 11% of fragments never sent |
| stating the punctuation rule explicitly, 13 articles | dash substitutions 97 → 35 |
| `escapeBlockMarker` on one German document | 13 calls with 9 retries → 4 calls, no retries |
| `stream: true` on `omniroute`, 6-document translation | 2m29s serial → 49s, 0 retries |
| `reasoning: {enabled:false, dialect: reasoning_effort}`, 6 documents | 9.1k output tokens (4.2k reasoning) → 4.9k, none |
