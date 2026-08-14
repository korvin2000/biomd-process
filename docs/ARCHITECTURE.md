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
exact shape of a `bio.md` or of `MetaData.json` sits behind a narrow contract and
is marked `TODO(domain)`. The pieces below are deliberately *not* finished in v0.1:

- the metadata target schema (`src/pipelines/extraction/MetadataContract.ts`)
- extraction chunk-merge rules for comma-separated list fields
- tolerances for Markdown structure equivalence
- catalogue classification: `type`, `gender`, `country`, romanized `title`,
  and search aliases (`src/pipelines/catalog/names.ts`)

Replacing any of them must not require touching orchestration, routing, retry,
state or CLI code. That property is the actual deliverable.

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
        │ ┌────▼────────────────┐
        │ │ routing │ reliability│
        │ └─────────────────────┘
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
     in every dossier, a boilerplate paragraph — is translated **once per run**
     (`TranslationMemory`), and a dropped or invented key is a validation failure
     the gateway retries rather than a silently damaged output.

   Link targets inside a sentence are masked as `⟦1⟧` rather than removed, so the
   translator still sees a whole sentence while the URL costs nothing; every mask
   is checked for survival before the result is accepted.

   Whole-document translation remains available as `tasks.translate.mode:
   document` for cases where maximum surrounding context matters more than cost.
4. **Budgets.** `cost.budget` caps requests / tokens / USD per run; exceeding it
   stops or warns per config.
5. **Skip work.** Resume by fingerprint plus `output.onExisting: skip` means a
   re-run over an unchanged corpus issues zero LLM calls.

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
