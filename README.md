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

> **Status: v0.3.** The orchestration, routing, reliability, cost control, resume
> and observability layers are complete and tested. The published format lives in
> `src/domain`, implemented against the normative specification in `external/`,
> and `biomd validate` checks the output against its invariant list. v0.3 added
> the two sources of fact an article does not contain — an image index and the
> web — and made a year-only date publishable instead of dropped.
> See [Extending](#extending) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
npm run biomd -- run --dry-run
```

`--dry-run` plans the whole job — documents, tasks, the model chain each pipeline
would use and an estimated cost — without issuing a single request. Drop the flag
to execute.

## Commands

| Command | Purpose |
|---|---|
| `run` | Process the corpus. Default command. |
| `run --dry-run` | Plan only: counts, model chain, estimated cost. Spends nothing. |
| `config check` | Validate the config, resolve paths, load every prompt template. |
| `config show` | Print the effective config with secrets redacted. |
| `models` | List resolved model targets, pools, and a routing preview. |
| `prompts list` / `prompts show <task>` | Inspect and render templates without spending tokens. |
| `report [runId]` | Summarize a finished run from its journal. |
| `portrait <who…>` | Search the image index for one person and print the ranking with its reasoning. Spends nothing. |
| `validate [dir]` | Check a published catalogue against the format invariants. Spends nothing. |

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
window, output ceiling, pricing, capabilities, reasoning effort and its dialect.

**Routing.** A scheduler picks an ordered chain of candidates per call.
Built-ins: `cost-optimized`, `context-optimized`, `sequential`, `round-robin`,
`least-failures`. Pools let each task type use a different set — cheap models for
extraction, a strong one for translation.

**Reliability.** Retry (same model, exponential backoff with jitter, honouring
`Retry-After`) and fallback (next model) are separate dimensions driven by a
typed error taxonomy. Circuit breakers stop a run from hammering a dead endpoint
once per document; client-side rate limiting avoids earning 429s in the first place.

**Cost.** By default, translation and localization send **only the prose**, as a
flat `{contentHash: text}` table: heading markers, list bullets, `:::` containers
and their attributes, code blocks, URLs and — for dossiers — `dates`, `ranking`,
`url`, media targets and unknown fields all stay local and are spliced back after.

Measured on the sample corpus in `examples/ru`:

| | payload vs. source file | deduplication |
|---|---|---|
| dossier localization | **52% smaller** | 142 → 117 distinct strings (**-18%**) |
| article translation | **18% smaller** (9–26% per file) | negligible between distinct articles |

The structural guarantee matters at least as much as the bytes: a `:::` block
that is never sent cannot come back unbalanced, so no retry or model escalation
is ever spent repairing one, and `dates`/`ranking`/`url` are identical across
editions by construction rather than by instruction.

On top of that, prompts are assembled stable-part-first so provider caches hit
across the corpus, context strategies escalate cheapest-first, and budgets in
requests, tokens or USD stop a run before it overspends.

**Asking the right source.** An article that never states a birthplace does not
start stating one on the third context rung, so `websearch` asks a different
source instead — and only about fields that are genuinely missing, sending an
eight-line identity card rather than the article. The portrait is chosen from an
image index by name matching and the index's own classification, with no model
involved at all.

**Resume.** Each task carries a fingerprint over its input, its prompt templates
and its output contract. Re-running an unchanged corpus issues zero calls; editing
a prompt correctly redoes exactly the work that prompt affects.

**Observability.** Every run writes `.biomd/runs/<runId>/` with a manifest, an
append-only `events.jsonl` journal (every request, retry, fallback, error and
artifact) and a checkpoint. The terminal shows live progress; `biomd report`
reads it back afterwards.

## Configuration

One YAML file, validated by Zod, layered `defaults < file < ${ENV} < CLI flags`.
Invalid config fails before any work starts, with the offending path named.
`biomd.config.yaml` in the repo root is a documented working example.

Ready-made configs for the common model setups — use with `-c`:

| File | Setup |
|---|---|
| [config/examples/local-only.yaml](config/examples/local-only.yaml) | LiteLLM / OmniRoute / 9router / vLLM / Ollama, nothing leaves the machine |
| [config/examples/openrouter-only.yaml](config/examples/openrouter-only.yaml) | OpenRouter only, with a hard USD budget |
| [config/examples/hybrid.yaml](config/examples/hybrid.yaml) | both: free local model first, paid models as fallback |

The hybrid pattern is the one worth knowing: put the local model first in every
pool and the paid ones behind it. Combined with fallback, the corpus is processed
locally and only the documents the local model actually fails on reach a paid model.

Secrets are referenced as `${VAR}` / `${VAR:-fallback}` and are redacted
everywhere they would otherwise be written.

## Prompts

Templates live in `prompts/<task>/{system.md,user.md}` — see
[prompts/README.md](prompts/README.md). The document body is never a template
variable; it is appended after everything the templates produce, which is what
keeps the cache prefix identical across the corpus.

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

## Known gaps

- The Markdown skeleton does not model footnote ids.
- Two people with the same name cannot be told apart in the image index —
  `photo/w/john_williams/` is the guitarist or the film composer depending on
  facts no filename carries. `portrait` never overwrites a curated `img`, which
  is the answer there.
- Search aliases for CJK names depend entirely on the extraction hint — no
  algorithm gets from 塞戈维亚 back to "Segovia". That is a property of the
  problem, not of this implementation.
- A dossier's `dates`/`ranking`/`url` are language-invariant *by construction*
  (they are never sent to a model), but nothing cross-checks editions that were
  authored outside this tool.
- No streaming, no provider batch APIs, no web UI.

## Development

```bash
npm run typecheck && npm test
```

```bash
npm run build
```
