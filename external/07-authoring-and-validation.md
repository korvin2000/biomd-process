---
document: 07-authoring-and-validation.md
title: Authoring, Editing and Validation
part: 7 of 9
status: normative
depends_on: [01-data-model.md, 02-value-domains.md, 03-catalogue-index.md, 04-localized-name-index.md, 05-entry-dossier.md, 06-path-resolution.md]
---

# 7. Authoring, Editing and Validation

This document collects the rules that apply to the JSON files **as files**
— encoding, editing, integrity — together with the operational recipes and the
complete validation catalogue.

---

## 7.1 JSON encoding rules

**Format requirement.** All three document types:

| Rule | Detail |
|---|---|
| Grammar | Strict JSON (RFC 8259). **No** comments, **no** trailing commas, **no** unquoted keys, **no** single quotes. |
| Encoding | UTF-8. A byte-order mark SHOULD NOT be written; consumers MUST tolerate one. |
| Line endings | `LF` RECOMMENDED. Significant only for diff hygiene. |
| Strings | Double-quoted. Literal Unicode characters are RECOMMENDED over `\uXXXX` escapes: `"Сеговия"`, not `"Сег..."`. |
| Escapes | Only where required: `\"`, `\\`, and the control-character escapes. |
| Numbers | Unquoted, and only where a number is specified (`ranking`). Everything else is a string, including `id`. |
| `null` | MUST NOT be authored anywhere. Omit the key instead. |
| Duplicate keys | MUST NOT be authored. Parsers silently keep the last occurrence, so an earlier value disappears without any error. |
| Key order | Semantically irrelevant. A stable house order is RECOMMENDED for legible diffs. |
| Trailing newline | RECOMMENDED. |
| Indentation | Two spaces, RECOMMENDED. |

**Serving requirement.** Files SHOULD be served with
`Content-Type: application/json; charset=utf-8`. Consumers SHOULD parse the body
regardless of the declared type, because a misconfigured static host is a common
and harmless deployment defect.

**Format requirement.** File names are case-sensitive in practice (most
production hosts serve from case-sensitive storage). `index-EN.json` will not be
found by a consumer requesting `index-en.json`.

---

## 7.2 Editing rules

**Format requirement.**

1. **Preserve unknown members.** When rewriting a file you did not author, carry
   through every member you do not recognize. This is what allows the format to
   grow additively without a version field.
2. **Never renumber `id`.** Deleting a row leaves a gap; the gap is correct.
3. **Never reuse an `id`.** A new entry takes a new value, even if an old one is
   free.
4. **Change a slug only deliberately.** It is the public address of the entry;
   changing it breaks existing deep links and every cross-entry link that
   targets it.
5. **Do not invent facts.** Omit an optional field rather than guessing at a
   plausible value. An absent row is correct; a wrong row is not.
6. **Edit all editions together.** A change to an L0 value (`dates`, `ranking`,
   `url`, any `target`, any `documents[].type`) MUST be applied to every edition
   of that entry in the same change.
7. **Never machine-translate an edition into place.** An L1 value is authored,
   not derived. If a translation is unavailable, do not create the edition:
   omit the language from `lang` and let readers fall back to the original.
8. **Keep media out of language directories.** Media is shared; a language
   directory holds only articles and dossiers.

---

## 7.3 Invariants

The complete list of properties a conforming catalogue satisfies. Each is
independently checkable, and each names the file(s) it constrains.

