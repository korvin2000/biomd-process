# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`biomd-process` is a Node.js/TypeScript CLI that batch-processes `*.bio.md` Markdown biography documents through LLMs. Four pipelines ship with it and any combination can run in one job:

- **`extract`** — heuristic metadata extraction into a dossier JSON
- **`translate`** — structure-preserving translation into a configurable list of languages
- **`localize`** — the per-language *edition* of the dossier, language-invariant fields copied verbatim
- **`catalog`** — LLM-free aggregation of everything already on disk into `index.json` / `index-<lang>.json`

**Status: v0.1 — the platform, not the domain.** Orchestration, routing, reliability, cost control, resume and observability are complete and tested. Everything that depends on the exact shape of a `bio.md` or `MetaData.json` sits behind a narrow contract and is marked `TODO(domain)` (list below). Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making structural changes — it covers the intended layering in more depth than is repeated here.

This repo is the **producer** half of a two-repo system: the actual catalogue website that renders this output is a separate application, not present here. [docs/Catalog-Index.md](docs/Catalog-Index.md) and [docs/MetaData.md](docs/MetaData.md) are *that other application's* normative data-format specs, vendored in only because they define the contract this tool's output must satisfy.

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
| `config check` (default) \| `config show [--json]` | Validate / print effective config, secrets redacted |
| `models [--pool name] [--tokens n]` | Resolved model targets, pools, routing preview |
| `prompts list` (default) \| `prompts show <task> [--messages]` | Inspect/render templates, no tokens spent |
| `report [runId] [--failed]` | Summarize a run from `.biomd/runs/<runId>/` |

## Architecture

Dependencies point strictly inward; nothing in an inner layer imports from an outer one:

```
cli → app (container.ts, composition root) → core (planner, orchestrator) ─┬→ pipelines (extract/translate/localize/catalog)
                                                                             ├→ io (source, writer)
                                                       ┌─────────────────────┴────────────────┐
                                                  llm (gateway)   documents (segmentation)  prompts (templates)  state (journal)
                                                       │
                                             routing + reliability
                                                       │
                                            config → shared (errors, hash, fs)
```

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

### The three cost-optimization mechanisms (read before touching prompts or pipelines)

1. **Cache-friendly message order.** `MessageBuilder` (`src/prompts/MessageBuilder.ts`) always emits `[stable system][stable instructions][volatile document]`, in that order. The document body (or the `{hash: text}` table) is *never* a template variable — it's appended last so provider prompt-caches hit across the whole corpus. Putting anything document-specific (a filename, a counter, a timestamp) into a template silently breaks this for every document that follows.
2. **Escalating context strategies** (`src/documents/context/strategies.ts`, walked by `runWithEscalation` in `src/pipelines/shared/escalation.ts`): `full` | `truncation-first` | `chunked` | `staged`, cheapest attempt first. On every rung but the last, acceptance is checked *after* the call, so a rejection escalates the **context** (the cheap axis). On the last rung there's no cheaper move left, so acceptance runs *inside* the gateway's `validate`, where rejection becomes an ordinary validation failure that inherits retry-then-fallback-to-a-stronger-**model**. Getting this ordering backwards means either retrying forever on rung one or never escalating context at all.
3. **Send prose, not documents.** `extractTextSpans` (`src/documents/markdown/textSpans.ts`) and the dossier-side equivalent in `src/pipelines/localization/StringTable.ts` pull out only translatable text; headings, list markers, `:::` containers and their attributes, fenced code, URLs, and — for dossiers — `dates`/`ranking`/`url`/media targets/unknown fields never leave the machine. What crosses the wire is a flat `{contentHash: text}` table (`tasks.translate.mode: segments`, the default); the model must return exactly the same keys, so a dropped or invented key is a validation failure, not silent corruption. Repeated strings are translated once per run via `TranslationMemory` (`src/pipelines/localization/TranslationMemory.ts`). Link targets inside a sentence are masked as `⟦1⟧` and checked for survival before acceptance. Whole-document mode (`tasks.translate.mode: document`) still exists for when maximum surrounding context matters more than cost.

### State, resume, observability

Every run writes `.biomd/runs/<runId>/`: `run.json` (manifest), `events.jsonl` (append-only — every request/retry/fallback/error/artifact write), `state.json` (checkpoint, fingerprint → status). `--resume`/`--resume-run` replays the checkpoint and skips completed fingerprints; `biomd report [runId]` reads the manifest + checkpoint back afterwards. `.biomd/`, `out/` and `dist/` are all git-ignored.

