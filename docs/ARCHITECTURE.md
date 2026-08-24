# biomd-process — Architecture

**Status:** v0.2 · **Scope:** generic LLM batch-processing platform, with the
catalogue data format implemented once, in `src/domain`, behind that platform.

The normative specification of the format this tool produces is
[`external/`](../external/README.md) — nine documents, written for implementers
of producers and consumers, owned by the reader application rather than by this
repository. Where this document and `external/` disagree, `external/` is right.

## 1. What this is (and is not)

`biomd-process` is a **batch runner for LLM tasks over a set of documents**.

Four task pipelines ship with it:

| Pipeline | Scope | Input | Output |
|---|---|---|---|
| `extract` | document | one `*.bio.md` | one dossier JSON in the source language |
| `translate` | document | one `*.bio.md` | one translated Markdown per target language |
| `localize` | document | the source dossier | one dossier JSON per target language |
| `catalog` | corpus | everything produced | `index.json` + `index-<lang>.json` |

Any combination can run in one job. With all four on, `ru/x.bio.md` yields
`out/ru/x.bio.json`, `out/en/x.bio.md`, `out/en/x.bio.json` and the catalogue —
i.e. each language directory holds a complete, self-consistent edition.

`catalog` calls no model at all (`usesLlm = false`); it reads what the others
wrote. It is off by default.

The v0.1 goal was the **platform**, not the domain: everything depending on the
exact shape of a `bio.md` or a dossier sat behind a narrow contract, so that
filling one in would not require touching orchestration, routing, retry, state or
CLI code. That property held, and v0.2 is what filling it in looked like — every
domain rule landed inside `src/domain` and the four pipelines, with no change to
`core`, `routing`, `reliability` or `state`.

### 1a. The domain layer

`src/domain` is the **only** place that knows what a catalogue is. Nothing above
it re-derives a rule, and a specification change has exactly one landing site.

| Module | Owns |
|---|---|
| `types.ts` | `EntryRow`, `NameIndex`, `Dossier` — `external/08` §8.4, transcribed |
| `values.ts` | The `VD-*` value domains: dates, comma lists, ranking, URL, target, slug, id, content/asset paths |
| `countries.ts` | ISO 3166-1 alpha-2, plus alpha-3, localized names and demonyms resolving into it |
| `vocabulary.ts` | `type`, `gender`, `documents[].type`, `lang`, the collective words — multilingual synonyms → canonical token |
| `dossier.ts` | Sanitize (with the version 1 → 2 migration), merge-without-overwriting, house member order |
| `catalog.ts` | `CatalogIndex` (load, upsert, allocate ids) and `mergeNameIndex` |
| `validate.ts` | `INV-1 … INV-28` as a pure function over a snapshot of the published files |

Two properties are worth stating because everything else follows from them:

**Every normalizer is narrow on output and wide on input.** It emits exactly the
canonical authored form the specification names, and accepts every plausible
spelling of it. The alternative to accepting `1893-02-21` is spending a retry on
a model that will very likely answer `1893-02-21` again.

**A value that cannot be read is dropped, never guessed.** `external/07` §7.2
rule 5 is "do not invent facts", and every dossier field is optional: an absent
row is correct, a wrong one is a claim about a person.

### 1b. What the model is asked, and what it is not

The extraction contract used to be the dossier's JSON Schema — ~1200 tokens in
the system prompt, and the same schema again in `response_format`, on every call
for every document. It bought a model that reproduced a structure.

None of that structure is information the model has. It is information *we* have.
So the model is now asked for a **flat table of short keys** (`FlatFields.ts`),
and the document is assembled here:

| | before | after |
|---|---|---|
| schema in the system prompt | ~1923 tok | ~660 tok (the field card) |
| schema in `response_format` | ~1195 tok | `json_object`, ~7 tok |
| shape errors possible | nesting, arrays-vs-lists, forbidden members, date format, enum spelling | none — the shape is not the model's to get wrong |

**≈ 2450 input tokens saved per extraction call**, before anything else.

Three further things are never asked for at all:

- **The gallery.** `media.photos` and `media.music` are a caption and a path, and
  the article already contains both — in its `::: image` containers and its
  tablature tables. `src/documents/markdown/media.ts` parses them. A harvested
  `target` is the path the article contains rather than one a model retyped.
- **`ranking`.** A project-defined editorial score is not a fact an article
  contains. It stays available through `tasks.extract.fields`.
