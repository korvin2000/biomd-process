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

**Status: v0.5 — platform complete, domain implemented, sources beyond the article, no document left behind, and the corpus is not only soloists.** Orchestration, routing, reliability, cost control, resume and observability were done in v0.1 and are largely unchanged; v0.4 closed the three ways a single document could still be lost — a routing decision that only looked at the context window, a pool with nothing to fall back to, and a corpus-scope dependency that let one failure retire the whole catalogue. v0.2 filled in the domain against the normative specification: the format lives in `src/domain` and nowhere else, and `biomd validate` checks the published output against its invariant list. v0.3 added the two sources of fact an article does not contain — an image index (`portrait`) and the web (`websearch`) — and lowered the date floor so a year-only date survives instead of being dropped. v0.4 made a failure local: it can cost the entry the field, the edition or the row it belongs to, never the catalogue. v0.5 addressed what a corpus of a thousand real articles turned out to contain that four sample biographies did not — **collectives** (a duo's portrait has two faces in it, a trio has no date of birth, and `gender: mixed` is what the format calls one), **a second name source** (`data/names.json`, the site's own extracted name list), and **quoted foreign text**, which a Russian article is full of and which must survive translation unchanged. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making structural changes.

This repo is the **producer** half of a two-repo system: the catalogue website that renders this output is a separate application, not present here. [`external/`](external/README.md) is *that application's* normative specification — nine documents, format version 2 — vendored in because it defines the contract this tool's output must satisfy. **`external/` is the source of truth for every question about the data format**, with one deliberate, configured exception noted under *Partial dates* below. `docs/MetaData.md` and `docs/Catalog-Index.md` are its superseded predecessors, kept only for history.

`images/artists.json` is a second vendored input: an index of ~2000 photographs, described by [`images/image-index-spec.md`](images/image-index-spec.md), which `portrait` searches. It is read, never written.

`data/names.json` is a third: the **name roster**, an extracted index of the site's own name list — article file → full name, family name, given name, patronymic, alternative spellings. `extract`, `portrait` and `catalog` all read it, and all three treat it as a second opinion rather than as authority (see *The roster* below). Also read, never written.

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
| `run [--dry-run\|-n] [--only extract,translate] [--lang en,de] [--limit n] [--concurrency n] [--strategy id] [--budget-usd n] [--max-requests n] [--resume auto\|off] [--resume-run <runId>] [--fail-fast] [--skip-existing\|--no-skip-existing] [-o/--out dir]` | Process the corpus (default command) |

`run` is the **default** command, so options must come *after* the subcommand: `biomd config check -c f.yaml`, never `biomd -c f.yaml config check`. The second form used to be parsed as `run` with two ignorable extra arguments and would quietly process the whole corpus; `run` now sets `allowExcessArguments(false)` so it is a hard error instead.
| `config check` (default) \| `config show [--json]` | Validate / print effective config, secrets redacted |
| `models [--pool name] [--tokens n] [--probe]` | Resolved model targets, pools, routing preview. **`--probe` sends one tiny completion to every target and reports who answered** — the only check that tells a declared model from a working one, and the one that catches a dead first-choice before a run silently spends the whole corpus on its paid fallback. Exits 1 if any target fails |
| `prompts list` (default) \| `prompts show <task> [--messages]` | Inspect/render templates, no tokens spent |
| `report [runId] [--failed] [--notes [regex]]` | Summarize a run from `.biomd/runs/<runId>/`. `--notes` replays what the pipelines reported — a refused web answer, a date conflict recorded rather than published, an edition not declared — which is the only account of a decision that produced no file |
| `portrait <who…> [--top n] [--min-identity n] [--all] [--json]` | Search the image index for one person and print the whole ranking with its reasoning. LLM-free. The way `tasks.portrait` thresholds get tuned |
| `validate [dir] [--strict] [--json] [--no-files]` | Check a published catalogue against `INV-1 … INV-28`. LLM-free; exits 1 on an error (`--strict`: on a warning too) |

## Architecture

Dependencies point strictly inward; nothing in an inner layer imports from an outer one:

```
cli → app (container.ts, composition root) → core (planner, orchestrator) ─┬→ pipelines (extract/websearch/translate/localize/portrait/catalog)
                                                                             ├→ io (source, writer, catalogue reader)
                                             ┌───────────────────────────────┴──────┐
                                  llm (gateway)  documents (segmentation)  images (photo index)  roster (name index)  prompts (templates)  state (journal)
                                             │                                     domain (the format)
                                   routing + reliability
                                             │
                                  config → shared (errors, hash, fs)
```

`src/domain` is the one place that knows what a catalogue is: value domains, token vocabularies, the dossier and index documents, and the invariant list. It depends on nothing but `shared`, and everything above it consumes it rather than re-deriving a rule. A change to `external/` lands there and nowhere else.

`src/images` is the mirror of that for the **input** side: it knows what an image index is (`images/image-index-spec.md`) and how to pick a portrait out of one. It depends on `domain` (for romanization, asset paths and the collective vocabulary) and `shared`, and on nothing else — no config, no filesystem beyond one JSON read, no LLM. A change to the image format lands there.

`src/roster` is the same arrangement for the second input: it knows what the name roster is and nothing about what anyone does with it.

`src/app/container.ts` (`createApp`) is the single place that wires concrete implementations together. Every module takes its collaborators as constructor arguments and constructs none of them itself — that's what makes `createApp(loaded, { configure: app => … })` a real extension point and every piece independently unit-testable.

### Data model and scheduling

```
WorkItem (= one discovered *.bio.md, id = slug+lang)
  → PlannedTask per (pipeline, variant)   -- e.g. translate×en, translate×de, localize×en depends on extract
    → TaskResult { artifacts[], usage, cost, notes[] }  →  ArtifactWriter → file on disk
```

