# biomd-process — Architecture

**Status:** v0.1 skeleton · **Scope:** generic LLM batch-processing platform, with
`bio.md` handling attached as replaceable adapters.

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

The v0.1 goal is the **platform**, not the domain. Everything that depends on the
exact shape of a `bio.md` or of `MetaData.json` sits behind a narrow contract, and
the point of that separation is that filling one in must not require touching
orchestration, routing, retry, state or CLI code. That property is the actual
deliverable, and it held: the domain rules below were added afterwards, entirely
within their contracts.

| Rule | Where it lives now |
|---|---|
| `DD.MM.YYYY` dates, list punctuation, uppercase document types, `ranking` range | `src/pipelines/extraction/normalize.ts` |
| The v2 rule that `id`/`title`/`gender`/`type`/`country`/`bio`/`dataStatus` are index facts, not dossier fields | `normalize.ts` — lifted out and routed to the catalogue |
| Chunk merge: union list fields, first-wins scalars | `src/pipelines/extraction/merge.ts` |
| Markdown structure tolerance (`strict` \| `lenient` \| `off`) | `src/documents/markdown/skeleton.ts`, `StructureGuard` |
| ASCII `title`, romanization, search aliases | `src/pipelines/catalog/{names,romanize}.ts` |
| Catalogue classification (`type`, `gender`, `country`) | noticed by `extract`, consumed by `catalog` — see §6a |

What is still open is listed as `TODO(domain)` in the code; grep for it.

### §6a — how `catalog` classifies without calling a model

`Catalog-Index.md` §1 assigns `type`, `gender`, `country` and the Latin `title`
to `index.json`, and `MetaData.md` forbids them in a dossier. Neither is
derivable from a dossier — but all four are derivable from the **article**, which
`extract` has open anyway.

So `extract` asks for them in a `catalog` key, `normalize.ts` lifts them out of
the dossier before it is written, and they land on the `catalogHints` channel.
`catalog` reads them and stays LLM-free, with a strict precedence: **an existing
index row wins**, then the hint, then the configured default. An index row is the
one artefact here a human may have edited, so nothing derived overwrites it.

The alternative — a second classification pass over the corpus — would have cost
a full extra round trip per entry to learn what the first pass already knew.

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
        │ └────┬────┘    └─────────────┘  └────────────┘ └─────────────┘
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
| `io` | discovery, path templates, atomic artifact writing | pipelines |
| `state` | run journal, checkpoints, fingerprints, resume | pipelines |
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
shape (estimated input tokens, expected output tokens, required capabilities), live
endpoint stats, and the attempt index.

Built-ins: `cost-optimized` (cheapest that fits), `context-optimized` (largest
usable window / best fit), `sequential` (declared order — classic primary→fallback),
`round-robin` (spread load). Custom strategies register by id:

```ts
routingRegistry.register({ id: 'my-strategy', select: ctx => [...] });
```

A strategy only ranks; it never calls anything. All of them get filtering for
capability and context fit for free from `RoutingContext.candidates`.

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