- **Anything about an entry that already has a dossier.** See §1c.

### 1c. `onExistingDossier` — the cheapest call is the one not made

An existing `<slug>.bio.json` beside the article is authored data. It may have
been curated, corrected, or written by hand for exactly the fields a model gets
wrong, and regenerating it is both expensive and a regression.

| Mode | Behaviour | Cost |
|---|---|---|
| `reuse` (default) | Normalize, migrate to version 2, re-emit | **zero tokens** |
| `complete` | Ask only for the fields it lacks; merge without overwriting | one short question |
| `rebuild` | Ignore it and extract from scratch | full |

Only the **source-side** file counts. Extraction's own output is deliberately not
an input to extraction's plan: a run that saw the file it wrote last time would
change the task's fingerprint and re-plan forever. Whether the output is already
current is what `--resume` and `run.skipExistingOutputs` answer.

### 1d. How `catalog` classifies without calling a model

`external/01` §1.1 assigns `type`, `gender`, `country`, `img` and the Latin
`title` to `index.json`, and `external/05` §5.3 forbids them in a dossier.
Neither is derivable from a dossier — but all of them are derivable from the
**article**, which `extract` has open anyway, or from the version 1 document
being migrated.

So they travel on the `catalogHints` channel, and `catalog` stays LLM-free with a
strict precedence: **an existing index row wins**, then the hint, then the
configured default. An index row is the one artefact here a human may have
edited, and its `id` is a join key that must never move.

### 1e. The catalogue is updated, never rebuilt

Regenerating `index.json` from whatever the current run processed is the single
most destructive thing a producer can do to this format: a run over a subset
would delete every row it did not visit, and with them every `id` that
`index-<lang>.json` joins on — silently, because a broken join just falls back to
the Latin `title`. `CatalogIndex.load` therefore reads the existing file and
`upsert` edits it in place, preserving row order, unknown members and every row
the run never saw. `mergeNameIndex` does the same for the name files, keeping a
hand-authored `[0]` and appending only aliases that are new.

`biomd validate` closes the loop: `INV-1 … INV-28` over the published files, no
model, no network. Almost every way this format breaks is silent at runtime, so
correctness has to be *checked*, not merely intended.

## 2. Layering

Dependencies point **inward**. No module imports from a layer above it.

```
                        ┌───────────────┐
                        │      cli      │  commander, progress rendering
                        └───────┬───────┘
                        ┌───────▼───────┐
                        │      app      │  composition root (container.ts)
                        └───────┬───────┘
        ┌───────────────────────┼───────────────────────┐
   ┌────▼────┐            ┌─────▼─────┐           ┌─────▼─────┐
   │  core   │            │ pipelines │           │    io     │
   │ planner │◄───────────┤ extract   │           │ source    │
   │ orchestr│  contracts │ translate │           │ writer    │
   └────┬────┘            └─────┬─────┘           └───────────┘
        │                       │
        │      ┌────────────────┼────────────────┬──────────────┐
        │ ┌────▼────┐    ┌──────▼──────┐  ┌──────▼─────┐ ┌──────▼──────┐
        │ │   llm   │    │  documents  │  │  prompts   │ │    state    │
        │ │ gateway │    │  context    │  │ templates  │ │ journal     │
        │ └────┬────┘    │   images    │  └────────────┘ └─────────────┘
        │      │         │   roster    │
        │      │         └─────────────┘
        │ ┌────▼─────────────────┐
        │ │ routing │ reliability│
        │ └──────────────────────┘
        └──────────────► config ─────────► shared (types, errors, fs, hash)
```

| Layer | Owns | Must not know about |
|---|---|---|
| `shared` | primitives: errors, hashing, atomic fs, async helpers | anything |
| `config` | schema, validation, defaults, env interpolation | runtime objects |
| `reliability` | error taxonomy, retry, breaker, rate limit | which model is called |
| `routing` | choosing an ordered list of model candidates | how a call is made |
| `llm` | OpenAI-compatible transport, usage, cost, token estimate | tasks, documents |
| `prompts` | template files → messages, cache-friendly ordering | LLM transport |
| `documents` | document model, segmentation, context strategies | prompts, LLM |
| `images` | the image-index format and portrait selection (identity, suitability, ranking, subject shape) | config, pipelines, LLM |
| `roster` | the name-roster format: article → name components, collective title, hand-authored aliases | config, pipelines, LLM |
| `io` | discovery, path templates, atomic artifact writing, catalogue reading | pipelines |
| `state` | run journal, checkpoints, fingerprints, resume | pipelines |
| `domain` | the catalogue format: value domains, vocabularies, dossier and index documents, invariants | scheduling, LLMs, the filesystem |
| `pipelines` | task semantics (extract / translate) | concurrency, CLI |
| `core` | planning, scheduling, budget, event bus | concrete pipelines |
| `app` | wiring everything from a validated config | — |
| `cli` | argument parsing, progress and error presentation | internals |

