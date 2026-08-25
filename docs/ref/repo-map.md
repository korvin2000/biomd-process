# Repository map — what to read, and what to skip

Most of the byte count in this tree is **not** the project. Roughly 1,200 files across
`bakeoff/`, `.scratch/` and `out-*/` are frozen output from experiments that have already been
written up in `reports/`. Reading them costs tokens and teaches nothing the report does not
say better.

## Skip by default

Do not glob, grep or index these unless the task is explicitly about one of them. Every row is
either gitignored or frozen output.

| Path | What it is | Why it existed | Read instead |
|---|---|---|---|
| `.scratch/` | ~235 loose files: one-off probes, A/B cards, replay dumps, Python comparators | the working surface for every investigation in `reports/` and `docs/findings-analysis.md` | the report that came out of it |
| `bakeoff/` | ~916 files: `ds/`, `oa/`, `cfg/`, `cfg2/`, per-combination `out/` trees, `run_all.sh`, `score.py` | the sampling bake-offs — 36 DeepSeek combinations, 114 Gemma4 runs, 20 OmniRoute runs | `reports/*.md` — the verdict, the method and the caveats |
| `out-v05/` (and any `out-*/`) | a frozen catalogue from an older version | before/after comparison for a format change | `out/` for current output |
| `configs/good/`, `configs/obsolete/` | saved and superseded config snapshots (`.bak`, `.ok`, `.lastworking`) | rollback points during endpoint debugging | `biomd.config.yaml` (live) and `biomd.config.yaml.example` (annotated) |
| `translation/examples/` | nine source articles copied out for prompt A/B | fixture set for `npm run score` runs | `input/ru` |
| `.biomd/` | run journals, checkpoints, JSONL logs, translation memory | runtime state | `biomd report [runId]` |
| `out/` | published output | the product | `biomd validate out` |
| `dist/`, `node_modules/` | build output, dependencies | — | `src/` |
| `.claude/worktrees/` | harness-managed git worktrees for background tasks | one worktree per spawned task | the branch, if a task's work needs reviewing |
| `progress.old.log` | 112 KB of superseded progress lines | — | `progress.log` |
| `docs/Plan_Catalog-v2-index-ids-localized-names-codex-split.md` | 63 KB completed planning document for the v2 index/id/localized-name work | the design conversation behind `src/domain/catalog.ts` and `src/pipelines/catalog/names.ts` | the code, or `docs/PROGRESS_AND_TODO.md` for the outcome |

## Not skippable, despite looking like scratch

| Path | Why it is core |
|---|---|
| **`tools/`** | one file, `score-translations.ts` — the `npm run score` regression suite. It is the only model-free measurement of a prompt change and is **not** scratch |
| `example/example.bio.md` | the single fixture every bake-off in `reports/` was run against. Cited by name in every report; replacing it invalidates every comparison |
| `examples/` | hand-authored *expected* output — `root-index/index{,-de,-en,-ja,-ru,-zh}.json` and six `ru/*.bio.{md,json}` pairs. This is what correct output looks like |
| `input/` | the working corpus (gitignored because it is the site's content, not this tool's) |
| `reports/` | the five sampling/model bake-off write-ups. See below |
| `external/`, `images/artists.json`, `data/names.json` | vendored inputs — read, never written |

## `reports/` — the model bake-offs

Moved out of the repository root on 2026-08-25. Each answers "what should this target's `params`
be", and each states its own confidence. **Three of the five conclude the sampler barely matters
at all** (`omniroute`, `gemma4-v2`, `deepseek`); the other two recommend a value and then caveat
their own ranking as within run-to-run noise. That caveat is the most useful thing they say.

| File | Model | Verdict |
|---|---|---|
| `omniroute-openai-report.md` | `cx/gpt-5.6-luna` and four siblings, ru→de | luna is the right choice; temperature does nothing on this gateway; reasoning is real, costly and must be switched off explicitly |
| `gemma4-report.md` | `gemma4-31b-local`, ru→de | `0.75 / 0.9 / top_k 64`. Its §3 (`top_k` needs `params.extra`) is **superseded** — `topK`/`minP` are first-class fields now |
| `gemma4-v2-report.md` | same, 114 runs, German text | none of `top_k`, `min_p`, `top_p` separates quality in the tested ranges; work on the prompt instead |
| `deepseek-v4-flash-report.md` | `deepseek/deepseek-v4-flash-0731`, ru→de | the samplers are noise; `provider` and `reasoning` are what change the output |
| `minimax-m3-temperature-report.md` | `minimax/minimax-m3`, ru→fr | `temperature: 0.35`; trend is reliable, ranks 2–5 are not |

The distilled recommendations, with the current config's actual values, are in
[providers.md](providers.md#model-tuning). `report.md` in the root is a different thing entirely —
a per-document localization diff, not a model study.

## What is worth reading, in order

1. [CLAUDE.md](../../CLAUDE.md) — loaded already
2. [INDEX.md](INDEX.md) → the one reference file your task needs
3. [source-map.md](source-map.md) — before grepping for a concept
4. `src/` — 131 files, ~21.8k lines
5. `tests/` — 27 files, 505 tests
