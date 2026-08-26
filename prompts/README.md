# Prompt templates

One directory per task type; each holds a `system.md` and a `user.md`. The
mapping lives in `prompts.templates` in the config, so a directory can be
renamed or an A/B variant added without touching code.

```
prompts/
  extraction/{system.md,user.md}            extract
  translation/{system.md,user.md}           translate, mode: document
  translation/{segments-system.md,          translate, mode: segments  (default)
               segments-user.md}
  translation/minimax-m3/segments-system.md translate, but only for that model
  localization/{system.md,user.md}          localize
```

## Per-model templates

A subdirectory named after a **model id** — the `id:` in `llm.models[]`, not the
provider's slug — shadows the file it sits beside. Nothing in the config names
it; it is found because it is there. `biomd prompts list` shows every one that
was found, and `biomd prompts show <task> --model <id>` renders it.

Shadowing is **per file**: the example above changes what `minimax-m3` gets as a
system prompt and leaves `segments-user.md` shared with everyone.

This exists because a prompt is tuned against a model, not against a task. The
shared `segments-system.md` is a hundred lines of rules that were each measured
before they were written down; a rule added to correct one model's habit is
three more lines every other model pays for on every call and may read
differently to each of them.

**Extend, do not fork.** An override is rendered with the shared text already
resolved, as `sharedSystem` and `sharedUser`. The shape that keeps a two-line
correction two lines long:

```eta
<%= it.sharedSystem %>

## One correction, for this model only
…
```

A wholesale replacement is possible — just do not mention the variable — and is
the escape hatch, not the pattern. Two copies of the same hundred rules is how
they end up disagreeing.

**Which model answers is not knowable when the request is built.** Routing picks
per call, and a fallback may reach a model the first attempt never considered, so
every rendering travels with the request and the gateway selects one at dispatch
(`CompletionRequest.variants`). Two consequences: each variant gets its own
prompt-cache key, since two different prefixes sharing one is a wrong hit; and
`estimatedInputTokens` is measured on the shared rendering, so an override that
is the shared prompt plus a few lines is estimated a few tokens short.

## Conventions

**Rendering.** [Eta](https://eta.js.org) syntax: `<%= it.name %>` interpolates and
`<% ... %>` runs control flow. Whitespace is preserved verbatim (`autoTrim` is
off) — prompts are whitespace-sensitive, and an engine that silently ate a
newline would change the cache prefix behind the author's back. Two consequences
worth knowing before editing one:

- Put the opening tag immediately **before** the content it guards and the
  closing tag immediately before what follows, so a skipped block leaves no blank
  line:
  `<% if (cond) { %>- a line\n<% } %>next`.
  The `<%_ … _%>` slurping form does the opposite — it eats the content's own
  newline and glues the lines together.
- A script tag whose first character is `(` is a syntax error: the generated code
  is `tR+="…"` on the line above, and automatic semicolon insertion does not fire
  before an open parenthesis. Start with a keyword instead —
  `<% var card = it.fields || []; card.forEach(… %>`.
- **A comment is `<% /* … */ %>`.** Eta 3 has no `<%# … %>` form; it raises "Bad
  template syntax". Use it for anything a maintainer needs and a model does not —
  why a rule is worded the way it is, what a change was measured against. Prose
  left in a template is prose the model reads and is billed for on every call.

**System = stable, user = instructions, payload = a later message.** The document body —
or, in the batch modes, the `{hash: text}` table — is *never* a template variable.
`MessageBuilder` puts it in a separate final user message after everything the
templates produce. The stable user message carries the cache breakpoint, which keeps
the prompt-cache prefix byte-identical across the whole corpus. Putting anything
document-specific into a template — a filename, a counter, a timestamp — silently
destroys that and multiplies input cost.

**Batch prompts answer a table, not a document.** `translateSegments` and
`localize` receive `{"<hash>": "<source text>"}` and must return an object with
**exactly the same keys**. Anything a template says that encourages merging,
splitting, reordering or commenting on the fragments will show up as a validation
failure and a retry, so keep those instructions blunt. `⟦1⟧`-style placeholders
stand for link targets and must be copied through unchanged — that rule is load
bearing, not decorative.

**Versioning.** Both files are hashed into a `promptVersion` that feeds each
task's fingerprint. Editing a template therefore invalidates previously completed
work and it will be redone on the next run; unchanged templates cost nothing.

Per-model overrides hash in too, and they invalidate the task for **every**
model rather than only the one they name. A fingerprint is computed at plan time
and the model is chosen per call, so it can never mean "this model's prompt" —
the choice is between over-invalidating and silently serving the output of a
prompt that has since been replaced. Adding the first override to a task
therefore re-plans that task across the corpus; `--skip-existing` is the way to
stop it costing a full re-run. A task with no override keeps exactly the version
it had before overrides existed.

## Working on a template

```bash
# render one with sample variables, without spending a token
npx tsx src/cli/main.ts prompts show extract
```

Keep A/B variants as sibling files (`system.v2.md`) and point the config at the
one you want; the version hash keeps the runs distinguishable in the journal.

## Variables available

| Task | Variables |
|---|---|
| `extract` | `fields[]` (`{key, hint}` — the field card), `language`, `languageName`, `requiredFields[]`, `partial`, `partLabel`, `notes` |
| `websearch` | `fields[]` (`{key, hint, refine?, current?}` — only what is missing), `language`, `languageName`, `checkLiveness`, `age`, `collective`, `requireSource` |
| `translate` | `sourceLanguage`, `targetLanguage`, `sourceLanguageName`, `targetLanguageName`, `glossary{}`, `partial`, `partLabel` |
| `translateSegments` | `sourceLanguage`, `targetLanguage`, `sourceLanguageName`, `targetLanguageName`, `glossary{}`, `count` |
| `localize` | `sourceLanguage`, `targetLanguage`, `sourceLanguageName`, `targetLanguageName`, `glossary{}`, `count` |

Every `*Name` variable is the language spelled out — `ru` → `Russian` — because a
two-letter code is unambiguous to a program and merely probable to a model.

**Name a language exactly once, with one expression.** `languageName()` already
falls back to the code when the runtime has no name for it, so
`<%= it.languageName %>` can never render empty and the old
`<%= it.languageName || it.language %>` bought nothing. It also *read* like two
languages being offered to the model, which is a real cost in a file whose whole
job is to be unambiguous — write `<%= it.sourceLanguageName %>` and nothing else.

The bare `sourceLanguage` / `targetLanguage` / `language` codes stay available
for a template that genuinely needs a machine value.

Everything under `prompts.variables` in the config is merged in as well, for
project-wide values such as `projectName`.

## What is *not* a template variable

Two things reach the model without passing through a template, and both are
deliberate — see mechanism 1 in `CLAUDE.md`. The **document** (or the
`{hash: text}` table) is appended after the rendered instructions as a volatile
section, so the provider's prompt cache hits across the whole corpus. So is the
**article context line** that `translateSegments` receives (`## About this
article` — the title and the opening of the lead): it changes per document, and
putting it in a template would break the cached prefix for every document that
follows.

Which is also the rule for editing these files: anything document-specific in a
template — a filename, a counter, a timestamp — silently costs the whole corpus
its cache.

`translateSegments` and `localize` do still receive `count`, and it earns its
place: telling the model how many values it owes is what stops a batch coming
back one key short. But it is a counter, so it goes in the **last** line rather
than the first — every batch of the corpus then shares an identical prefix up to
it, which is the whole of what the cache needs.
