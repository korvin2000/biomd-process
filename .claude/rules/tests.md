---
paths:
  - "tests/**/*.ts"
---

# Writing a test

Full account: [docs/ref/testing.md](../../docs/ref/testing.md).

- **Start from `tests/helpers/workspace.ts`.** `Workspace` builds a temp project and calls
  `createApp` — the same composition root production uses. Never hit a real endpoint.
- **`FakeClient` dispatches on the last message's fenced block**, because extraction, string batches
  and web search all ask for `json_object` and cannot be told apart by `responseFormat`:

  | fence | is | answer with |
  |---|---|---|
  | ` ```json ` | a `{key: text}` batch | `echoTable()` — transliterates, because an answer that returns the source is now *rejected* |
  | ` ```markdown ` | an article | `DEFAULT_FACTS` |
  | ` ```yaml ` | a web-search identity card | whatever the test needs |
  | none, `json_object` | extraction | the supplied facts |

- **Assert the calls that did *not* happen.** `foreignFragments`, `onExistingDossier: reuse`,
  `findGaps` with no gaps and all three plan-time skips are "no request was made" behaviours.
- **Assert `TaskResult.notes`.** A refused web answer, a recorded date conflict, a mixed-alphabet
  word — these produce no file, and the notes are the only account of the decision.
- **`requestedTable(call)`** parses what a call actually asked for; it is how the repair and
  narrowing ladders are pinned down.
- Relative imports need `.js`; type-only imports need `import type`. `noUncheckedIndexedAccess` is
  on, so indexed access is `T | undefined`.
