---
document: 03-catalogue-index.md
title: The Catalogue Index — index.json
part: 3 of 9
status: normative
depends_on: [01-data-model.md, 02-value-domains.md]
---

# 3. The Catalogue Index — `index.json`

**Location:** `<catalogue-root>/index.json` · **Cardinality:** exactly one per
catalogue · **Media type:** `application/json`, UTF-8

`index.json` is the catalogue's identity, classification and routing layer. It
is the only document a consumer must fetch in full, and everything it contains
is therefore restricted to what is needed **before** any per-entry file is read:
what exists, what each entry is, and where its content lives.

---

## 3.1 Document shape

**Format requirement.** The root value MUST be a JSON **array** of objects. Each
object is one entry row.

```json
[
  { "id": "1", "…": "…" },
  { "id": "2", "…": "…" }
]
```

**Consumer behaviour.** A root value that is not an array is a fatal error: the
catalogue cannot be built and the consumer MUST report failure rather than
render an empty catalogue. This is the only fatal condition in the format — every
other defect degrades a single row.

### Array order

**Format requirement.** The array order is the **catalogue display order**: the
order in which entries appear when no search query and no filter is active, and
the order a sequential previous/next control follows. Producers MAY reorder rows
freely; doing so MUST NOT change any `id`.

---

## 3.2 Row schema

| Field | Req. | JSON type | Domain | Localized | Summary |
|---|:--:|---|---|---|---|
| `id` | ● | string | [`VD-ID`](02-value-domains.md) | L3 | Stable join key to `index-<lang>.json`. |
| `title` | ● | string | [`VD-LATIN`](02-value-domains.md) | L2 | Latin fallback name and last-resort search key. |
| `type` | ● | string | [`VD-ENUM-TYPE`](02-value-domains.md) | L3 | Craft, or the reserved value `hidden`. |
| `md` | ● | string | [`VD-PATH-CONTENT`](02-value-domains.md) | L3 | Article path. Defines the slug and hence the route. |
| `lang` | ○ | string | [`VD-LANGLIST`](02-value-domains.md) | L3 | Content editions that exist; first = original. |
| `gender` | ○ | string | [`VD-ENUM-GENDER`](02-value-domains.md) | L3 | `m` \| `f` \| `mixed`; also selects the default portrait. |
| `country` | ○ | string | [`VD-COUNTRY`](02-value-domains.md) | L3 | ISO 3166-1 alpha-2, authored lowercase. |
| `json` | ○ | string | [`VD-PATH-CONTENT`](02-value-domains.md) | L3 | Dossier path. **Presence decides biography vs page.** |
| `img` | ○ | string | [`VD-PATH-ASSET`](02-value-domains.md) | L3 | Portrait; resolved against the catalogue root, never localized. |

**Format requirement.** No other member is defined by this version of the
format. In particular, `born`, `died` and `dates` MUST NOT appear in a row:
dates are dossier facts (`INV-6`).

**Consumer behaviour.** Unknown members MUST be ignored, not rejected.
Producers MUST preserve unknown members when rewriting a file they did not
author.

---

## 3.3 Canonical row

```json
{
  "id": "3",
  "title": "Andres Segovia",
  "lang": "ru,de",
  "type": "guitarist",
  "gender": "m",
  "country": "es",
  "md": "/andres-segovia.bio.md",
  "json": "/andres-segovia.bio.json",
  "img": "photos/andres-segovia.jpg"
}
```

**Producer requirement (house style).** Members SHOULD be written in the order
above: identity, then classification, then paths. JSON object member order is
semantically irrelevant; a fixed order keeps diffs legible.

---

## 3.4 Field reference

### 3.4.1 `id` — REQUIRED

Domain [`VD-ID`](02-value-domains.md). A stable decimal string, unique across
the file, used as the object key in every `index-<lang>.json`.

**Consumer behaviour.** A row whose `id` is absent, empty, or neither a string
nor a number MUST be skipped entirely — such a row can be neither joined to a
name nor reliably distinguished from another. A duplicate `id` MUST be resolved
by keeping the **first** occurrence and skipping the later ones.

### 3.4.2 `title` — REQUIRED

Domain [`VD-LATIN`](02-value-domains.md). Two jobs, both fallbacks:

1. **Display fallback** — rendered whenever the reader's language has no name
   for this `id` in `index-<lang>.json`.
2. **Search key of last resort** — the only field that lets a Latin-script query
   reach an entry whose every localized name is in another script.

