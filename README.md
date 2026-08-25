# biomd-process

Batch-process `bio.md` Markdown documents with LLMs. Six task types ship with it:

- **`extract`** — heuristic metadata extraction into a dossier JSON.
- **`websearch`** — the facts the article does not contain, from a model with web
  search; also re-checks a death the article is too old to mention.
- **`translate`** — structure-preserving translation into a configurable list of
  languages.
- **`localize`** — the per-language *edition* of the dossier, with the
  language-invariant fields copied verbatim.
- **`portrait`** — LLM-free selection of the entry's portrait out of an existing
  image index.
- **`catalog`** — optional, LLM-free aggregation into `index.json` and the
  `index-<lang>.json` name files.

Any combination can run in one job. With all of them on, `ru/paco.bio.md` produces:

```
out/ru/paco.bio.json    dossier extracted from the article, completed from the web
out/en/paco.bio.md      translated article
out/en/paco.bio.json    dossier localized into English
out/index.json          catalogue index (incl. the chosen portrait) + index-en.json, index-ru.json
```

> **Status: v0.6.** Orchestration, routing, reliability, cost control, resume and
> observability were complete in v0.1 and are largely unchanged. The published
> format lives in `src/domain`, implemented against the normative specification
> in [`external/`](external/README.md), and `biomd validate` checks the output
> against its invariant list. What each release since has added:
>
> - **v0.3** — the two sources of fact an article does not contain: an image
>   index (`portrait`) and the web (`websearch`). A year-only date is published
>   rather than dropped.
> - **v0.4** — a failure is local. A dependency can be declared *optional*, so
>   one document failing one translation no longer retires the catalogue for the
>   whole corpus; only a task whose output is genuinely on disk counts as done;
>   and a routing candidate must both *hold* the prompt and have room left to
>   *emit* the answer.
> - **v0.5** — what a corpus of a thousand real articles turned out to contain
>   that four samples did not: **collectives** (a duo, a trio, `gender: mixed`),
>   a **second name source** (`data/names.json`, the site's own name list, read
>   by `src/roster`), and quoted **foreign text**, which is kept verbatim
>   instead of being sent to a translator.
> - **v0.6** — *when* and *where* the work goes. Each routing pool picks its own
>   strategy, its share of an endpoint's concurrency, and a preferred model per
>   language, so translation is scheduled across every endpoint at once instead
>   of queueing on the cheapest one (measured 1m 43s → 34s on three articles).
>   The three settings that all mean "this output already exists" are read at
>   plan time rather than after a model has been billed, and `progress.log` is
>   one line per finished task, written to be read *while* the run is going.
>
> The mechanisms behind all of this, their defaults and the reasoning:
> **[docs/ref/INDEX.md](docs/ref/INDEX.md)**.

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

Point `biomd.config.yaml` at your corpus and your endpoints, then:

```bash
npm run biomd -- config check
```

```bash
npm run biomd -- models --probe
```

```bash
npm run biomd -- run --dry-run
```

`--probe` sends one tiny completion to every target and reports who answered;
for a `web_search` target it also requires a provider search call with a
consulted source. A pool is a
fallback chain, so a dead first choice is otherwise invisible until the bill
arrives. `--dry-run` then plans the whole job — documents, tasks, the model
chain each pipeline would use and an estimated cost — without issuing a single
request. Drop the flag to execute.

## Commands

| Command | Purpose |
|---|---|
| `run` | Process the corpus. Default command. |
| `run --dry-run` | Plan only: counts, model chain, estimated cost. Spends nothing. |
| `config check` | Validate the config, resolve paths, load every prompt template. |
| `config show` | Print the effective config with secrets redacted. |
| `models` | List resolved model targets, pools, and a routing preview. |
| `models --probe` | Call every target once; search targets must prove a real search. Exits 1 if any fails. |
| `prompts list` / `prompts show <task>` | Inspect and render templates without spending tokens. |
| `report [runId]` | Summarize a finished run from its journal. `--notes` replays the decisions that produced no file — a refused web answer, a date conflict recorded rather than published. |
| `portrait <who…>` | Search the image index for one entry and print the ranking with its reasoning (`--faces n` for an ensemble). Spends nothing. |
| `validate [dir]` | Check a published catalogue against the format invariants. Spends nothing. |

All of them accept `-c/--config <file>`, and options come *after* the subcommand.

