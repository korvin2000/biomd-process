---
document: 02-value-domains.md
title: Value Domains
part: 2 of 9
status: normative
depends_on: [01-data-model.md]
---

# 2. Value Domains

Every field in this format draws its values from one of the domains registered
here. The schema documents (03, 04, 05) name a domain rather than restating its
rules, so each rule is defined exactly once.

A domain specifies, for the values it admits:

- the **JSON type**,
- the **grammar** or admissible set,
- the **canonical authored form** (what a producer writes),
- the **normalized form** (what a consumer holds in memory after reading),
- the **localization class** (§2.2),
- the **consumer behaviour** when a value is malformed.

---

## 2.1 Absent, empty, and null

**Format requirement.**

| Form | Meaning | Producer rule |
|---|---|---|
| key absent | the fact is not recorded | **This is the canonical way to express "no value".** |
| `""` (empty string) | the fact is not recorded | Tolerated. Producers SHOULD omit the key instead. |
| `[]` (empty array) | an empty collection | Permitted and meaningful for `media.photos`, `media.music`, `documents`. |
| `null` | — | **MUST NOT be authored.** No field in this format is nullable. |

**Consumer behaviour.** A consumer MUST treat an absent key and an
all-whitespace or empty string as equivalent: both mean "not recorded". It MUST
NOT render an empty label, an empty row, or the literal text `null` for either.
A `null` value MUST be treated as absent rather than as an error that
invalidates the document.

**Consumer behaviour.** String values SHOULD be trimmed of leading and trailing
whitespace on read. Producers MUST NOT rely on significant leading or trailing
whitespace in any value.

---

## 2.2 Localization classes

Every string value in this format belongs to exactly one localization class.
The class determines whether the value differs between editions of the same
entry, and it is the property most often got wrong when a new edition is created
by copying an existing one.

| Class | Name | Rule | Where it occurs |
|---|---|---|---|
| **L0** | Language-invariant | Byte-identical in **every** edition of the entry. A discrepancy between editions is a data error. | `dates`, `ranking`, `url`, every `target`, `documents[].type` |
| **L1** | Localized | Authored in the language of the file it sits in. There is **no** canonical original and **no** runtime translation. | Every prose field of a dossier; every `label`; every name in `index-<lang>.json` |
| **L2** | Latin fallback | One value shared by all languages, written in Latin script, used when no L1 value is available. | `index.json.title` |
| **L3** | Language-neutral token | A machine token that is never displayed verbatim; it is *resolved* into localized text by the consumer. | `country`, `gender`, `type`, `lang`, `id`, slugs, paths |

**Format requirement (L1).** A prose value MUST be authored in the language of
its directory. Copying an edition and leaving its values in the source language
is non-conforming even though it is syntactically valid: the consumer has no
translation layer and will render the wrong language verbatim.

**Format requirement (L1, proper nouns).** Proper nouns that are not
conventionally translated keep their own spelling in every edition: band names,
work titles, institution names, award names of that kind. Localization applies
to *common* nouns and to names that have an established form in the target
language.

> Example. In the German edition of an entry: `"bands": "Band of Gypsys"`
> (untranslated proper noun) but `"jobs": "Gitarrist,Komponist"` (translated
> common nouns), while the Russian edition of the same entry has
> `"bands": "Band of Gypsys"` and `"jobs": "Гитарист,Композитор"`.

**Format requirement (L0).** L0 values MUST be identical across editions. A
consumer MAY read them from whichever edition it happens to have loaded and MUST
NOT attempt to reconcile differing copies.

**Format requirement (L2).** `title` is not a translation of anything: it is the
fallback used when the reader's language has no name for the entry, and the
last-resort search key that lets a Latin query reach an entry whose every
localized name is in another script.

---

## 2.3 Text normalization used by consumers

Informative, but it determines which aliases are worth authoring
(see [`04-localized-name-index.md`](04-localized-name-index.md)).

**Reference behaviour.** Before matching a query against a name, a consumer
folds both sides:

1. lowercase;
2. Unicode NFD;
3. remove combining marks that follow a **Latin** letter (`Agustín` → `agustin`)
   — marks on non-Latin letters are preserved, because they are what distinguish
   Cyrillic `й` from `и`;
4. Unicode NFC;
5. map `ё` → `е`.

