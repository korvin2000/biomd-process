# Config map — the settings that change behaviour

**`src/config/schema.ts` (1413 lines of Zod) is the authority.** Every default below was read from
it on 2026-08-25; when the two disagree, the schema is right and this file is stale. The schema
carries a doc comment on nearly every setting — read the comment, not just the type.

One YAML file, Zod-validated, layered `defaults < file < ${ENV} < CLI flags`
(`src/config/loader.ts`, `merge.ts`). Invalid config fails **before any work starts**, naming the
offending path. Secrets are `${VAR}` / `${VAR:-fallback}` references resolved from `.env`, redacted
on any serialization (`redactConfig`, used by `config show` and the journal).

Ready-made configs: `config/examples/{local-only,openrouter-only,hybrid}.yaml`. **The hybrid
pattern — free local model first in every pool, paid models behind it as fallback — is the one
worth reusing as-is**, because a pool of one has no fallback chain at all.

```bash
npm run biomd -- config show --json
```

## Two sections that sit at the root, not under a task

Both because several tasks have to agree about them.

| Section | Is | Read by |
|---|---|---|
| **`catalogue:`** | **not** task settings — it describes the *format's deployment*: `supportedLanguages`, `datePrecision` (`year`), `defaultType` (`musician`), `defaultPageType` (`hidden`), `allowUnknownTypes` (`false`) | `extract`, `websearch`, `localize`, `catalog`, `validate` |
| **`roster:`** | the second input source: `file` (`''` = off, the default), `language` (`ru`), `fillMetadata`, `aliases`, `nameHints`, `reportConflicts` | `extract`, `portrait`, `catalog` |

## Money and time

