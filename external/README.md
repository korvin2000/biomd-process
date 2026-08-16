---
document: README.md
title: Catalogue Data Format — Specification Index
format_version: 2
status: normative
audience: implementers of producers (authoring tools) and consumers (readers, importers, validators)
---

# Catalogue Data Format — Specification

**Format version:** 2 · **Status:** normative · **Language of specification:** English

This specification defines the **JSON data layer** of a statically served,
multilingual catalogue of person profiles: what files exist, how they reference
one another, what every field means, and precisely which values every field may
take.

The specification is **self-contained**. It assumes no access to the reference
implementation, to its repository, or to any other document.

---

## 1. What the format is

A catalogue is a set of **static files** served over HTTP (or read from a local
directory). There is no database, no query API and no server-side logic: a
consumer discovers everything by fetching a small number of JSON documents and,
on demand, one article and one dossier per entry.

The data layer is built from exactly **three JSON document types** plus one
Markdown document type:

| # | Document | Cardinality | Answers |
|---|---|---|---|
| 1 | `index.json` | exactly one per catalogue | *Which entries exist? What is each one? Where is its content?* |
| 2 | `index-<lang>.json` | zero or one per UI language | *What is entry X called in language L, and what else might a reader type to find it?* |
| 3 | `<lang>/<slug>.bio.json` | zero or one per entry **per language** | *What are the structured facts about entry X, written in language L?* (the **dossier**) |
| 4 | `<lang>/<slug>.bio.md` | one per entry **per language** | The long-form article. **Its markup is out of scope here** — only its location is specified. |

The design rule that generates the whole model is stated once and never
violated:

> **One fact lives in exactly one file.**
> Where it lives is decided by *who needs it and when*, not by what it is about.

---

## 2. Scope

### In scope

- The complete schema, value domains and constraints of `index.json`.
- The complete schema, value domains and constraints of `index-<lang>.json`.
- The complete schema, value domains and constraints of `<lang>/<slug>.bio.json`.
- The **location and naming** of the companion article `<lang>/<slug>.bio.md`,
  and how that location is derived from `index.json`.
- Path and URL resolution rules for every path-valued field.
- Referential integrity between the three JSON documents.
- JSON authoring, editing and encoding conventions.
- Failure semantics: what a conforming consumer does with malformed data.

### Out of scope

- The **markup language of the article** (`*.bio.md` / `*.md`) — its block
  syntax, media directives and layout rules are specified separately.
- Presentation: typography, colour, animation, layout of the reader UI.
- Any auxiliary content file that is not one of the three JSON types above.

---

## 3. Reading order

The documents are ordered so that each one depends only on those before it.

| File | Contents | Read it when |
|---|---|---|
| [`01-data-model.md`](01-data-model.md) | Concepts, entities, relationships, identity, the request lifecycle | Always first |
| [`02-value-domains.md`](02-value-domains.md) | The registry of value kinds (`VD-*`): every text, enum, code, date, number, URL and path domain the schemas refer to | Before reading any schema |
| [`03-catalogue-index.md`](03-catalogue-index.md) | `index.json` — field-by-field normative schema | Producing or consuming the index |
| [`04-localized-name-index.md`](04-localized-name-index.md) | `index-<lang>.json` — field-by-field normative schema | Adding languages, names or search aliases |
| [`05-entry-dossier.md`](05-entry-dossier.md) | `<lang>/<slug>.bio.json` — field-by-field normative schema | Producing or consuming dossiers |
| [`06-path-resolution.md`](06-path-resolution.md) | The two base URLs, language injection, target grammar, resolution algorithm | Resolving any path or URL found in the data |
| [`07-authoring-and-validation.md`](07-authoring-and-validation.md) | JSON encoding rules, editing rules, the invariant list, the validation catalogue, authoring recipes | Writing or validating files |
| [`08-json-schemas.md`](08-json-schemas.md) | Machine-readable JSON Schema (draft 2020-12) for all three documents | Automated validation |
| [`09-worked-examples.md`](09-worked-examples.md) | Complete, mutually consistent example files, including deliberate counter-examples | Learning by example; conformance testing |