Matching is then a plain substring test, ranked by position (exact match >
prefix > word-start > interior). A Cyrillic query is additionally expanded into
Latin transliteration variants and tested against ASCII-only fields, which is
what lets a Cyrillic query reach a Latin `title`. **No transliteration is
attempted in the other direction**, and none is possible for CJK: a Latin query
reaches a CJK name only if an alias provides the bridge.

---

# Domain registry

---

## VD-ID — entry identifier

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L3 |
| Grammar | `[0-9]+` — plain decimal, no sign, no leading zeroes |
| Canonical form | `"7"` |
| Normalized form | the same string, trimmed |

**Format requirement.**

- An `id` MUST be a JSON **string**, not a number. It is used as an object key
  in `index-<lang>.json`, where keys are strings by definition; authoring `7`
  and `"7"` in different files invites the two to drift apart. `"7"`, `7` and
  `"0007"` are three different keys as far as the join is concerned.
- Values MUST be unique across `index.json`.
- Values MUST be **stable forever**: assigned once at creation, never
  renumbered, never reused — not even after the row is deleted.
- New values SHOULD be assigned sequentially from the highest value in use.

**Consumer behaviour.** A consumer MUST accept a JSON number in the `id` field
and coerce it with a decimal string conversion (`7` → `"7"`), for tolerance
only. A row whose `id` is absent, empty or of any other type MUST be skipped.

> **Why stability matters.** `id` is the only join key to the localized names.
> Renumbering on insert or delete breaks every `index-<lang>.json` entry that
> referenced the old value, and the breakage is **silent**: the names simply
> fall back to the Latin `title` and nothing reports an error.

---

## VD-LATIN — Latin fallback name

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L2 |
| Grammar | free text; Latin script; ASCII RECOMMENDED |
| Canonical form | `"Andres Segovia"` |

**Format requirement.** The value SHOULD be the plain Latin rendering of the
entry's name, without diacritics where a diacritic-free form is unambiguous. It
is the fallback, not the showcase: the fully accented and script-correct forms
belong in `index-<lang>.json`.

Non-ASCII characters are permitted but reduce the value's usefulness: an
ASCII-only value is what a transliterated query can be matched against.

Examples: `"Andres Segovia"`, `"Django Reinhardt"`, `"Project Authors"`,
`"Agustin Barrios Mangore"`.

---

## VD-NAME — localized display name or alias

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L1 |
| Grammar | free text, any script, non-empty after trimming |
| Canonical form | `"Андрес Сеговия"`, `"安德烈斯·塞戈维亚"`, `"Andrés Segovia"` |

**Format requirement.** Values are written in the natural orthography of the
language of the file, with full diacritics and in the native script.
Transliteration MUST NOT be applied; a romanization is an *additional alias*,
never a replacement for the native form.

**Consumer behaviour.** Elements that are not non-empty strings MUST be dropped;
an entry left with no usable names MUST be treated as absent.

---

## VD-LOCALIZED — localized prose

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L1 |
| Grammar | free text, any script |
| Rendering | displayed verbatim; no markup is interpreted |

**Format requirement.** No markup, HTML, or line-break convention is
interpreted inside these values: they are plain text. A value that needs
structure belongs in the article, not in the dossier.

Applies to: `forename`, `surname`, `birthname`, `birthplace`, `deathplace`, and
(as lists, see VD-CSV-LIST) `relatives`, `instruments`, `genres`, `bands`,
`awards`, `teachers`, `disciples`, `jobs`.

---

## VD-LABEL — localized display label

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L1 |
| Grammar | free text, any script, non-empty |
| Rendering | caption of a photo, title of a track, title of a document |

A specialization of VD-LOCALIZED for the `label` member of media and document
items. It is displayed text and is therefore translated per edition, while the
accompanying `target` (VD-TARGET) is L0 and identical in every edition.

**Producer requirement.** A label SHOULD be short enough to render on one line
(indicatively ≤ 60 characters) and SHOULD describe the resource's role
(`"Main portrait"`, `"Concert programme, 1957"`), not repeat the entry's name.

---

## VD-CSV-LIST — multi-value field encoded in a string

| Property | Value |
|---|---|
| JSON type | string (**not** an array) |
| Localization class | L1 |
| Grammar | `item ("," item)*` |
| Canonical form | `"rock,pop"` or `"rock, pop"` — both are accepted |
| Normalized form | `["rock", "pop"]` |

**Format requirement.** Multi-value metadata is encoded as a **comma-separated
string**, not as a JSON array. A future revision may introduce arrays; until
then a producer MUST emit the string form and a consumer MUST accept it.

