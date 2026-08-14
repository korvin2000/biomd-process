# Implementation Plan — Catalogue v2

## Stable ids · localized name index · ISO countries · hidden pages · search rewrite · CodexModal decomposition

**Status:** 🚧 IN PROGRESS · **Date:** 2026-07-31
**Step 1 (documentation) — ✅ DONE 2026-07-31.**
**Step 2 (data migration) — ✅ DONE 2026-07-31**, with four as-built deviations
recorded in §5.
**Step 3 (name indexes + technical pages) — ✅ DONE 2026-07-31**; see §6.
**Step 4 (data layer + routing) — ✅ DONE 2026-07-31**, with five as-built
deviations recorded in §7.
**Step 6 (codex decomposition) — ✅ DONE 2026-07-31**; see §9. The 🔴
`BioArticle` link-classification requirement found in Step 3 is **fixed** —
`#/slug`, `<slug>.bio.md` and `<slug>.md` all navigate in-app, so the `::: nav`
menus written in Step 3 work.
**Step 5 (search + browse UI) — ✅ DONE 2026-07-31**; see §8. A pre-existing
🔴 was found and fixed there: `fold()` destroyed Cyrillic `й`, so
transliterated search could never reach **Йован Йовичич**.
Only Step 7 (guard-rails: `lint:content` + Vitest) remains.
Decisions D4, D6, D11, D12 signed off by the owner; **D10 was accepted then
reversed** (dates stay in the dossier); D1–D3, D5, D7–D9 stand as
recommendations unless contested.
**Scope:** `pages/index.json`, new `pages/index-<lang>.json`, all `*.bio.json`,
`docs/` specs, `.claude-memory/`, and `app/src/{lib,components}`.
**Read first:** `CLAUDE.md` → [`.claude-memory/INDEX.md`](../../.claude-memory/INDEX.md) →
[`13-app-code-map.md`](../../.claude-memory/13-app-code-map.md) →
[`14-app-patterns-and-gotchas.md`](../../.claude-memory/14-app-patterns-and-gotchas.md) →
[`15-app-critique.md`](../../.claude-memory/15-app-critique.md).

---

## 0. Verdict

The four problems named in the request are all real, and the proposed direction
is right. In particular:

- **Transliteration as the multilingual search basis is genuinely broken** for
  CJK — `search.ts` `CYR_TO_LAT` only covers Cyrillic, so a Chinese, Japanese
  or Korean query can never match anything today. A per-language alias index is
  the correct fix, and it is the *only* one of the four problems that cannot be
  solved by tidying what exists.
- **The duplication is measurable:** `type`, `country`, `gender`, `title`,
  `forename`, `surname` and `bio` are stored in `index.json` *and* in every
  language edition of `*.bio.json` — 12 files today, and the editions already
  disagree (`pages/ru/andres-segovia.bio.json` has `country: "ES"`,
  `index.json` has `"Spain"`; `metadata.id` runs `0001…0007` while `index.json`
  has 10 rows and no id at all).
- **Non-biography pages have no home in the current model.** Every code path
  from `loadEntry` to `CodexModal` assumes a `json` sibling exists.

Three proposals need adjustment before implementation (details in §1); the rest
is accepted as specified.

This change also **deletes** a fair amount of accumulated workaround:
`COUNTRY_TEXT_TO_ISO`, `countryDisplay`, `resolveCountry`, `resolveCountryCode`
(the "10-entry band-aid" from [`15`](../../.claude-memory/15-app-critique.md)),
the ranking-prefetch pipeline, and the forename/surname fallback chain. Net
production LOC is expected to be roughly flat despite six new files.

### Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| D1 | `index-ch.json` in the request → the ISO 639-1 code for Chinese is **`zh`**, which is what `app/src/lib/languages.ts` already uses. `ch` would never be loaded (and `CH` is Switzerland). | Use **`index-zh.json`** — and the same applies to the content directory, which is `pages/zh/`, not `pages/ch/`: `localizeContentPath` builds `/<lang>/…` from the very same `Lang` code. Treated as a typo throughout. |
| D2 | Request C says "*change the **bio.md** format*" but lists `id`, `title`, `gender`, `type`, `country`, `bio`, `dataStatus` — those live in **`*.bio.json`**; the `.bio.md` files have no front-matter at all (verified across all 15). | Read C as **`*.bio.json`**. No `.bio.md` change. |
| D3 | `id` = "порядковый номер". A literal *position* renumbers every row on insert/delete and silently breaks every `index-<lang>.json` key. | **Assign sequentially, never renumber, never reuse.** Looks identical today; safe forever. Store as a **string** (JSON object keys are strings — `"7"` vs `7` would be a live bug class). |
| D4 | **Codex biography header.** | ✅ **DECIDED — keep `<h1>forename</h1>` + `<h2>surname</h2>` as today.** `*.bio.json` is a **per-language edition**, so `forename`/`surname` are *already* the localized name in the edition being displayed — the header therefore follows `contentLang`, which is more correct than following the UI language. My earlier objection was wrong because it was reasoning from the **test data, which is not internationalized** (`pages/ru/andres-segovia.bio.json` holds Latin `"Andrés"/"Segovia"`, `pages/de/…` holds a Cyrillic `title`). That is a data defect, fixed in Step 2 — see §3.3 and [Step 2.3](#step2-i18n). |
| D5 | `type: "hidden"` overloads a *craft* taxonomy (`guitarist`/`composer`/`luthier`) with a *visibility* concept. Two axes in one field. | **Ship it as asked** — for technical pages `type` has no other job — but route every check through **one predicate** (`isListed(entry)` in `lib/entry.ts`). Splitting visibility into its own field later then costs 3 lines in 1 file, not a codebase sweep. |
| D6 | Removing the card rank stars (G1) makes the whole `prefetchAll` → `rankings` pipeline dead weight. | ✅ **DECIDED — delete it.** `ranking` stays in `bio.json` for the Lore tab. Removes ~45 lines and N boot-time fetches. **Future filter fields (birth date, …) must not bring it back** — they belong in the index, not behind N round-trips. See §13. |
| D7 | Default portraits `photos/default-{male,female,mixed}.jpg` **do not exist yet**. | Create the 3 files as part of Step 2. Until then the existing procedural SVG placeholder (`lib/placeholder.ts`) catches the 404 — nothing breaks, but every default-portrait card shows a monogram. |
| D8 | This refactor splits one source of truth into two files joined by `id`. Drift (dangling id, duplicate id, duplicate slug, bad ISO code, `json`-less row typed as a person) is a matter of *when*. | Add **`scripts/lint-content.mjs`** (Step 7) — ~120 lines, zero deps, `node scripts/lint-content.mjs`. This is the guard-rail that makes the split safe. Strongly recommended. |
| D9 | The repo has **no tests at all** (backlog item #1 in [`15`](../../.claude-memory/15-app-critique.md)). This change rewrites the highest-logic pure module in the app (search + scoring). | Add **Vitest + ~5 focused spec files** for `search`, `entry`, `names`, `paths`, `metadata` in Step 7. Skippable, but this is the single best moment to do it. |
| D10 | Denormalize birth/death dates into `index.json` ahead of the filter UI (§13). | ❌ **REVERSED 2026-07-31 (owner).** Dates live **only** in `*.bio.json` `dates`. Briefly accepted and implemented in Step 2, then withdrawn: **one fact, one file** outranks pre-building a facet nobody has asked for yet. `born`/`died`/`dates` in an index row is now a validation *error*. §13 keeps the reasoning for the day a date filter is actually built. |
| D12 | `country` case in `index.json`. | ✅ **DECIDED 2026-07-31 (owner) — authored lowercase** (`es`, `py`), read **case-insensitively**. Generalized to all enum-like fields (`type`, `gender`, `lang`, `country`): the loader normalizes **once at the boundary** — `country` → uppercase (what `Intl.DisplayNames` and `CountryFlag` expect), the rest → lowercase — so no downstream code ever does a case-insensitive compare. Canonical form at the edge, not scattered `.toLowerCase()` calls. |
| D11 | **Test-data licence.** You've confirmed the fixtures are partly copied, mismatched or untranslated, and that they may be rewritten to spec. | Applied throughout Step 2. Working rule: for **real people** (Barrios, Segovia, Django, Hendrix, Paco, Jovičić) facts must be *correct* — real dates, real places, properly translated — because wrong facts about real people are not neutral test data. For **synthetic rows** (`authors`, `biomd-demo`, the duplicate "Codex"/"ChatGPT" pairs, `goya2.right`) only internal consistency is required. Nothing invented for a real person. |

---

## 1. Critical assessment of each proposal

### Accepted as specified

| Item | Assessment |
|---|---|
| **A2** `gender` → `index.json` | Correct. Gender is language-independent, is needed *before* `bio.json` loads (default portrait), and is a stated future search facet. Vocabulary in the live data is `m` / `f` / `mixed` (`pages/ru/authors.bio.json`). |
| **A3** `country` as ISO alpha-2 | Strictly better. Deletes `COUNTRY_TEXT_TO_ISO` + 3 wrapper functions, gives free localization via `Intl.DisplayNames` in all 10 UI languages, fixes the facet-chip case-drift bug, and makes `CountryFlag` reachable without a lookup table. All 6 countries in the live data are already covered by `CountryFlag` (PY ES UA FR US RS). |
| **A4** drop `forename`/`surname` | Correct. Two downstream dependencies must be re-sourced: `search.ts:69-70` (haystacks → localized names + aliases) and `CharacterCard.tsx:77` (`initialsOf` for the placeholder → derive from the display name). |
| **A5** optional `json` / `img` | Required by problem #3. `json` absent becomes the **declared** switch for "this is a page, not a biography" (see E below). |
| **A7** `title` = Latin fallback | Good. Makes explicit what the code already relies on. Two live rows need re-authoring: `"Авторы проекта"` → `"Project Authors"`, `"Франсис гоя"` → `"Francis Goya"`. Side benefit: the Latin-slug-as-search-bridge hack ([`14`](../../.claude-memory/14-app-patterns-and-gotchas.md)) stops being load-bearing. |
| **B** `index-<lang>.json` | Format `{"id": ["name", "alias", …]}` is the right shape: direct id lookup, no ordering coupling, minimal bytes. Two rules to make normative: **[0] is the display name, [1…] are search-only aliases never rendered**, and **omit an id entirely when its localized name equals the Latin `title`** (keeps `index-en.json` nearly empty). |
| **C** `bio.json` slimming | Correct. Two notes: `forename`/`surname` **stay** — they are the *localized* name of the edition and remain the codex header source (D4) — and `ranking` stays for the Lore tab. Removing `title` is then not a loss: `forename + surname` already carries the localized name for anything that has loaded the dossier, and `index-<lang>.json` carries it for everything that has not. |
| **D** routing | Unchanged contract, `#/{md-basename}`. Deliberately *not* switching to `#/{id}`: human-readable URLs, back-compatible with existing deep links, and content already hard-codes this form (`pages/ru/goya2.right.bio.md` has `::: nav` items pointing at `/#/williams_cd1`). **But see §2.4 — there is a live routing bug to fix here.** |
| **G** `CharacterCard` | All three points accepted. |

### Accepted with modification

| Item | Modification |
|---|---|
| **A1** `id` | Stable-forever, string-typed. See D3. |
| **A6** `type: "hidden"` | Behind a single predicate. See D5. Also: hidden entries must stay **routable and resolvable** — excluded only from the grid, search results, facet lists, result counts and ←/→ page-turn order. `App.tsx` builds `bySlug` from *all* records so `#/about` and cross-links from `::: nav` keep working. |
| **F** search | Aliases are the *primary* mechanism, but keep `translitVariants` as a **bounded query-side fallback applied only to the Latin fields**. Rationale: with UI=`en` a reader typing "Сеговия" has no Cyrillic haystack to hit — transliteration is exactly what covers that, and it costs one `Set` per token per query once hoisted out of the per-document loop. Transliteration being a bad *basis* and a useful *fallback* are not in conflict. |
| **E** CodexModal | Accepted, and extended: the decomposition should also lift the **shell** (backdrop, page-turn panel, ornaments, close/prev/next, language menu, scroll container, keyboard handling) out of the orchestrator, not just the two content modes. Otherwise `CodexModal.tsx` stays a 200-line component that merely delegates its last 40 lines. |

### Design point worth stating explicitly

`lang` (in `index.json`) and `index-<lang>.json` are **orthogonal**:

- `lang: "ru,en"` = which **content editions** (`pages/<lang>/*.bio.md`) exist.
- `index-zh.json` = which **name translations** exist.

A Chinese reader can therefore find 安德烈斯·塞戈维亚 by name and open the
Russian edition of the article. That is the intended behaviour and it must be
documented, because it is the non-obvious part of the two-file split.

---

## 2. Verified baseline (measured, not assumed)

| Fact | Value |
|---|---|
| `pages/index.json` rows | **10** (working tree; `biomd-demo` was removed but its files remain) |
| Rows sharing one `json` | 3 pairs — `barrios.bio.md`/`agustin-barrios.bio.md`, `jovicic.bio.md`/`jovan-jovicic.bio.md`, and `goya2.right.bio.md` reusing `paco-de-lucia.bio.json` |
| `*.bio.json` files | **12** (`ru` 8, `en` 3, `de` 1) |
| `*.bio.md` files | **15** (`ru` 11, `en` 3, `de` 1) |
| Distinct `metadata.id` | `0001`–`0007`, plus `9999` (demo) |
| Fields to strip from every `bio.json` | `id`, `title`, `gender`, `type`, `country`, `bio`, `dataStatus` — present in **all 12** |
| Countries in `index.json` | Paraguay, Spain, Ukraine, France, United States, Serbia → `PY ES UA FR US RS` |
| `CountryFlag` coverage | 22 codes; all 6 above are covered |
| UI languages | 10 (`en es ja de fr it pt ru zh ko`) |
| `pages/photos/` | 10 jpg; `iznaola`, `koshkin`, `kozlov_v1` unreferenced |

### 2.4 Live bugs this change must fix (found while surveying)

1. 🔴 **`goya2.right` is unroutable.** `hooks.ts:67` matches `^#\/([\w-]+)$`;
   `\w` excludes `.`, so the slug `goya2.right` (from the untracked
   `pages/ru/goya2.right.bio.md`) never matches. The card opens it (state is
   set directly) but a **deep link or reload silently shows nothing**.
   → widen to `[\w.-]+` and `decodeURIComponent` the capture.
2. 🟠 **`translitVariants` is recomputed per document.** `search.ts:77` builds
   the variant `Set` inside `tokenMatches`, i.e. N× per token. Hoist to once
   per token per query.
3. 🟠 **Country facet is exact-string on free text** (`search.ts:99`) — any
   case or spelling drift creates a duplicate chip. Fixed for free by A3.
4. 🟡 **`pages/index.json.old`** is untracked *inside `publicDir`* — Vite
   serves it and copies it into `dist/`. Move it out of `pages/` or delete it.

---

## 3. Target formats (normative — these go into `docs/`)

### 3.1 `pages/index.json`

```jsonc
[
  {
    "id":      "3",                          // string; stable; assigned once; never reused
    "title":   "Andres Segovia",             // Latin/ASCII fallback name + last-resort search key
    "lang":    "ru,de",                      // content editions; first = original. Absent → "ru"
    "type":    "guitarist",                  // craft, or "hidden" for technical pages
    "gender":  "m",                          // "m" | "f" | "mixed"; absent on non-person pages
    "country": "es",                         // ISO 3166-1 alpha-2, LOWERCASE (D12); optional
    "md":      "/andres-segovia.bio.md",     // REQUIRED. Localized to /<lang>/…  Slug = basename
    "json":    "/andres-segovia.bio.json",   // OPTIONAL. Absent ⇒ page, not biography ⇒ no tabs
    "img":     "photos/andres-segovia.jpg"   // OPTIONAL. Absent ⇒ photos/default-<gender>.jpg
  }
]
```

**Rules**

- `id` — unique, stable, never reused, **not** a position. Sequential decimal
  strings by convention. Sole join key to `index-<lang>.json`.
- `md` — the only required path. **Slug** = basename minus `.bio.md` / `.md`;
  must be Latin/ASCII; must be unique across the index; it is the route
  (`#/{slug}`).
- `json` present ⟺ the entry is a **biography** (4-tab codex). This is a
  *declared* property, decided from `index.json` — never inferred from whether
  a fetch happened to succeed, so the chrome never changes shape mid-load.
- `type: "hidden"` — excluded from grid, search, facets, counts and ←/→ order;
  still routable and still a valid cross-link target.
- `country` — ISO alpha-2, **lowercase** (D12); display name from
  `Intl.DisplayNames`. Semantics: the person's **principal national identity**,
  not necessarily their birthplace (Django Reinhardt is `fr` though born in
  Belgium; birthplace lives in the dossier). One value — pick the primary one
  for dual nationals.
- **No dates** (D10 reversed). `born`/`died`/`dates` in an index row is a
  validation error; the dossier's `dates` is the only home.
- **Case** — `type`, `gender`, `country`, `lang` are authored lowercase and
  read case-insensitively; the loader normalizes each once (D12).
- Default portrait map: `m → photos/default-male.svg`,
  `f → photos/default-female.svg`, `mixed`/absent → `photos/default-mixed.svg`
  (as built in Step 2 — engraved SVG, ~1.5 KB each, not the `.jpg` this plan
  first assumed). A 404 on any portrait still falls through to the procedural
  SVG placeholder.

### 3.2 `pages/index-<lang>.json`

```jsonc
// pages/index-ru.json
{
  "3": ["Андрес Сеговия", "Сеговия", "Андрэс Сеговия"],
  "4": ["Авторы проекта"]
}
```

- Key = `index.json` `id`. Value = non-empty array of strings.
- `[0]` = **display name** in that language. `[1…]` = **aliases**: search-only,
  never rendered. Misspellings, maiden names, stage names, alternate
  romanizations, name-order variants.
- **Omit an id entirely** when its localized name equals the Latin `title` —
  `index-en.json` should be nearly empty.
- Missing file, missing id, empty array → fall back to `index.json.title`.
  Never an error.
- `<lang>` is an ISO 639-1 code from `LANGUAGES` (`languages.ts`). Files for
  unknown codes are simply never loaded.

### 3.3 `*.bio.json` — `metadata` after slimming

Removed: `id`, `title`, `gender`, `type`, `country`, `bio`, `dataStatus`.
Kept: `birthname`, `forename`, `surname`, `birthplace`, `deathplace`, `dates`,
`relatives`, `instruments`, `genres`, `bands`, `awards`, `teachers`,
`disciples`, `jobs`, `ranking`, `url`, plus `media` and `documents` unchanged.

`metadata` becomes purely a **dossier**. The field-ownership rule that explains
*why* those seven fields move — and the rule the whole model now rests on:

| Kind | Lives in | Rule |
|---|---|---|
| Identity & classification, needed **before** any per-entry fetch | `index.json` | `id`, `type`, `gender`, `country`, `lang`, paths, Latin `title` |
| **Display name + search aliases** | `index-<lang>.json` | one tiny file per UI language, loaded once |
| **Language-scoped prose** | `pages/<lang>/*.bio.json` | authored **per edition** |
| Language-invariant dossier facts | `pages/<lang>/*.bio.json` | copied identically into every edition |

**Every prose field in `metadata` is language-scoped and MUST be authored in
that edition's language** — not just `forename`/`surname`, but also
`birthname`, `birthplace`, `deathplace`, `instruments`, `genres`, `bands`,
`awards`, `teachers`, `disciples`, `jobs`, `relatives`. This is what makes the
codex header (D4) and the Lore tab correct without any runtime translation
layer.

> Consequence: `LoreTab.localizeJob()` ([LoreTab.tsx:164](../../app/src/components/codex/LoreTab.tsx)) —
> which routes job strings through `typeLabel` to half-translate English data —
> becomes obsolete and is **deleted** in Step 6. It exists only because the
> test data is not internationalized.

Language-**invariant** facts (`dates`, `ranking`, `url`) stay in `bio.json` and
are therefore copied across editions. That is accepted: only one edition is
ever loaded, so it is duplication in cold files, not in the hot path. The sync
risk is real but cheap to police — `lint-content` warns when these three
differ between editions of the same entry (§10).

#### The one deliberate overlap

`index-<lang>.json[id][0]` (display name) and `forename + " " + surname` in the
same language's `bio.json` are two spellings of the same fact. This is a
**deliberate denormalization**, for the same reason `type`/`country`/`gender`
are denormalized into `index.json`: the grid and the search box must render
1249 names without 1249 network round-trips, and splitting a display name back
into given/family parts is not reliably reversible ("Paco de Lucía",
"Sánchez Gómez", "Јован Јовичић").

`lint-content` turns the invisible sync risk into a checked invariant: it
**warns** when `[0] !== forename + " " + surname` for the same language.
A warning, not an error — roster/pseudo-identity pages legitimately differ
(`authors`: display "Авторы проекта", forename `"Сергей,Виктор,…"`).

---

## 4. Step 1 — Documentation (source of truth first)

Per `CLAUDE.md`, `docs/` changes land **before** code.

| File | Change |
|---|---|
| **`docs/Catalog-Index.md`** | **NEW.** Normative spec for `index.json` + `index-<lang>.json`: §3 above in full, plus the routing contract, the `lang` vs `index-<lang>` orthogonality, the search model (localized names → aliases → Latin fallback → transliteration fallback), authoring recipes, and the validation rules `lint-content` enforces. This document does not exist today — `index.json` has only ever been described in a memory note. |
| `docs/MetaData.md` | Remove the 7 fields from the field tables; add a "moved to index.json" pointer box; update *LLM authoring rules* 6 & 8 (id/country no longer live here); rewrite *Recommended complete template*, *Minimal valid entry*, the `parseMetadata` example (it currently *throws* without `id`/`title`/`bio`), *Parsing procedure* step 5, and the *UI mapping* table (add the page/no-tabs mode). |
| `docs/MetaData.json` | Regenerate the template to match §3.3. |
| `docs/Biography_card_Design.md` | Document the two codex modes: **biography** (header + 4 tabs) and **page** (header + article, no tab bar); state the header composition for each. |
| `docs/Biography-Markup.md` | One clarification only: a `::: nav` / link target resolves via `#/{slug}` where slug is the `md` basename, and may target a `hidden` entry. |
| `CLAUDE.md` | Update *Core conventions* (index.json owns id/type/gender/country; ISO countries everywhere; localized names in `index-<lang>.json`) and the `pages/` row in the layout table. |
| `.claude-memory/11-index-json.md` | **Rewrite.** Its whole "⚠ Deviations" section (free-text country, no id) is what this change resolves. |
| `.claude-memory/03-metadata-schema.md` | Strip the 7 fields; point at `Catalog-Index.md` for identity. |
| `.claude-memory/{INDEX,01,07,12,13,14,15}.md` | Add the `Catalog-Index.md` row to `INDEX.md`; update conventions (07), architecture/code map/recipes (12/13/14 — the "Add a catalogue entry" recipe changes materially); tick off the country-table and search-scaling items in the 15 backlog. |

**Exit criteria:** a reader can author a new catalogue entry — biography *or*
technical page, in any language — from `docs/` alone.

---

## 5. Step 2 — Migrate the existing data

No code changes; the app is expected to be broken between Step 2 and Step 4.
(If a green working tree matters more than review granularity, do Steps 2–4 on
one branch and merge as one commit.)

> **Test-data licence (D11).** The fixtures are partly copied between files and
> partly untranslated; they are to be rewritten to spec rather than preserved.
> Real people get *correct* facts; synthetic rows only need to be internally
> consistent.

> ### ✅ As built (2026-07-31) — four deviations from the plan as written
>
> 1. **Default portraits are `.svg`, not `.jpg`** (D7). ~1.5 KB each, sharp at
>    any card size, no binary blobs in git, drawn in the same engraved
>    paper/gold/burgundy language as `lib/placeholder.ts`. Accents follow the
>    Lore tab's gender colours (`#41506b` / `#7a1f2b`) with muted gold for
>    `mixed`. `Catalog-Index.md` §8 and note 11 updated to match.
> 2. **Row 8 (`jovicic.bio.md`) `lang` corrected `"ru,en"` → `"ru"`.** The
>    declared `en` edition has never existed — `pages/en/jovicic.bio.md` is
>    absent. A **pre-existing v1 defect**, invisible because `loadEntry` fails
>    soft; the validation pass caught it immediately. This is the first thing
>    the two-file split has already paid for.
> 3. **`goya2.right.bio.md` → `goya2.right.md`.** Pages carry no `.bio.` infix
>    (§9). The dot in the basename is **kept deliberately** as the fixture for
>    the `useHashRoute` slug bug (§2.4 #1) — `#/goya2.right` must work after
>    Step 4.
> 4. **Localization rule extended to `media[].label` / `documents[].label`.**
>    They are displayed prose and were being left in one language. `target`s
>    stay invariant; proper nouns (band names, work titles) keep their own
>    spelling in every edition. `MetaData.md` and note 03 updated.
>
> Verified: 11 index rows, 12 dossiers, **0 errors, 0 warnings** against the
> §11 rules (run as a throwaway script; `scripts/lint-content.mjs` still lands
> in Step 7).

1. **Rewrite `pages/index.json`** to §3.1:
   - assign `id` `"1"`…`"11"` in current file order (`biomd-demo` returns last);
   - `title` → Latin (`"Project Authors"`; the rest already are);
   - `country` → ISO (`PY ES UA FR US RS`);
   - `gender` lifted from the paired `bio.json` (`m`, plus `mixed` for `authors`);
   - drop `forename`/`surname`;
   - reclassify the rows that never fitted the one-row-per-person model:

   | # | Row today | Becomes | Why |
   |---|---|---|---|
   | 1 | Agustín Barrios Mangoré **ChatGPT** | listed `guitarist` | the canonical Barrios entry |
   | 2 | Agustín Barrios Mangoré **Codex** (`barrios.bio.md`) | **`hidden`** | an alternate *rendering* of the same person, kept for comparison — reachable at `#/barrios`, but two identical cards in the grid is noise |
   | 7 / 8 | Јован Јовичич **GPT** / **Codex** (`jovicic.bio.md`) | listed / **`hidden`** | same pair, same reason |
   | 10 | "Франсис гоя" | **`hidden`**, **no `json`** | a triple mismatch: the row is titled *Francis Goya*, points at `paco-de-lucia.bio.json`, and `goya2.right.bio.md` actually contains a **John Williams discography** with `::: nav` links to `williams_cd1…4`. It is a sub-page, not a biography — exactly the case `hidden` + optional `json` was added for. Retitle to `"John Williams Discography 5"` |
   | — | `biomd-demo` (removed from the index in the working tree) | **`hidden`** | it is the BioMD 1.3 conformance fixture; `hidden` is its correct home, and it stops polluting the grid |

   Result: **7 listed biographies + 4 hidden rows**, which exercises every new
   branch (listed/hidden, with/without `json`, with/without `img`) before a
   single technical page is written.

   ↩ Easily reversed: if you'd rather compare the two renderings side by side
   in the grid, drop `hidden` from rows 2 and 8 and disambiguate them in
   `index-ru.json` instead (`"Агустин Барриос (Codex)"`).
2. **Strip 7 fields from all 12 `*.bio.json`** files. Mechanical — do it with a
   script, not by hand, and diff the result.
3. <a id="step2-i18n"></a>**Internationalize the dossier prose in all 12
   `*.bio.json`** (§3.3). This is the larger half of the step and cannot be
   scripted — it is authoring.
   The test data is currently language-blind; measured defects:

   | Defect | Where | Fix |
   |---|---|---|
   | `forename`/`surname` are Latin in the **ru** editions (`Andrés`/`Segovia`, `Django`/`Reinhardt`, `Jimi`/`Hendrix`, `Agustín`/`Barrios`, `Francisco`/`Sánchez Gómez`) | 5 of 8 `pages/ru/*.bio.json` | Cyrillic: `Андрес`/`Сеговия`, `Джанго`/`Рейнхардт`, … |
   | `title` is **Cyrillic inside the `en` and `de` editions** ("Джанго Рейнхардт" in `pages/en/`, "Андрес Сеговия" in `pages/de/`) | 4 files | Field is removed anyway (C) — but it proves the editions were copied, not translated |
   | `forename`/`surname` are **Serbian** Cyrillic (`Јован`/`Јовичић`) in both the `ru` and `en` editions | `{ru,en}/jovan-jovicic.bio.json` | ru → `Йован`/`Йовичич`; en → `Jovan`/`Jovičić` |
   | `birthplace`, `deathplace`, `instruments`, `genres`, `bands`, `awards`, `teachers`, `disciples`, `jobs` are English in **every** edition ("Linares, Spain", "classical guitar", "Solo artist", "Primarily self-taught", "Guitarist,Teacher,Editor,Arranger") | all 12 | Translate per edition. This is what retires `LoreTab.localizeJob` |
   | `forename` holds a comma list (`"Сергей,Виктор,Александр,Константин"`) | `ru/authors.bio.json` | Leave as-is — `CodexModal.tsx:109` already handles it deliberately; just note it in the spec as the roster-page convention |

   `en` and `de` editions currently exist for only 4 entries, so the real
   authoring volume is 8 ru files + 4 translated ones.
4. **Create the 3 default portraits** (`pages/photos/default-{male,female,mixed}.jpg`)
   in the ivory/gold/burgundy palette, 300×400 to match the card aspect (D7).
5. **Hygiene:** move `pages/index.json.old` out of `publicDir` (→ `docs/attic/`
   or delete); decide whether `biomd-demo` returns to the index as a `hidden`
   row — recommended, it is the BioMD 1.3 conformance fixture and `hidden` is
   exactly the right home for it.

**Verification:** `node scripts/lint-content.mjs` (written in Step 7 — or run
the checks manually here): every id unique, every slug unique, every `country`
a known ISO code, every `json`/`md` path resolving to a file that exists in
every declared `lang`.

---

## 6. Step 3 — Localized name indexes + technical pages (test data)

1. **`pages/index-ru.json`** — Cyrillic display names for all 10 rows (they
   move here out of `index.json.title`), plus 1–3 aliases each: surname-only
   (`"Сеговия"`), inverted order (`"Хендрикс Джими"`), common misspellings
   (`"Джанго Райнхардт"`).
2. **`pages/index-de.json`**, **`pages/index-en.json`** — deliberately sparse,
   to exercise the "omit when equal to `title`" rule. `en` gets only the two
   re-authored rows; `de` gets Segovia (the one entry with a `de` edition).
3. **`pages/index-zh.json`** and **`pages/index-ja.json`** — the CJK test cases
   that motivate the whole change (problem #1). e.g.
   `"3": ["安德烈斯·塞戈维亚", "塞戈维亚"]`, `"3": ["アンドレス・セゴビア"]`.
   These must be findable **without** any transliteration path existing.
4. **Technical pages** — `pages/ru/{about,sources,links,news}.md` (plain `.md`,
   no `.bio.` infix, no `bio.json`) plus `pages/en/about.md` to exercise the
   language menu on a page. Each gets an `index.json` row with ids `"12"`–`"15"`:
   `type: "hidden"`, `title`, `lang`, and no `json` / `img` / `gender`.
   Final corpus: **15 rows — 7 listed, 8 hidden.**
5. Add their names to `index-ru.json` / `index-en.json` — hidden entries are
   not searchable, but the codex header still needs a display name.

**Verification:** `#/about` opens a tabless codex; `about` appears in no search
result, no facet chip and no result count; `←`/`→` never lands on it.

> ### ✅ As built (2026-07-31)
>
> **15 rows — 7 listed, 8 hidden.** Name indexes: `ru` (all 15),
> `en` (7), `de` (2), `zh` (6), `ja` (6). Technical pages:
> `pages/ru/{about,sources,links,news}.md` + `pages/en/about.md`, each opening
> with the same four-item `::: nav` whose `active` item is written as a link so
> the renderer can mark it `aria-current` (a bare label yields no `<a>` and the
> `active:` property does nothing — as in the pre-existing `goya2.right` page).
>
> Two spec refinements the real data forced, both now in §10/§11:
>
> 1. **`[0]` may repeat `title` when the entry carries aliases.** The original
>    "omit when equal to `title`" rule made it impossible to give an entry
>    English aliases (`Reinhardt`, `Jean Reinhardt`) without tripping the
>    dead-weight warning. Now only a *lone* name equal to `title` warns.
> 2. **The display-name check skips two legitimate cases** — a comma-list
>    `forename` (roster convention) and a **shared dossier** (two rows pointing
>    at one `json`: only the canonical row owns the name, the alternates
>    distinguish themselves on purpose). Expressed as rules, not an id
>    allowlist.
>
> Also: `authors.bio.md`'s dead `[…](../about.htm)` now points at `#/about` —
> the legacy reference the new page was always meant to satisfy.
>
> Verified: **0 errors, 0 warnings** across 15 rows, 12 dossiers and 5 name
> indexes; all five new pages have a `# title`, balanced `:::` fences at
> column 0, and parse to `nav` + `lead` + `align`.

---

## 7. Step 4 — Code, part 1: data layer + routing

No visible UI change beyond what compile errors force. Everything here is pure
or near-pure and is the natural first test target.

### New / rewritten modules

| File | Contents |
|---|---|
| `lib/types.ts` | `IndexEntry` per §3.1 (`id`, `title`, `type`, `md` required; `gender`/`country`/`json`/`img`/`lang` optional; `country` normalized to uppercase, the other enums to lowercase, at load — D12). `EntryMeta` loses the 7 fields. New `NameIndex = Record<string, readonly string[]>`. |
| **`lib/names.ts`** (new) | Pure helpers over a `NameIndex`: `displayName(names, id, fallback)`, `aliasesOf(names, id)`. ~25 lines. |
| **`lib/entry.ts`** (new) | Pure entry-derived facts: `slugOf` (moved from `paths.ts` — it is about entries, not paths), `isBiography(e) = Boolean(e.json)`, `isListed(e) = e.type !== "hidden"`, `portraitPath(e)` (img → `photos/default-<gender>.jpg`), `initialsFrom(displayName)`. ~50 lines. **All visibility/biography branching in the app goes through these two predicates** (D5). |
| `lib/catalog.ts` | `loadIndex()` gains row validation (`id` + `md` required, `id` coerced to string, duplicate id/slug → DEV warning + first wins) and a module-level promise cache cleared by `retry`. New `loadNames(lang)` — cached per lang, 404 → `{}`, never throws. `loadEntry` skips the JSON fetch when `entry.json` is absent (`data: null`). **`prefetchAll` deleted** (D6). |
| `lib/hooks.ts` | `useCatalog(lang)` resolves `Promise.all([loadIndex(), loadNames(lang)])` into one `Catalog` object: `{ records, listed, byId, bySlug, names, lang }`, where `CatalogRecord = { entry, id, slug, langs, listed, biography }`. One memo dependency for everything downstream. `rankings` state removed. `useHashRoute` slug pattern → `[\w.-]+` + `decodeURIComponent` (§2.4 #1). |
| `lib/metadata.ts` | Delete `COUNTRY_TEXT_TO_ISO`, `countryDisplay`, `resolveCountry`, `resolveCountryCode`. Rename `regionName` → `countryName(iso, locale)`. Keep `rankStars` (Lore tab). Dates/lists untouched. |
| `lib/paths.ts` | `slugOf` moves out; everything else unchanged. |

**Exit criteria:** `npm run build` clean; the app renders the catalogue with
localized card titles and ISO country names; `#/goya2.right` deep-links.

### As built — ✅ DONE 2026-07-31

`tsc -b` and `vite build` clean. Verified in the running app (DOM assertions;
the Browser pane would not composite, so no screenshot):

| Check | Result |
|---|---|
| Grid | 7 listed rows; the 8 hidden ones appear in no card, chip, count or search hit |
| Localized titles | ru `Андрес Сеговия` · ja `アンドレス・セゴビア` · zh `安德烈斯·塞戈维亚`; id 4 has no `ja`/`zh` name → falls back to `title` |
| Countries | ru `Испания` · de `Spanien` · ja `スペイン`, from lowercase `es` |
| Facet order | sorted by **label** per locale — ru `Испания…Франция`, ja `アメリカ合衆国…フランス` |
| CJK search | `塞戈维亚` (zh) and `セゴビア` (ja) each return exactly 1 — the original motivating failure |
| Alias search | ru `Мангоре`, `Феррейра`, `Тавровские` → 1 each |
| `#/goya2.right` | opens (§2.4 #1 fixed) |
| `#/about` | deep-links; `aria-label`/`<h1>` = `О проекте`, no subtitle (nothing to show) |
| Requests on boot | exactly `/index.json` + `/index-<lang>.json` — no dossier warm |
| Page open | `#/about` fetched **only** `/ru/about.md`; no speculative `about.bio.json` |
| Language switch | one `/index-ja.json` fetch; the grid never blanked to a skeleton |

**Five as-built deviations from §7:**

1. **`Catalog` is `{records, listed, bySlug, names}`** — `byId` and `lang` were
   dropped. Nothing consumed either (search joins aliases through `names`, and
   `App` already has `lang` from i18n), and an unread `lang` on the object is a
   footgun for `EMPTY_CATALOG`. Both are one line to reinstate when a consumer
   appears.
2. **`buildCatalog` lives in `catalog.ts`, not `hooks.ts`.** It is pure, so it
   belongs beside the loaders it consumes and is unit-testable without React;
   `hooks.ts` stays React wiring only. `CatalogRecord` gained `display` (the
   localized name) — it is a catalogue fact under the current language, needed
   by the card, the codex header and the `aria-label`, not only by search.
3. **`entryTargetSlug` shipped in Step 4** (§9 assigned it to Step 6) because
   `App.navigateByMdPath` had to be rewritten here anyway and a second URL
   parser was the thing to avoid. `BioArticle` is still unwired — Step 6.
4. **A failed `loadIndex()` self-clears** instead of being cleared by `retry`.
   Same effect, no extra API surface. `loadNames` likewise drops its cache
   entry on a network error so a blip does not stick for the session.
5. **Compile-forced component work landed early.** Deleting `prefetchAll`
   removes the ranking source, so G1 (stars off the card) came with it; the
   ISO switch made facet chips sort by raw code, so `Intl.Collator` label
   sorting (listed under Step 5) came too. `CodexModal`, `GalleryTab` and
   `LoreTab` were re-sourced (`type`/`gender`/`country` from the index row,
   `display` for the name) but **not** decomposed — that is still Step 6.

**Known-unchanged, by design:** a page still renders the 4-tab chrome
(`PageView` is Step 6), and `LoreTab.localizeJob` is still there (Step 6).

---

## 8. Step 5 — Code, part 2: search + browse UI

### `lib/search.ts` — rewritten

```ts
type Weight = 3 | 2 | 1;                       // localized name · alias · latin/slug
interface Field  { readonly text: string; readonly weight: Weight }  // pre-folded
interface SearchDoc {
  readonly record: CatalogRecord;
  readonly display: string;                    // localized name, or title fallback
  readonly fields: readonly Field[];
}

buildSearchIndex(listed: CatalogRecord[], names: NameIndex): SearchDoc[]
searchEntries(docs: SearchDoc[], query: string, filters: SearchFilters): SearchDoc[]
```

**Build once** per `(listed, names, lang)` — folding and lowercasing never
happen per keystroke. Fields per doc: localized name (3), each alias (2), Latin
`title` (1), slug with `-`→` ` (1).

**Per query:**
1. fold + tokenize once;
2. build each token's `translitVariants` **once** (§2.4 #2), used only against
   weight-1 Latin fields;
3. AND across tokens — every token must hit some field;
4. score per token = best field match × field weight:
   `equals 100 · startsWith 70 · word-boundary start 50 · includes 25 · translit-variant 10`;
5. sort by score desc, stable tiebreak on index order.

**Cost:** ~1249 docs × ~4 fields × 2 tokens ≈ 10⁴ `String.includes` calls per
query — sub-millisecond. An inverted index / trie is **deliberately not built**:
it is not measurable at this scale and would be real complexity. Revisit only
if profiling on the full legacy set says otherwise.

**Input responsiveness:** `useDeferredValue(query)` in `App.tsx` — React 19
native, no timers, no debounce constant to tune.

### Components

| File | Change |
|---|---|
| `App.tsx` | Facets, counts, grid and `turnPage` all read `catalog.listed`; `bySlug` (route + cross-link resolution) reads **all** records so hidden pages stay reachable. `rankings` removed. `useDeferredValue` for the query. Sort facet chips with `Intl.Collator(locale)`. |
| `SearchBar.tsx` | Country chips: value = ISO, label = `countryName(iso, locale)`. |
| `CharacterGrid.tsx` | `rankings` prop removed; passes `doc.display` through. |
| `CharacterCard.tsx` | (G1) stars + `ranking` prop + `RankStars` import removed — `RankStars` itself stays, Lore uses it. (G2) `title` prop = `doc.display`. (G3) subtitle = `typeLabel` · `countryName(entry.country, locale)`. Portrait = `portraitPath(entry)`, `onError` → procedural placeholder seeded from the display name. |

**Exit criteria:** searching `Сеговия` (UI ru), `Segovia` (UI en),
`塞戈维亚` (UI zh) and `セゴビア` (UI ja) all return the Segovia card; hidden
entries appear nowhere; exact-name matches rank first.

### As built — ✅ DONE 2026-07-31

`tsc -b` and `vite build` clean, console clean on a fresh tab. `search.ts` is
233 lines in four sections (folding · index · query · scoring), `CharacterGrid`
78.

**Measured, not assumed:** 1249 documents × a two-token query
(`сеговия анд`), 100 runs → **0.398 ms per query**. That is the number the
"no inverted index / no trie" decision rests on; re-measure before revisiting
it.

| Check | Result |
|---|---|
| Exit criteria | `Сеговия` (ru) · `Segovia` (en) · `塞戈维亚` (zh) · `セゴビア` (ja) → the Segovia card, 1 of 7, in each UI language |
| Ranking | query `а` → prefix matches first (`Агустин`, `Андрес`, `Авторы`), then word-internal (`Джанго`, `Йован`, `Пако`), then alias-only (`Джими`) |
| Ties | keep index order (`Array.prototype.sort` is stable per spec — no tiebreak field needed) |
| AND across tokens | `агустин барриос` → 1 · `агустин хендрикс` → **0** |
| Aliases | `Мангоре`, `Феррейра`, `Тавровские` → 1 each |
| Latin fallback | `сеговия` finds Segovia even in **fr**, which has no `index-fr.json` at all — the Cyrillic query transliterates onto `index.json`'s Latin `title` |
| Field build | Segovia in ru = display (w3) + 3 aliases (w2) + one deduped Latin field (w1); `title` and slug fold to the same text and collapse |
| Empty query | filter-only path, no scoring pass |

**Deviations and one bug found:**

1. 🔴 **`fold()` was destroying `й`** — a pre-existing v1 defect, surfaced by
   this work. `normalize("NFD")` decomposes `й` into `и` + combining breve and
   the old blanket mark-strip deleted the breve, so `йовичич` folded to
   `иовичич` and could only transliterate to `iovicic` — never `jovicic`.
   A Cyrillic query for **Йован Йовичич** therefore missed the entry in every
   non-`ru` language. Fixed by stripping marks only from Latin bases
   (`/([a-z])[̀-ͯ]+/g`) and re-composing with NFC, so `Agustín →
   agustin` and `Jovičić → jovicic` still hold while `й` survives. Verified:
   `translitVariants("йовичич")` now yields all 12 spellings including
   `jovicic`, and `йовичич` finds the entry in en/zh/fr.
2. **Transliteration is gated on the field being ASCII, not on weight 1.**
   §8 used weight as a proxy for "Latin text"; an ASCII flag computed once at
   build time is the actual property, and an English alias in `index-en.json`
   is weight 2 but still Latin. Same cost, no proxy.
3. **Variants are built only for tokens that contain Cyrillic.** For a Latin
   token `CYR_TO_LAT` echoes the input back, so the expansion was pure waste.
4. **`SearchDoc` has no `display` field.** `record.display` already carries it
   (Step 4), and duplicating it would be two sources for one fact.
5. **`CharacterGrid` takes `records: CatalogRecord[]`, not `SearchDoc[]`.**
   The grid renders a catalogue, not a search result; App maps `.record` at
   the boundary. This drops the grid's dependency on `search.ts` entirely.
6. **A stale-results cue was added** — while `query !== deferredQuery` the
   grid dims to `opacity-60`. Two lines, and it is what makes
   `useDeferredValue` legible to the reader rather than just faster.

**Known limitation, not fixed:** the transliterator is single-character, so
`хендрикс` does not reach `hendrix` (`кс`→`x` is a digraph rule the table
cannot express). Adding digraph support would be a structural change for one
name; an alias in `index-<lang>.json` is the documented mechanism for exactly
this, and is a content decision.

---

## 9. Step 6 — Code, part 3: CodexModal decomposition

`CodexModal.tsx` is 264 lines doing eleven jobs. Target — every file one job,
none over ~110 lines:

```
components/codex/
  CodexModal.tsx      ~55   orchestrator: pick the view, wire the shell
  CodexShell.tsx     ~110   backdrop · page-turn panel · corner ornaments ·
                            close/prev/next · language menu · scroll area ·
                            footer · Esc/←/→ keys · scroll context
  CodexHeader.tsx     ~45   kicker · h1 (+ optional h2) · subtitle · ❦ divider
  CodexTabs.tsx       ~35   the tab strip (roles, audio, active styling)
  BiographyView.tsx   ~70   dossier header + CodexTabs + tab switch
  PageView.tsx        ~30   title/country header + BioArticle
  CodexSkeleton.tsx   ~12
  useCodexEntry.ts    ~35   contentLang state + loadEntry + bundle
  tabs/{Biography,Gallery,Documents,Lore}Tab.tsx   moved; small edits below
```

`CodexModal.tsx` reduces to:

```tsx
export function CodexModal({ record, title, onClose, onTurn, onNavigateEntry }: Props) {
  const { lang } = useI18n();
  const { langs, contentLang, setContentLang, bundle } = useCodexEntry(record, lang);

  return (
    <CodexShell
      slug={record.slug} ariaLabel={title} contentLang={contentLang}
      langs={langs} onContentLang={setContentLang} onClose={onClose} onTurn={onTurn}
    >
      {record.biography
        ? <BiographyView record={record} title={title} bundle={bundle} onNavigateEntry={onNavigateEntry} />
        : <PageView      record={record} title={title} bundle={bundle} onNavigateEntry={onNavigateEntry} />}
    </CodexShell>
  );
}
```

### Details that matter

- **Scroll coordination.** The scroll container lives in `CodexShell`;
  `CodexTabs` (two levels down) must reset it. Shell publishes
  `useCodexScroll() → { scrollToTop }` via a tiny context — cleaner than
  threading a ref through two components. Shell itself resets on
  `[slug, contentLang]`.
- **Layout invariants preserved verbatim** ([`14`](../../.claude-memory/14-app-patterns-and-gotchas.md)):
  the scroll area stays `absolute inset-[11px]`; close/nav buttons stay at
  `left-9`/`right-9`; the `LanguageMenu` capture-phase Escape still fires
  before the shell's.
- **Body scroll-lock stays in `App.tsx`.** Do not move it into the shell.
- **Header composition** (D4):
  - `BiographyView` → **unchanged from today**: `<h1>{meta.forename}</h1>` +
    `<h2>{meta.surname}</h2>` (h2 omitted when equal), subtitle
    `type · country · years`. Names come from the **`contentLang` edition**, so
    switching the language menu re-titles the header — correct, and free.
    `type`/`country` now come from `entry`, years from `meta.dates`.
    The `longName` text-balance branch (`CodexModal.tsx:111`) moves across
    verbatim.
  - **Load state:** while `bundle === null` there is no `meta` yet. Render
    `<h1>{displayName}</h1>` (from `index-<lang>.json`) with no `<h2>` and no
    subtitle, then resolve. With the data internationalized this is
    "Андрес Сеговия" → "Андрес"/"Сеговия" — a one-line reflow, and usually
    invisible: `CharacterCard.onClick` already calls `loadEntry` before the
    modal mounts, and the open animation is 250 ms. Do **not** add a spinner.
  - `PageView` → `<h1>{title}</h1>`, subtitle = `country` only, omitted when
    absent. No tab bar, no dossier.
  - Both compose the same `CodexHeader`; it takes
    `{ kicker?, title, secondary?, subtitleParts: string[] }` so the difference
    is data, not a branch.
- **`aria-label`** on the dialog → the localized display name (currently
  `entry.title`).
- **Tab re-sourcing:**
  - `LoreTab` — `type` and `gender` now come from `entry`, country from
    `entry.country` via `countryName`/`CountryFlag`; the `meta.country`
    fallback chain disappears. **`localizeJob()` is deleted** — with jobs
    authored per edition (§3.3) the mapping is dead weight, and it never
    worked for anything outside the 5 `type.*` keys.
  - `GalleryTab` — prepend the index portrait **only when `entry.img` is
    declared** (a synthetic `default-mixed.jpg` in a photo gallery is noise);
    `ThemeRow` name = display name.
  - `BiographyTab` — unchanged.
- **`PageView` failure mode:** `md` missing → `t("codex.notFound")` (key
  already exists in all 10 dictionaries).
- 🔴 **`BioArticle` must learn two more in-app link forms.** Its `a` handler
  (`lib/biomd/BioArticle.tsx`) only recognises `*.bio.md`. Both other forms
  documented in `Biography-Markup.md` §3.6 fall through to the **legacy
  archive branch** — `target="_blank"` with an "archival reference" tooltip:
  - `#/{slug}` — renders as an external-looking new-tab link;
  - `<slug>.md` (a **page**, no `.bio.` infix) — resolved against the resource
    base and 404s.

  Every technical page written in Step 3 uses `#/{slug}` in its `::: nav`, so
  the four-way section menu is inert until this lands. Fix: classify in-app
  targets in one predicate next to `slugOf` (`lib/entry.ts`) —
  `entryTargetSlug(url): string | null` handling `#/slug`, `/#/slug`,
  `<slug>.bio.md` and `<slug>.md` — and have both `BioArticle` and
  `App.navigateByMdPath` consume it. One classifier, no second URL parser.

### Optional, closes the loop

`SiteFooter.tsx`'s nine placeholder buttons become real links when a matching
hidden entry exists (`about` → `#/about`), keeping the translated placeholder
for the rest. ~15 lines, data-driven. Say if that is out of scope.

**Exit criteria:** biography codex visually identical to today apart from the
D4 header change; `#/about` renders header + article with no tab bar and no
empty-metadata artifacts; language menu still works on both modes.

### As built — ✅ DONE 2026-07-31

`tsc -b` and `vite build` clean, console clean. **271 lines → 45**, across ten
files none of which exceeds 161:

| File | Lines | |
|---|---|---|
| `CodexModal.tsx` | 45 | picks the view, wires the shell |
| `CodexShell.tsx` | 161 | all the chrome + the reading pane |
| `BiographyView.tsx` | 92 | dossier header + tabs + tab switch |
| `CodexHeader.tsx` | 54 | shared by both modes |
| `CodexTabs.tsx` | 53 | tab strip + the `CodexTab` type |
| `PageView.tsx` | 42 | header + article |
| `useCodexEntry.ts` | 42 | `contentLang` + `bundle` |
| `CodexArticle.tsx` | 32 | article body + missing-source fallback |
| `codexScroll.ts` | 15 | the pane-reset context |
| `CodexSkeleton.tsx` | 12 | |

Verified in the running app (DOM assertions; the Browser pane will not
composite, so no screenshot):

| Check | Result |
|---|---|
| Page mode (`#/about`) | **0 tab strips, 0 tabs**; `<h1>` = `О проекте`, no `<h2>`, no subtitle; kicker and closing line kept |
| `::: nav` menus | `#/sources`, `#/links`, `#/news` render **without `target="_blank"`**; clicking *Новости* switched the codex in place and moved `aria-current` |
| Biography mode | 4 tabs, Biography selected; `<h1>Андрес</h1><h2>Сеговия</h2>`; subtitle `Гитарист · Испания · 1893 — 1987` |
| Scroll context | pane at 400 px → **0** after a tab switch (two levels down, no ref threaded) |
| Entry language switch | header re-titled to `Andrés` / `Segovia` from the **de** dossier, article German, pane reset to 0 |
| All four tabs | Gallery 3 figures · Documents · Lore 3 sections · Biography 4600 chars |
| `#/goya2.right` | page mode, 0 tabs, fetched only `/ru/goya2.right.md` |
| Footer | 4 items became real `#/…` links and open their codex; 5 stay placeholders |

**Four as-built deviations from §9:**

1. **`BiographyTab` is deleted, not moved.** It was exactly "article, or the
   missing-source line" — which is also the entire body of a page. Both now
   use one `CodexArticle`; the caller names the message (`bio.missing` for a
   chronicle, `codex.notFound` for a page), so the wording still fits each
   context. This removes a file instead of adding one.
2. **`onNavigateEntry` now carries the slug, not the URL.** `BioArticle` has
   the URL and already classifies it, so making `App` re-parse would have been
   the second parser §9 warns against. `App.openLinkedEntry(slug)` just checks
   the slug exists.
3. **Tab reset is by remount, not an effect.** `App` keys the modal on the
   slug, so turning the page mounts a fresh `BiographyView` already on the
   Biography tab. `CodexShell` still resets the *scroll* explicitly on
   `[slug, contentLang]`, because a language switch does not remount.
4. **`SiteFooter` wiring was done** (the optional item). `FOOTER_ITEMS` gained
   an optional `slug`; an item renders as a link when `hasEntry(slug)` and as
   the translated placeholder otherwise, so the five sections that do not
   exist yet behave exactly as before.

**Known gap, deferred to Step 7:** an in-app link whose slug is absent from
`index.json` now does nothing (before, it opened a 404 in a new tab). That is
a *content* error and belongs in `lint:content`, not in runtime defensiveness
— see §10. `pages/ru/goya2.right.md` has several; it is a routing fixture, not
reference content.

---

## 10. Step 7 — Guard-rails, verification, memory

1. **`scripts/lint-content.mjs`** (D8) — wire as `npm run lint:content`, exit
   non-zero on ❌, print ⚠ and continue on smells.

   *Structure* ❌ — unique ids · unique slugs · `md` exists for every declared
   `lang` · `json` exists when declared · `country` in
   `Intl.supportedValuesOf("region")` · `gender` in `m|f|mixed` · every
   `index-<lang>.json` key present in `index.json` · `[0]` non-empty · none of
   the 7 removed fields still present in any `bio.json` · **no `born`/`died`/
   `dates` in any index row** (D10 reversed) · `country` a known ISO region,
   compared case-insensitively.

   *Consistency* ⚠ — `index-<lang>[id][0] !== forename + " " + surname` for the
   same language (§3.3, roster pages exempt) · `dates`/`ranking`/`url` differ
   between editions of one entry (§3.3) · a localized name identical to the
   Latin `title` (dead weight, should be omitted) · `type: "hidden"` row with
   an `img`.

   *Dead cross-links* ⚠ — an in-app link inside any `*.md` (`#/slug`,
   `<slug>.bio.md`, `<slug>.md` — classify with the same rule as
   `lib/entry.ts` `entryTargetSlug`) whose slug is not in `index.json`. Since
   Step 6 these render as in-app links and silently do nothing when the target
   is missing, so this check is what makes the failure visible. Skip
   `goya2.right.md` (a routing fixture) or accept its warnings.

   *Translation smell* ⚠ — a non-Latin-script edition (`ru`, `zh`, `ja`, `ko`)
   whose `forename`/`surname`/`birthplace` are pure ASCII, or a Latin-script
   edition holding Cyrillic. This is the check that would have caught every
   defect in [Step 2.3](#step2-i18n), and it is ~10 lines of regex.
2. **Vitest + specs** (D9) — `search` (fold, translit hoisting, scoring order,
   CJK alias hit, AND semantics), `entry` (predicates, portrait fallback,
   slug edge cases incl. `goya2.right`), `names` (missing file/id/empty),
   `paths`, `metadata` (DMY, `countryName`).
3. **Browser-pane verification** — dev server, then: card titles per UI
   language; the four search queries from §8; facet chips localized; deep-links
   `#/andres-segovia`, `#/goya2.right`, `#/about`; language switch inside both
   codex modes; console + network clean. Note the pane's compositing throttle
   when checking hover/transition states (see memory
   `browser-pane-transition-verification`).
4. **Update `.claude-memory/`** — the notes listed in Step 1, now with the
   as-built truth, and mark the resolved items in the [`15`](../../.claude-memory/15-app-critique.md) backlog.

---

## 11. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Steps 2–3 change data while Steps 4–6 change code — the app is broken in between | 🟠 | One branch, or squash 2→4. `lint-content` before the code lands. |
| `id` drift between `index.json` and 5 `index-<lang>.json` files | 🟠 | `lint-content` (D8); ids assigned once and never renumbered (D3). |
| **Step 2b is authoring, not scripting.** Internationalizing 12 `bio.json` dossiers is the largest single chunk of the plan and the only part a script cannot do. Half-done, it leaves the codex header showing Latin names over a Russian article | 🟠 | Do the 8 `ru` files first (they back 10 of 10 index rows); the 4 `en`/`de` editions can follow. `lint-content`'s translation-smell check (§10) makes "half-done" visible rather than silent. |
| Search regression — the rewrite touches the app's highest-logic module | 🟠 | Vitest specs (D9); keep the transliteration fallback so no query that works today stops working. |
| CodexModal refactor breaks a CSS/layout invariant (`inset-[11px]`, unlayered-CSS specificity, capture-phase Escape) | 🟠 | Move markup **verbatim**; no styling changes in the same commit; visual check both modes. |
| Default portraits missing at ship | 🟡 | Procedural SVG placeholder already covers it; D7 makes it explicit. |
| Content/app deploy skew (old `index.json` + new app) | 🟡 | Not possible: `index.json` resolves via `APP_BASE` and ships with the bundle in `dist/`. **No back-compat layer is needed** — clean cut, defensive loader only. |
| Hidden entries leak into the grid or ←/→ | 🟡 | Single predicate (D5) + explicit `listed` vs `records` split in `App.tsx`. |

---

## 12. Summary

| Step | Deliverable | Touches |
|---|---|---|
| 1 | Specs: new `docs/Catalog-Index.md` + 5 doc updates + 9 memory notes | `docs/`, `.claude-memory/`, `CLAUDE.md` |
| 2 | `index.json` v2 (11 rows, ids + lowercase ISO countries + 4 reclassified `hidden`) · 12 `bio.json` slimmed **and internationalized** · 3 default portraits | `pages/` |
| 3 | 5 `index-<lang>.json` · 5 technical pages (ids 12–15) → 15 rows, 7 listed | `pages/` |
| 4 | Data layer: `types` `names` `entry` `catalog` `hooks` `metadata` `paths` + routing fix | `app/src/lib/` |
| 5 | Search rewrite + scoring · browse UI (App, SearchBar, Grid, Card) | `app/src/{lib,components}/` |
| 6 | CodexModal → 8 focused files · tab re-sourcing | `app/src/components/codex/` |
| 7 | `lint-content` · Vitest specs · browser verification · memory update | `scripts/`, `app/`, `.claude-memory/` |

---

## 13. Future: search facets — and why the prefetch must not come back (D6)

The stated roadmap is filtering by **birth date, gender, type, …**. Gender,
type and country are handled by this change (they move into `index.json`).
Birth date is the interesting one, because it is the first filter field that
lives in `bio.json` — and it is exactly the case where re-introducing a
prefetch sweep would be the wrong shape:

- **O(N) requests to answer one query.** 1249 idle fetches to populate a facet
  map, repeated per language, before the first filter can be honest.
- **Racy results.** Until the sweep finishes, "born before 1900" silently
  returns a subset. A filter that is *sometimes* right is worse than one that
  is missing.
- **Not indexable.** You cannot sort or range-scan what has not arrived.

**Whatever the search filters on must be answerable from one already-loaded
file.** `gender`, `type` and `country` satisfy that today because they live in
`index.json` (A2/A3).

### Dates: deliberately not pre-denormalized (D10 reversed)

`born`/`died` were briefly added to `index.json` in Step 2 and then removed at
the owner's direction. The trade-off, recorded so it does not have to be
rediscovered:

| | Dates in `index.json` | Dates only in the dossier *(chosen)* |
|---|---|---|
| Duplication | one fact in two files, kept in step by lint | **one fact, one file** |
| Date filter | answerable immediately | needs the fields added first |
| Index size @1249 | +~30 KB at boot | — |

The deciding argument was that this refactor exists to *end* duplication, and a
facet nobody has built yet is a poor reason to reintroduce it. That is a
coherent call: the cost of adding the fields later is one migration pass over
`index.json`, which is exactly what a generator script is for.

**When a date filter is actually wanted**, the work is:

1. add `born`/`died` back to the `index.json` rows — mechanically derivable
   from the dossiers, so `scripts/sync-index.mjs` (sibling of `lint-content`)
   generates them rather than anyone hand-copying;
2. flip the §11 rule from "dates in an index row are an error" to "dates in an
   index row must equal the original-language dossier";
3. `SearchFilters` grows a range predicate applied before the token loop
   (cheap — it shrinks the candidate set).

What must **not** happen is answering the filter by fetching dossiers.

**Nothing in this plan blocks the later addition:** `IndexEntry` stays open to
additional optional fields, and the search corpus (§8) is built from a **field
list**, so a new facet touches `buildSearchIndex` + `SearchFilters` only.

Prefetch as **cache warming** — making a codex open instant — remains a
legitimate, separate job. If it is ever wanted back it should be
intent-driven (hover/focus, as `CharacterCard` already does) or
viewport-driven, never a full sweep.
