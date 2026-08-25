# Reference index

The on-demand tier behind [CLAUDE.md](../../CLAUDE.md). Each file is self-contained; read the one
row that matches your task rather than the set.

**Link, do not import.** These are plain Markdown links on purpose: a `@path` import in `CLAUDE.md`
loads into the context window at launch, so importing this tier would organise it without saving a
token.

## Written for this repo

| Read | When |
|---|---|
| [source-map.md](source-map.md) | you need a symbol, a file, or "who owns this concept" — **check here before grepping** |
| [architecture.md](architecture.md) | changing scheduling, dependencies, the call path, routing, resume, or the run journal |
| [cost-mechanisms.md](cost-mechanisms.md) | touching a prompt, a pipeline, a context strategy, or anything that decides what crosses the wire |
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

## Longer-form, this repo's own

| Read | When |
|---|---|
| [docs/ARCHITECTURE.md](../ARCHITECTURE.md) | the full prose version of `architecture.md`, plus extension points and non-goals |
| [docs/PROGRESS_AND_TODO.md](../PROGRESS_AND_TODO.md) | **why** something was built this way. The dev log — `git log` is one squashed commit and carries no rationale. Russian narration, English technical terms |
| [docs/findings-analysis.md](../findings-analysis.md) | the 2026-08-23 regression hunt: which search models actually search, why `albert` failed, why the poems were never translated, and the measured prompt A/B |
| [docs/findings.md](../findings.md) · [docs/translation-model-bakeoff*.md](../translation-model-bakeoff.md) | per-model translation comparisons |

## Superseded — do not implement against

`docs/MetaData.md` · `docs/Catalog-Index.md` — replaced by `external/`, kept for history.