## 3. Core data model

```
WorkItem      one discovered source document      (id = stable slug + lang)
   │
   ├── PlannedTask  (extract,   variant=-)                   ─┐
   ├── PlannedTask  (translate, variant=en)                   │ unit of scheduling,
   ├── PlannedTask  (translate, variant=de)                   │ retry and resume
   └── PlannedTask  (localize,  variant=en)  ──depends on──►  extract
                                                             ─┘
PlannedTask ──execute──► TaskResult { artifacts[], usage, cost, notes[] }
                                        │
                                        └──► ArtifactWriter ──► file on disk
```

### Scheduling and dependencies

A pipeline declares prerequisites structurally (`{ pipeline: 'extract' }` for the
same work item, `scope: 'all'` for every task of a pipeline corpus-wide); the
planner resolves them to task ids and the orchestrator runs the plan in
**dependency waves** — every task whose prerequisites are met goes in together at
full concurrency, and the next wave starts when they finish.

Waves rather than a fully dynamic DAG because pipelines form two or three stages,
never a deep graph, and a wave boundary is exactly the guarantee an aggregation
needs: everything `catalog` indexes has already landed on disk. A task whose
prerequisite *failed* is retired as `dependency-failed` instead of being run and
billed for a call that cannot succeed.

A dependency that matches nothing is dropped, not failed: turning `extract` off
must not make `localize` unschedulable, because a dossier may already exist.

With every task enabled the waves are:

```
1  extract                     writes the dossier + catalogue hints
2  websearch, portrait         websearch completes the dossier in place;
   translate                   portrait reads the name out of it
3  localize                    reads the finished dossier
4  catalog                     indexes what actually landed on disk
```

`websearch` is the one pipeline that rewrites another's output rather than
adding a file of its own — the dossier is the dossier, whichever source filled a
given field — so everything downstream of it declares the dependency and
`localize` folds its prompt version into the fingerprint.

Two identities per task:

- **`taskId`** — `hash(workItemId, pipelineId, variant)`. Stable across runs;
  identifies "the same job".
- **`fingerprint`** — `hash(taskId, sourceContentHash, promptVersion, outputContract)`.
  Changes when the input or the prompt changes. Resume compares fingerprints, so
  editing a prompt template correctly invalidates previously completed work while
  re-running an unchanged corpus costs nothing.

Pipelines **return** artifacts; they never write files. That keeps them pure enough
to unit-test, and makes `--dry-run` a property of the orchestrator rather than a
flag threaded through every pipeline.

## 4. LLM call path

```
Pipeline
  └─ LlmGateway.complete(request, policy)
       ├─ Budget.check()                     stop the run before it overspends
       ├─ Router.select(candidates, ctx)      ordered ModelTarget[]
       └─ for target of candidates:           ← fallback dimension
            ├─ CircuitBreaker.guard(target)
            ├─ RateLimiter.acquire(endpoint)
            └─ RetryPolicy.run():             ← retry dimension
                 └─ withTimeout(client.chat)
                      └─ ErrorClassifier → retryable? / next target? / fatal?
```

Two orthogonal dimensions, deliberately separated:

- **retry** = same target, transient failure (429, 5xx, network, timeout);
  exponential backoff with full jitter, honouring `Retry-After`.
- **fallback** = next target, target-specific failure (auth, model missing,
  context overflow, breaker open, retry budget exhausted).

Non-retryable by construction: `invalid_request`, `content_filter`, `auth`
(fallback only), and anything after the run budget trips.

`context_length` is special: it is reported back to the caller as a typed signal so
the pipeline can **escalate its context strategy** (see §6) instead of failing.

### Providers

