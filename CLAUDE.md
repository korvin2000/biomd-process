# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`biomd-process` is a Node.js/TypeScript CLI that batch-processes `*.bio.md` Markdown biography documents through LLMs. Six pipelines ship with it and any combination can run in one job:

- **`extract`** — heuristic metadata extraction into a dossier JSON
- **`websearch`** — the facts the article does not contain, from a model with web search; also re-checks an undated death
- **`translate`** — structure-preserving translation into a configurable list of languages
- **`localize`** — the per-language *edition* of the dossier, language-invariant fields copied verbatim
- **`portrait`** — LLM-free selection of the entry's `img` out of an existing image index
- **`catalog`** — LLM-free aggregation of everything already on disk into `index.json` / `index-<lang>.json`

**Status: v0.3 — platform complete, domain implemented, sources beyond the article.** Orchestration, routing, reliability, cost control, resume and observability were done in v0.1 and are unchanged. v0.2 filled in the domain against the normative specification: the format lives in `src/domain` and nowhere else, and `biomd validate` checks the published output against its invariant list. v0.3 added the two sources of fact an article does not contain — an image index (`portrait`) and the web (`websearch`) — and lowered the date floor so a year-only date survives instead of being dropped. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making structural changes.

This repo is the **producer** half of a two-repo system: the catalogue website that renders this output is a separate application, not present here. [`external/`](external/README.md) is *that application's* normative specification — nine documents, format version 2 — vendored in because it defines the contract this tool's output must satisfy. **`external/` is the source of truth for every question about the data format**, with one deliberate, configured exception noted under *Partial dates* below. `docs/MetaData.md` and `docs/Catalog-Index.md` are its superseded predecessors, kept only for history.

`images/artists.json` is a second vendored input: an index of ~2000 photographs, described by [`images/image-index-spec.md`](images/image-index-spec.md), which `portrait` searches. It is read, never written.

## Commands

```bash
npm install
cp .env.example .env            # fill in endpoint URLs / API keys
npm run biomd -- config check   # validate biomd.config.yaml, load every prompt template
npm run biomd -- run --dry-run  # plan the job (docs, tasks, model chain, est. cost) — spends nothing
npm run biomd -- run            # execute
```

Dev loop:

```bash
npm run typecheck    # tsc --noEmit
npm test              # vitest run (all tests)
npm run test:watch    # vitest, watch mode
npm run build          # tsc -p tsconfig.build.json -> dist/
```

Single test file / single test:

```bash
npx vitest run tests/catalog.test.ts
npx vitest run tests/catalog.test.ts -t "keeps the id an entry already had"
```

There is no lint script or ESLint/Prettier config in this repo — `typecheck` + `test` are the whole gate.

In development the CLI (`src/cli/main.ts`, bin name `biomd`) always runs through `tsx` via `npm run biomd -- <args>`; the built `dist/cli/main.js` (after `npm run build`) is what `bin.biomd` in `package.json` points at.

Other CLI commands (all accept `-c/--config <file>`):

| Command | Purpose |
|---|---|
| `run [--dry-run\|-n] [--only extract,translate] [--lang en,de] [--limit n] [--concurrency n] [--strategy id] [--budget-usd n] [--max-requests n] [--resume auto\|off] [--resume-run <runId>] [--fail-fast] [--skip-existing] [-o/--out dir]` | Process the corpus (default command) |