Useful `run` flags: `--only extract,translate`, `--lang en,de`, `--limit 10`,
`--concurrency 8`, `--strategy context-optimized`, `--budget-usd 5`,
`--resume off`, `--fail-fast`, `--skip-existing`.

## How it works

```
corpus ──► JobPlanner ──► tasks ──► Orchestrator ──► artifacts on disk
                │                        │
         resume/fingerprint         LlmGateway ──► route → rate limit → breaker
                                        │              → timeout → retry → validate
                                        └──► journal (events.jsonl) + checkpoint
```

**Models.** Any OpenAI-compatible endpoint: LiteLLM, OmniRoute, 9router, vLLM,
Ollama's shim, OpenRouter, OpenAI. Per model you configure the wire name, context
window, output ceiling, Chat Completions vs Responses API, pricing, capabilities,
reasoning effort and its dialect;
per endpoint, whether answers are streamed.

**Routing.** A strategy ranks an ordered chain of candidates per call —
`cost-optimized`, `context-optimized`, `sequential`, `round-robin`,
`least-failures`, `least-busy`. Pools let each task use a different model set,
and each pool sets its own strategy, its lane of an endpoint's concurrency, and a
preferred model per target language: extraction is scarce in money, translation
in wall-clock, and one global setting could not say both.
→ [docs/ref/architecture.md](docs/ref/architecture.md)

**Reliability.** Retry (same model, bounded exponential backoff with jitter,
honouring `Retry-After`) and fallback (next model) are separate axes driven by a
typed error taxonomy rather than by matching provider message strings. Circuit
breakers stop a run hammering a dead endpoint; client-side rate limiting avoids
earning 429s in the first place. A task whose *answer* was broken
— every call returned 200 and the document they add up to does not hold together
— is run again with the models that failed it demoted. Whatever survives all of
that costs the entry a field, an edition or a row, never the catalogue.
→ [docs/ref/failure-modes.md](docs/ref/failure-modes.md)

**Cost.** By default, translation and localization send **only the prose**, as a
flat `{contentHash: text}` table — markup, code, URLs and a dossier's
language-invariant fields never leave the machine and are spliced back after,
and a fragment not written in the source language is not sent at all. Stable
prompt instructions and the volatile payload are separate messages so provider caches hit across the corpus,
context strategies escalate cheapest-first, a partial answer is repaired
key-by-key rather than re-sent whole, output already on disk is recognized
before a model is called, and budgets in requests, tokens or USD stop a run
before it overspends. → [docs/ref/cost-mechanisms.md](docs/ref/cost-mechanisms.md)

Measured on the sample corpus in `examples/ru`:

| | payload vs. source file | deduplication |
|---|---|---|
| dossier localization | **52% smaller** | 142 → 117 distinct strings (**-18%**) |
| article translation | **18% smaller** (9–26% per file) | negligible between distinct articles |

The structural guarantee matters as much as the bytes: a `:::` block that is
never sent cannot come back unbalanced, and `dates`/`ranking`/`url` are identical
across editions by construction rather than by instruction.

**Asking the right source.** An article that never states a birthplace does not
start stating one on the third context rung, so `websearch` asks a different
source instead — only about fields genuinely missing, sending an eight-line
identity card rather than the article, and nothing personal about a collective.
Search targets use the Responses hosted `web_search` tool. A response is rejected
unless the provider reports a completed search call, and a source URL is accepted
only when it appears in the provider's search evidence.
The portrait is chosen from an image index by name matching, the index's own
classification and the pictures the article itself embeds — no model at all.

**Resume.** Each task carries a fingerprint over its input, its prompt templates
and its output contract. Re-running an unchanged corpus issues zero calls; editing
a prompt correctly redoes exactly the work that prompt affects.

**Observability.** Every run writes `.biomd/runs/<runId>/` with a manifest, an
append-only `events.jsonl` journal (every request, retry, fallback, error and
artifact) and a checkpoint, which `biomd report` reads back afterwards. The
terminal shows live progress; so does `progress.log` in the project root, one
plain line per finished task naming the model that actually answered it, written
to be `tail -f`-able — and `grep ' ! ' progress.log` is the incident report.

## Configuration

One YAML file, strictly validated by Zod at every fixed object layer, layered
`defaults < file < ${ENV} < CLI flags`.
Invalid config fails before any work starts, with the offending path named.
`biomd.config.yaml` in the repo root is a documented working example, and
[docs/ref/config-map.md](docs/ref/config-map.md) is the map of every setting.

