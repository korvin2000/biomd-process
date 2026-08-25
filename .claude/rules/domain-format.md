---
paths:
  - "src/domain/**/*.ts"
  - "external/**/*.md"
---

# Editing the format layer

Full account: [docs/ref/domain-format.md](../../docs/ref/domain-format.md). Normative source:
`external/` — nine documents, version 2.

- **This directory is the only place a format rule may live.** A change to `external/` lands here
  and nowhere else. `core`, `routing`, `reliability` and `state` stay ignorant of guitarists.
- **Narrow on output, wide on input.** A normalizer emits exactly the canonical authored form and
  accepts every plausible spelling of it. Fixing `1893-02-21` locally is free; re-asking costs a
  round trip and usually returns the same thing.
- **Drop, never guess** (`external/07` §7.2 rule 5). Every dossier field is optional. An invented
  field is a claim about a person.
- **`mergeDossier` fills gaps and never overwrites** — with exactly one exception, a *sharper
  reading of the same date* (`1893` → `21.02.1893`). Adding a second exception needs a reason in
  the file.
- **Two settings deliberately override `external/`**: `catalogue.datePrecision` (publishes a
  left-truncated partial date the spec says to omit) and `tasks.catalog.aliasPolicy` (drops aliases
  §4.5 asks for, because §4.5's own matching rules already reach them). Both are documented
  trade-offs — do not "fix" either back to the spec without saying so.
- **`resolveEnsemble` is asked of a *name*** — a title, heading, slug or roster entry — **never of
  the prose.** `выступал в дуэте с Мелешко` is a sentence about one guitarist.
- `src/images` and `src/roster` are the same arrangement for the two *input* formats. A rule about
  `images/artists.json` belongs in `src/images`, not here.
