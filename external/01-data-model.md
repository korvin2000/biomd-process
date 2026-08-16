---
document: 01-data-model.md
title: The Data Model
part: 1 of 9
status: normative
depends_on: []
---

# 1. The Data Model

This document defines the entities of the catalogue, the relationships between
them, and the order in which a consumer discovers them. It contains no field
schemas; those are in documents 03–05.

---

## 1.1 The problem the model solves

A catalogue must answer three questions **before** it can display anything:

1. *What entries exist, and what is each one?*
2. *What is each entry called in the reader's language, and by what other
   strings can a reader find it?*
3. *Where does an entry's content live?*

Answering all three from per-entry files would require fetching the whole
corpus to render one screen. The format therefore splits the data by **access
time**, not by subject matter:

| Data class | Needed | Stored in |
|---|---|---|
| Identity, classification, paths | before any per-entry fetch | `index.json` |
| Display name + search aliases, per language | before any per-entry fetch, per UI language | `index-<lang>.json` |
| Structured facts of one entry | only when that entry is opened (or when a cross-entry feature crawls) | `<lang>/<slug>.bio.json` |
| Long-form prose of one entry | only when that entry is opened | `<lang>/<slug>.bio.md` |

**Format requirement.** A fact MUST be stored in exactly one of these files. The
most consequential applications of that rule are:

- Dates (birth, death, active period) are dossier facts. They MUST NOT appear in
  `index.json`, even though a date filter would be cheaper to implement if they
  did.
- Identity and classification (`id`, `title`, `type`, `gender`, `country`) are
  index facts. They MUST NOT appear in a dossier.
- A display name is a name-index fact. It MUST NOT be duplicated into the
  dossier, and the dossier's `forename`/`surname` are **name components** used to
  compose a header, not a second copy of the display name.

---

## 1.2 Entities and their relationships

```text
                       ┌───────────────────────────────┐
                       │          index.json           │
                       │  array of entry rows          │
                       └───────────────┬───────────────┘
                                       │ one row = one Entry
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │ join key: id                 │ derived: slug = basename(md)  │
        ▼                              ▼                               ▼
┌───────────────────────┐   ┌────────────────────────┐   ┌────────────────────────┐
│  index-<lang>.json    │   │  <lang>/<slug>.bio.md  │   │ <lang>/<slug>.bio.json │
│  { id: [name, …] }    │   │  the article           │   │  the dossier           │
│  0…1 file per UI lang │   │  1 per declared lang   │   │  1 per declared lang   │
└───────────────────────┘   └────────────────────────┘   └───────────┬────────────┘
                                                                     │ targets
                                                                     ▼
                                                        ┌────────────────────────┐
                                                        │  shared media archive  │
                                                        │  photos, audio, scans  │
                                                        │  NEVER localized       │
                                                        └────────────────────────┘
```

### Relationship summary

| Relationship | Cardinality | Mechanism |
|---|---|---|
| Entry → localized names | 1 : 0..n languages | `index.json.id` used as an **object key** in `index-<lang>.json` |
| Entry → article editions | 1 : 1..n | `index.json.md` + each code in `index.json.lang` |
| Entry → dossier editions | 1 : 0..n | `index.json.json` + each code in `index.json.lang` |
| Entry → route | 1 : 1 | slug derived from `index.json.md` |
| Entry → portrait | 1 : 0..1 | `index.json.img` |
| Dossier → media/documents | 1 : 0..n | `target` strings, resolved against the **resource base** |
| Dossier → entry | n : 1 | *implicit*: a dossier contains no back-reference and MUST NOT contain one |

**Note on the last row.** A dossier is anonymous: it knows nothing about which
entry points at it. This is what allows two entries to share one dossier
(§1.6).

---

## 1.3 The two identities of an entry

An entry has **two distinct identifiers**, and confusing them is the single most
damaging authoring error in this format.

| | `id` | slug |
|---|---|---|
| Declared by | the `id` field | derived from the `md` field's basename |
| Shape | opaque decimal string, e.g. `"7"` | Latin lexical token, e.g. `andres-segovia` |
| Purpose | join key to `index-<lang>.json` | routing, file naming, cross-entry links |
| Appears in URLs | never | yes — the route is `#/<slug>` |
| Appears in file names | never | yes — `<slug>.bio.md`, `<slug>.bio.json` |
| Stability requirement | absolute: assigned once, never reused, never renumbered | high: changing it breaks existing deep links and cross-links |
| Effect of a mistake | silent — localized names fall back to the Latin `title`, with no error anywhere | loud — links 404 or open the wrong entry |

