# Architecture — scheduling, the call path, routing, state

The parts of the design that take several files to see. Full prose version:
[docs/ARCHITECTURE.md](../ARCHITECTURE.md). Where to find a symbol:
[source-map.md](source-map.md).

## Data model

```
WorkItem (= one discovered *.bio.md, id = slug+lang)
  → PlannedTask per (pipeline, variant)     e.g. translate×en, translate×de, localize×en
    → TaskResult { artifacts[], usage, cost, notes[] } → ArtifactWriter → file on disk
```

**Pipelines return artifacts; they never write files.** That is what makes `--dry-run` free and
pipelines unit-testable without touching disk.

## Scheduling — waves, not a DAG

A pipeline declares prerequisites structurally:
`TaskDependency { pipeline, variant?, scope: 'item'|'all', optional? }`. `JobPlanner` resolves
them to task ids; `Orchestrator` runs the plan in **dependency waves** (p-queue).

Waves rather than a general DAG because pipelines are 2–3 stages deep, and a wave boundary is
exactly the guarantee `catalog` needs — everything it indexes has already landed.

- A dependency matching nothing is **dropped**, not failed.
- A task whose prerequisite failed is retired `dependency-failed`, never run, never billed.
- A wave opens on its dependencies being **settled** — completed *or* failed — not on succeeding.

### `optional: true` separates the ordering barrier from the prerequisite

Load-bearing for any aggregation. A corpus-scope dependency resolves to *every* task of that
pipeline, so under an all-or-nothing rule one document failing one translation retired `catalog`
and no `index.json` was written **for the entire corpus** — two hundred good entries losing their
rows to a neighbour's bad luck.

`catalog`'s five dependencies are therefore **ordering only**: it reads the disk rather than the
plan, and a language whose translation failed is simply absent from that entry's editions.
`websearch` is optional to `localize` and `portrait` for the same reason — it only ever *adds* to
a dossier `extract` already wrote.

`PlannedTask` carries both lists: `dependencies` gates the wave, `requiredDependencies` gates
retirement.

> Mark a dependency optional only where the dependent genuinely degrades. One that would silently
> publish a worse answer should stay required and be retired instead.

### Two ids per task — `src/state/Fingerprint.ts`

| Id | Formula | Purpose |
|---|---|---|
| `taskId` | `hash(pipeline, workItemId, variant)` | stable identity across runs |
| `fingerprint` | `hash(taskId, sourceContentHash, promptVersion, contract)` | what resume compares |

The fingerprint **deliberately excludes the model and the routing strategy**, so adding a fallback
model never invalidates the whole corpus.

## LLM call path

```
Pipeline → runWithEscalation()                         [src/pipelines/shared/escalation.ts]
  → LlmGateway.complete(request, policy)
      Budget.check() → Router.select() [ordered ModelTarget[]] → for target in candidates:
        CircuitBreaker.guard → RateLimiter.acquire → RetryPolicy.run(withTimeout(client.chat))
          → ErrorClassifier → retryable? / fallbackable? / fatal?
```

**Retry (same target) and fallback (next target) are separate axes**, driven entirely by the
`LlmErrorKind → Disposition` table in `src/reliability/errors.ts`.

> Extend that table. Never match provider message strings at a call site.

Two kinds are special:

- `context_length` is reported back as a typed signal so the pipeline can escalate its *context
  strategy* instead of just failing;
- `output_truncated` is **fallbackable but not retryable** — the payload was accepted and the model
  ran out of room, so re-asking buys the identical cut. Only a wider target or a smaller request
  changes anything; `isOutputTruncated` lets a caller that can shrink its request do so.

One transport (`OpenAiCompatibleClient`) covers every OpenAI-compatible endpoint — LiteLLM,
OmniRoute, 9router, vLLM, Ollama's shim, OpenRouter, OpenAI — via `baseUrl` plus per-endpoint
`headers`/`query`. Reasoning is emitted in whichever dialect a model declares
(`reasoning_effort` | `reasoning` | `thinking` | `none`).

## Routing

`RoutingStrategy.select(ctx): ModelTarget[]` ranks a pool and **never calls anything**. Built-ins:
`cost-optimized`, `context-optimized`, `sequential`, `round-robin`, `least-failures`, `least-busy`.
Custom strategies register via `app.strategies.register(defineStrategy(id, description, select))`.

