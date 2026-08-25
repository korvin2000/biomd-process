# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`biomd-process` is a Node/TypeScript CLI that batch-processes `*.bio.md` biography documents
through LLMs. Six pipelines — `extract`, `websearch`, `translate`, `localize`, `portrait`,
`catalog` — any combination in one job. **Status v0.6.**

This repo is the **producer** half of a two-repo system; the catalogue website that renders its
output is a separate application, not here. `external/` is *that application's* normative
specification, vendored in because it defines the contract this output must satisfy.

## Commands

```bash
npm install
cp .env.example .env                  # endpoint URLs / API keys
npm run biomd -- config check         # validate config, load every prompt template
npm run biomd -- models --probe       # one tiny call to every target — REQUIRED before a real run
npm run biomd -- run --dry-run        # plan the job (docs, tasks, model chain, est. cost) — spends nothing
npm run biomd -- run
```

```bash
npm run typecheck && npm test         # the whole gate — there is no lint script or ESLint config
```

| Command | Purpose |
|---|---|
| `run [--dry-run] [--only extract,translate] [--lang en,de] [--limit n] [--concurrency n] [--strategy id] [--budget-usd n] [--max-requests n] [--resume auto\|off] [--resume-run <id>] [--fail-fast] [--skip-existing\|--no-skip-existing] [-o dir]` | process the corpus (**default** command) |
| `config check` (default) \| `config show [--json]` | validate / print effective config, secrets redacted |
| `models [--pool name] [--tokens n] [--probe]` | resolved targets, pools, routing preview. Exits 1 if any target fails |
| `prompts list` (default) \| `prompts show <task> [--messages]` | inspect/render templates, no tokens spent |
| `report [runId] [--failed] [--notes [regex]]` | summarize a run. `--notes` replays decisions that produced **no file** |
| `portrait <who…> [--top n] [--min-identity n] [--all] [--json]` | search the image index for one person, with reasoning. LLM-free |
| `validate [dir] [--strict] [--json] [--no-files]` | check a published catalogue against `INV-1 … INV-28`, all of them. Exits 1 on an error (`--strict`: on a warning too) |

All accept `-c/--config <file>`. In development the CLI always runs through `tsx` via
`npm run biomd -- <args>`; `npm run build` produces the `dist/cli/main.js` that `bin.biomd` points at.

Single test · prompt-change regression scorer:

```bash
npx vitest run tests/catalog.test.ts -t "keeps the id an entry already had"
```

```bash
npm run score -- input/ru out
```

## Invariants

- **Format rules live in `src/domain` and nowhere else.** A change to `external/` has exactly one
  landing site. `src/images` and `src/roster` are the same arrangement for the two input formats.
- **Pipelines return artifacts; they never write files.** That is what makes `--dry-run` free.
- **`src/app/container.ts` is the only place concrete implementations are wired.** Everything takes
  its collaborators as constructor arguments.
- **Extend the `LlmErrorKind → Disposition` table in `src/reliability/errors.ts`**; never match
  provider message strings at a call site.
- **Drop, never guess.** An absent field is correct; an invented one is a claim about a person.
  Normalizers are narrow on output and wide on input.
- **Classification (`type`/`gender`/`country`/`img`/`title`) is an error inside a `*.bio.json`**
  (`INV-7`). It goes to `out/.hints/`, where `catalog` picks it up.
- **The catalogue is updated, never rebuilt** — ids, row order, unknown members and hand-edits all
  survive `upsert`.
- **Relative imports need an explicit `.js` extension** and type-only imports need `import type`
  (`NodeNext` + `verbatimModuleSyntax`). `noUncheckedIndexedAccess` is on.

## Gotchas — none of these are discoverable before they bite

- **`run` is the default command, so options come *after* the subcommand.**
  `biomd config check -c f.yaml`, never `biomd -c f.yaml config check` — the second form used to be
  parsed as `run` with two ignorable arguments and quietly processed the whole corpus.
- **A pool is a fallback chain, so a first choice that never works is invisible**: the run
  completes, every document is produced, and the only trace is the bill from the backup. Hence
  `--probe` before, and the run summary's target-health table after. A pool of **one** has no chain
  at all and turns every transient failure into a failed document.
- **`omniroute` needs `stream: true`** — with buffered answers, two *overlapping* requests get the
  same completion, and a web-search answer about the wrong guitarist is well-formed, sourced, and
  uncatchable downstream. `maxConcurrent: 3` on that endpoint is safe **only** because streaming is
  on; if streaming is ever turned off, it must go back to `1`.
- **A model without web search answers search questions anyway**, fluently, with fabricated
  citations. Search targets therefore declare `webSearchMode`, and a result is accepted only with
  provider search-call/source evidence; the capability list alone is not proof.
- **Editing a prompt template invalidates every fingerprint** (both files hash into
  `promptVersion`) and re-plans the corpus. It also correctly starts a fresh translation-memory
  namespace — but a bad rendering already cached is re-served verbatim until then.
- **Only `resume` and `existing-output` mean "done"** (`isTaskDone`, `src/state/types.ts`). Add a
  skip reason to that whitelist only if it means the artifact is on disk — counting a retired task
  makes the next resume skip it forever.