**Format requirement.** `id` MUST NOT be treated as a position, an index into
the array, or a path component. Rows MAY be reordered freely; `id` values MUST
NOT change when they are.

---

## 1.4 Editions: content language versus name language

Two language axes exist and they are **independent**. Conflating them is the
second most common modelling error.

| Axis | Declared by | Means |
|---|---|---|
| **Content editions** | the `lang` field of the `index.json` row | which `<lang>/` directories contain this entry's article (and dossier) |
| **Name translations** | which `index-<lang>.json` files contain this entry's `id` | in which UI languages the entry can be *named* and *found by search* |

Consequences a consumer must handle and a producer may exploit:

- An entry with `lang: "ru"` MAY appear in `index-zh.json`. A reader whose UI is
  Chinese then finds the entry by its Chinese name and opens the **Russian**
  edition. The catalogue is searchable in more languages than it is written in.
- An entry MAY have a content edition in a language for which no
  `index-<lang>.json` exists at all. Its display name is then the Latin `title`.
- A dossier is a **per-language edition, not a translation of a canonical
  original**. There is no source language and no runtime translation layer:
  every prose value is authored in the language of the directory the file sits
  in.

**Reference behaviour.** When a reader opens an entry, the consumer selects the
edition to read as:

```text
edition = lang_list.includes(ui_language) ? ui_language : lang_list[0]
```

That is: the reader's own language when the entry has it, otherwise the entry's
**original** language, which is by definition the first code in `lang`.

---

## 1.5 Biography versus page

**Format requirement.** The presence of the `json` field decides the kind of an
entry:

| | `json` present | `json` absent |
|---|---|---|
| Kind | **biography** | **page** |
| Data | article + dossier | article only |
| Reference UI | header + four tabs (Biography · Gallery · Documents · Lore) | header + article only |
| Article file name | `<slug>.bio.md` by convention | `<slug>.md` by convention |

Two properties of this rule matter:

1. It is **declared**, never inferred. A consumer MUST NOT decide that an entry
   is a page because its dossier failed to load; a biography whose dossier is
   missing remains a biography with empty structured data.
2. It is independent of the **file-name convention**. The `.bio.` infix is a
   naming habit that makes the two kinds legible on disk; it carries no
   semantics. An entry whose `md` ends in `.bio.md` but which declares no `json`
   is a page.

Pages exist for technical and editorial content: "About", "Sources", "Links",
"News", continuation pages belonging to another entry, and fixtures.

---

## 1.6 Shared dossiers

**Format requirement.** Two or more `index.json` rows MAY declare the **same**
`json` path. Nothing in the format forbids it, and the reference implementation
supports it: each row keeps its own `id`, its own slug, its own route and its
own article, while sharing one set of structured facts.

Typical uses: an alternate rendering of the same subject, or a variant layout
kept for comparison.

**Producer requirement.** When rows share a dossier, exactly one of them SHOULD
be regarded as the canonical entry, and the display names of the others SHOULD
distinguish them (for example by appending a qualifier). A validator MUST NOT
report a name/dossier mismatch for a non-canonical row (see `INV-16`).

By contrast, rows MUST NOT share a **slug**: the slug is the route, and a
duplicate makes one of the two entries unreachable.

---

## 1.7 The request lifecycle

The order in which a conforming consumer acquires data. Each step names the
minimum it must have completed before the next becomes possible.

```text
1. GET  <catalogue-root>/index.json                     ── once per session
   └─ normalize rows → the entry table (identity, classification, paths)

2. GET  <catalogue-root>/index-<ui-lang>.json           ── once per UI language
   └─ join by id → display names + search aliases
   └─ 404 is normal and not an error: fall back to `title`

3. (browse / search)                                     ── no further I/O required

4. GET  <catalogue-root>/<edition>/<slug>.bio.md         ── when an entry opens
   GET  <catalogue-root>/<edition>/<slug>.bio.json       ── in parallel, if `json` declared

5. GET  <resource-base>/<target>                         ── when a photo, track or
                                                            document is displayed
```

**Consumer behaviour.**

- Steps 1 and 2 SHOULD be issued in parallel; step 2 MUST NOT block rendering
  when it fails.
- Step 4's two requests SHOULD be issued in parallel; either MAY fail
  independently without invalidating the other.
- Results of steps 1, 2 and 4 SHOULD be cached for the session, keyed by
  (entry, language) for step 4.
