---
paths:
  - "src/pipelines/**/*.ts"
  - "src/documents/**/*.ts"
---

# Editing a pipeline or the Markdown layer

Full account: [docs/ref/pipelines.md](../../docs/ref/pipelines.md) ·
what crosses the wire: [docs/ref/cost-mechanisms.md](../../docs/ref/cost-mechanisms.md).

- **Pipelines return artifacts; they never write files.** That is what makes `--dry-run` free and
  a unit test disk-free.
- **A task that *updates* its output must declare `mergesOutput`** (`catalog`, `websearch`), or
  `run.skipExistingOutputs` reads the file's existence as "done" and it never runs again.
- **Mark a dependency `optional: true` only where the dependent genuinely degrades.** A corpus-scope
  dependency resolves to *every* task of that pipeline, so a required one lets one bad document
  retire the whole catalogue.
- **A harvest declares `coverage: 'whole'`.** "Answer every key this article supports" cannot tell
  an article's silence from an unsent sentence, so partial context attempts are dropped at plan time.
- **The repair ladder moves on the cheap axis first**: a missing key is re-asked alone, a truncated
  batch is halved on the *same* model, and only then does it fall back to a wider one.
- **`verify` gets `strict`, and it decides how much a rejection may cost.** On a lenient round the
  key is re-asked alone, on the model already chosen; on the strict round the rejection fails the
  call and escalates the batch. Reject on both for something *wrong*; reject only while `!strict`
  for something merely *worse*, or a defect nobody can repair costs a document.
- **A retry must not be served the previous attempt's answers** — they are what failed. That is what
  `ExecutionContext.attempt` is for.
- **`src/documents/markdown/inline.ts` holds the one link/image pattern.** Five private copies once
  disagreed on an escaped bracket and cost an entire edition.
- **Structure the model *invented* is a defect; a list marker is not.** `structuralDrift` reports
  the first through `verify`; `escapeBlockMarker` takes a backslash at splice time for the second
  rather than spending nine calls re-asking for a right answer.
- **`StructureGuard` ignores fenced content.** That is how 44% of one article stayed in Russian
  while passing every check.