### A pool is a list or an object; the object is where the three per-pool decisions live

`translate: [a, b, c]` is the shorthand and still means what it did. The expanded form adds
`strategy`, `maxConcurrent`, `prefer`, `options` — each a thing a *global* setting cannot express,
because the stages are scarce in different resources: **extraction in money, translation in
wall-clock, web search in "a model that can actually search"**. A global `strategy:` is now the
**default a pool inherits**, not the only answer. A per-pool strategy id that does not resolve
fails when the app is built, not on the one call that uses that pool.

### `least-busy` — the scarce resource in a translation run is time

`cost-optimized` ranks the free local model first for every request, which is right about price
and, at `run.concurrency: 3` against an endpoint serving one request at a time, turns three
concurrent tasks into one while two endpoints sit idle. `least-busy` ranks the **emptiest**
endpoint first and breaks the tie on cost — so an untouched pool behaves exactly like
`cost-optimized` and only differs once something is busy.

It ranks on **how full** an endpoint is, never on how many slots it has left. An endpoint allowing
three parallel requests has three free slots while idle and one allowing a single request has one,
so a count would hand the generous endpoint every request from the first onward — precisely the
imbalance the strategy prevents. As a fraction of capacity, idle is idle.

### Concurrency is counted twice, on purpose — `src/llm/Lanes.ts`

An endpoint's `maxConcurrent` is a fact about the provider. A **lane**
(`llm.routing.pools.<pool>.maxConcurrent.<endpoint>`) is this pool's share of that budget, and the
schema refuses lanes summing above the endpoint's cap: **a lane divides a cap, it never raises
one.** A pool's free capacity is whichever runs out first, so an endpoint another pool is
saturating correctly reads as full.

Two mechanisms enforce it and they are not interchangeable:

- **Claims** are the routing *input* — the gateway claims a lane in the **same synchronous tick**
  as the ranking that chose it. Without that, three tasks starting together all read "the local
  model is free", all pick it, and two block on a semaphore they could have avoided.
- **Semaphores** are the *enforcement*, and still apply when the chain has nowhere else to go.
  Ranking is advice; a cap is a cap.

The lane semaphore is acquired **before** the endpoint's, never after, so a pool whose lane is full
never occupies an endpoint slot while waiting.

### `prefer` — a language naming its own model

`llm.routing.pools.<pool>.prefer.<variant>` floats models to the front for one task variant —
for `translate`/`localize`, the target language. A Chinese open-weights model renders Chinese and
Japanese better than a Western one and the reverse holds for European languages: a fact about the
language, not the run.

Applied **after** the strategy has ranked, so quality outranks price and queue depth. It is a
**reordering, never a filter** — the rest of the pool stays behind as the fallback chain, so a
preference can slow a language down and can never make it unroutable. A `prefer` entry naming a
model the pool does not contain is a **config error**, not a line that silently does nothing.

### A pool is the fallback chain, and a pool of one has none

Retry, fallback and circuit breaking all run out at the end of the ranked list, so a single-model
pool turns every transient failure into a failed document (`All 1 model target(s) failed`). The
hybrid pattern in `config/examples/` exists for this.

### Fit is two windows, not one — `Router.buildContext`

A target must both **hold** the prompt and **emit** the expected answer. Only the first used to be
checked, so a 64K window with an 8K output ceiling accepted a long article and cut its translation
off mid-sentence. `RoutingContext.fits` now requires `outputHeadroom ≥ 0` as well.

`llm.routing.onOverflow` decides the consequence: `demote` (default) ranks it last but still calls
it if nothing else is left; `skip` drops it so the doomed call is never made. **Neither ever routes
nowhere** — when no target fits, the least-overloaded one is still tried, because a real provider
error names a mis-sized pool better than silence does.

### Fallback one level up: the answer was wrong, not the call

`reliability.taskFallback` · `src/core/AttemptScope.ts` · `Orchestrator.executeTask`.

Everything above answers *this call failed*. None of it answers *every call returned 200 and the
document they add up to is broken* — only the task that assembled the document knows that, and it
arrives as a pipeline error long after the last successful response.

