<!-- Human-facing. Not loaded into any session: only CLAUDE.md, .claude/CLAUDE.md and
     .claude/rules/*.md are memory files, and this is none of them. -->

# `.claude/` — what loads, and when

Verified against [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory),
2026-08-25.

```
biomd-process/
├── CLAUDE.md                       always resident — keep under 200 lines
├── .claude/
│   ├── settings.json               shared, checked in (permissions allowlist)
│   ├── settings.local.json         personal, gitignored — create as needed
│   ├── rules/                      one topic per file, path-scoped
│   │   ├── domain-format.md          → src/domain/**, external/**
│   │   ├── llm-routing.md            → src/llm/**, src/routing/**, src/reliability/**
│   │   ├── pipelines.md              → src/pipelines/**, src/documents/**
│   │   ├── prompts.md                → prompts/**
│   │   ├── tests.md                  → tests/**
│   │   └── config-and-providers.md   → biomd.config.yaml*, src/config/**
│   └── worktrees/                  harness-managed, gitignored
└── docs/ref/                       on-demand reference tier, plain links
```

## The four tiers, in cost order

| Tier | Loads | Cost | Holds |
|---|---|---|---|
| `CLAUDE.md` | every session, in full | paid on every task | commands, invariants, gotchas, boundaries, the routing table |
| `.claude/rules/*.md` **with** `paths:` | when Claude reads a matching file | paid only on matching work | what bites you while editing *that* area |
| `.claude/rules/*.md` **without** `paths:` | every session | same as `CLAUDE.md` | nothing here — every rule in this repo is scoped |
| `docs/ref/*.md` | when Claude follows a link | paid only when consulted | the full account, worked examples, measured numbers |

Two consequences that decide where a fact goes:

- **`@path` imports load eagerly at launch.** Splitting `CLAUDE.md` by import is organisation, never
  a token saving. `docs/ref/` is therefore linked, never imported — and paths inside backticks are
  not expanded, so a mention like `` `@README` `` is safe.
- **`/compact` re-reads the project-root `CLAUDE.md` but not the rules.** A path-scoped rule
  reloads only when Claude next reads a file it matches. **So a rule that must never be missed
  belongs in `CLAUDE.md`** — which is why the `NEVER` / `ASK` boundaries live there and only their
  elaboration lives here.

## Auto memory is deliberately *not* in this repo

Claude's own notes live at `~/.claude/projects/<project>/memory/` — machine-local, shared across
every worktree of this repo, indexed by a `MEMORY.md` whose first 200 lines load each session.

That is the supported location and it stays there. A repo-local `.claude-memory/` would mean
committing Claude's private notes about *your* corrections and preferences into a shared tree, and
it is not what the memory system reads by default.

If you do want it in-repo, the supported lever is `autoMemoryDirectory` in `settings.json` (an
absolute path or one starting with `~/`) — not moving the files, which just orphans them.

## Verifying

| Question | Answer |
|---|---|
| Which memory files actually loaded? | `/context`, section **Memory files** |
| Which instruction files loaded, when and why? | the `InstructionsLoaded` hook |
| What has Claude saved about this project? | `/memory`, then open the auto-memory folder |
| Is `CLAUDE.md` too big? | `/doctor` proposes trims; target is under 200 lines |

`/context`, `/memory` and `/doctor` are interactive terminal panels — run them from a `claude`
terminal session.