---

## 4. Conventions used by this specification

### 4.1 Requirement keywords

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY** and **OPTIONAL** are to be
interpreted as described in RFC 2119/RFC 8174 when, and only when, they appear
in capitals.

- Requirements on **producers** (whoever writes the files) are the format's
  contract.
- Requirements on **consumers** (whoever reads them) describe conforming
  behaviour, including the **failure semantics** a producer may rely on.

### 4.2 Statement classes

Each normative statement belongs to one of three classes, labelled explicitly
wherever the distinction matters:

| Class | Meaning |
|---|---|
| **Format requirement** | Part of the data contract. Violating it makes the data non-conforming. |
| **Consumer behaviour** | What a conforming consumer does, including with non-conforming data. Producers may rely on it, but SHOULD NOT author to it deliberately. |
| **Reference behaviour** | What the reference reader application does. Informative: it explains *why* a field exists and how authoring choices surface, but it is not binding on other consumers. |

### 4.3 Notation

- `monospace` — a literal key, value, path or code point sequence.
- `<placeholder>` — a metavariable, e.g. `<lang>`, `<slug>`.
- `⟺` — "if and only if".
- `VD-NAME` — a reference to a value domain defined in
  [`02-value-domains.md`](02-value-domains.md).
- `INV-n` — a reference to an invariant listed in
  [`07-authoring-and-validation.md`](07-authoring-and-validation.md).
- In field tables, **Req.** is `●` for REQUIRED and `○` for OPTIONAL.

### 4.4 Absent versus empty

Throughout this specification, a field is **absent** when its key is not present
in the object. A field whose value is an empty string (`""`) or an empty array
(`[]`) is **present but empty**. Where the two are treated differently, the text
says so explicitly; the general rule is stated in
[`02-value-domains.md` §2](02-value-domains.md).

---

## 5. Glossary

| Term | Definition |
|---|---|
| **Catalogue** | The complete set of files described by this specification, rooted at one `index.json`. |
| **Catalogue root** | The base URL or directory that directly contains `index.json`, the `index-<lang>.json` files and the language directories. |
| **Entry** | One record of the catalogue: one row of `index.json` together with everything reachable from it. |
| **Edition** | One language-specific realization of an entry's content: the article, and the dossier if the entry has one. An entry has one edition per code listed in its `lang` field. |
| **Dossier** | The `<lang>/<slug>.bio.json` file: the structured facts of one edition. |
| **Article** | The `<lang>/<slug>.bio.md` (or `<slug>.md`) file: the long-form prose of one edition. |
| **Biography** | An entry that declares a dossier (`json` present). |
| **Page** | An entry that declares no dossier (`json` absent) — an article-only entry such as an "About" or "Sources" page. |
| **`id`** | The stable, opaque string that joins an `index.json` row to its `index-<lang>.json` names. |
| **Slug** | The routing and file identity of an entry, derived from the basename of its `md` path. |
| **Resource base** | The independently configured base URL under which shared media and documents live. Distinct from the catalogue root. |
| **Producer** | Any process or person that writes catalogue files. |
| **Consumer** | Any process that reads them: a reader UI, an importer, a validator, a static-site generator. |

---

## 6. Versioning and compatibility

- This document set specifies **format version 2**. The version is a property of
  the specification, not a field in the data: catalogue files carry no version
  marker.
- Version 2 is **not** backward compatible with version 1. Version 1 documents
  are distinguishable by the presence of identity fields (`title`, `type`,
  `gender`, `country`, `img`) at the **top level of a dossier**, and by free-text
  country names. See
  [`07-authoring-and-validation.md` §7](07-authoring-and-validation.md) for the
  disposal rule.
- Consumers MUST ignore unknown members rather than reject the document
  containing them; producers MUST preserve unknown members when editing a file
  they did not author. This is what makes additive evolution possible without a
  version field.