Ready-made configs for the common model setups — use with `-c`:

| File | Setup |
|---|---|
| [config/examples/local-only.yaml](config/examples/local-only.yaml) | LiteLLM / OmniRoute / 9router / vLLM / Ollama, nothing leaves the machine |
| [config/examples/openrouter-only.yaml](config/examples/openrouter-only.yaml) | OpenRouter only, with a hard USD budget |
| [config/examples/hybrid.yaml](config/examples/hybrid.yaml) | both: free local model first, paid models as fallback |

The hybrid pattern is the one worth knowing: put the local model first in every
pool and the paid ones behind it. Combined with fallback, the corpus is processed
locally and only the documents the local model actually fails on reach a paid model.

Two sections sit at the root rather than under a task, because several tasks have
to agree about them: `catalogue:` describes the *format's* deployment (supported
languages, date precision, defaults), and `roster:` the optional name roster.

Secrets are referenced as `${VAR}` / `${VAR:-fallback}` and are redacted
everywhere they would otherwise be written.

## Prompts

Templates live in `prompts/<task>/{system.md,user.md}` — see
[prompts/README.md](prompts/README.md) for the conventions and
[docs/ref/prompts.md](docs/ref/prompts.md) for the naming, title and punctuation
rules they encode. The document body is never a template variable; it is appended
after everything the templates produce, which is what keeps the cache prefix
identical across the corpus.

A prompt change is measured, not eyeballed. `npm run score -- input/ru out`
compares a translated corpus against its source and reports the invariants a
structure guard cannot see — source-script text left in the prose, a substituted
dash, punctuation pulled inside a quotation mark.

## Extending

| To add… | Implement | Register at |
|---|---|---|
| a per-document task | `DocumentPipeline` | `PipelineRegistry` |
| an aggregation over the corpus | `CorpusPipeline` | `PipelineRegistry` |
| a routing rule | `RoutingStrategy` | `RoutingStrategyRegistry` |
| a context tactic | `ContextStrategy` | `ContextStrategyRegistry` |
| a document source | `SourceProvider` | `createApp` |
| an output destination | `ArtifactWriter` | `createApp` |
| a transport | `LlmClient` | `LlmClientFactory` |
| a progress UI | `ProgressReporter` | `runJob` |

`createApp(loaded, { configure })` gives you the wired container before anything
runs, so a host application can swap any single piece:

```ts
import { createApp, loadConfig, runJob, defineStrategy } from 'biomd-process';

const loaded = await loadConfig();
const app = createApp(loaded, {
  configure: (app) => {
    app.strategies.register(defineStrategy('prefer-local', 'local first', (ctx) =>
      [...ctx.candidates].sort((a, b) => Number(b.tags.includes('local')) - Number(a.tags.includes('local'))),
    ));
  },
});
await runJob(app);
```

## Documentation

| Read | For |
|---|---|
| [docs/ref/INDEX.md](docs/ref/INDEX.md) | **start here.** The on-demand reference tier, one file per concern |
| [external/README.md](external/README.md) | **any** data-format question. Normative, nine documents, format version 2 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the full prose architecture, extension points and non-goals |
| [docs/PROGRESS_AND_TODO.md](docs/PROGRESS_AND_TODO.md) | *why* something was built this way — `git log` carries no rationale |

## Known gaps

- The Markdown skeleton does not model footnote ids. (The footnote *marker* this
  corpus writes is recognized as the link it is.)
- Two people with the same name cannot be told apart in the image index —
  `photo/w/john_williams/` is the guitarist or the film composer depending on
  facts no filename carries. `portrait` never overwrites a curated `img`, which
  is the answer there.
- Whether an entry is one person or an ensemble is read from its **title**, not
  from its prose: "played in a duo with Meleshko" is a sentence about one
  guitarist. An ensemble whose title says so nowhere — no heading, no roster
  entry, nothing in the slug — is scored as a soloist.
- Search aliases for CJK names depend entirely on the extraction hint — no
  algorithm gets from 塞戈维亚 back to "Segovia". That is a property of the
  problem, not of this implementation.
- No provider batch APIs, no web UI.

## Development

```bash
npm run typecheck && npm test
```

```bash
npm run build
```