- Pipelines (`src/core/types.ts`: `DocumentPipeline` | `CorpusPipeline`) **return** artifacts, they never write files — that's what makes `--dry-run` free and pipelines pure enough to unit test without touching disk.
- A pipeline declares prerequisites structurally (`TaskDependency { pipeline, variant?, scope: 'item'|'all', optional? }`); `JobPlanner` resolves them to task ids and `Orchestrator` runs the plan in **dependency waves** (p-queue), not a general DAG — pipelines are at most 2-3 stages deep, and a wave boundary is exactly the guarantee `catalog` needs (everything it indexes has already landed). A dependency that matches nothing is dropped, not failed. A task whose prerequisite failed is retired `dependency-failed`, never run or billed.
- **`optional: true` separates the ordering barrier from the prerequisite**, and the distinction is load-bearing for an aggregation. A corpus-scope dependency resolves to *every* task of that pipeline, so under the old all-or-nothing rule one document failing one translation retired `catalog` and no `index.json` was written **for the entire corpus** — two hundred good entries losing their rows to a neighbour's bad luck. `catalog`'s five dependencies are therefore ordering only: it reads the disk rather than the plan, and a language whose translation failed is simply absent from that entry's editions. `websearch` is optional to `localize` and `portrait` for the same reason — it only ever *adds* to a dossier `extract` already wrote. Mark a dependency optional only where the dependent genuinely degrades; one that would silently publish a worse answer should stay required and be retired instead. `PlannedTask` carries both lists (`dependencies` gates the wave, `requiredDependencies` gates retirement), and a wave opens on dependencies being **settled** — completed *or* failed — not on their succeeding.
- Two ids per task (`src/state/Fingerprint.ts`): **`taskId`** = `hash(pipeline, workItemId, variant)`, a stable identity across runs; **`fingerprint`** = `hash(taskId, sourceContentHash, promptVersion, contract)` — deliberately excludes the model/routing strategy, so adding a fallback model never invalidates the whole corpus. Resume compares fingerprints against `.biomd/runs/<id>/state.json`.

### LLM call path

```
Pipeline → runWithEscalation() [src/pipelines/shared/escalation.ts]
  → LlmGateway.complete(request, policy)
      Budget.check() → Router.select() [ordered ModelTarget[]] → for target in candidates:
        CircuitBreaker.guard → RateLimiter.acquire → RetryPolicy.run(withTimeout(client.chat))
          → ErrorClassifier [src/reliability/errors.ts: LlmErrorKind] → retryable? / fallbackable? / fatal?
```

Retry (same target) and fallback (next target) are separate axes driven entirely by the `LlmErrorKind → Disposition` table in `src/reliability/errors.ts` — extend that table rather than matching provider message strings at a call site. `context_length` is reported back as a typed signal so the pipeline can escalate its *context strategy* instead of just failing, and `output_truncated` — the answer hit the model's own `maxOutputTokens` — is the one kind that is **fallbackable but not retryable**: the payload was accepted and the model ran out of room, so re-asking it buys the identical cut. Only a wider target, or a smaller request, changes anything; `isOutputTruncated` lets a caller that can shrink its request do so (see mechanism 4).