| Key | Default | What it decides |
|---|---|---|
| `run.concurrency` | `4` | tasks in flight |
| `cost.budgetUsd` | — | hard spend ceiling; `BudgetGuard` checks before each call |
| `cost.maxRequests` | `0` (off) | request ceiling |
| `llm.routing.strategy` | `cost-optimized` | the **default a pool inherits**, not the only answer |
| `llm.routing.pools.<pool>.strategy` | inherits | per-pool. Extraction is scarce in money, translation in wall-clock — `least-busy` is the translation answer |
| `llm.routing.pools.<pool>.maxConcurrent.<endpoint>` | `{}` | a **lane**: this pool's share of that endpoint's cap. The schema refuses lanes summing above the cap |
| `llm.routing.pools.<pool>.prefer.<variant>` | `{}` | a language naming its own model. Reordering, never a filter; naming a model outside the pool is a **config error** |
| `llm.routing.onOverflow` | `demote` | `demote` ranks a non-fitting target last but still calls it; `skip` drops it |
| `llm.models[].contextWindow` · `maxOutputTokens` · `capabilities` | — | a target must both **hold** the prompt and **emit** the answer; `capabilities` is what the transport and the `web_search` gate believe |
| `llm.endpoints[].maxConcurrent` · `minRequestSpacingMs` · `stream` | `0` · `0` · `false` | facts about the provider. **`stream: true` is a correctness setting on `omniroute`** — see [failure-modes](failure-modes.md#endpoint-faults) |
| `context.strategy` | `truncation-first` | the escalation ladder's starting rung |
| `reliability.taskFallback` | — | re-run a task whose *answer* was wrong; `lastAttempt.strategy` / `.temperature` |

## The three "this already exists" settings — all read at *plan* time

| Key | Default | Means |
|---|---|---|
| `output.onExisting` | `overwrite` | `skip` = a writer's promise, so the task is not planned at all. `overwrite` replaces; `fail` stops loudly |
| `run.skipExistingOutputs` | `false` | the file is on disk. `--no-skip-existing` overrides |
| `tasks.extract.onExistingDossier` | `reuse` | `reuse` re-emits an authored dossier for zero tokens; `complete` asks only for missing keys; `rebuild` ignores it |

A task declaring `mergesOutput` (`catalog`, `websearch`) is exempt from the first two.

## Per-task settings worth knowing

### `tasks.extract`
| Key | Default | |
|---|---|---|
| `readWholeDocument` | `true` | declares `coverage: 'whole'` — drops every partial context attempt at plan time |

### `tasks.translate`
| Key | Default | |
|---|---|---|
| `mode` | `segments` | vs `document` |
| `maxSegmentsPerCall` | `40` | **size it so the *answer* fits the smallest model in the pool** |
| `repairAttempts` | `1` (0–3) | `0` restores all-or-nothing |
| `foreignFragments` | `keep` | a fragment with no source-script letter is not sent |
| `fencedBlocks` | `auto` | `code` restores pre-verse behaviour; `text` treats every fence as prose |
| `contextChars` | `300` | title + lead opening, in the volatile half of the message |
| `useTranslationMemory` | — | `persistent` caches across runs in `run.memoryDir`, namespaced by prompt version |

### `tasks.localize`
| Key | Default | |
|---|---|---|
| `maxStringsPerCall` | `60` | same sizing rule |
| `repairAttempts` | `1` | |
| `localizableFields` | allowlist | an allowlist on purpose: everything absent from it (`dates`, `ranking`, `url`, every `target`) is language-invariant **by construction** |

### `tasks.websearch`
| Key | Default | |
|---|---|---|
| `requireWebSearchCapability` | `true` | only as honest as the capability list |
| `livenessAgeYears` | `78` | born this long ago with no `died` → the absence becomes a question |
| `onDateConflict` | `prefer-precise` | vs `report` (writes `conflicts[]` to the hint file) / `ignore` |
| `contextChars` | `600` | the lead paragraph, for telling namesakes apart |

### `tasks.portrait`
| Key | Default | |
|---|---|---|
| `minIdentity` | `0.9` | applied to the **identity score alone** |
| `assetPrefix` | `pages/` | changing it strands every existing `img` — see `tasks.catalog.refresh` |
| `onLowConfidence` | `omit` | `default` writes the gender fallback asset instead |

### `tasks.catalog`
| Key | Default | |
|---|---|---|
| `merge` | `true` | **do not set false** — it detaches localized names from their entries |
| `refresh` | `[]` | the narrow escape hatch: members this run may *correct* (`img`, `title`, `type`, `gender`, `country`, `displayNames`). Switch on for the fixing run, then off |
| `aliasPolicy` | `distinct` | `spec` restores `external/04` §4.5's full list |
| `displayNameOrder` | `roster` | vs `surname-first` / `given-first` |

## Output layout

`output.baseDir` = `out`. `output.channels` maps a channel to a path template relative to it;
placeholders are `{slug} {lang} {sourceLang} {targetLang} {pipeline} {taskId} {runId}` plus anything
a pipeline puts in the artifact's `pathVars`. `{lang}` is always the language of the *produced*
artifact.

| Channel | Default template |
|---|---|
| `metadata` | `{lang}/{slug}.bio.json` |
| `translation` | `{lang}/{slug}.bio.md` |
| `catalogIndex` | `index.json` |
| `catalogLocalizedIndex` | `index-{lang}.json` |
| `catalogHints` | `.hints/{slug}.json` — internal `extract`→`catalog` hand-off, dot-prefixed so the site ignores it |
| `portraitHints` | `.hints/{slug}.portrait.json` — the chosen portrait, the runners-up, and why they lost |
| `websearchHints` | `.hints/{slug}.web.json` — classification the web supplied, and `conflicts[]` |

Also: `output.jsonIndent` `2`, `output.finalNewline` `true`.

## Run and logging

| Key | Default |
|---|---|
| `run.memoryDir` | `.biomd/memory` |
| `run.resume` | `auto` (or `off`, or a runId) |
| `run.failFast` | `false` |
| `logging.level` | `info` |
| `logging.file` | `.biomd/logs/biomd.jsonl` |
| `logging.progressFile` | `progress.log` |
| `logging.progressIntervalMs` | `30000` — both a floor and a ceiling on flushes |
| `prompts.dir` | `prompts` |
| `prompts.templates` | task → directory, so a directory can be renamed without touching code |

## Environment

`.env` supplies the `${VAR}` references (`.env.example` lists them). `BIOMD_DEBUG=1` makes an
`AppError` print its serialized JSON alongside the message.
