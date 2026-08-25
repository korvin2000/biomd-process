# The domain layer — `src/domain`

**Every rule of the published format lives here and nowhere else.** A change to `external/` has
exactly one landing site; `core`, `routing`, `reliability` and `state` stay ignorant of guitarists.
Adding a format rule anywhere else is the mistake this directory exists to prevent.

Module → responsibility table: [source-map.md](source-map.md#srcdomain--the-published-format-no-other-layer-may-know-these-rules).
Normative source: [external/](../../external/README.md), and
[external/02-value-domains.md](../../external/02-value-domains.md) for every `VD-*`.

## Two invariants of the code itself

**Narrow on output, wide on input.** Each normalizer emits exactly the canonical authored form and
accepts every plausible spelling of it. Rewriting `1893-02-21` locally is free; re-asking for it
costs a round trip and usually returns `1893-02-21` again.

**Drop, never guess** (`external/07` §7.2 rule 5). An absent field is correct; an invented one is a
claim about a person. Every dossier field is optional, so dropping degrades gracefully.

## Partial dates — the one place this deployment overrides `external/`

The specification says a date not known to the day is not representable and must be omitted
(`external/02`, `external/05` §5.11). That loses a real fact every time an article says only "born
in 1885", so **`catalogue.datePrecision`** lowers the floor and the canonical form is published
**truncated from the left**:

```
21.02.1893  →  02.1893  →  1893
```

Setting it back to `day` restores the specification exactly.

The trade-off is stated once, in the config: VD-DATE requires a consumer to treat anything outside
`\d{1,2}\.\d{1,2}\.\d{4}` as **absent**, so a strict reader ignores `"1893"` and behaves as if the
field had been dropped. Nothing breaks, and a reader that wants the year can have it.

`biomd validate` accepts whatever the setting allows and raises **no per-value warning** — the
setting *is* the statement of intent, and warning on every deliberate value would make `--strict`
unusable. The calendar is still checked: a producer writing `31.02.1900` has published a date that
does not exist.

`mergeDossier` performs **the one overwrite in the codebase**: a sharper reading of the *same* date
(`1893` → `21.02.1893`) replaces the blunter one, because those are one fact known to two depths
rather than two competing facts.

### The same day printed twice is still one day

Russian reference writing dates the nineteenth century in both calendars, and `aleksandrov.bio.md`
does it twice in one line: `род. 11(23).12.1818, ум. 24.12.1884 / 05.01.1885`. Neither form parsed,
so that entry published **no dates at all** while the article states both.

`parseDate` now reduces a bracketed or slashed alternative to the form printed **first** — reading,
not guessing. A genuine *range* is a different claim and is still refused: a dash was always
rejected, and a slash survives only when both sides are full dates within a fortnight of each
other, which no range ever is.

## A word written in two alphabets is always a machine's mistake

`abiton`'s dossier published `Авель Карлеvaro` — a model transliterating Abel Carlevaro's name and
stopping halfway. A *sentence* mixing alphabets is ordinary in this corpus ("Играл на гитаре Pedro
Maldonado"), so `mixedScriptWords` tests **per word**, where the mixture is never intentional.

It is **reported** (`biomd report --notes alphabets`), not repaired: which half is right is not
knowable from here, and dropping the field would lose a teacher the article really does name.

## A collective is a value, not a special case

`resolveEnsemble` maps `дуэт`, `квартета`, `Gitaartrio`, `cuarteto`, `ансамбль` to `{group, size?}`
— declined stems and Germanic compounds included, because a whole-word table misses most real
titles. Two things read it, and both would otherwise be guesses:

- **`gender: mixed`**, which `external/02` *defines* as "a collective entry", and which a model
  asked to choose between `m`, `f` and `mixed` gets wrong for four men often enough to matter;
- **how many faces belong in the photograph** (`src/images/subject.ts`).

> Ask it of a **name** — a title, a heading, a slug, the roster's entry — and never of the prose.
> `выступал в дуэте с Мелешко` is a sentence about one guitarist, and a table reading `ГРАН-дуэт`
> correctly files him as a pair.

### An ensemble has no `forename` — `ExtractionPipeline.forCollective`

Not decoration: `displayNamesOf` renders `forename + surname`, so whatever lands there is published
as the beginning of the trio's display name in every language index. Three things turn up in it,
and **a comma tells the first two apart from the third**:

| What is there | Where it goes |
|---|---|
| the collective's **name**, with nowhere else to go | promoted to `surname` |
| the collective's name **again**, beside a `surname` that already says it | dropped |
| its **members** | moved to `relatives`, which `external/05` defines as "related persons" and the reader renders as exactly that comma-joined line |

A real fact in the wrong member is worth moving, not discarding.

## Classification never touches the dossier

`type` / `gender` / `country` / `img` / `title` belong to `index.json` and are **errors inside a
`*.bio.json`** (`INV-7`). But they are only derivable from the article — which `extract` has open
anyway — from a v1 document being migrated, from a web search, or (for `img`) from the image index.

Every path routes them to a hint channel under `out/.hints/`, where `catalog` picks them up while
staying `usesLlm = false`. Precedence is strict and one-directional:

```
existing index row → extract hint (the article, or an authored v1 dossier)
                   → websearch hint → portrait hint (img only) → catalogue.defaultType
```

## An alias earns its place or it is not authored

`external/04` §4.5 asks a producer to author every form a reader plausibly types.
**`tasks.catalog.aliasPolicy` narrows that on purpose** — the second place after
`catalogue.datePrecision` where a setting overrides the specification — because §4.5 also specifies
how a consumer *matches*: graded by position, word-start included. A query for `Сеговия` therefore
already reaches `Андрес Сеговия`, and an alias contained in one that is already there adds a row, a
byte and a tie, and no reachability at all.

`distinct` (the default) drops exactly that, plus an alias equal to the row's Latin `title`
(searched in its own right) and a machine transliteration — `Andres Segoviya`, `Dzhon Vilyams` —
which nobody types and which the consumer's own Cyrillic→Latin expansion already covers from the
other end.

It **keeps** what nothing else reaches: the inverted order (`Сеговия Андрес` is not a substring of
anything), the birth name, and the roster's spellings. `spec` restores the full list.

> Containment is tested on **whole words**, so `Ким` is not swallowed by `Иоаким`.

## `index-<lang>.json[0]` is a display name, not one alias among several

The reader prints it under the thumbnail and searches everything behind it, and because
`index.json.title` is Latin-only, for every non-Latin language this element **is** the name the
entry is shown under. `tasks.catalog.displayNameOrder` therefore makes it a deployment choice
rather than a derivation.

`roster` (the default) reads: the roster's own `fullname` for the roster's language — `Абитон
Жерар`, the catalogue's own heading, written by a person — falling back to `Surname Forename` when
the roster does not know the entry. Every other language keeps `Forename Surname`, because a
Russian filing convention is not an English one. **Whichever order loses becomes the first alias**,
so nothing stops being findable.

### The roster abbreviates

`Адамян С.В.` is the same name as `Сергей Викторович Адамян` with less of it, and taking the roster
whole would publish initials where a reader expects a name. So a roster heading that merely
*reduces* what the dossier already knows — every word present in the full name, whole or as an
initial, and fewer words spelled out — loses to the same name in the roster's order.

One that says something genuinely new keeps its place, and that is what the setting exists for:
`Абреу Зекинья` is the name a reader looks for, and `Хосе Гомеш де Абреу` is what the article
calls him.

## The catalogue is updated, never rebuilt

`CatalogIndex.load` reads the existing `index.json` and `upsert` **edits** it: row order, unknown
members, hand-edited classification and — above all — every `id` survive, as do rows this run never
visited. `mergeNameIndex` does the same for `index-<lang>.json`, keeping a hand-authored `[0]` and
appending only new aliases.

Regenerating either from scratch would silently detach localized names from their entries, which is
why `tasks.catalog.merge: false` exists but should not be used.

### The escape hatch, narrower than `merge: false`

The same rule that protects a hand-edit makes a machine mistake permanent. Change
`tasks.portrait.assetPrefix` and every row keeps the `img` built from the old one — for ever,
silently, because `upsert` only ever fills an **empty** member.

`tasks.catalog.refresh` names the members this run may *correct*: `img`, `title`, `type`, `gender`,
`country`, and `displayNames` for `index-<lang>.json[0]`. It is **empty by default**, every
replacement is reported in the run notes, and it is meant to be switched on for the run that fixes
something and switched back off.

`biomd validate` catches the specific case that motivated it — a `..` segment in an `img` is an
error, since `VD-PATH-ASSET` has none — and warns when one photograph is shared by two rows, which
is nearly always the portrait matcher resolving a family name rather than a person.

## Validation

`biomd validate [dir] [--strict] [--json] [--no-files]` — LLM-free, exits 1 on an error
(`--strict`: on a warning too). `validateCatalogue` is a pure function over a snapshot of the files.

<!-- GAP: src/domain/validate.ts implements INV-1..INV-14 and INV-17..INV-28. INV-15 (index-<lang>[id][0]
     agrees with forename + " " + surname of the same language's dossier — warning severity) and
     INV-16 (its exemption for comma-list forenames and rows that do not own their dossier) are
     specified in external/07-authoring-and-validation.md:93-94 and are NOT implemented. Verified
     2026-08-25. Do not describe validate as covering the full list until this is closed or the
     omission is recorded as deliberate. -->
