# Throughput and cost — configuring for one or the other

The mechanisms are in [architecture.md](architecture.md#routing); the endpoint facts are in
[providers.md](providers.md). This file is the operational half: which knobs to turn, in what
order, and how to tell whether they worked.

## The one-paragraph version

**Extraction is scarce in money; translation is scarce in wall-clock; web search is scarce in
"a model that can actually search".** A single global `strategy:` forces all three to pretend
otherwise, which is why a pool may override it. The measured difference on three articles into
English at `run.concurrency: 3` was **1m 43s → 34s**, same output, $0.00012 of it paid — not
faster models, three of them working instead of one.

## Why the default is slow, precisely

`cost-optimized` ranks the free local model first **for every request**, which is right about
price and wrong about time:

```
run.concurrency: 3, strategy: cost-optimized, no lanes

  task A ─┐
  task B ─┼─→ local-small  (llama-server, 1 slot)  →  serialised
  task C ─┘
             omniroute   idle for the whole run
             openrouter  idle for the whole run
```

The pool is not the constraint and neither is `run.concurrency`. The constraint is that **ranking
alone decides where a request goes**, and every request ranks the same list identically.

## The four knobs, in the order they matter

### 1. `strategy: least-busy` on the pool that is time-scarce

Ranks the **emptiest endpoint** first and breaks the tie on cost. An untouched pool therefore
behaves exactly like `cost-optimized`; it only starts to differ once something is busy.

It ranks on **how full** an endpoint is — a fraction of capacity — never on free slot count. An
endpoint allowing three parallel requests has three free slots while idle and one allowing a single
request has one, so a count would hand the generous endpoint every request from the first one
onward. **As a fraction of what each can hold, idle is idle.**

```yaml
translate:
  models: [gemma-local, gpt-luna, deepseek, minimax-m3]
  strategy: least-busy
```

### 2. Lanes — `maxConcurrent` per pool per endpoint

An endpoint's own `maxConcurrent` is a fact about the provider. A **lane** is this pool's share of
it, and the schema refuses lanes summing above the cap: **a lane divides a cap, it never raises
one.**

```yaml
translate:
  strategy: least-busy
  maxConcurrent:
    local: 1          # llama-server has one slot; this is arithmetic, not policy
    omniroute: 4      # safe only because the endpoint sets stream: true
    openrouter: 3     # the only paid endpoint — cap it deliberately
```

Without a lane the most permissive endpoint takes the majority of the corpus simply because it says
yes more often — and here that is also the one that bills. One slot each keeps all three busy and
the bill on the free two.

Enforcement is two mechanisms that are **not interchangeable**:

- **Claims** are the routing input — the lane is claimed in the same synchronous tick as the
  ranking that chose it. Without that, three tasks starting together all read "the local model is
  free", all pick it, and two block on a semaphore they could have avoided.
- **Semaphores** are the enforcement and still apply when the chain has nowhere else to go.
  Ranking is advice; a cap is a cap.

The lane semaphore is acquired **before** the endpoint's, so a pool whose lane is full never
occupies an endpoint slot while waiting.

### 3. `run.concurrency` ≥ the number of lanes

**This is the one most often forgotten, and it silently undoes the other two.** Lanes are permission
to run in parallel; `run.concurrency` is how many tasks the orchestrator has in flight at all. With
8 lanes and `concurrency: 3`, five lanes are never filled — the orchestrator runs out of tasks
before the endpoints run out of slots.

```
sum(lanes)  ≤  sum(endpoint maxConcurrent)      enforced by config check
run.concurrency  ≥  sum(lanes in the busiest pool)   your job
```

### 4. `prefer` — quality, applied after ranking

`prefer.<variant>` floats models to the front for one task variant, which for `translate` and
`localize` is the target language. Applied **after** the strategy ranks, so quality outranks both
price and queue depth — and it is a **reordering, never a filter**, so a preference can slow a
language down and can never make it unroutable.

```yaml
prefer:
  de: [gpt-luna]        # the only family that transliterates into German
  en: [gpt-luna]
  es: [minimax-m3]
  fr: [deepseek, minimax-m3]
  zh: [deepseek]
  ja: [deepseek]
  ko: [deepseek]
  it: [deepseek]
```

A `prefer` entry naming a model the pool does not contain is a **config error**, not a line that
silently does nothing.

> Note the interaction: `prefer` pins a language to one endpoint, which partially defeats
> `least-busy` for that language. That is the intended trade — a German edition from the right
> model is worth more than a German edition sooner — but it means a corpus translated into **one**
> preferred language will queue on one endpoint however many lanes you grant.

---

## Three configurations

### Maximum throughput — a large corpus, cost secondary

```yaml
run:
  concurrency: 8              # ≥ sum of lanes below
llm:
  endpoints:
    - id: local        { maxConcurrent: 1 }                    # server-limited
    - id: omniroute    { maxConcurrent: 4, stream: true }      # stream is mandatory above 1
    - id: openrouter   { maxConcurrent: 4, minRequestSpacingMs: 300 }
  routing:
    onOverflow: skip          # never pay for a call that cannot finish
    pools:
      extract:
        models: [gemma-local, gpt-luna, deepseek]
        strategy: least-busy
        maxConcurrent: { local: 1, omniroute: 2, openrouter: 2 }
      translate:
        models: [gemma-local, gpt-luna, deepseek, minimax-m3]
        strategy: least-busy
        maxConcurrent: { local: 1, omniroute: 2, openrouter: 2 }
```

Ceilings to know before raising anything further:

| Ceiling | Where |
|---|---|
| `llama-server` serves **1 slot** | server-side; needs `--parallel`, not config |
| OmniRoute `COMBO_CONCURRENCY_PER_MODEL` = 3 *(upstream default)* | arguing with it above 3 gains nothing |
| OmniRoute `OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT` = 1 *(upstream default)* | a >256 KB body **queues**; `mode: segments` stays well below |
| OmniRoute `RELAY_IP_PER_MINUTE` = 30 *(upstream default)* | tighter than this project's `requestsPerMinute: 60` if the install kept it |
| a token bucket **starts full** | `requestsPerMinute: 60` permits 60 simultaneous requests and then a minute of silence. `minRequestSpacingMs` is the honest floor `requestsPerMinute` cannot express |

### Minimum cost — a small corpus, or a prompt experiment

```yaml
run:
  concurrency: 2
  skipExistingOutputs: true
llm:
  routing:
    strategy: cost-optimized     # free local model first for everything it can serve
    onOverflow: skip
    pools:
      extract:   { models: [gemma-local, deepseek], strategy: cost-optimized }
      translate: { models: [gemma-local, gpt-luna], strategy: cost-optimized }
cost:
  budgetUsd: 0.50                # a hard stop, checked before each call
  maxRequests: 200
tasks:
  extract:   { onExistingDossier: reuse }
  translate: { useTranslationMemory: persistent, repairAttempts: 1 }
```

The largest savings are not here, though — they are the calls never made. See
[cost-mechanisms.md](cost-mechanisms.md), especially §8 (three settings read at plan time) and §3
(`foreignFragments: keep` drops 11% of fragments on `input/ru` before anything is sent).

### Reproducibility — measuring a prompt change

```yaml
run: { concurrency: 1 }
llm:
  routing:
    strategy: sequential          # declaration order; the first entry is what runs
    pools:
      translate: { models: [gemma-local] }
tasks:
  translate:
    useTranslationMemory: off     # a memory hit is not a measurement
```

and on the target: `params: { temperature: 0, seed: <fixed> }`. A pool of one has no fallback
chain, which is wrong for a batch and exactly right for an experiment.

> **A cached rendering is not a fresh answer**, and neither is an OmniRoute response-cache hit.
> Vary a nonce, or turn the memory off, or the "before" and the "after" are the same bytes.

---

## Verifying it worked

**During**, in another terminal:

```bash
tail -f progress.log
```

Endpoint spread is visible directly — the `endpoint:model` field after each artifact. Three
different endpoints on three consecutive lines is the win; the same one on every line means the
ranking is not spreading.

```bash
grep ' ! ' progress.log
```

Every incident: a retry, a fallback, a target written off for the run.

**After:**

| Check | What it tells you |
|---|---|
| the run summary's **target health table** | requests, successes, failures, latency and cost per target. A target serving **0** of its requests is a config bug wearing a successful run |
| `npm run biomd -- report <runId>` | totals, failures, and `--notes` for decisions that produced no file |
| wall clock ÷ documents | compare against the serial baseline before deciding a change helped |

**Before:**

```bash
npm run biomd -- models --probe
```

```bash
npm run biomd -- run --dry-run
```

`--dry-run` prints the plan, the model chain and the estimated cost, and spends nothing. `--probe`
is the only thing that distinguishes a declared target from a working one.

---

## Symptom → cause

| Symptom | Likely cause |
|---|---|
| every line in `progress.log` names one endpoint | `cost-optimized` on a time-scarce pool, or no lanes |
| lanes configured, still serialised | `run.concurrency` below the lane count |
| one language is slow, the rest are fast | `prefer` pinning it to a single endpoint |
| `All 1 model target(s) failed` | a pool of one — no fallback chain exists |
| a paid target served the whole corpus | the free first choice was down. `--probe`; read the health table |
| every web search hit the paid target | `sequential` with the paid entry first, or `cost-optimized` breaking a zero-price tie by declaration order |
| the fourth pool entry never gets used | `reliability.fallback.maxTargets` truncates the chain |
| answers are correct but about the wrong subject | OmniRoute buffered-overlap cross-talk — `stream: true` |
| a long article is cut off mid-sentence | `maxOutputTokens` understated, or `onOverflow: demote` calling a target that cannot finish |
| `404 No endpoints found that can handle the requested parameters` | working as intended: `requireParameters: true` caught a provider that would have dropped your samplers |
| a re-run finishes implausibly fast | OmniRoute response cache, or `run.skipExistingOutputs`, or a translation-memory hit |