`run` is the **default** command, so options must come *after* the subcommand: `biomd config check -c f.yaml`, never `biomd -c f.yaml config check`. The second form used to be parsed as `run` with two ignorable extra arguments and would quietly process the whole corpus; `run` now sets `allowExcessArguments(false)` so it is a hard error instead.
| `config check` (default) \| `config show [--json]` | Validate / print effective config, secrets redacted |
| `models [--pool name] [--tokens n]` | Resolved model targets, pools, routing preview |
| `prompts list` (default) \| `prompts show <task> [--messages]` | Inspect/render templates, no tokens spent |
| `report [runId] [--failed]` | Summarize a run from `.biomd/runs/<runId>/` |
| `portrait <who…> [--top n] [--min-identity n] [--all] [--json]` | Search the image index for one person and print the whole ranking with its reasoning. LLM-free. The way `tasks.portrait` thresholds get tuned |
| `validate [dir] [--strict] [--json] [--no-files]` | Check a published catalogue against `INV-1 … INV-28`. LLM-free; exits 1 on an error (`--strict`: on a warning too) |

## Architecture

Dependencies point strictly inward; nothing in an inner layer imports from an outer one:

```
cli → app (container.ts, composition root) → core (planner, orchestrator) ─┬→ pipelines (extract/websearch/translate/localize/portrait/catalog)
                                                                             ├→ io (source, writer, catalogue reader)
                                             ┌───────────────────────────────┴──────┐
                                  llm (gateway)  documents (segmentation)  images (photo index)  prompts (templates)  state (journal)
                                             │                                     domain (the format)
                                   routing + reliability
                                             │
                                  config → shared (errors, hash, fs)
```

`src/domain` is the one place that knows what a catalogue is: value domains, token vocabularies, the dossier and index documents, and the invariant list. It depends on nothing but `shared`, and everything above it consumes it rather than re-deriving a rule. A change to `external/` lands there and nowhere else.

`src/images` is the mirror of that for the **input** side: it knows what an image index is (`images/image-index-spec.md`) and how to pick a portrait out of one. It depends on `domain` (for romanization and asset paths) and `shared`, and on nothing else — no config, no filesystem beyond one JSON read, no LLM. A change to the image format lands there.

`src/app/container.ts` (`createApp`) is the single place that wires concrete implementations together. Every module takes its collaborators as constructor arguments and constructs none of them itself — that's what makes `createApp(loaded, { configure: app => … })` a real extension point and every piece independently unit-testable.

### Data model and scheduling

```
WorkItem (= one discovered *.bio.md, id = slug+lang)
  → PlannedTask per (pipeline, variant)   -- e.g. translate×en, translate×de, localize×en depends on extract
    → TaskResult { artifacts[], usage, cost, notes[] }  →  ArtifactWriter → file on disk
```

- Pipelines (`src/core/types.ts`: `DocumentPipeline` | `CorpusPipeline`) **return** artifacts, they never write files — that's what makes `--dry-run` free and pipelines pure enough to unit test without touching disk.
- A pipeline declares prerequisites structurally (`TaskDependency { pipeline, variant?, scope: 'item'|'all' }`); `JobPlanner` resolves them to task ids and `Orchestrator` runs the plan in **dependency waves** (p-queue), not a general DAG — pipelines are at most 2-3 stages deep, and a wave boundary is exactly the guarantee `catalog` needs (everything it indexes has already landed). A dependency that matches nothing is dropped, not failed. A task whose prerequisite failed is retired `dependency-failed`, never run or billed.
- Two ids per task (`src/state/Fingerprint.ts`): **`taskId`** = `hash(pipeline, workItemId, variant)`, a stable identity across runs; **`fingerprint`** = `hash(taskId, sourceContentHash, promptVersion, contract)` — deliberately excludes the model/routing strategy, so adding a fallback model never invalidates the whole corpus. Resume compares fingerprints against `.biomd/runs/<id>/state.json`.

### LLM call path

```
Pipeline → runWithEscalation() [src/pipelines/shared/escalation.ts]
  → LlmGateway.complete(request, policy)
      Budget.check() → Router.select() [ordered ModelTarget[]] → for target in candidates:
        CircuitBreaker.guard → RateLimiter.acquire → RetryPolicy.run(withTimeout(client.chat))
          → ErrorClassifier [src/reliability/errors.ts: LlmErrorKind] → retryable? / fallbackable? / fatal?
```

