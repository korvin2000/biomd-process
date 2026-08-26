# Reference index

The on-demand tier behind [CLAUDE.md](../../CLAUDE.md). Each file is self-contained; read the one
row that matches your task rather than the set.

**Link, do not import.** These are plain Markdown links on purpose: a `@path` import in `CLAUDE.md`
loads into the context window at launch, so importing this tier would organise it without saving a
token. The other conditional tier is `.claude/rules/*.md`, which loads when Claude reads a file its
`paths:` glob matches — see [.claude/README.md](../../.claude/README.md).

## Written for this repo

| Read | When |
|---|---|
| [repo-map.md](repo-map.md) | **first, if you are about to glob or grep the tree** — ~1,200 files are frozen experiment output that should be skipped |
| [source-map.md](source-map.md) | you need a symbol, a file, or "who owns this concept" — check here before grepping |
| [architecture.md](architecture.md) | changing scheduling, dependencies, the call path, routing, resume, or the run journal |
| [cost-mechanisms.md](cost-mechanisms.md) | touching a prompt, a pipeline, a context strategy, or anything that decides what crosses the wire |
| [throughput.md](throughput.md) | configuring for speed or for cost: strategies, lanes, `run.concurrency`, `prefer`, and a symptom→cause table |
| [providers.md](providers.md) | adding or tuning a model target — OmniRoute, OpenRouter, llama.cpp, and what each one silently ignores |
| [adaptive-routing.md](adaptive-routing.md) | the `adaptive` strategy: its five inputs, its two subjective numbers, which knob moves which model, and the local harness that replaced paid experiments |
| [failure-modes.md](failure-modes.md) | before a real run · when a run "succeeded" but the data is wrong · when an endpoint behaves oddly |
| [domain-format.md](domain-format.md) | anything about dates, names, aliases, collectives, the catalogue merge, or `biomd validate` |
| [pipelines.md](pipelines.md) | working on one of the six tasks — what it reads, returns, and refuses to do |
| [images-and-roster.md](images-and-roster.md) | portrait selection, `images/artists.json`, or `data/names.json` |
| [config-map.md](config-map.md) | you need a setting's default or its effect, and don't want to read 1413 lines of Zod |
| [prompts.md](prompts.md) | editing a template, or a translation came out wrong |
| [testing.md](testing.md) | writing a test — especially how `FakeClient` decides what a request *is* |

## Normative and vendored (authority, not commentary)

| Read | When |
|---|---|
| [external/README.md](../../external/README.md) | **any** data-format question. Nine documents, format version 2. This is the source of truth |
| [external/02-value-domains.md](../../external/02-value-domains.md) | a specific `VD-*` domain — what `src/domain/values.ts` implements |
| [external/07-authoring-and-validation.md](../../external/07-authoring-and-validation.md) | the `INV-*` list `biomd validate` checks |
| [images/image-index-spec.md](../../images/image-index-spec.md) | the image index format, and where `src/images` departs from its recommended pipeline |
| [prompts/README.md](../../prompts/README.md) | Eta template conventions, whitespace and ASI traps, variables per task |
| [biomd.config.yaml.example](../../biomd.config.yaml.example) | the annotated config — 1063 lines, and the comments carry the *reasons*. `src/config/schema.ts` is the authority on defaults |

## Measurements and history

| Read | When |
|---|---|
| [reports/](../../reports/) | five model bake-offs: OmniRoute/OpenAI, Gemma4 (×2), DeepSeek V4 Flash, MiniMax-M3. Distilled into [providers.md](providers.md#model-tuning) |
| [docs/ARCHITECTURE.md](../ARCHITECTURE.md) | the canonical long-form architecture, plus extension points and non-goals. [architecture.md](architecture.md) is the operational subset of it |
| [docs/PROGRESS_AND_TODO.md](../PROGRESS_AND_TODO.md) | **why** something was built this way. The dev log — `git log` is one squashed commit and carries no rationale. Russian narration, English technical terms |
| [docs/findings.md](../findings.md) | the brief: the regression the 2026-08-23 investigation was asked to explain (Russian) |
| [docs/findings-analysis.md](../findings-analysis.md) | its answer: which search models actually search, why `albert` failed, why the poems were never translated, and the measured prompt A/B |
| [docs/translation-model-bakeoff.md](../translation-model-bakeoff.md) · [-de](../translation-model-bakeoff-de.md) | earlier per-model translation comparisons |

## Superseded — do not implement against

`docs/MetaData.md` · `docs/Catalog-Index.md` — replaced by `external/`, kept for history.
`reports/gemma4-report.md` §3 — `topK`/`minP` are first-class config fields now, not `params.extra`.