One transport (`src/llm/OpenAiCompatibleClient.ts`) covers every OpenAI-compatible endpoint (LiteLLM, OmniRoute, 9router, vLLM, Ollama's shim, OpenRouter, OpenAI) via `baseUrl` plus per-endpoint `headers`/`query`. Reasoning is emitted in whichever dialect a model declares (`reasoning_effort` | `reasoning` | `thinking` | `none` — `reasoningDialectSchema` in `src/config/schema.ts`).

### Routing

`RoutingStrategy.select(ctx): ModelTarget[]` ranks a pool and never calls anything (`src/routing/strategies/builtin.ts`: `cost-optimized`, `context-optimized`, `sequential`, `round-robin`, `least-failures`). Pools (`llm.routing.pools` in config) let `extract` and `translate` route to different model sets — cheap models for extraction, a strong one for translation. Custom strategies register via `app.strategies.register(defineStrategy(id, description, select))`.

**A pool is the fallback chain, and a pool of one has none.** Everything the reliability layer does — retry, fallback, circuit breaking — runs out at the end of the ranked list, so a single-model pool turns every transient failure into a failed document (`All 1 model target(s) failed`). The hybrid pattern in `config/examples/` exists for this: the free local model first, paid models behind it, and `cost-optimized` keeping the local one first for everything it can actually serve.

**Fit is two windows, not one** (`Router.buildContext`). A target must both *hold* the prompt and *emit* the expected answer, and only the first used to be checked — so a 64K window with an 8K output ceiling accepted a long article without complaint and cut its translation off mid-sentence. `RoutingContext.fits` now requires `outputHeadroom ≥ 0` as well, and `llm.routing.onOverflow` decides what to do about a target that fails either test: `demote` (the default) ranks it last but still calls it if nothing else is left, `skip` drops it from the chain so the doomed call is never made. Neither ever routes nowhere — when no target fits, the least-overloaded one is still tried, because a real provider error names a mis-sized pool better than silence does.

### The cost-optimization mechanisms (read before touching prompts or pipelines)

1. **Cache-friendly message order.** `MessageBuilder` (`src/prompts/MessageBuilder.ts`) always emits `[stable system][stable instructions][volatile document]`, in that order. The document body (or the `{hash: text}` table) is *never* a template variable — it's appended last so provider prompt-caches hit across the whole corpus. Putting anything document-specific (a filename, a counter, a timestamp) into a template silently breaks this for every document that follows.
2. **Escalating context strategies** (`src/documents/context/strategies.ts`, walked by `runWithEscalation` in `src/pipelines/shared/escalation.ts`): `full` | `truncation-first` | `chunked` | `staged`, cheapest attempt first. On every rung but the last, acceptance is checked *after* the call, so a rejection escalates the **context** (the cheap axis). On the last rung there's no cheaper move left, so acceptance runs *inside* the gateway's `validate`, where rejection becomes an ordinary validation failure that inherits retry-then-fallback-to-a-stronger-**model**. Getting this ordering backwards means either retrying forever on rung one or never escalating context at all.

   **A truncated rung is only cheap for a task that can tell when it has found its answer.** A *harvest* — "answer every key this article supports" — cannot: an unanswered key looks identical whether the article is silent or the sentence was never sent, so the ladder accepts a reading of the first 1500 tokens and reports the other 85% as absent. Those pipelines declare `coverage: 'whole'` on the spec and `runWithEscalation` drops every partial attempt **at plan time** — the doomed call is never billed, and the choice of ladder stops silently deciding how much of the corpus gets read. `extract` (`tasks.extract.readWholeDocument`, default true) and whole-document `translate` both do this; `websearch` has no document to slice.
3. **Send prose, not documents.** `extractTextSpans` (`src/documents/markdown/textSpans.ts`) and the dossier-side equivalent in `src/pipelines/localization/StringTable.ts` pull out only translatable text; headings, list markers, `:::` containers and their attributes, fenced code, URLs, and — for dossiers — `dates`/`ranking`/`url`/media targets/unknown fields never leave the machine. What crosses the wire is a flat `{contentHash: text}` table (`tasks.translate.mode: segments`, the default); the model must return exactly the same keys, so a dropped or invented key is caught rather than silently written out. Repeated strings are translated once via `TranslationMemory`; `tasks.*.useTranslationMemory: persistent` keeps that cache across runs in `run.memoryDir`, namespaced by prompt version so a prompt edit starts a fresh one. Link targets inside a sentence are masked as `⟦1⟧` and checked for survival before acceptance. Whole-document mode (`tasks.translate.mode: document`) still exists for when maximum surrounding context matters more than cost.

   **A fragment that is not in the source language is not sent at all** (`tasks.translate.foreignFragments: keep`, the default; `src/pipelines/shared/script.ts`). A Russian article quotes the rest of the world in its own spelling — `Plays Domenico Scarlatti`, `Allegro vivo`, `'Amadeus' Guitar Duo`, `[MP3](⟦1⟧)` — and none of it should be translated. Every prompt in this repo says so, and an instruction is obeyed on most calls; a fragment with no letter of the *source script* in it cannot be a sentence of the source language, so not sending it is both cheaper and obeyed on all of them. On `input/ru` that is 11% of the fragments and every one is a work title, a composer, or a link label. A **mixed** fragment is always sent: "Играл на гитаре Pedro Maldonado" is Russian prose, and keeping the name intact is the prompt's job. The rule needs a source language with an alphabet of its own, so it does nothing for a Latin-script corpus.

   **Romanize from the source language, not from the subject's nationality.** A Russian article about a Ukrainian guitarist spells his name in Russian, and a model reading `Александр Викторович ТАВРОВСКИЙ (род. … Переяслав-Хмельницкий, Киевская обл., Украина)` is very willing to answer `Oleksandr Viktorovych TAVROVSKYI` — a form no source in the corpus contains, arrived at by romanizing through a language that is nowhere in the request. It is a plausible-looking answer and a wrong one, and the rule that invited it was the sensible-sounding "where a person is known by a Latin spelling, that spelling is the answer": nationality is not the same thing as publication. Every translation and localization prompt now states the constraint with the three examples that matter (`Александр` → `Alexander`, never `Oleksandr`), and the exception stays exactly where it was — a Latin spelling the person is actually published under still wins.

   Two related traps: a bad rendering is cached by `useTranslationMemory: persistent` and will be re-served verbatim until the prompt version changes (which is what namespaces the cache, so editing the prompt does start a fresh one — the stale file just lingers in `run.memoryDir`); and **a template must name a language once.** `<%= it.sourceLanguageName || it.sourceLanguage %>` is an Eta fallback that can never fire, because `languageName()` already falls back to the code — but it *reads* like two languages being offered, in a file whose entire job is to be unambiguous.

   **What the batch loses in context, it gets back in two lines** (`tasks.translate.contextChars`, 300 by default). Twenty fragments lifted out of their article are twenty sentences with no subject; the article's title and the opening of its lead tell the model it is translating a biography of a flamenco guitarist rather than a company report. It rides in the *volatile* half of the message, after the rendered instructions, so mechanism 1 is untouched — the cache prefix is the same for every document in the corpus.
4. **Repair the gap, not the batch** (`callBatch` in `src/pipelines/shared/stringBatch.ts`). One missing key used to reject the whole `{hash: text}` table and re-send all of it — two identical billed calls for one dropped fragment. The first call now accepts a *partial* answer and only the missing/malformed keys are re-asked; the **last** repair round is strict, so a surviving gap still becomes a validation failure with the usual retry-then-stronger-model treatment, on a payload of the few keys that need it. `tasks.*.repairAttempts: 0` restores all-or-nothing. A response that is unusable as a whole (no JSON, not an object) skips the ladder — re-asking per key cannot repair it. Fragments with no letters are never sent at all.

   **A batch cut off by the output limit is narrowed, not escalated** (`callNarrowing`, same file). That failure is neither a broken model nor a broken response: the payload was accepted and the answer had nowhere left to go, so retrying buys the identical cut and falling back to a wider model pays for what the caller can fix for free — half a table needs half the output. The batch is halved and re-asked on the model already chosen, converging in a round or two; a *single* fragment that still does not fit has no cheaper axis left, so it propagates and inherits the usual fall-back-to-a-wider-model. This is the repair ladder's principle one level down: move on the cheap axis (how much is asked at once) before the dear one (which model is asked). Keep `tasks.*.max{Segments,Strings}PerCall` sized so the *answer* fits the smallest model in the pool — narrowing is a correction, and every oversized call is still one cut-off answer paid for before it.
5. **Reasoning is a cost setting.** `reasoning.dialect: none` (the default) sends no reasoning parameter and leaves the model's own behaviour alone; **any other dialect states the intent in both directions**, so `enabled: false` emits an explicit "do not reason" — the only way to quiet a model that reasons unless told otherwise. `exclude` hides traces but does not make them free. The run summary reports the reasoning share of output tokens.
6. **Ask for facts, not for a schema** (`src/pipelines/extraction/FlatFields.ts`). Extraction sends a flat card of ~22 short keys and `response_format: json_object`, and assembles the dossier locally. The previous contract shipped the dossier's JSON Schema twice per call — once in the system prompt, once in `response_format` — for **≈2450 input tokens per document** that told the model about nesting, `dates`, comma lists and forbidden members, none of which is information the model has. Adding a field to the card costs one line; adding it to `metadata` costs nothing at all, because `buildDossier` owns the shape.
7. **Parse what you can instead of asking for it.** The gallery comes out of the article's own `::: image` containers and tablature tables (`src/documents/markdown/media.ts`) — no tokens, and the `target` is the path the article contains rather than one a model retyped. Country names, demonyms and alpha-3 codes resolve to ISO 3166-1 alpha-2 locally (`src/domain/countries.ts`, via `Intl.DisplayNames`); crafts and genders map from any of the corpus languages (`src/domain/vocabulary.ts`); a title that says `дуэт`, `квартет` or `Gitaartrio` settles both `gender: mixed` — which `external/02` *defines* as "a collective entry" — and how many faces the portrait matcher should expect; `"unknown"` / `"н/д"` / `"—"` are dropped rather than published. Every one of these is a rule that would otherwise have to be stated in the prompt, obeyed by a model, and paid for on every call.
8. **The cheapest call is the one not made.** `tasks.extract.onExistingDossier: reuse` (the default) re-emits an **authored** `<slug>.bio.json` — the one beside the article, normalized and migrated to version 2 — for **zero tokens**; `complete` asks only for the keys it lacks. This tool's *own* previous output deliberately does not count (`findSourceDossier`): a task that treated its own product as authored input would re-plan itself on every run. A second run is cheap for a different reason — `--resume` and `run.skipExistingOutputs` skip what is already on disk. The dry-run cost preview knows the difference: a task can declare `usesLlm: false` per-task, not just per-pipeline.
9. **Stop asking the document for what it does not contain** — but be sure it does not contain it. An article that never states a birthplace does not start stating one on the third context rung, and re-reading it buys the same silence three times. That is only true once the *first* rung carried the whole article (see mechanism 2); a truncated read turns "the document is silent" into a claim the run cannot support, and hands `websearch` a question the article had already answered. `websearch` takes over at that point and asks a *different source*, and its questions are computed from the dossier: no gaps means no call, no artifact, no cost. What it sends is an identity card of eight short lines (plus, optionally, the lead paragraph for telling namesakes apart) — never the article.
10. **A picture is data, not a generation problem.** The portrait is chosen from `images/artists.json` by name matching, the index's own `ai` block, and **the images the article itself embeds** — which is the article having already answered the question, for nothing. No model, no vision call, and the `img` that lands in `index.json` points at a file that exists.
11. **A second opinion is cheaper than a second call.** `data/names.json` already knows the family name behind a byline that only gives initials, the pseudonym a reader will type, and the title of a collective the slug abbreviates. Reading it costs one JSON parse per run and removes three classes of failure: an extraction that produced no name (and would have been retried and escalated over it), an ensemble with no display name in `index-<lang>.json`, and a portrait search with nothing but a slug to search on.

### State, resume, observability

Every run writes `.biomd/runs/<runId>/`: `run.json` (manifest), `events.jsonl` (append-only — every request/retry/fallback/error/artifact write, plus each task's **notes**), `state.json` (checkpoint, fingerprint → status). `--resume`/`--resume-run` replays the checkpoint and skips completed fingerprints; `biomd report [runId]` reads the manifest + checkpoint back afterwards. **Only `resume` and `existing-output` count as done** (`isTaskDone`, `src/state/types.ts`) — those are the planner's two reasons and both say the output exists. Everything the orchestrator *retires* (`dependency-failed`, `run stopped`, `aborted`) describes a task that never ran, and counting it as done made the next resume skip it forever: one failed translation produced a catalogue that could never be built again, because the run that would have fixed it quietly declined to try. Add a skip reason to the whitelist only if it means the artifact is on disk. `.biomd/`, `out/` and `dist/` are all git-ignored.

**A merge's output file is not evidence that the merge happened.** `run.skipExistingOutputs` reads a file's existence as "this work is done", which is right for a translation and exactly wrong for a task that *updates* what is already there: `catalog` reads `index.json` and writes it back, and `websearch` completes the dossier `extract` just wrote, so both declare an output that exists from the end of the first run onwards. Both were therefore skipped for ever — a catalogue that could never pick up a new article and a web search that ran once per corpus. Neither failed; they simply stopped happening, which is the worst way for a batch tool to be wrong. `TaskSeed.mergesOutput` marks them, and the planner leaves the fingerprint comparison (a claim about the *work*) to do the real deduplication. `--no-skip-existing` is the manual override for everything else.

**Silence is a failure mode, and the reliability layer is built out of silence.** A pool is a fallback chain and its whole point is that one target dying is survivable — which also means a first choice that never works is invisible: the run completes, every document is produced, and the only trace is the bill from the model that was supposed to be the backup. That is exactly what happened on a real run here: `or-search` answered `404 No active credentials` eight times, the circuit opened, and the remaining 37 web searches went to the paid `or-osearch` without one line saying so. Three things now make it audible, and none of them changes what the run does:

- **`onTargetDown`** — a gateway event fired **once** per target, the first time it is written off (a non-retryable failure, `model_unavailable`, or a circuit already open). A fallback is normal; a target that never works is a config bug.
- **the target health table** in the run summary — requests, successes, failures, latency and cost per target, with a named call-out for any target that served **zero** of its requests.
- **`biomd models --probe`** — the pre-flight. Note that reading the endpoint's `/v1/models` would *not* have caught this: `cx/gpt-5.6-luna` was listed the whole time and rejected every completion. Only a real call distinguishes declared from working.

One bug made all of this worse and is worth not reintroducing: `AppLogger` spread its caller's fields **over** the record envelope, so a caller passing `{ message: … }` as context — which the fallback observer did, carrying the provider's own message — replaced the line that says *what happened* with the line that says *why*. The JSONL log recorded `"404 No active credentials for provider: omniroute"` and never named the target that died. The envelope is now written last.

## Configuration

One YAML file (`biomd.config.yaml`), Zod-validated (`src/config/schema.ts`), layered `defaults < file < ${ENV} < CLI flags` (`src/config/loader.ts`, `merge.ts`). Invalid config fails before any work starts, with the offending path named. Secrets are `${VAR}` / `${VAR:-fallback}` references resolved from `.env`, redacted on any serialization (`redactConfig`, used by `config show` and the journal). Three ready-made configs live in `config/examples/` (`local-only`, `openrouter-only`, `hybrid`) — the hybrid pattern (free local model first in every pool, paid models behind it as fallback) is the one worth reusing as-is.

Two sections sit at the root rather than under a task, for the same reason: several tasks have to agree about them.

**`catalogue:`** is **not** task settings — it describes the *format's* deployment (`supportedLanguages`, `datePrecision`, `defaultType`, `defaultPageType`, `allowUnknownTypes`), and `extract`, `websearch`, `localize`, `catalog` and `validate` all read it.

**`roster:`** describes the second input source (`file`, `language`, `fillMetadata`, `aliases`, `nameHints`, `reportConflicts`); `extract`, `portrait` and `catalog` read it. An empty `file` turns it off entirely, which is the default — a configured file that is missing is an error, because a mistyped path and a deliberately absent roster must not look the same.

## Prompts

`prompts/<task>/{system.md,user.md}` (Eta templates — see [prompts/README.md](prompts/README.md)), mapped by `prompts.templates` in config so a directory can be renamed without touching code. Both files hash into `promptVersion`, which feeds the task fingerprint, so editing a template is a tracked change that correctly invalidates already-completed work. `translateSegments`/`localize` templates answer a `{hash: text}` table and must return exactly the same keys; instructions that invite merging, splitting or reordering fragments will surface as validation failures and retries.

## The domain layer — `src/domain`

**Every rule of the published format lives here and nowhere else.** A change to `external/` has exactly one landing site; `core`, `routing`, `reliability` and `state` stay ignorant of guitarists. Adding a rule anywhere else is the mistake this directory exists to prevent.

| Module | Owns |
|---|---|
| `types.ts` | `EntryRow`, `NameIndex`, `Dossier`, the member orders, the forbidden-member list |
| `values.ts` | `VD-*` domains: `normalizeDate` (+ `parseDate`, `datePrecisionOf`, `refinesDate`, `yearOf`), `normalizeCsvList`, `normalizeRanking`, `normalizeUrl`, `normalizeTarget`, `slugOf`, `normalizeId`, content/asset paths |
| `romanize.ts` | folding (`Andrés` → `Andres`) and Cyrillic transliteration; used by the name index *and* by image matching |
| `countries.ts` | 249 alpha-2 codes; `resolveCountry` accepts a code, an alpha-3, a name in any of ten languages (via `Intl.DisplayNames`), or a demonym — and `countryName` runs it backwards, `("au", "ru")` → `"Австралия"`, for the prose fields a code must never leak into |
| `vocabulary.ts` | `resolveEntryType` / `resolveGender` / `resolveDocumentType` / `resolveLanguage` / `resolveEnsemble` / `languageName` — multilingual synonyms → the canonical token |
| `dossier.ts` | `sanitizeDossier` (v1→v2 migration included), `mergeDossier` (fill gaps, never overwrite), `orderDossier` |
| `catalog.ts` | `CatalogIndex` — load, upsert, allocate ids — and `mergeNameIndex` |
| `validate.ts` | `INV-1 … INV-28` as a pure function over a snapshot of the files |

Two invariants of the code itself:

- **Narrow on output, wide on input.** Each normalizer emits exactly the canonical authored form and accepts every plausible spelling of it. Rewriting `1893-02-21` is free; re-asking for it costs a round trip and usually returns `1893-02-21` again.
- **Drop, never guess.** `external/07` §7.2 rule 5: an absent field is correct, an invented one is a claim about a person. Every dossier field is optional, so dropping degrades gracefully.

Two behaviours that follow, and that are easy to break by accident:

**Partial dates — the one place this deployment overrides `external/`.** The specification says a date not known to the day is not representable and must be omitted (`external/02`, `external/05` §5.11). That loses a real fact every time an article says only "born in 1885", so `catalogue.datePrecision` lowers the floor and the canonical form is published **truncated from the left**: `21.02.1893` → `02.1893` → `1893`. Setting it back to `day` restores the specification exactly.

The trade-off is stated once, in the config: VD-DATE requires a consumer to treat anything outside `\d{1,2}\.\d{1,2}\.\d{4}` as **absent**, so a strict reader ignores `"1893"` and behaves as if the field had been dropped — nothing breaks, and a reader that wants the year can have it. `biomd validate` accepts whatever the setting allows and raises no per-value warning: the setting *is* the statement of intent, and warning on every deliberate value would make `--strict` unusable. The calendar is still checked — a producer that writes `31.02.1900` has published a date that does not exist — and `mergeDossier` performs the one overwrite in the codebase: a sharper reading of the *same* date (`1893` → `21.02.1893`) replaces the blunter one, because those are one fact known to two depths rather than two competing facts.

**A collective is a value, not a special case.** `resolveEnsemble` maps `дуэт`, `квартета`, `Gitaartrio`, `cuarteto`, `ансамбль` to `{group, size?}` — declined stems and Germanic compounds included, because a whole-word table misses most real titles. Two things read it and both would otherwise be guesses: `gender: mixed`, which `external/02` defines as *"a collective entry"* and which a model asked to choose between `m`, `f` and `mixed` gets wrong for four men often enough to matter; and how many faces belong in the entry's photograph (`src/images/subject.ts`).

Ask it of a **name** — a title, a heading, a slug, the roster's entry — and never of the prose. `выступал в дуэте с Мелешко` is a sentence about one guitarist, and a table that reads `ГРАН-дуэт` correctly files him as a pair.

A third thing follows from it, in `ExtractionPipeline.forCollective`: **an ensemble has no `forename`**, and the field is not decoration — `displayNamesOf` renders `forename + surname`, so whatever lands there is published as the beginning of the trio's display name in every language index. Three things turn up in it, and a comma tells the first two apart from the third: the collective's **name**, with nowhere else to go (promoted to `surname`); the collective's name **again**, beside a `surname` that already says it (dropped); or its **members** (moved to `relatives`, which `external/05` defines as *"related persons"* and the reader renders as exactly that comma-joined line). A real fact in the wrong member is worth moving, not discarding.

**Classification never touches the dossier.** `type`/`gender`/`country`/`img`/`title` belong to `index.json` and are errors inside a `*.bio.json` (`INV-7`), but they are only derivable from the article — which `extract` has open anyway — from a v1 document being migrated, from a web search, or (for `img`) from the image index. Every path routes them to a hint channel under `out/.hints/`, where `catalog` picks them up while staying `usesLlm = false`. Precedence is strict and one-directional: **existing index row → `extract` hint (the article, or an authored v1 dossier) → `websearch` hint → `portrait` hint (`img` only) → `catalogue.defaultType`**.

**An alias earns its place or it is not authored.** `external/04` §4.5 asks a producer to author every form a reader plausibly types, the bare family name and a transliteration among them. `tasks.catalog.aliasPolicy` narrows that on purpose — the second place after `catalogue.datePrecision` where a setting overrides the specification — because §4.5 also specifies how a consumer *matches*: graded by position, word-start included. A query for `Сеговия` therefore already reaches `Андрес Сеговия`, and an alias contained in one that is already there adds a row, a byte and a tie, and no reachability at all. `distinct` (the default) drops exactly that, plus an alias equal to the row's Latin `title` (searched in its own right) and a machine transliteration — `Andres Segoviya`, `Dzhon Vilyams` — which nobody types and which the consumer's own Cyrillic→Latin expansion already covers from the other end. It keeps what nothing else reaches: the inverted order (`Сеговия Андрес` is not a substring of anything), the birth name, and the roster's spellings. `spec` restores the full list. Containment is tested on **whole words**, so `Ким` is not swallowed by `Иоаким`.

**`index-<lang>.json[0]` is a display name, not one alias among several.** The reader prints it under the thumbnail and searches everything behind it, and because `index.json.title` is Latin-only, for every non-Latin language this element *is* the name the entry is shown under. `tasks.catalog.displayNameOrder` therefore makes it a deployment choice rather than a derivation, and `roster` (the default) reads: the roster's own `fullname` for the roster's language — `Абитон Жерар`, the catalogue's own heading, written by a person — falling back to `Surname Forename` when the roster does not know the entry; every other language keeps `Forename Surname`, because a Russian filing convention is not an English one. Whichever order loses becomes the first alias, so nothing stops being findable.

One refinement earns its keep on this corpus: **the roster abbreviates.** `Адамян С.В.` is the same name as `Сергей Викторович Адамян` with less of it, and taking the roster whole would publish initials where a reader expects a name. So a roster heading that merely *reduces* what the dossier already knows — every word of it present in the full name, whole or as an initial, and fewer words spelled out — loses to the same name in the roster's order, while one that says something genuinely new keeps its place. That second case is what the setting exists for: `Абреу Зекинья` is the name a reader looks for, and `Хосе Гомеш де Абреу` is what the article calls him.

**The catalogue is updated, never rebuilt.** `CatalogIndex.load` reads the existing `index.json` and `upsert` edits it: row order, unknown members, hand-edited classification and — above all — every `id` survive, as do rows this run never visited. `mergeNameIndex` does the same for `index-<lang>.json`, keeping a hand-authored `[0]` and appending only new aliases. Regenerating either from scratch would silently detach localized names from their entries, which is why `tasks.catalog.merge: false` exists but should not be used.

**The same rule that protects a hand-edit makes a machine mistake permanent**, and that needed an escape hatch narrower than `merge: false`. Change `tasks.portrait.assetPrefix` and every row keeps the `img` built from the old one — for ever, silently, because `upsert` only ever fills an empty member. `tasks.catalog.refresh` names the members this run is allowed to *correct* (`img`, `title`, `type`, `gender`, `country`, and `displayNames` for `index-<lang>.json[0]`); it is empty by default, every replacement is reported in the run notes, and it is meant to be switched on for the run that fixes something and switched back off. `biomd validate` now catches the specific case that motivated it — a `..` segment in an `img` is an error, since `VD-PATH-ASSET` has none — and warns when one photograph is shared by two rows, which is nearly always the portrait matcher resolving a family name rather than a person.

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
| `subject.ts` | *how many people* — solo or a collective of `n`, and how a detected face count rates against it |
| `select.ts` | the staged pipeline and the §14 lexicographic key |

What the real index actually contains, and why the code looks the way it does — the specification's own weight table assumes the opposite:

- `meta.people`, `meta.title` and `ocr` are **empty in every record**; `meta.description` holds an XMP dump and `meta.keywords` EXIF rationals. Hence the junk guard, and hence identity resting on the path.
- `photo/<letter>/` is the initial of the subject the file is **filed under**. `photo/b/buek_segovia.jpg` is Buek's photograph — an excellent picture of Segovia and a wrong avatar for him. That single signal is worth −0.30.
- A directory can be a person (`almeida_laurindo/4lalm07.jpg`, no usable filename tokens) *or* a discography (`paco_de_lucia/siroco.jpg`), so a directory match scores below a filename match and an unexplained proper noun in the filename is penalized.
- `pena_cd05_1993.jpg` is a record sleeve that classifies as `portrait`, one face, high confidence. Release markers are excluded by default; note that `\b` never fires before `_cd` because `_` is a word character.
- `nameTokensRu` is a list of *alternative spellings* (`сеговия|сеговиа|зеговия`), not additional people — only Latin filename tokens can name a second subject.
- `ai.confidence` is low across the board (median 0.54 for `portrait`) and images are small (median 0.04 MP), so confidence modulates trust in the class rather than gating, and the resolution term is log-scaled and bounded.

**Two additions the real corpus forced, and what they were worth.** Of the thirteen articles in `input/ru`, nine are collectives; before these, the matcher found a usable portrait for **three** of the thirteen — and one of the three was a photograph of one member of a duo. Now it finds **ten**, and the three it declines are the three the archive genuinely has nothing for: two with no file at all, one with nothing but scans of his editions.

- **The subject shape** (`src/images/subject.ts`). Every threshold in `suitability.ts` was calibrated for a soloist: one face is the ideal, two are a penalty, `group` is nearly disqualifying, and the coverage window assumes a head fills the frame. All of it is exactly wrong for a quartet, whose correct photograph has four small faces in it — `photo/t/trio_ural.jpg` scored identity 0.97 and was then discarded as visual tier 3. So the expectation is an input: `faceFit` rates the count against it, the class tables invert (`group` high, `portrait` low — a `portrait` of an ensemble is a picture of one member), the coverage window divides by the number of people, and the orientation preference flips, because a line-up is a wide photograph.
- **The article's own images** (`NameQuery.articleImages`). Whoever wrote the entry chose the picture that opens it, which is the closest thing to a curated answer the corpus holds — and the only evidence that survives a filename the name index cannot reach: `photo/k/kag.jpg` is the Classical Guitarists' Ensemble, and no amount of matching turns `classicalag` into `kag`. The **first** image scores 0.95; a later one scores 0.86, deliberately *below* the acceptance threshold, because a biography's later pictures are its teachers, its colleagues and its record sleeves as often as they are its subject — one of those wins only with a name match behind it. The images are read by the same scanner that harvests the gallery, from `HarvestResult.imageTargets`, which unlike `photos` does not require a caption.

Three rules that must survive any edit:

- **Identity first, always** (§16). Picture quality never compensates for a weak name match; the acceptance threshold is applied to the identity score alone.
- **The key is lexicographic, not a weighted sum** (§14), with identity banded to 0.1 and `faceCoverage` ahead of the hybrid score — otherwise colour and megapixels quietly outvote "you can actually see the subject's face".
- **Below the threshold, write nothing.** `external/03` §3.4.9 already specifies the fallback (`photos/default-male.svg` etc. by gender), and those synthetic assets are deliberately kept out of the gallery, which a value written into `img` would not be. `onLowConfidence: default` exists for a deployment that disagrees.

- **The expectation is an input, not an inference from the picture.** `faceCount` decides how well a candidate fits the subject; it never decides *what the subject is*. That comes from the title, through `resolveEnsemble`, and a wrong answer there is visible in the hint file's `searched.subject` rather than buried in a score.

Not attempted, deliberately: telling two people with the same name apart. `photo/w/john_williams/` cannot be resolved by filename analysis, and a heuristic that guessed would be wrong silently. The answer there is a curated `img` in `index.json`, which this pipeline never overwrites.

## The name roster — `src/roster`

**Every rule of `data/names.json` lives here**, the way `src/images` owns the
image index. `NameRosterStore` reads it once per run and hands out a slug-keyed
index; `entry.ts` decides the two questions the file itself does not answer.

| Module | Owns |
|---|---|
| `types.ts` | the record format, and the normalized `RosterEntry` |
| `entry.ts` | *is this a person's name* and *is this a collective* |
| `NameRosterStore.ts` | one cached load per path, the slug index, the counts of what it could not use |

What the file is: `{fullname, surname, forename, patronymic?, url, aliases?}` per
article, 739 records against a corpus of about a thousand, written in Russian and
in the catalogue's own order (`Носкова Е. Н.`). What it knows that no reading of
one article can: the family name behind a byline that only gives initials, the
pseudonym (`Инсаров` for a man the catalogue files under `Черножуков`), the
spelling variant a reader will actually type (`Баццотти` beside `Баззотти`), and
a collective's own title.

What it also is: wrong in places. `authors.bio.md` is filed as surname
`"Музыкальные пристрастия –"`, forename `"музыка"`, patronymic `"гитариста"` — a
page title chopped into three columns — and `di_meola.bio.md` has the given and
family names swapped. So `isNamePart` refuses a column whose words are not
capitalized words, initials or particles, and such a record contributes its
`fullName` and its aliases (still usable as search text) and no name components
at all.

Three consumers, one rule between them — **fill a gap, never overwrite a fact**:

- **`extract`** merges `forename`/`surname` into the dossier through
  `mergeDossier`, which is the same gap-filling used everywhere else, and adds
  the roster's keys to the *satisfied* set so a partial answer is not rejected
  (and retried, and escalated) over a name this side already has.
  `roster.reportConflicts` notes a disagreement instead of resolving it: the
  article is what the entry is about.
- **`portrait`** takes every spelling as `extraNames`. For a collective this is
  often the only searchable name there is.
- **`catalog`** takes the hand-authored aliases — the best in the system, because
  a person wrote them — for the roster's **own language only**. They are variant
  spellings, not translations, and `Кривенко В.М.` under an English heading is
  not a localization.

`roster.language` is what keeps that last rule honest, and the mechanism is the
shape of the value: `catalog` hands `displayNamesOf` a map keyed by language
holding exactly one entry, so an English name index cannot pick the aliases up
even by accident.

## The `websearch` task

Runs after `extract`, before `localize`/`portrait`/`catalog`, and **rewrites the dossier in place** (`overwrite: true` on the `metadata` channel). Everything about it is conditional:

- `src/pipelines/websearch/gaps.ts` computes the questions from the dossier. No gaps → no call, no artifact, zero cost. `country` is checked against the `catalogHints` file, since it is not a dossier member at all.
- The **liveness rule**: born ≥ `livenessAgeYears` ago (78 by default, and a year-only birth date is enough) with no `died` turns the absence into a question. The answer contract is `status: alive | dead | unknown` — a date of death is written **only** when the answer explicitly says `dead`. Silence is not evidence of death; `filterLiveness` drops a date that arrives without the status.
- `src/pipelines/websearch/answer.ts` refuses far more than it accepts: every value goes through the same domain normalizer as an extraction, a source URL is required (`requireSource`), confidence is a floor, and a value that contradicts what is on record is rejected rather than merged.
- **A date is the exception, because "contradicts" was hiding a correction.** `upgradePrecision` asks for the sharper form of a date the article gave loosely — and an article that says "born about 1950" is sometimes simply wrong about the year, so the truthful answer arrives *contradicting* the record instead of refining it. The old rule dropped it, the prompt told the model its answer "must agree with what is known" (so it usually withheld it in the first place), and nothing anywhere said a question had been asked and unanswered. Armik is the worked example: the article says `1950`, the web says `25.07.1949`, and the catalogue kept publishing `1950` through run after clean-looking run. Now `tasks.websearch.onDateConflict` decides, out loud:
  - **`prefer-precise`** (the default) — a **strictly more precise** sourced date replaces the coarser one, disagreeing year included. It is implemented by clearing the recorded value so `mergeDossier` fills the gap in its ordinary way; nothing reaches into the merge's rules.
  - **`report`** — the record stands and the candidate is written to `out/.hints/<slug>.web.json` as a `conflicts[]` entry with its source, for a person to settle.
  - **`ignore`** — dropped, with a note. The pre-existing behaviour, kept only for reproducibility.

  Precision is the whole discriminator, and it has to be: two dates of the **same** precision that disagree are two claims about a person, and preferring one by provenance alone publishes a coin toss. `sharpensDate` in `src/domain/values.ts` is the weaker sibling of `refinesDate` — "does this carry more information" rather than "is this the same fact read more closely" — and nothing in the domain acts on it, because deciding that a sourced day beats an unsourced year is a policy about whom to trust and belongs to the pipeline holding both provenances.
- **The answer is written in the edition's language.** The dossier being completed is `out/<lang>/<slug>.bio.json`, so a prose value belongs in *that* language, however English the sources were — the prompt says so, and `localize` then carries it into every other edition. The one rule that survives in the machine tongue is `country`, which is a token (`VD-COUNTRY`) rather than prose. Keeping those two straight is not pedantry: telling a model once that "countries are ISO 3166-1 alpha-2" gets `"birthplace": "Melbourne, au"` published as a caption, so `normalizePlace` spells a bare code back out through `countryName`. It fires only where the code is unambiguous — alpha-3 always, alpha-2 only when it agrees with the country already established for the entry — because a two-letter token after a city name is usually *not* a country: `Nashville, TN`, `Adelaide, SA`, `Recife, PE`, `Los Angeles, CA`. A country spelled as a word is never touched at all.
- **A collective is asked nothing personal.** A quartet has no date of birth, no birthplace and no date of death, and a search model asked for one *answers* — with the founding year dressed up as a birthday, or a member's home town as the ensemble's. When the title names a collective (`resolveEnsemble`), `born`/`died`/`birthplace`/`deathplace` are dropped from the question list and the liveness rule never fires; `country` and `url` are what remain, and they are real questions about an ensemble.
- The article is never sent. The wire carries an identity card of ~8 short lines — name, known dates, instruments, jobs — plus, optionally, the article's lead paragraph capped at `contextChars`, which exists solely to tell namesakes apart.
- Routing requires the `web_search` capability by default. A model without search answers these questions anyway, fluently and without a source; that is the failure mode the capability gate exists to prevent. **The gate is only as honest as the capability list** — declaring `web_search` on an OpenRouter model with no `:online` suffix and no web plugin gets exactly the confident fiction the gate was meant to stop, and nothing detects it, because a sourceless answer and a fabricated source look the same from here.

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
| `data/names.json` | The name roster. No spec of its own — `src/roster/types.ts` is the description, and the two malformed records it tolerates are named there |
| [external/02-value-domains.md](external/02-value-domains.md) | Every `VD-*` value domain — the source `src/domain/values.ts` implements |
| [external/07-authoring-and-validation.md](external/07-authoring-and-validation.md) | `INV-1 … INV-28`, the list `biomd validate` checks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full layering, extension points, non-goals — the source this file summarizes |
| [docs/PROGRESS_AND_TODO.md](docs/PROGRESS_AND_TODO.md) | Dev log: original spec, defaults chosen and why, what shipped when (RU/EN) |
| ~~docs/MetaData.md~~, ~~docs/Catalog-Index.md~~ | **Superseded** by `external/`. Kept for history; do not implement against them |
| [prompts/README.md](prompts/README.md) | Template conventions, Eta whitespace and ASI traps, variables per task |