So the task is run again, and what varies between attempts is deliberately small: targets that
already failed it are **demoted** (`RoutingRequest.avoid`) so a fresh one leads the chain; the last
attempt — with nobody new to ask — changes *how* it asks via `lastAttempt.strategy` and
`lastAttempt.temperature`. Demotion rather than exclusion, because a pool of three that has used
all three still has to route somewhere. Applied **after** `prefer`: a language preference is a
claim about quality, and a model that just produced a broken answer for this task is evidence.

`ExecutionContext.llm` is an `LlmPort` rather than the gateway itself so the orchestrator can wrap
it — that is what gave `extract`, `translate`, `websearch` and `localize` this at once without a
line changing in any of them. A pipeline holding a cache does need to know, and gets
`ExecutionContext.attempt`.

**Two failures are deliberately not retried.** One that never reached a model is deterministic — an
unreadable source, a bad path template — and three goes is three times the wall-clock for the same
error. And a call that exhausted its chain has already had this treatment one level down, so
re-running meets the same chain in a worse state and the report names an open circuit instead of
the failure that opened it. **The exception is the reason the mechanism exists:** when those
targets failed by *answering badly* (`response_format`) rather than by failing, the models are
alive, the answers were wrong, and asking again more literally is a genuinely different question.

## State, resume, observability

Every run writes `.biomd/runs/<runId>/`:

| File | Contents |
|---|---|
| `run.json` | manifest |
| `events.jsonl` | append-only: every request, retry, fallback, error, artifact write, plus each task's **notes** |
| `state.json` | checkpoint, fingerprint → status |

`--resume` / `--resume-run` replays the checkpoint and skips completed fingerprints;
`biomd report [runId]` reads them back afterwards.

**Only `resume` and `existing-output` count as done** (`isTaskDone`). Everything the orchestrator
*retires* — `dependency-failed`, `run stopped`, `aborted` — describes a task that never ran.

> Add a skip reason to that whitelist only if it means the artifact is on disk.

`.biomd/`, `out/` and `dist/` are git-ignored.

### `progress.log` — the one surface written to be read *while* the run happens

`src/observability/ProgressLog.ts`, `logging.progressFile`. Everything else is for a machine to read
back afterwards and is unreadable while you are waiting four hours. One plain line per finished
task in the project root, appended, `tail -f`-able:

```
[22:40:01] [extract]   '\ru\abiton.bio.json' : local-small:gemma4-31b-local (35.0s)
[22:40:36] [translate] ! 'abiton -> de' fallback local:local-small -> omniroute:or-luna - output_truncated: ...
[22:41:38] [translate] '\de\abiton.bio.md' : or-luna:cx/gpt-5.6-luna (32.4s)
```

Four things are load-bearing:

- **The model is joined to the task** by the task id, which every completion request already carries
  as its `correlationId`. `AttemptRecord` carries it plus the wire `modelName`. **The last success
  wins**, so a task that fell back is credited to the model that did the work.
- **A line with `!` is an incident** — a retry, a fallback, or a target written off for the run —
  and it exists so the line under it is explicable. `grep ' ! ' progress.log` is the incident
  report. Incidents name their task, because the file they are about may never exist.
- **Which file a line is about** is: published outputs, else whatever was written, else the task's
  own label. `extract` writes a dossier *and* an internal `.hints/` hand-off and only the first
  earns a line — but `portrait`'s whole product *is* a hint file.
- **Writes are buffered and flushed at most once per `logging.progressIntervalMs`** — equally a
  floor and a ceiling, so a line arriving just after a flush does not wait for the next task.
  `--dry-run` writes nothing.

### Making silence audible

A pool's whole point is that one target dying is survivable, which also makes a first choice that
never works invisible. Three things make it audible without changing what the run does:

- **`onTargetDown`** — fired **once** per target, the first time it is written off (non-retryable
  failure, `model_unavailable`, or a circuit already open). A fallback is normal; a target that
  never works is a config bug.
- **the target health table** in the run summary — requests, successes, failures, latency and cost
  per target, with a named call-out for any target that served **zero** of its requests.
- **`biomd models --probe`** — the pre-flight. Reading `/v1/models` would not have caught this:
  `cx/gpt-5.6-luna` was listed the whole time and rejected every completion. Only a real call
  distinguishes declared from working.

See [failure-modes.md](failure-modes.md) for what each of these caught.