**Normalization algorithm (normative for consumers).**

```text
split on U+002C COMMA  →  trim each element  →  discard empty elements
```

**Format requirement.** A single value that itself contains a comma cannot be
represented: there is no escape mechanism. Producers MUST avoid commas inside an
item — rephrase the item, or split it into two. Consumers MUST NOT attempt to
detect "commas that were not separators".

> Consequence for names. `"Иванов, Иван"` in a list field is two items, not one
> inverted name. Write personal names in a list in their natural order.

**Reference behaviour.** `instruments`, `genres` and `jobs` are rendered as
individual chips; `awards`, `teachers`, `disciples` and `relatives` are rendered
as one comma-joined line. Either way the split above is applied first, so
whitespace after the separator is cosmetic.

---

## VD-ENUM-GENDER — gender

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L3 |
| Admissible values | `"m"`, `"f"`, `"mixed"` — **closed set** |
| Authored case | lowercase |
| Read case | case-insensitive |
| Normalized form | lowercase |

| Value | Meaning |
|---|---|
| `m` | male |
| `f` | female |
| `mixed` | a collective entry: an ensemble, a project team, an authoring collective |

**Consumer behaviour.** A value outside the set MUST be discarded (the field
becomes absent) and SHOULD be reported as a warning; it MUST NOT invalidate the
row. An absent value is equivalent to `mixed` for the purpose of selecting a
default portrait, but MUST NOT be rendered as if `mixed` had been declared.

---

## VD-ENUM-TYPE — entry classification

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L3 |
| Admissible values | **open vocabulary**, plus one reserved value |
| Authored case | lowercase |
| Read case | case-insensitive |
| Normalized form | lowercase |

The field carries the entry's **craft**, and doubles as the visibility switch
through one reserved value.

### Established vocabulary

| Value | Meaning |
|---|---|
| `guitarist` | performer on the guitar |
| `musician` | musician not classified more narrowly; also collectives: for example both: guitarist and composer |
| `composer` | composer |
| `conductor` | conductor |
| `luthier` | instrument maker |
| `guitar-historian` | a guitar researcher and historian who studies the guitar and its history |
| `publisher` | Music publishers and publishers of literature related to the guitar and music in general |
| `hidden` | None of above. A technical internal key used for technical pages on the website, such as “About,” “News,” and “Donate”—which are not directly related to the musicians |

The vocabulary is **open**: a producer MAY introduce a new craft value at any
time. A consumer MUST accept unknown values, MUST use them for grouping and
filtering like any other value, and SHOULD display an unknown value verbatim
when it has no localized label for it.

### The reserved value

| Value | Meaning |
|---|---|
| `hidden` | The entry is **excluded from discovery** but remains fully addressable. |

**Format requirement.** `hidden` MUST be excluded from: the catalogue grid,
search results, facet lists, result counts, and any sequential
previous/next order. It MUST remain: routable by its slug, resolvable as the
target of a cross-entry link, and openable in every language it declares.

Use it for technical pages, for sub-pages that belong to another entry, and for
fixtures that must not pollute the catalogue.

> **Design note (informative).** This deliberately overloads a craft taxonomy
> with a visibility concept, accepted because a technical page has no craft, so
> the field has no other job for exactly the rows that use it.

**Producer requirement.** A `hidden` row SHOULD omit `gender` and `img`: neither
is used, since the entry is never carded.

---

## VD-ENUM-DOCTYPE — document category

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L0 |
| Admissible values | **open vocabulary** |
| Canonical form | UPPERCASE symbolic token, `[A-Z][A-Z0-9_]*` |
| Read case | case-insensitive |

**Format requirement.** The value is a symbol, not a caption: it is
language-invariant and MUST NOT be translated per edition. The human-readable
title of the document is its `label` (VD-LABEL).

### Observed vocabulary

| Value | Meaning |
|---|---|
| `TRANSCRIPT` | a transcription (musical or textual) |
| `DOSSIER` | a compiled file of records |
| `ARTICLE` | an article or essay |
| `REFERENCE` | an external reference work or authoritative page |
| `SCAN` | a scanned printed original |
| `DISCOGRAPHY` | a list of recordings |
| `SOURCE` | reserved by consumers for the row synthesized from `metadata.url`; producers SHOULD NOT author it |