- **A task that *updates* its output must declare `mergesOutput`** (`catalog`, `websearch`), or
  `run.skipExistingOutputs` reads its file's existence as "done" and it never runs again.
- **`tasks.catalog.refresh` is empty by default and `upsert` only fills empty members**, so a
  machine mistake is permanent: change `tasks.portrait.assetPrefix` and every row keeps the old
  `img`. Switch `refresh` on for the run that fixes it, then off.
- **On OpenRouter, a sampler you set is not a sampler that was applied.** One model id is served
  by many hosts and most drop what they do not implement, answering 200 either way.
  `provider.requireParameters: true` turns that silence into a `404`.
- **`git log` is one squashed commit and carries no rationale.** The decision trail is
  [docs/PROGRESS_AND_TODO.md](docs/PROGRESS_AND_TODO.md) — Russian narration, English technical
  terms.

## Do not index these

~1,200 files here are frozen experiment output, already written up in `reports/`. Do not glob,
grep or read them unless the task is explicitly about one:

`.scratch/` · `bakeoff/` · `out-*/` · `configs/` · `translation/examples/` · `.biomd/` · `out/` ·
`dist/` · `.claude/worktrees/` · `progress.old.log`

**`tools/` is not in that list** — it holds `score-translations.ts`, the `npm run score` regression
suite. Neither are `example/`, `examples/` (hand-authored expected output) or `input/`. Full table
with reasons: [docs/ref/repo-map.md](docs/ref/repo-map.md).

## Boundaries

**NEVER**

- call a paid endpoint for testing. Free: everything on `local` (`gemma-local`) and on `omniroute`
  (`gpt-luna`, `search-std`, `search-mx`, `search-safe`). **Everything on `openrouter` costs
  money** — `deepseek`, `minimax-m3`, `paid-search` — **ask first.** Check `pricing` in
  `biomd.config.yaml` rather than trusting an id: `biomd.config.yaml.example` still uses the
  older `or-*` / `local-small` names.
- set `tasks.catalog.merge: false` — it silently detaches localized names from their entries.
- add a format rule outside `src/domain`, or re-derive a Markdown link pattern outside
  `src/documents/markdown/inline.ts`.
- implement against `docs/MetaData.md` or `docs/Catalog-Index.md` — superseded by `external/`.
- invent a value to fill a field. Report it (`TaskResult.notes`) or drop it.

**ASK**

- before any run that spends real money over the corpus, or that changes `tasks.catalog.refresh`,
  `datePrecision`, or `aliasPolicy` — each overwrites published data.

## Read when needed

Start at **[docs/ref/INDEX.md](docs/ref/INDEX.md)**, which routes to all of the below.
Area-specific rules load automatically when you open a matching file — see
[.claude/README.md](.claude/README.md) for which tier holds what.

| Topic | File | When |
|---|---|---|
| Symbols, files, ownership | [docs/ref/source-map.md](docs/ref/source-map.md) | **before grepping for a concept** |
| What to skip in this tree | [docs/ref/repo-map.md](docs/ref/repo-map.md) | before globbing or grepping |
| Scheduling, call path, routing, resume | [docs/ref/architecture.md](docs/ref/architecture.md) | changing how work is planned or dispatched |
| Throughput vs cost: strategies, lanes, concurrency | [docs/ref/throughput.md](docs/ref/throughput.md) | tuning a run for speed or for spend |
| OmniRoute / OpenRouter / llama.cpp, model tuning | [docs/ref/providers.md](docs/ref/providers.md) | adding or tuning a model target |
| The eleven cost mechanisms | [docs/ref/cost-mechanisms.md](docs/ref/cost-mechanisms.md) | touching a prompt, pipeline or context strategy |
| Silent-failure catalogue | [docs/ref/failure-modes.md](docs/ref/failure-modes.md) | before a real run, or when a "successful" run is wrong |
| Dates, names, aliases, collectives, validation | [docs/ref/domain-format.md](docs/ref/domain-format.md) | anything in `src/domain` |
| Per-pipeline contracts | [docs/ref/pipelines.md](docs/ref/pipelines.md) | working on one of the six tasks |
| Portrait matching, the name roster | [docs/ref/images-and-roster.md](docs/ref/images-and-roster.md) | `src/images`, `src/roster` |
| Settings and their defaults | [docs/ref/config-map.md](docs/ref/config-map.md) | instead of reading 1413 lines of Zod |
| Naming, titles, punctuation rules | [docs/ref/prompts.md](docs/ref/prompts.md) | editing a template |
| `FakeClient` dispatch, `Workspace` | [docs/ref/testing.md](docs/ref/testing.md) | writing a test |
| **The data format itself** | [external/README.md](external/README.md) | **any** format question — normative, nine documents |

## Done

- `npm run typecheck && npm test` both pass.
- Changed the published output? `npm run biomd -- validate out` exits 0.
- Changed a prompt? `npm run score -- input/ru out` before and after, and the invariants it reports
  did not get worse.
- Changed routing or endpoints? `npm run biomd -- models --probe` exits 0, and the run summary shows
  no target serving 0 of its requests.
- Ran a real job? `grep ' ! ' progress.log` is explicable, and `biomd report --notes` shows no
  decision you did not intend.