**Consumer behaviour.** If `title` is absent or empty, the consumer substitutes
the `id` string. That produces a catalogue that displays bare numbers, so a
producer MUST always author it.

### 3.4.3 `type` — REQUIRED

Domain [`VD-ENUM-TYPE`](02-value-domains.md). The entry's craft, or `hidden`.

**Consumer behaviour.** An absent or empty `type` yields an unclassified entry:
it remains **visible** (it is not `hidden`), it contributes no facet value, and
it renders without a classification label. Producers MUST author the field
anyway — an unclassified entry is invisible to every craft filter.

The complete visibility contract of `hidden` is in
[`02-value-domains.md`](02-value-domains.md).

### 3.4.4 `md` — REQUIRED

Domain [`VD-PATH-CONTENT`](02-value-domains.md). The article path, written
root-relative and **without** the language directory.

`md` carries three distinct responsibilities:

| Responsibility | Derivation |
|---|---|
| Where the article is | `<catalogue-root>/<edition>/` + the value, minus its leading slash |
| The entry's slug | the value's basename with `.bio.md` or `.md` removed |
| The entry's route | `#/<slug>` |

**Consumer behaviour.** A row without `md` MUST be skipped: it can be neither
routed nor rendered. A row whose derived slug duplicates an earlier row's slug
MUST be skipped, keeping the first occurrence.

**Producer requirement.** The extension SHOULD be `.bio.md` for biographies and
`.md` for pages. This is a naming convention only — the biography/page
distinction is decided by `json` (§3.4.7), not by the extension.

### 3.4.5 `lang` — OPTIONAL

Domain [`VD-LANGLIST`](02-value-domains.md). The comma-separated list of content
editions that exist for this entry. **The first code is the original
language** and is the fallback edition for readers whose language is not listed.

```json
"lang": "ru,de"      // a Russian original with a German edition
"lang": "ru"         // Russian only
```

**Format requirement.** Every listed code MUST have a complete edition on disk.
Listing a language whose files do not exist produces an entry that appears
available in that language and then fails to load.

**Consumer behaviour.** Absent, empty, or reduced to nothing after dropping
unsupported codes ⇒ the catalogue's primary language (`ru` in the reference
deployment). Producers SHOULD state the field explicitly.

**Reference behaviour.** Entries that have no edition in the reader's language
are still listed and still searchable; they are marked as foreign finds and
carry the flags of the languages they *are* written in.

### 3.4.6 `gender` — OPTIONAL

Domain [`VD-ENUM-GENDER`](02-value-domains.md). Also selects the default
portrait when `img` is absent (§3.4.9).

**Producer requirement.** Omit for `hidden` rows and for any entry that does not
denote a person or a group of persons.

### 3.4.7 `json` — OPTIONAL — the biography switch

Domain [`VD-PATH-CONTENT`](02-value-domains.md). The dossier path, written
root-relative and **without** the language directory.

**Format requirement.** `json` present ⟺ the entry is a biography. This is a
**declaration**, not an observation: a consumer MUST NOT downgrade a biography
to a page because the dossier failed to load. A failed load yields a biography
with empty structured data.

**Format requirement.** The value is independent of `md`. It usually shares the
basename with `md`, but it need not: several rows MAY point at the same dossier
(§1.6), and a row MAY point at a dossier whose basename differs from its own
slug. The dossier file name never determines the slug.

```json
"md":   "/barrios-alternate.bio.md",
"json": "/agustin-barrios.bio.json"     // legitimate: a shared dossier
```

### 3.4.8 `country` — OPTIONAL

Domain [`VD-COUNTRY`](02-value-domains.md). Lowercase ISO 3166-1 alpha-2;
normalized to uppercase on read; rendered as a localized country name and, where
available, a flag. Denotes the principal national identity, not the birthplace.

### 3.4.9 `img` — OPTIONAL

Domain [`VD-PATH-ASSET`](02-value-domains.md). The entry's portrait, shared by
every edition, resolved against the **catalogue root** (not the resource base).

**Reference behaviour — the portrait fallback chain.**

```text
img declared ────────────────► use it
    │ absent
    ▼
gender = m     ──► photos/default-male.svg
gender = f     ──► photos/default-female.svg
gender = mixed
gender absent  ──► photos/default-mixed.svg
    │ that file also fails to load
    ▼
a deterministic monogram generated from the slug and the display name
```

A missing portrait therefore never yields a broken image. The default assets are
lightweight vector files, not photographs.

**Reference behaviour.** The declared `img` also leads the entry's gallery, as
its first item. The *synthetic* defaults do not: they are interface chrome, not
photographs.