**Consumer behaviour.** A consumer MUST NOT hard-code an exhaustive set. An
unrecognized value MUST still render, with a generic document presentation.

---

## VD-COUNTRY — country code

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L3 |
| Grammar | exactly two ASCII letters — **ISO 3166-1 alpha-2** |
| Authored case | **lowercase** (`es`, `py`, `us`) |
| Read case | case-insensitive |
| Normalized form | **UPPERCASE** (`ES`, `PY`, `US`) |

**Format requirement.**

- The value MUST be an ISO 3166-1 **alpha-2** code. Alpha-3 (`esp`), numeric
  (`724`) and free-text names (`"Spain"`, `"Испания"`) are all non-conforming.
- Exactly one code. Dual nationality is expressed by choosing the principal one.
- The house style is lowercase; a consumer MUST nevertheless accept `ES`, `es`
  and `Es` as the same value.

**Semantics.** The value is the person's **principal national identity**, which
is not necessarily their place of birth. An entry may legitimately carry `fr`
while its dossier records a birthplace in Belgium — the birthplace is a dossier
fact and belongs there.

**Consumer behaviour.** A value that is not two ASCII letters MUST be discarded
(the field becomes absent) and SHOULD be reported as a warning. The displayed
country name MUST be derived at runtime from the code in the reader's language
(e.g. via a locale-aware region-name facility); it MUST NOT be authored.

> **Why uppercase after normalization.** Locale region-name lookups and flag
> asset registries are conventionally keyed by the uppercase form. Normalizing
> once, at the boundary, means no downstream comparison has to be
> case-insensitive.

---

## VD-LANG — content language code

| Property | Value |
|---|---|
| JSON type | string (as a member of VD-LANGLIST, and as a file-name component) |
| Localization class | L3 |
| Grammar | exactly two ASCII letters — **ISO 639-1** |
| Authored case | lowercase |
| Read case | case-insensitive |
| Normalized form | lowercase |

### Admissible set

The set is **closed** and defined by the catalogue's deployment. The reference
deployment supports ten languages:

| Code | Language | Code | Language |
|---|---|---|---|
| `en` | English | `it` | Italian |
| `es` | Spanish | `pt` | Portuguese |
| `ja` | Japanese | `ru` | Russian |
| `de` | German | `zh` | Chinese |
| `fr` | French | `ko` | Korean |

**Format requirement.** Chinese is `zh`, **never** `ch`. This applies
identically to the name-index file name (`index-zh.json`) and to the content
directory (`zh/`).

**Format requirement.** The same code is used in three places and MUST agree in
all of them: the `lang` list of a row, the directory name of that edition, and
the `index-<lang>.json` file name.

**Consumer behaviour.** A code outside the supported set MUST be ignored rather
than treated as an error.

---

## VD-LANGLIST — declared content editions

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L3 |
| Grammar | `lang ("," lang)*`, each `lang` per VD-LANG |
| Canonical form | `"ru,de"` |
| Normalized form | ordered list, e.g. `["ru", "de"]` |

**Format requirement.**

- **Order is significant: the first code is the entry's original language**, and
  it is the edition a consumer falls back to when the reader's language is not
  available.
- Every listed code MUST have a complete edition on disk (article, plus dossier
  when `json` is declared). See `INV-8`.
- Codes MUST NOT repeat.

**Consumer behaviour.** Unsupported codes are dropped. If the field is absent,
empty, or leaves an empty list after dropping, the consumer MUST substitute the
catalogue's **primary language** — `ru` in the reference deployment. Producers
SHOULD write the field explicitly rather than relying on this default.

---

## VD-DATE — calendar date

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L0 |
| Grammar | `D[D] "." M[M] "." YYYY` — formally `\d{1,2}\.\d{1,2}\.\d{4}` |
| Canonical form | zero-padded: `"21.02.1893"` |
| Normalized form | the triple (day, month, year) |

**Format requirement.**

- The order is **day, month, year**, separated by full stops. This is **not**
  ISO 8601 and MUST NOT be mixed with it in the same catalogue.
- The year MUST be exactly four digits. Years before 1000 and eras other than CE
  are not representable.
- Zero-padding of day and month is RECOMMENDED and is the canonical form;
  consumers MUST also accept the unpadded form (`"5.5.1885"`).
- Partial dates (year only, month and year only), ranges, approximations
  (`"c. 1885"`), and any qualifier text are **not representable**. A date that
  is not known to the day MUST be omitted; the prose belongs in the article.