Retry (same target) and fallback (next target) are separate axes driven entirely by the `LlmErrorKind → Disposition` table in `src/reliability/errors.ts` — extend that table rather than matching provider message strings at a call site. `context_length` is reported back as a typed signal so the pipeline can escalate its *context strategy* instead of just failing.

One transport (`src/llm/OpenAiCompatibleClient.ts`) covers every OpenAI-compatible endpoint (LiteLLM, OmniRoute, 9router, vLLM, Ollama's shim, OpenRouter, OpenAI) via `baseUrl` plus per-endpoint `headers`/`query`. Reasoning is emitted in whichever dialect a model declares (`reasoning_effort` | `reasoning` | `thinking` | `none` — `reasoningDialectSchema` in `src/config/schema.ts`).

### Routing

`RoutingStrategy.select(ctx): ModelTarget[]` ranks a pool and never calls anything (`src/routing/strategies/builtin.ts`: `cost-optimized`, `context-optimized`, `sequential`, `round-robin`, `least-failures`). Pools (`llm.routing.pools` in config) let `extract` and `translate` route to different model sets — cheap models for extraction, a strong one for translation. Custom strategies register via `app.strategies.register(defineStrategy(id, description, select))`.

### The cost-optimization mechanisms (read before touching prompts or pipelines)

1. **Cache-friendly message order.** `MessageBuilder` (`src/prompts/MessageBuilder.ts`) always emits `[stable system][stable instructions][volatile document]`, in that order. The document body (or the `{hash: text}` table) is *never* a template variable — it's appended last so provider prompt-caches hit across the whole corpus. Putting anything document-specific (a filename, a counter, a timestamp) into a template silently breaks this for every document that follows.
2. **Escalating context strategies** (`src/documents/context/strategies.ts`, walked by `runWithEscalation` in `src/pipelines/shared/escalation.ts`): `full` | `truncation-first` | `chunked` | `staged`, cheapest attempt first. On every rung but the last, acceptance is checked *after* the call, so a rejection escalates the **context** (the cheap axis). On the last rung there's no cheaper move left, so acceptance runs *inside* the gateway's `validate`, where rejection becomes an ordinary validation failure that inherits retry-then-fallback-to-a-stronger-**model**. Getting this ordering backwards means either retrying forever on rung one or never escalating context at all.
3. **Send prose, not documents.** `extractTextSpans` (`src/documents/markdown/textSpans.ts`) and the dossier-side equivalent in `src/pipelines/localization/StringTable.ts` pull out only translatable text; headings, list markers, `:::` containers and their attributes, fenced code, URLs, and — for dossiers — `dates`/`ranking`/`url`/media targets/unknown fields never leave the machine. What crosses the wire is a flat `{contentHash: text}` table (`tasks.translate.mode: segments`, the default); the model must return exactly the same keys, so a dropped or invented key is caught rather than silently written out. Repeated strings are translated once via `TranslationMemory`; `tasks.*.useTranslationMemory: persistent` keeps that cache across runs in `run.memoryDir`, namespaced by prompt version so a prompt edit starts a fresh one. Link targets inside a sentence are masked as `⟦1⟧` and checked for survival before acceptance. Whole-document mode (`tasks.translate.mode: document`) still exists for when maximum surrounding context matters more than cost.
4. **Repair the gap, not the batch** (`callBatch` in `src/pipelines/shared/stringBatch.ts`). One missing key used to reject the whole `{hash: text}` table and re-send all of it — two identical billed calls for one dropped fragment. The first call now accepts a *partial* answer and only the missing/malformed keys are re-asked; the **last** repair round is strict, so a surviving gap still becomes a validation failure with the usual retry-then-stronger-model treatment, on a payload of the few keys that need it. `tasks.*.repairAttempts: 0` restores all-or-nothing. A response that is unusable as a whole (no JSON, not an object) skips the ladder — re-asking per key cannot repair it. Fragments with no letters are never sent at all.
5. **Reasoning is a cost setting.** `reasoning.dialect: none` (the default) sends no reasoning parameter and leaves the model's own behaviour alone; **any other dialect states the intent in both directions**, so `enabled: false` emits an explicit "do not reason" — the only way to quiet a model that reasons unless told otherwise. `exclude` hides traces but does not make them free. The run summary reports the reasoning share of output tokens.
6. **Ask for facts, not for a schema** (`src/pipelines/extraction/FlatFields.ts`). Extraction sends a flat card of ~22 short keys and `response_format: json_object`, and assembles the dossier locally. The previous contract shipped the dossier's JSON Schema twice per call — once in the system prompt, once in `response_format` — for **≈2450 input tokens per document** that told the model about nesting, `dates`, comma lists and forbidden members, none of which is information the model has. Adding a field to the card costs one line; adding it to `metadata` costs nothing at all, because `buildDossier` owns the shape.
7. **Parse what you can instead of asking for it.** The gallery comes out of the article's own `::: image` containers and tablature tables (`src/documents/markdown/media.ts`) — no tokens, and the `target` is the path the article contains rather than one a model retyped. Country names, demonyms and alpha-3 codes resolve to ISO 3166-1 alpha-2 locally (`src/domain/countries.ts`, via `Intl.DisplayNames`); crafts and genders map from any of the corpus languages (`src/domain/vocabulary.ts`); `"unknown"` / `"н/д"` / `"—"` are dropped rather than published. Every one of these is a rule that would otherwise have to be stated in the prompt, obeyed by a model, and paid for on every call.
8. **The cheapest call is the one not made.** `tasks.extract.onExistingDossier: reuse` (the default) re-emits an existing `<slug>.bio.json` — normalized and migrated to version 2 — for **zero tokens**; `complete` asks only for the keys it lacks. The dry-run cost preview knows the difference: a task can declare `usesLlm: false` per-task, not just per-pipeline.
9. **Stop asking the document for what it does not contain.** An article that never states a birthplace does not start stating one on the third context rung — `truncation-first` → `full` → `chunked` over 40 000 characters buys the same silence three times. `websearch` takes over at that point and asks a *different source*, and its questions are computed from the dossier: no gaps means no call, no artifact, no cost. What it sends is an identity card of eight short lines (plus, optionally, the lead paragraph for telling namesakes apart) — never the article.
10. **A picture is data, not a generation problem.** The portrait is chosen from `images/artists.json` by name matching and the index's own `ai` block. No model, no vision call, and the `img` that lands in `index.json` points at a file that exists.

### State, resume, observability

Every run writes `.biomd/runs/<runId>/`: `run.json` (manifest), `events.jsonl` (append-only — every request/retry/fallback/error/artifact write), `state.json` (checkpoint, fingerprint → status). `--resume`/`--resume-run` replays the checkpoint and skips completed fingerprints; `biomd report [runId]` reads the manifest + checkpoint back afterwards. `.biomd/`, `out/` and `dist/` are all git-ignored.

## Configuration

One YAML file (`biomd.config.yaml`), Zod-validated (`src/config/schema.ts`), layered `defaults < file < ${ENV} < CLI flags` (`src/config/loader.ts`, `merge.ts`). Invalid config fails before any work starts, with the offending path named. Secrets are `${VAR}` / `${VAR:-fallback}` references resolved from `.env`, redacted on any serialization (`redactConfig`, used by `config show` and the journal). Three ready-made configs live in `config/examples/` (`local-only`, `openrouter-only`, `hybrid`) — the hybrid pattern (free local model first in every pool, paid models behind it as fallback) is the one worth reusing as-is.

The root `catalogue:` section is **not** task settings: it describes the *format's* deployment (`supportedLanguages`, `datePrecision`, `defaultType`, `defaultPageType`, `allowUnknownTypes`), and `extract`, `websearch`, `localize`, `catalog` and `validate` all read it, so it lives once at the root rather than five times.

## Prompts

`prompts/<task>/{system.md,user.md}` (Eta templates — see [prompts/README.md](prompts/README.md)), mapped by `prompts.templates` in config so a directory can be renamed without touching code. Both files hash into `promptVersion`, which feeds the task fingerprint, so editing a template is a tracked change that correctly invalidates already-completed work. `translateSegments`/`localize` templates answer a `{hash: text}` table and must return exactly the same keys; instructions that invite merging, splitting or reordering fragments will surface as validation failures and retries.

## The domain layer — `src/domain`

**Every rule of the published format lives here and nowhere else.** A change to `external/` has exactly one landing site; `core`, `routing`, `reliability` and `state` stay ignorant of guitarists. Adding a rule anywhere else is the mistake this directory exists to prevent.

| Module | Owns |
|---|---|
| `types.ts` | `EntryRow`, `NameIndex`, `Dossier`, the member orders, the forbidden-member list |
| `values.ts` | `VD-*` domains: `normalizeDate` (+ `parseDate`, `datePrecisionOf`, `refinesDate`, `yearOf`), `normalizeCsvList`, `normalizeRanking`, `normalizeUrl`, `normalizeTarget`, `slugOf`, `normalizeId`, content/asset paths |
| `romanize.ts` | folding (`Andrés` → `Andres`) and Cyrillic transliteration; used by the name index *and* by image matching |
| `countries.ts` | 249 alpha-2 codes; `resolveCountry` accepts a code, an alpha-3, a name in any of ten languages (via `Intl.DisplayNames`), or a demonym |
| `vocabulary.ts` | `resolveEntryType` / `resolveGender` / `resolveDocumentType` / `resolveLanguage` — multilingual synonyms → the canonical token |
| `dossier.ts` | `sanitizeDossier` (v1→v2 migration included), `mergeDossier` (fill gaps, never overwrite), `orderDossier` |
| `catalog.ts` | `CatalogIndex` — load, upsert, allocate ids — and `mergeNameIndex` |
| `validate.ts` | `INV-1 … INV-28` as a pure function over a snapshot of the files |

Two invariants of the code itself:

- **Narrow on output, wide on input.** Each normalizer emits exactly the canonical authored form and accepts every plausible spelling of it. Rewriting `1893-02-21` is free; re-asking for it costs a round trip and usually returns `1893-02-21` again.
- **Drop, never guess.** `external/07` §7.2 rule 5: an absent field is correct, an invented one is a claim about a person. Every dossier field is optional, so dropping degrades gracefully.

Two behaviours that follow, and that are easy to break by accident:

**Partial dates — the one place this deployment overrides `external/`.** The specification says a date not known to the day is not representable and must be omitted (`external/02`, `external/05` §5.11). That loses a real fact every time an article says only "born in 1885", so `catalogue.datePrecision` lowers the floor and the canonical form is published **truncated from the left**: `21.02.1893` → `02.1893` → `1893`. Setting it back to `day` restores the specification exactly.

The trade-off is stated once, in the config: VD-DATE requires a consumer to treat anything outside `\d{1,2}\.\d{1,2}\.\d{4}` as **absent**, so a strict reader ignores `"1893"` and behaves as if the field had been dropped — nothing breaks, and a reader that wants the year can have it. `biomd validate` accepts whatever the setting allows and raises no per-value warning: the setting *is* the statement of intent, and warning on every deliberate value would make `--strict` unusable. The calendar is still checked — a producer that writes `31.02.1900` has published a date that does not exist — and `mergeDossier` performs the one overwrite in the codebase: a sharper reading of the *same* date (`1893` → `21.02.1893`) replaces the blunter one, because those are one fact known to two depths rather than two competing facts.

**Classification never touches the dossier.** `type`/`gender`/`country`/`img`/`title` belong to `index.json` and are errors inside a `*.bio.json` (`INV-7`), but they are only derivable from the article — which `extract` has open anyway — from a v1 document being migrated, from a web search, or (for `img`) from the image index. Every path routes them to a hint channel under `out/.hints/`, where `catalog` picks them up while staying `usesLlm = false`. Precedence is strict and one-directional: **existing index row → `extract` hint (the article, or an authored v1 dossier) → `websearch` hint → `portrait` hint (`img` only) → `catalogue.defaultType`**.

**The catalogue is updated, never rebuilt.** `CatalogIndex.load` reads the existing `index.json` and `upsert` edits it: row order, unknown members, hand-edited classification and — above all — every `id` survive, as do rows this run never visited. `mergeNameIndex` does the same for `index-<lang>.json`, keeping a hand-authored `[0]` and appending only new aliases. Regenerating either from scratch would silently detach localized names from their entries, which is why `tasks.catalog.merge: false` exists but should not be used.

## The image layer — `src/images`

**Every rule of the image index lives here**, the way `src/domain` owns the published format. `PortraitPipeline` is only wiring: it assembles what is known about the person and writes the answer to a hint file.

| Module | Owns |
|---|---|
| `types.ts` | the index format (`image-index-spec.md`), and the normalized `ImageRecord` |
| `ImageIndexStore.ts` | one cached load per path, the inverted maps, the junk guard on `meta` |
| `tokens.ts` | path → name tokens, markers, initials, the noise lexicon, the phonetic key |
| `similarity.ts` | bounded OSA edit distance and the length-dependent fuzzy threshold |
| `query.ts` | slug + dossier + Latin title → `NameQuery` (both scripts, concatenations, context words) |
| `identity.ts` | *is this the right person* — one weight table, `IDENTITY`, and machine-readable reasons |
| `suitability.ts` | *is this picture usable* — tiers, the §15 hybrid score, hard exclusions |
| `select.ts` | the staged pipeline and the §14 lexicographic key |

What the real index actually contains, and why the code looks the way it does — the specification's own weight table assumes the opposite:

- `meta.people`, `meta.title` and `ocr` are **empty in every record**; `meta.description` holds an XMP dump and `meta.keywords` EXIF rationals. Hence the junk guard, and hence identity resting on the path.
- `photo/<letter>/` is the initial of the subject the file is **filed under**. `photo/b/buek_segovia.jpg` is Buek's photograph — an excellent picture of Segovia and a wrong avatar for him. That single signal is worth −0.30.
- A directory can be a person (`almeida_laurindo/4lalm07.jpg`, no usable filename tokens) *or* a discography (`paco_de_lucia/siroco.jpg`), so a directory match scores below a filename match and an unexplained proper noun in the filename is penalized.
- `pena_cd05_1993.jpg` is a record sleeve that classifies as `portrait`, one face, high confidence. Release markers are excluded by default; note that `\b` never fires before `_cd` because `_` is a word character.
- `nameTokensRu` is a list of *alternative spellings* (`сеговия|сеговиа|зеговия`), not additional people — only Latin filename tokens can name a second subject.
- `ai.confidence` is low across the board (median 0.54 for `portrait`) and images are small (median 0.04 MP), so confidence modulates trust in the class rather than gating, and the resolution term is log-scaled and bounded.

Three rules that must survive any edit:

- **Identity first, always** (§16). Picture quality never compensates for a weak name match; the acceptance threshold is applied to the identity score alone.
- **The key is lexicographic, not a weighted sum** (§14), with identity banded to 0.1 and `faceCoverage` ahead of the hybrid score — otherwise colour and megapixels quietly outvote "you can actually see the subject's face".
- **Below the threshold, write nothing.** `external/03` §3.4.9 already specifies the fallback (`photos/default-male.svg` etc. by gender), and those synthetic assets are deliberately kept out of the gallery, which a value written into `img` would not be. `onLowConfidence: default` exists for a deployment that disagrees.

Not attempted, deliberately: telling two people with the same name apart. `photo/w/john_williams/` cannot be resolved by filename analysis, and a heuristic that guessed would be wrong silently. The answer there is a curated `img` in `index.json`, which this pipeline never overwrites.

## The `websearch` task

Runs after `extract`, before `localize`/`portrait`/`catalog`, and **rewrites the dossier in place** (`overwrite: true` on the `metadata` channel). Everything about it is conditional:

- `src/pipelines/websearch/gaps.ts` computes the questions from the dossier. No gaps → no call, no artifact, zero cost. `country` is checked against the `catalogHints` file, since it is not a dossier member at all.
- The **liveness rule**: born ≥ `livenessAgeYears` ago (78 by default, and a year-only birth date is enough) with no `died` turns the absence into a question. The answer contract is `status: alive | dead | unknown` — a date of death is written **only** when the answer explicitly says `dead`. Silence is not evidence of death; `filterLiveness` drops a date that arrives without the status.
- `src/pipelines/websearch/answer.ts` refuses far more than it accepts: every value goes through the same domain normalizer as an extraction, a source URL is required (`requireSource`), confidence is a floor, and a "refinement" that contradicts what is on record is rejected rather than merged.
- The article is never sent. The wire carries an identity card of ~8 short lines — name, known dates, instruments, jobs — plus, optionally, the article's lead paragraph capped at `contextChars`, which exists solely to tell namesakes apart.
- Routing requires the `web_search` capability by default. A model without search answers these questions anyway, fluently and without a source; that is the failure mode the capability gate exists to prevent.

## Conventions worth knowing before editing

- ESM + `NodeNext` + `verbatimModuleSyntax`: relative imports in `.ts` files need an explicit `.js` extension (e.g. `from '../config/loader.js'`), and type-only imports use `import type`. The compiler enforces this; it isn't a style choice.
- `strict: true` plus `noUncheckedIndexedAccess: true` — array/index access types as `T | undefined`; don't assume otherwise.
- Tests build an isolated on-disk project per test via `Workspace` (`tests/helpers/workspace.ts` — temp dir + `createApp`) and a scripted transport via `FakeClient`. Extraction, string batches and web search all ask for `json_object`, so they are told apart by what the request carries: a ```json fenced block is a `{key: text}` batch (echoed back — an identity translation), a ```markdown one is an article (answered with `DEFAULT_FACTS`, the flat card), a ```yaml one is a web-search identity card, anything else is a whole-document translation. Use these rather than hitting a real endpoint.
- Design history and rationale — why fingerprints exclude the model, why waves instead of a general DAG, measured token-savings numbers, which open questions were resolved and how — lives in `docs/PROGRESS_AND_TODO.md`, a running dev log, not `git log` (this repo currently has a single squashed "Initial commit").

## Docs map

| File | Covers |
|---|---|
| **[external/README.md](external/README.md)** | **Normative.** The catalogue data format, version 2, in nine documents. Start here for any data-format question |
| [images/image-index-spec.md](images/image-index-spec.md) | The image index format and its recommended selection pipeline — what `src/images` implements, and departs from where the data required it |
| [external/02-value-domains.md](external/02-value-domains.md) | Every `VD-*` value domain — the source `src/domain/values.ts` implements |
| [external/07-authoring-and-validation.md](external/07-authoring-and-validation.md) | `INV-1 … INV-28`, the list `biomd validate` checks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full layering, extension points, non-goals — the source this file summarizes |
| [docs/PROGRESS_AND_TODO.md](docs/PROGRESS_AND_TODO.md) | Dev log: original spec, defaults chosen and why, what shipped when (RU/EN) |
| ~~docs/MetaData.md~~, ~~docs/Catalog-Index.md~~ | **Superseded** by `external/`. Kept for history; do not implement against them |
| [prompts/README.md](prompts/README.md) | Template conventions, Eta whitespace and ASI traps, variables per task |