---

## 3.5 Normalization performed on read

**Consumer behaviour.** A conforming consumer normalizes each row exactly once,
at the point of reading, so that no downstream comparison has to be
case-insensitive or type-tolerant.

| Field | Input tolerated | Normalized to | On failure |
|---|---|---|---|
| `id` | string or number, surrounding whitespace | trimmed string | row skipped |
| `title` | any string | trimmed string | substitute `id` |
| `type` | any case, whitespace | lowercase, trimmed | `""` (unclassified, visible) |
| `md` | any string, whitespace | trimmed string | row skipped |
| `lang` | any case, spaces around commas | ordered list of supported codes | `[primary language]` |
| `gender` | any case | lowercase member of the set | field dropped, warning |
| `country` | any case | **UPPERCASE** two-letter code | field dropped, warning |
| `json` | any string | trimmed string | field dropped ⇒ entry becomes a page |
| `img` | any string | trimmed string | field dropped ⇒ default portrait |

### Row-level disposition

| Condition | Disposition |
|---|---|
| root is not an array | fatal: catalogue fails to load |
| `id` missing/empty/wrong type | row skipped, warning |
| `md` missing/empty | row skipped, warning |
| `id` already seen | row skipped, warning; first occurrence kept |
| derived slug already seen | row skipped, warning; first occurrence kept |
| any other defect | field-level degradation only; the row survives |

---

## 3.6 Complete example

```json
[
  {
    "id": "1",
    "title": "Agustin Barrios Mangore",
    "lang": "ru",
    "type": "guitarist",
    "gender": "m",
    "country": "py",
    "md": "/agustin-barrios.bio.md",
    "json": "/agustin-barrios.bio.json",
    "img": "photos/agustin-barrios.jpg"
  },
  {
    "id": "3",
    "title": "Andres Segovia",
    "lang": "ru,de",
    "type": "guitarist",
    "gender": "m",
    "country": "es",
    "md": "/andres-segovia.bio.md",
    "json": "/andres-segovia.bio.json",
    "img": "photos/andres-segovia.jpg"
  },
  {
    "id": "4",
    "title": "Project Authors",
    "lang": "ru,de",
    "type": "musician",
    "gender": "mixed",
    "country": "ua",
    "md": "/authors.bio.md",
    "json": "/authors.bio.json",
    "img": "photos/authors.jpg"
  },
  {
    "id": "12",
    "title": "About the Project",
    "lang": "ru,en",
    "type": "hidden",
    "md": "/about.md"
  }
]
```

Read from this example:

- Entry `1` exists only in Russian; a German reader still finds it (if
  `index-de.json` names it) and reads the Russian edition.
- Entry `3` has two editions; `ru` is the original because it is listed first.
- Entry `4` is a collective (`gender: "mixed"`), which is why its dossier may
  carry a comma-list in `forename`.
- Entry `12` is a page: no `json`, hence no tabs; `hidden`, hence absent from
  the grid, from search and from the facets, while `#/about` still opens it. It
  correctly omits `gender` and `img`.

---

## 3.7 Anti-patterns

| Anti-pattern | Why it is wrong | Correct form |
|---|---|---|
| `"id": 3` | The join key must be a string; `3` and `"3"` are different object keys. | `"id": "3"` |
| Renumbering ids after deleting a row | Silently breaks every localized name for the shifted ids. | Leave gaps; never reuse. |
| `"md": "/ru/andres-segovia.bio.md"` | The language directory is injected by the consumer; writing it produces `/ru/ru/…`. | `"md": "/andres-segovia.bio.md"` |
| `"country": "Spain"` / `"esp"` / `"ES "` | Not an alpha-2 code (the third is, but relies on trimming). | `"country": "es"` |
| `"born": "21.02.1893"` in a row | Dates are dossier facts. | Move to the dossier's `metadata.dates`. |
| `"lang": "ch"` for Chinese | The ISO 639-1 code for Chinese is `zh`. | `"lang": "zh"` |
| Declaring `"lang": "ru,en"` with no English files | The entry advertises an edition that cannot load. | Create the files, or drop `en`. |
| Two rows with `md` basenames `x.bio.md` and `x.md` | Both derive the slug `x`; the second row becomes unreachable. | Give one of them a distinct basename. |
| `"img": "/pages/photos/x.jpg"` | `img` resolves against the catalogue root, not the resource base. | `"img": "photos/x.jpg"` |
| `"type": ""` to hide an entry | Empty means *unclassified and visible*. | `"type": "hidden"` |