**Consumer behaviour.**

- A consumer MUST parse the string explicitly against the grammar above. It MUST
  NOT pass the string to a locale-dependent date parser: `01.02.1893` is
  1 February in this format and would be read as 2 January by an American
  parser.
- Day is validated as 1–31 and month as 1–12; calendar validity beyond that
  (e.g. 31 February) is not checked, and such a value MUST NOT crash a consumer.
- A value that does not match the grammar MUST be treated as absent.
- Every date field is optional and MAY be absent for living persons or unknown
  sources. A consumer MUST NOT assume any date exists.

Valid: `"05.05.1885"`, `"5.5.1885"`, `"31.12.1999"`.
Invalid: `"1885-05-05"`, `"05/05/1885"`, `"05.05.85"`, `"1885"`, `"c. 1885"`,
`""`.

---

## VD-RANKING — editorial score

| Property | Value |
|---|---|
| JSON type | **number** (not a string) |
| Localization class | L0 |
| Range | 0–100 inclusive |
| Canonical form | integer, e.g. `96` |

**Format requirement.** The value is a project-defined editorial score. It MUST
be a JSON number: `"96"` is non-conforming and a consumer will discard it.

**Consumer behaviour.** A consumer MUST clamp the value into 0–100 for display
and MUST discard a non-numeric or `NaN` value (the field becomes absent).

**Reference behaviour.** The score is rendered both as a proportional meter and
as a five-tier star rating, banded as:

| Score | Tier |
|---|---|
| ≥ 90 | ★★★★★ |
| 75–89 | ★★★★ |
| 55–74 | ★★★ |
| 35–54 | ★★ |
| < 35 | ★ |

---

## VD-URL — external URL

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L0 |
| Grammar | an absolute URL with an explicit scheme; `https:` RECOMMENDED, `http:` permitted |
| Canonical form | `"https://example.org/biography"` |

**Format requirement.** The value MUST be an **absolute** URL. A relative value
is not an error but is interpreted as a resource path (VD-TARGET), which is
almost never what is intended for a citation.

**Format requirement.** The URL is L0: the same source is cited by every
edition. A language-specific version of a source (e.g. a per-language wiki page)
therefore **cannot** be expressed here; record such links as `documents` entries
if per-edition citation is required — noting that `documents[].target` is itself
L0, so the divergence must instead be expressed through separate document items.

**Consumer behaviour.** The URL is presented as the entry's source reference.
It MUST be opened in a new browsing context with referrer and opener protection
(`rel="noopener noreferrer"`) since it is third-party content.

---

## VD-SLUG — entry slug (derived, never authored directly)

| Property | Value |
|---|---|
| JSON type | — (derived from the `md` path) |
| Localization class | L3 |
| Grammar | `[A-Za-z0-9_.-]+` |
| Canonical form | lowercase Latin words joined by hyphens: `andres-segovia` |

**Derivation (normative).** Take the last path segment of `md`; remove a
trailing `.bio.md`, otherwise a trailing `.md` (both matched
case-insensitively). The remainder is the slug.

```text
"/andres-segovia.bio.md"  →  andres-segovia
"/about.md"               →  about
"/series/part-2.bio.md"   →  part-2
```

**Format requirement.**

- The slug MUST be unique across the entire catalogue.
- It MUST match `[A-Za-z0-9_.-]+`. Non-ASCII slugs are non-conforming: a
  consumer that validates routes will refuse to open them.
- It SHOULD be lowercase Latin with hyphens as word separators. A dot is
  permitted (it occurs in migrated content) but SHOULD be avoided in new
  entries.
- It is the entry's public address (`#/<slug>`) and therefore SHOULD be treated
  as permanent. Renaming a slug invalidates every existing deep link and every
  cross-entry link that targets it.

---

## VD-PATH-CONTENT — catalogue path to a localized content file

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L3 |
| Used by | `index.json`: `md`, `json` |
| Grammar | `"/" segment ("/" segment)*` — root-relative, leading slash REQUIRED |
| Canonical form | `"/andres-segovia.bio.md"` |
| Resolved against | the **catalogue root**, after language injection |

**Format requirement.**

- The path is written **as if the file sat directly in the catalogue root**. The
  language directory MUST NOT appear in the value.
- The leading slash is the house style and SHOULD always be written. (A consumer
  strips leading slashes before resolution, so its presence does not change the
  result.)