## Configuration

One YAML file (`biomd.config.yaml`), Zod-validated (`src/config/schema.ts`), layered `defaults < file < ${ENV} < CLI flags` (`src/config/loader.ts`, `merge.ts`). Invalid config fails before any work starts, with the offending path named. Secrets are `${VAR}` / `${VAR:-fallback}` references resolved from `.env`, redacted on any serialization (`redactConfig`, used by `config show` and the journal). Three ready-made configs live in `config/examples/` (`local-only`, `openrouter-only`, `hybrid`) — the hybrid pattern (free local model first in every pool, paid models behind it as fallback) is the one worth reusing as-is.

## Prompts

`prompts/<task>/{system.md,user.md}` (Eta templates — see [prompts/README.md](prompts/README.md)), mapped by `prompts.templates` in config so a directory can be renamed without touching code. Both files hash into `promptVersion`, which feeds the task fingerprint, so editing a template is a tracked change that correctly invalidates already-completed work. `translateSegments`/`localize` templates answer a `{hash: text}` table and must return exactly the same keys; instructions that invite merging, splitting or reordering fragments will surface as validation failures and retries.

## Where domain logic is deliberately stubbed (`TODO(domain)`)

Grep `TODO(domain)` for the current, authoritative list. As of this writing:

- `src/pipelines/extraction/MetadataContract.ts` — thin Zod mirror of `docs/MetaData.md`: no `DD.MM.YYYY` validation, no rejection of fields that moved to `index.json`, no list normalization
- `src/pipelines/extraction/merge.ts` — chunk merge takes the first non-empty value per field; comma-separated list fields should be unioned instead
- `src/pipelines/translation/StructureGuard.ts`, `src/documents/markdown/skeleton.ts` — structure verification is an exact Markdown-skeleton match, no configurable tolerance
- `src/pipelines/catalog/names.ts`, `src/pipelines/catalog/CatalogPipeline.ts` — `type`/`gender`/`country`/romanized `title` are preserved-or-defaulted, not inferred; search aliases beyond the bare surname aren't generated
- `src/config/schema.ts` — config-side placeholders mirroring the above

None of this affects orchestration, routing, retry, state or CLI — that separation is the actual deliverable of v0.1, so new domain logic belongs behind these same narrow contracts (`DocumentPipeline`/`CorpusPipeline`, the Zod schemas), not spread into `core`, `routing` or `reliability`.

## Conventions worth knowing before editing

- ESM + `NodeNext` + `verbatimModuleSyntax`: relative imports in `.ts` files need an explicit `.js` extension (e.g. `from '../config/loader.js'`), and type-only imports use `import type`. The compiler enforces this; it isn't a style choice.
- `strict: true` plus `noUncheckedIndexedAccess: true` — array/index access types as `T | undefined`; don't assume otherwise.
- Tests build an isolated on-disk project per test via `Workspace` (`tests/helpers/workspace.ts` — temp dir + `createApp`) and a scripted transport via `FakeClient`, which tells requests apart by `response_format`: `json_schema` → extraction (answered with supplied metadata), `json_object` → a string batch (echoed back, identity translation), else → whole-document translation. Use these rather than hitting a real endpoint.
- Design history and rationale — why fingerprints exclude the model, why waves instead of a general DAG, measured token-savings numbers, which open questions were resolved and how — lives in `docs/PROGRESS_AND_TODO.md`, a running dev log, not `git log` (this repo currently has a single squashed "Initial commit").

## Docs map

| File | Covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full layering, extension points, non-goals — the source this file summarizes |
| [docs/PROGRESS_AND_TODO.md](docs/PROGRESS_AND_TODO.md) | Dev log: original spec, defaults chosen and why, what shipped when (RU/EN) |
| [docs/MetaData.md](docs/MetaData.md) | Downstream consumer's dossier (`*.bio.json`) format — normative for `extract`/`localize` output |
| [docs/Catalog-Index.md](docs/Catalog-Index.md) | Downstream consumer's `index.json` / `index-<lang>.json` format — normative for `catalog` output |
| [prompts/README.md](prompts/README.md) | Template conventions, Eta syntax, variables available per task |