| ID | Severity | Invariant | Where |
|---|---|---|---|
| `INV-1` | error | `id` is unique across the index. | `index.json` |
| `INV-2` | error | `id` is a non-empty decimal **string**, without leading zeroes. | `index.json` |
| `INV-3` | error | The slug derived from `md` is unique across the index. | `index.json` |
| `INV-4` | error | The slug matches `[A-Za-z0-9_.-]+`. | `index.json` |
| `INV-5` | error | Every row has `id`, `title`, `type` and `md`. | `index.json` |
| `INV-6` | error | No row carries `born`, `died` or `dates`. | `index.json` |
| `INV-7` | error | No dossier carries `id`, `title`, `type`, `gender`, `country`, `img`, `bio` or `dataStatus`. | dossier |
| `INV-8` | error | For every code in `lang`, the article exists; and if `json` is declared, the dossier exists too. | filesystem |
| `INV-9` | error | `country` is a known ISO 3166-1 alpha-2 code. | `index.json` |
| `INV-10` | error | `gender` ∈ {`m`, `f`, `mixed`}. | `index.json` |
| `INV-11` | error | Every code in `lang` is a supported ISO 639-1 code, with no repeats. | `index.json` |
| `INV-12` | error | Every key of `index-<lang>.json` matches an existing `id`. | name index |
| `INV-13` | error | Every value of `index-<lang>.json` is a non-empty array of non-empty strings. | name index |
| `INV-14` | warning | No entry whose only element equals `title` (dead weight — omit the whole `id`). An entry that also carries aliases is fine. | name index |
| `INV-15` | warning | `index-<lang>[id][0]` agrees with `forename + " " + surname` of the same language's dossier. | name index + dossier |
| `INV-16` | — | `INV-15` does **not** apply when `forename` is a comma-list (the roster convention), nor to rows that do not own their dossier outright (shared dossiers). | — |
| `INV-17` | warning | `dates`, `ranking`, `url`, every `target` and every `documents[].type` are identical across all editions of an entry. | dossier |
| `INV-18` | warning | A non-Latin-script edition (`ru`, `zh`, `ja`, `ko`) whose prose is pure ASCII, or a Latin-script edition holding Cyrillic — the signature of an untranslated copy. | dossier |
| `INV-19` | error | Every dossier has a top-level `metadata` object. | dossier |
| `INV-20` | error | `ranking`, when present, is a number in 0–100. | dossier |
| `INV-21` | error | Every date matches `\d{1,2}\.\d{1,2}\.\d{4}` with day 1–31 and month 1–12. | dossier |
| `INV-22` | error | Every media and document item has a non-empty `label` and `target`. | dossier |
| `INV-23` | error | No file inside a language directory other than articles and dossiers. | filesystem |
| `INV-24` | warning | A `hidden` row carries neither `img` nor `gender`. | `index.json` |
| `INV-25` | warning | `type`, `gender`, `country` and `lang` are authored lowercase. | `index.json` |
| `INV-26` | error | No `null` value and no duplicate object key anywhere. | all |
| `INV-27` | warning | No `documents[].target` duplicates `metadata.url` (the source row is synthesized from `url`). | dossier |
| `INV-28` | warning | No alias shorter than three characters, and no alias duplicating `[0]` after case folding. | name index |

---

## 7.4 Validation catalogue

The disposition of each defect, split by who observes it.

### 7.4.1 Fatal

| Defect | Consumer disposition |
|---|---|
| `index.json` unreachable, unparseable, or not an array | The catalogue cannot be built. Report failure; offer a retry. |

This is the only fatal condition. Everything else degrades locally.

### 7.4.2 Row-fatal (the row disappears)

| Defect | Consumer disposition |
|---|---|
| `id` missing, empty, or of a type other than string/number | skip the row, warn |
| `md` missing or empty | skip the row, warn |
| `id` duplicates an earlier row | skip the row, warn; first occurrence wins |
| slug duplicates an earlier row's slug | skip the row, warn; first occurrence wins |

**Consequence.** A duplicate makes an entry silently invisible while its files
remain on disk. This is the failure mode `INV-1` and `INV-3` exist to catch
before publication.

### 7.4.3 Field-level degradation (the row survives)

| Defect | Consumer disposition |
|---|---|
| `title` missing | display the `id` |
| `type` missing | unclassified, still visible, contributes no facet |
| `gender` outside the set | field dropped, warn |
| `country` not two ASCII letters | field dropped, warn |
| `lang` empty or wholly unsupported | fall back to the primary language |
| `json` missing | the entry is a page |
| `img` missing | default portrait by gender |
| unknown member | ignored |

### 7.4.4 Name-index degradation

| Defect | Consumer disposition |
|---|---|
| file missing or unreachable | no localized names; fall back to `title`. **Not an error.** |
| root not an object | whole file ignored |
| value not an array | that `id` ignored |
| element not a non-empty string | element dropped |
| all elements dropped | that `id` ignored |
| key matching no `id` | never looked up; harmless at runtime, an error at validation time |

### 7.4.5 Dossier degradation

| Defect | Consumer disposition |
|---|---|
| file missing, unparseable, or root not an object | treated as absent; the entry stays a biography with empty structured data |
| no top-level `metadata` object | **whole document discarded**, `media` and `documents` included |
| `media` / `documents` absent or of the wrong type | treated as empty |
| item without `target` | item skipped |
| `ranking` not a number | field treated as absent |
| malformed date | that date treated as absent |
| forbidden version 1 member | ignored |
| unknown member | ignored, preserved on edit |

---

## 7.5 Authoring recipes

### 7.5.1 Add a biography

1. Append a row to `index.json` with the **next unused** `id`, a Latin `title`,
   `type`, `gender`, lowercase `country`, `lang`, and the `md` / `json` / `img`
   paths. **No dates.**
2. For **each** code listed in `lang`, create both files, fully authored in that
   language:
   - `<root>/<lang>/<slug>.bio.md` — the article;
   - `<root>/<lang>/<slug>.bio.json` — the dossier.
   Copy the L0 values verbatim between editions; author every L1 value natively.
3. Add the localized name and its aliases to `index-<lang>.json` for **every**
   language a reader might search in — including languages with no content
   edition.
4. Put media under the resource base, never inside a language directory.
5. Verify the invariants of §7.3.

### 7.5.2 Add a page (article-only entry)