- The value MUST NOT contain `.` or `..` segments, a query string, or a
  fragment.
- An absolute URL is permitted but exempts the file from language injection
  entirely — the same document is then used for every edition. This SHOULD be
  avoided.

Resolution is specified in [`06-path-resolution.md`](06-path-resolution.md).

---

## VD-PATH-ASSET — catalogue path to a shared asset

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | L3 |
| Used by | `index.json`: `img` |
| Grammar | `segment ("/" segment)*` — **bucket-relative, no leading slash** by convention |
| Canonical form | `"photos/andres-segovia.jpg"` |
| Resolved against | the **catalogue root**, **without** language injection |

**Format requirement.**

- The value MUST NOT be localized: one image serves every edition.
- The value resolves against the **catalogue root**, not the resource base. This
  is the one place where a catalogue-root-relative media path occurs, and it is
  a deliberate difference from every `target` inside a dossier (VD-TARGET).
- A leading slash is tolerated and does not change the result, but the
  no-leading-slash form is the house style, precisely so the difference from
  VD-PATH-CONTENT stays visible on inspection.
- An absolute URL is permitted.

> **The trap.** A catalogue may contain both `<catalogue-root>/photos/x.jpg`
> (reachable from `img`) and `<resource-base>/photos/x.jpg` (reachable from a
> dossier `target`). These are different files at different URLs. See
> [`06-path-resolution.md` §6.2](06-path-resolution.md).

---

## VD-TARGET — resource target inside a dossier

| Property | Value |
|---|---|
| JSON type | string |
| Localization class | **L0** — never translated, never localized |
| Used by | `media.photos[].target`, `media.music[].target`, `documents[].target` |
| Resolved against | the **resource base** (deployment parameter, default `/pages`) |

Admissible forms, in the order a consumer tests them:

| # | Form | Example | Resolution |
|---|---|---|---|
| 1 | the sentinel `embedded` | `"embedded"` | Not a location. Only valid for `documents[].target`; see [`05-entry-dossier.md`](05-entry-dossier.md). |
| 2 | absolute URL / any URI scheme | `"https://example.org/a.jpg"` | Used verbatim. |
| 3 | protocol-relative | `"//cdn.example.org/a.jpg"` | Used verbatim. |
| 4 | base-relative | `"photo/a/x.jpg"` or `"/photo/a/x.jpg"` | `<resource-base>/photo/a/x.jpg` — with or without the leading slash, identically. |
| 5 | base-anchored escape | `"^/main/x.jpg"` | `<resource-origin>/main/x.jpg` — leaves the resource base. |
| 6 | relative with `..` | `"/../main/x.jpg"` | Climbs out of the base segment by segment. Form 5 is preferred. |

**Format requirement.**

- A target MUST NOT be localized. Media is shared by every edition of an entry;
  only the accompanying `label` differs between editions.
- A query string and/or fragment MAY be appended to forms 4–6 and is preserved
  through resolution: `"photo/a/x.jpg?v=2"`.
- Form 5 (`^`) is RECOMMENDED over form 6 (`..`) whenever the target lies
  outside the resource base: `^` holds however deep the base is configured,
  whereas `..` must match the base segment for segment and silently resolves
  elsewhere if the deployment changes.
- The sentinel `embedded` is matched **exactly**, in lowercase. `"Embedded"` is
  a relative path, not the sentinel.

The complete resolution algorithm, including the legacy prefix allowance, is in
[`06-path-resolution.md`](06-path-resolution.md).

### Recognized resource kinds

A consumer selects its presentation from the target's **file extension**, never
from the label or from `documents[].type`. The extension is read from the path
part only; query and fragment are ignored.

| Extensions | Treated as |
|---|---|
| `.jpg` `.jpeg` `.png` `.gif` `.webp` `.avif` `.svg` `.bmp` `.apng` `.ico` | image — opened in an image viewer |
| `.mp3` `.wav` `.ogg` `.oga` `.m4a` `.aac` `.flac` | audio — played by the built-in player |
| `.mid` `.midi` | MIDI — played by a synthesizer, not by the audio element |
| `.txt` | plain-text tablature/score — opened in a text viewer |
| anything else | a document — opened as a link in a new browsing context |

**Producer requirement.** Because the extension is the sole signal, a target
MUST carry the extension appropriate to its content. An audio resource served
from an extension-less URL cannot be played inline by a conforming consumer.
