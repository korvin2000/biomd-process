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
  localization/{system.md,user.md}          localize
```

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

**System = stable, user = instructions, payload = appended.** The document body —
or, in the batch modes, the `{hash: text}` table — is *never* a template variable.
`MessageBuilder` appends it after everything the templates produce, which keeps
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
| `extract` | `fields[]` (`{key, hint}` — the field card), `language`, `requiredFields[]`, `partial`, `partLabel`, `notes` |
| `websearch` | `fields[]` (`{key, hint, refine?, current?}` — only what is missing), `language`, `checkLiveness`, `age`, `requireSource` |
| `translate` | `sourceLanguage`, `targetLanguage`, `glossary{}`, `partial`, `partLabel` |
| `translateSegments` | `sourceLanguage`, `targetLanguage`, `glossary{}`, `count` |
| `localize` | `sourceLanguage`, `targetLanguage`, `glossary{}`, `count` |

Everything under `prompts.variables` in the config is merged in as well, for
project-wide values such as `projectName`.