One transport: `OpenAiCompatibleClient` (official `openai` SDK, custom `baseURL`).
That single client covers LiteLLM, OmniRoute, 9router, vLLM, Ollama's OpenAI shim,
OpenRouter and the OpenAI API itself. Per-endpoint `headers` and `query` cover the
provider-specific extras (e.g. OpenRouter's `HTTP-Referer`/`X-Title`). Reasoning is
configured per model and emitted in whichever dialect the endpoint expects
(`reasoning_effort`, `reasoning: {effort}`, or `thinking`), selected by
`reasoningDialect`.

## 5. Routing

```ts
interface RoutingStrategy {
  readonly id: string;
  select(ctx: RoutingContext): ModelTarget[];   // ordered, best first
}
```

`RoutingContext` carries the candidate pool (from `llm.routing.pools`), the request
shape (estimated input tokens, expected output tokens, required capabilities, the
pool name and the task variant), live endpoint stats, live endpoint **occupancy**,
and the attempt index.

Built-ins: `cost-optimized` (cheapest that fits), `context-optimized` (largest
usable window / best fit), `sequential` (declared order — classic primary→fallback),
`round-robin` (rotate), `least-failures` (health-aware), `least-busy` (emptiest
endpoint first, as a fraction of its capacity, cheapest as the tie-break). Custom
strategies register by id:

```ts
routingRegistry.register({ id: 'my-strategy', select: ctx => [...] });
```

A strategy only ranks; it never calls anything, and it never *changes* occupancy —
it only reads it. All of them get filtering for capability and context fit for free
from `RoutingContext.candidates`.

### 5.1 Pools

A pool is either a list of model ids or an object:

```yaml
pools:
  extract: [local-small, or-cheap]           # shorthand: models only
  translate:
    models: [local-small, or-luna, or-cheap]
    strategy: least-busy                      # falls back to llm.routing.strategy
    options: {}                               # merged over llm.routing.options
    maxConcurrent: { local: 1, openrouter: 1 }# this pool's lane on each endpoint
    prefer: { zh: [or-deepseek] }             # task variant -> try these first
```

The Router composes them in a fixed order, and the order is the design:

```
capability filter → pool strategy ranks → prefer floats a variant's models up
                  → onOverflow policy → the gateway's fallback chain
```

`prefer` sits *after* the strategy because it is a statement about quality, and
quality outranks both price and queue depth. It is a stable reordering and never a
filter, so the rest of the pool remains the fallback chain.

### 5.2 Concurrency: endpoints, lanes, claims

`src/llm/Lanes.ts` owns everything about who may talk to whom, and it separates two
things a single number would confuse:

| | what it is | who enforces it |
|---|---|---|
| `llm.endpoints[].maxConcurrent` | what the provider tolerates | endpoint semaphore |
| `pools.<pool>.maxConcurrent.<endpoint>` | this pool's share of it | lane semaphore |

The schema refuses lanes that sum to more than the endpoint allows: a lane divides a
cap, it never raises one. A pool's free capacity is whichever runs out first, so an
endpoint saturated by another pool reads as full rather than as available.

**Claims** are the routing input and **semaphores** are the enforcement. The gateway
claims a lane synchronously, in the same tick as the ranking that produced the chain,
which closes the race that would otherwise make `least-busy` advisory: three tasks
starting together would all read "the local model is free", all choose it, and two
would then block on a semaphore they could have avoided. The claim moves with the
call on fallback and is released when the logical call ends. The lane semaphore is
acquired *before* the endpoint's — never after, or a pool whose lane is full would
hold an endpoint slot while waiting for one.

### 5.3 Watching a run happen

`src/observability/ProgressLog.ts` writes `progress.log` in the project root: one
plain line per finished task, plus a line for every retry, fallback and
written-off target. It is the only output of this tool meant to be read *during*
a run rather than replayed after one.

```
[22:40:01] [extract]   '\ru\abiton.bio.json' : local-small:gemma4-31b-local (35.0s)
[22:40:36] [translate] ! 'abiton -> de' fallback local:local-small -> omniroute:or-luna - output_truncated: ...
[22:41:38] [translate] '\de\abiton.bio.md' : or-luna:cx/gpt-5.6-luna (32.4s)
```

Two seams make it possible, and both were widened rather than worked around:

| question | who knows | how it gets there |
|---|---|---|
| which model answered | `LlmGateway` | `AttemptRecord.correlationId` + `.modelName` |
| which task is finished | `Orchestrator` | `progressLog.taskFinished(...)` |

The join key is the task id, which every pipeline already sets as the
request's `correlationId`. Incidents arrive through `GatewayObserver`
(`RetryInfo` / `FallbackInfo` / `TargetDownInfo`, all now carrying `pipeline`
and `correlationId`), so an incident can name the task it interrupted.

Writes are buffered and flushed at most once per `logging.progressIntervalMs`,
and at least once per interval while anything is pending - a timer, unref'd, so
it never holds the process open.

### 5.4 Fallback for a wrong answer

`LlmGateway` falls back when a **call** fails. `Orchestrator.executeTask` falls
back when a **task** fails — which is a different event, and the one that
produces no file:

| what failed | who notices | what happens |
|---|---|---|
| the request | `LlmGateway` | retry, then the next target in the chain |
| one fragment of a batch | `stringBatch` `verify`, inside `validate` | re-ask that key, then the chain |
| the assembled document | the pipeline, after every call succeeded | `taskFallback`: run the task again elsewhere |

`ExecutionContext.llm` is an `LlmPort`, so the orchestrator can hand each attempt
an `AttemptScope` — a wrapper that carries `AttemptTuning` (`avoid`, `strategy`,
`temperature`) into every call and records which targets answered. No pipeline
knows any of this exists.

Composition inside the router is then:

```
capability filter → pool strategy ranks → prefer floats → avoid demotes → onOverflow policy
```

`avoid` sits after `prefer` on purpose: a preference is a claim about quality, a
target that just failed this task is evidence.

## 6. Token & cost optimization

1. **Cache-friendly message assembly.** `MessageBuilder` always emits
   `[stable system][stable instruction block][volatile document block]`, in that
   order, so prompt-cache prefixes stay identical across documents. Nothing
   run-specific (timestamps, file paths, counters) ever enters the prefix.
2. **Escalating context strategies.** A strategy returns an *ordered list of
   attempts*, cheapest first; the pipeline stops at the first attempt whose result
   is accepted.

   | strategy | attempts |
   |---|---|
   | `full` | whole document |
   | `truncation-first` | head slice → whole document |
   | `chunked` | document split into token-bounded chunks, results merged |
   | `staged` | head slice → head+tail → chunked |

   Acceptance is the pipeline's decision (e.g. "all required fields present"), so
   the escalation ladder is reusable across task types.

   Where that check runs matters. On every rung but the last it runs *after* the
   call, so a rejected cheap result escalates the **context** — the cheap move.
   On the last rung there is no cheaper recourse, so acceptance runs *inside* the
   call's validator, where a rejection becomes an ordinary validation failure and
   inherits retry and fallback to a stronger **model**. Cheap axis first, expensive
   axis last.
3. **Send prose, not documents.** The largest saving is not shaving words off a
   prompt — it is not sending the parts that never needed translating.

   `extractTextSpans` lifts the translatable text out of a Markdown article and
   `collectUnits` does the same for a dossier. Heading hashes, list bullets,
   table pipes, `:::` containers and their `src:`/`position:`/`size:` attributes,
   fenced code, every URL, and — for dossiers — `dates`, `ranking`, `url`, every
   media `target` and every unknown field all stay on this side. What crosses the
   wire is a flat `{contentHash: text}` table; what comes back is
   `{contentHash: translation}`; the output is rebuilt locally by substitution.

   Three consequences, and only the first is about cost:

   - markup and URLs are never billed, and a `bio.md` collapses to its words;
   - **structure is preserved by construction.** A `:::` block that was never
     sent cannot come back broken, and an invariant field copied from the source
     cannot be rewritten. The structure guard becomes a safety net rather than
     the defence;
   - because the key *is* the hash of the text, a repeated string — `Гитарист`
     in every dossier, a boilerplate paragraph — is translated **once**
     (`TranslationMemory`), and a key that comes back missing or malformed is
     caught rather than silently written out.

   Link targets inside a sentence are masked as `⟦1⟧` rather than removed, so the
   translator still sees a whole sentence while the URL costs nothing; every mask
   is checked for survival before the result is accepted.

   Whole-document translation remains available as `tasks.translate.mode:
   document` for cases where maximum surrounding context matters more than cost.
4. **Repair the gap, not the batch.** Models answer 39 of 40 keys often enough
   that it must not cost a second full batch — and it did: a run journal here
   showed two identical, separately billed translation calls because one
   fragment of twenty was dropped.

   So the first call for a batch accepts a **partial** answer, and only the keys
   that are missing or malformed are re-asked, on their own. The last repair
   round is strict, so a gap that survives repair still becomes an ordinary
   validation failure and inherits retry-then-fall-back-to-a-stronger-model — on
   a payload of the few keys that need it. A response that is unusable *as a
   whole* (no JSON, not an object) skips the ladder and fails immediately, since
   re-asking for individual keys cannot repair it.

   The same cheap-axis-first shape as the context ladder, one level down:
   `tasks.*.repairAttempts: 0` collapses it back to all-or-nothing.

   A fragment with no letters in it — a year span, a lone placeholder — is never
   sent at all. It has no words to translate, and it was a recurring reason for a
   model to drop a key.
5. **Say what to do about reasoning.** Reasoning tokens bill at the output rate
   and routinely exceed the answer: 78% of the output tokens in one measured run
   here. `reasoning.dialect: none` sends no reasoning parameter and leaves the
   model's default in place; **any other dialect states the intent in both
   directions**, so `enabled: false` is an instruction to stop rather than mere
   silence. That distinction is the only way to quiet a model that reasons unless
   told otherwise. `exclude` hides the traces; it does not make them free, and the
   run summary now names the reasoning share so the cause is visible.
6. **Budgets.** `cost.budget` caps requests / tokens / USD per run; exceeding it
   stops or warns per config.
7. **Skip work.** Resume by fingerprint plus `output.onExisting: skip` means a
   re-run over an unchanged corpus issues zero LLM calls. With
   `tasks.*.useTranslationMemory: persistent` a re-run over a *grown* corpus pays
   only for the strings that are new — the cache file is namespaced by prompt
   version, so editing a prompt starts a fresh one rather than handing back the
   strings the edit was meant to change.

## 7. Prompts

Every task type owns template files under `prompts/`:

```
prompts/
  extraction/{system.md,user.md}
  translation/{system.md,user.md}
```

Rendered by a small Eta-backed engine. Templates are hashed into
`promptVersion`, which feeds task fingerprints — so a prompt edit is a real,
tracked change. Templates are loaded once and cached; `biomd prompts` renders one
with sample variables for inspection and diffing without spending tokens.

## 8. State, resume and observability

Per-run directory (`.biomd/runs/<runId>/`):

| File | Purpose |
|---|---|
| `run.json` | manifest: config hash, versions, counts, final summary |
| `events.jsonl` | append-only journal — one JSON object per event |
| `state.json` | checkpoint: fingerprint → status, rewritten atomically |

Resume (`--resume` / `--resume <runId>`) replays `state.json`, skips tasks whose
fingerprint is recorded `completed`, and re-plans everything else. The journal is
the machine-readable protocol asked for: it captures task lifecycle, every LLM
request (target, attempt, latency, usage, cost, retry/fallback reason), every error
with its classification, and artifact writes.

Metrics tracked live: files, tasks by status, LLM requests, retries, fallbacks,
errors by kind, prompt/completion/cached tokens, estimated cost.

## 9. Configuration

One YAML file, validated by Zod, layered:

```
defaults  <  config file  <  ${ENV} interpolation  <  CLI flags
```

Invalid config fails fast with a path-annotated message before any work starts
(`biomd config check`). Secrets are referenced as `${VAR}` and never written to the
journal — endpoint entries are redacted on serialization.

## 10. Extension points

| To add… | Implement | Register at |
|---|---|---|
| new per-document task | `DocumentPipeline` | `PipelineRegistry` |
| new aggregation | `CorpusPipeline` | `PipelineRegistry` |
| new routing rule | `RoutingStrategy` | `RoutingStrategyRegistry` |
| new context tactic | `ContextStrategy` | `ContextStrategyRegistry` |
| new source of documents | `SourceProvider` | container |
| new output destination | `ArtifactWriter` | container |
| new transport | `LlmClient` | `LlmClientFactory` |
| new token estimator | `TokenEstimator` | container |
| new progress UI | `ProgressReporter` | cli |

## 11. Deliberate non-goals for v0.1

- No web UI, no daemon, no queue server — a CLI over a local corpus.
- No streaming responses (batch work does not benefit; it complicates accounting).
- No embeddings / vector store.
- No provider-native batch APIs yet (the `LlmClient` contract leaves room).