- A consumer that needs cross-entry dossier facts (for example, to filter by
  birth year) necessarily performs step 4 for many entries. It SHOULD do so with
  bounded concurrency and only when such a feature is actually in use; the
  format does not provide a precomputed digest.

---

## 1.8 Physical layout

```text
<catalogue-root>/
├── index.json                     ─ the catalogue index                (document 03)
├── index-en.json                  ─ localized names, English           (document 04)
├── index-ru.json
├── index-de.json
├── …                              ─ one optional file per UI language
│
├── ru/                            ─ one directory per content language
│   ├── andres-segovia.bio.md      ─ article, Russian edition
│   ├── andres-segovia.bio.json    ─ dossier, Russian edition           (document 05)
│   ├── about.md                   ─ a page article (no dossier)
│   └── …
├── de/
│   ├── andres-segovia.bio.md      ─ article, German edition
│   └── andres-segovia.bio.json    ─ dossier, German edition
├── en/
│   └── …
│
└── photos/                        ─ assets referenced by index.json `img`
    ├── andres-segovia.jpg            (shared by every edition — never localized)
    └── …
```

Separately, and **not necessarily inside the catalogue root**:

```text
<resource-base>/                   ─ default: /pages
├── photo/…                        ─ images referenced by dossier `target`s
├── music/…                        ─ audio referenced by dossier `target`s
├── articles/…                     ─ documents and scans
└── …
```

**Format requirement.** Language directories contain **only** articles and
dossiers. Media MUST NOT be placed inside a language directory: media is shared
by all editions, and no path in the format localizes a media reference.

**Format requirement.** The `<lang>` directory name is the ISO 639-1 code of the
edition (see `VD-LANG` in [`02-value-domains.md`](02-value-domains.md)); it MUST
match the code as it appears in the row's `lang` list, and Chinese is therefore
`zh/`, never `ch/`.

---

## 1.9 Where the article lives

The article's own markup is out of scope. Its **location** is fully determined
by the index row and is specified here.

Given a row with `md = "/andres-segovia.bio.md"` and `lang = "ru,de"`:

| Edition | Article path |
|---|---|
| `ru` (original) | `<catalogue-root>/ru/andres-segovia.bio.md` |
| `de` | `<catalogue-root>/de/andres-segovia.bio.md` |

The rule, stated normatively:

1. `md` is written **as if the file sat directly in the catalogue root**, with a
   leading slash. The language directory MUST NOT be written into `md`.
2. For edition `L`, the article path is obtained by inserting `L` as the first
   path segment: strip leading slashes from `md`, then prefix `/<L>/`.
3. Any intermediate directories in `md` are preserved beneath the language
   directory: `md = "/series/part-2.bio.md"` with `L = de` resolves to
   `/de/series/part-2.bio.md`.
4. The same transformation applies to `json`. It applies to **no other field**:
   `img` and every dossier `target` are never localized.

**Format requirement.** For every code listed in `lang`, the article file MUST
exist. If `json` is declared, the dossier file MUST exist for every code listed
in `lang` as well. A declared edition with a missing file is a broken entry, not
a fallback: the consumer has no instruction to substitute another language's
file.

The exact algorithm, including the treatment of absolute URLs in `md`/`json`,
is in [`06-path-resolution.md`](06-path-resolution.md).

---

## 1.10 What each document type contributes to the rendered entry

Informative, but it explains the purpose of every field group and is therefore
the fastest way to understand the schemas that follow.

| Rendered element | Comes from |
|---|---|
| Card in the catalogue grid | `index.json`: `img`, `type`, `country`, `gender`; `index-<lang>.json`: display name |
| Search matching | `index-<lang>.json`: display name + aliases; `index.json`: `title`, slug; dossier: `forename`, `surname`, `dates` (advanced criteria only) |
| Facet filters | `index.json`: `type`, `country`, `gender`, `lang` |
| Route / deep link | `index.json`: `md` → slug |
| Codex header, biography | dossier: `forename`, `surname`, `dates.born`, `dates.died`; `index.json`: `type`, `country` |
| Codex header, page | `index-<lang>.json` display name; `index.json`: `country` |
| Biography tab | the article file |
| Gallery tab | `index.json`: `img` (leading item); dossier: `media.photos`, `media.music` |
| Documents tab | dossier: `documents`, plus `metadata.url` as a trailing source row |
| Lore / Attributes tab | dossier: everything else in `metadata`; `index.json`: `type`, `gender`, `country` |