1. Append a row with `type: "hidden"` (unless the page should appear in the
   grid), an `id`, a Latin `title`, `lang`, and `md` pointing at `/<slug>.md`.
   **No `json`, no `img`, no `gender`.**
2. Create `<root>/<lang>/<slug>.md` for each declared language.
3. Add its display name to `index-<lang>.json`. Hidden entries are not
   searchable, but the header still needs a name.

### 7.5.3 Add a language edition to an existing entry

1. Append the code to that row's `lang` — **at the end**, so the original
   language stays first.
2. Create `<root>/<newlang>/<slug>.bio.md` and, for a biography,
   `<root>/<newlang>/<slug>.bio.json`.
3. In the new dossier: copy `dates`, `ranking`, `url` and every `target` and
   `documents[].type` **verbatim**; translate every other value.
4. Add the localized name to `index-<newlang>.json` if it differs from `title`
   or if it carries aliases.

### 7.5.4 Add a searchable alias

Append it to the entry's array in `index-<lang>.json`, after `[0]`. Content
change only: no other file is touched.

### 7.5.5 Share one dossier between two entries

1. Create the second row with its own `id`, its own `md` (hence its own slug),
   and the **same** `json` value as the first.
2. Give the two rows distinguishable display names in each
   `index-<lang>.json`.
3. Record which row is canonical, so that `INV-15` is checked only against it
   (`INV-16`).

### 7.5.6 Retire an entry

| Goal | Action |
|---|---|
| Hide it from the catalogue but keep every link working | set `type: "hidden"`. Keep the row, the files, and the names. |
| Remove it completely | delete the row, its `index-<lang>.json` keys, its articles and its dossiers. **Leave the `id` unused forever.** |

**Producer requirement.** Prefer hiding. Deleting turns every published link to
that slug into a dead address.

### 7.5.7 Rename a slug

1. Rename the article (and dossier, if its basename follows the slug) in
   **every** language directory.
2. Update `md` (and `json`, if renamed) in the row.
3. Update every cross-entry link in every article that targets the old slug.
4. Accept that external deep links to the old slug are now dead; the format has
   no redirect mechanism.

The `id` does not change. The localized names do not change.

---

## 7.6 Pre-publication checklist

A compact, ordered pass. Each line is mechanically checkable.

**`index.json`**

- [ ] Root is an array; the file parses.
- [ ] Every row has `id`, `title`, `type`, `md`.
- [ ] `id` values are unique strings; none was renumbered or reused.
- [ ] Derived slugs are unique and match `[A-Za-z0-9_.-]+`.
- [ ] `country` values are lowercase alpha-2; `gender` values are in the set.
- [ ] `lang` lists contain only supported codes; the first is the original.
- [ ] No row carries a date field.
- [ ] `hidden` rows carry no `img`, no `gender`.
- [ ] `md`/`json` contain no language directory; `img` is bucket-relative.

**`index-<lang>.json`**

- [ ] Root is an object; every value is a non-empty array of non-empty strings.
- [ ] Every key exists in `index.json`.
- [ ] No entry consists of a single name identical to `title`.
- [ ] `[0]` is the natural, fully-accented name; aliases are names only.

**Dossiers**

- [ ] Every declared edition exists, for every declared language.
- [ ] Every dossier has a top-level `metadata` object.
- [ ] No forbidden version 1 member.
- [ ] Dates match `DD.MM.YYYY`; `ranking` is a number 0–100.
- [ ] L0 values are byte-identical across editions.
- [ ] L1 values are genuinely in the directory's language.
- [ ] Every media/document item has both `label` and `target`.
- [ ] No `target` is localized; no media lives in a language directory.

**All files**

- [ ] Valid UTF-8, strict JSON, no comments, no trailing commas.
- [ ] No `null`; no duplicate object keys.

---

## 7.7 Disposal of version 1 data

A version 1 document is recognizable by any of:

- identity members at the **top level of a dossier**: `title`, `type`, `gender`,
  `country`, `img`, `bio`, `dataStatus`;
- free-text country names (`"Spain"`) in place of alpha-2 codes;
- `forename` / `surname` present in `index.json`;
- absent `id` values, and therefore no `index-<lang>.json` at all.

**Migration rule.**

| Version 1 location | Version 2 destination |
|---|---|
| dossier `title` | `index.json` → `title` (Latin) and `index-<lang>.json` → `[0]` (localized) |
| dossier `type` / `gender` | `index.json` → `type` / `gender` |
| dossier `country: "Spain"` | `index.json` → `country: "es"` |
| dossier `img` | `index.json` → `img` |
| dossier `bio` | the article file |
| dossier `dataStatus` | discarded |
| `index.json` `forename` / `surname` | dossier `metadata`, per edition |

**Format requirement.** No compatibility layer exists: consumers do not read the
version 1 shape. Leftover members are inert, and MUST be removed rather than
left in place, because they are a second copy of a fact that will drift.
