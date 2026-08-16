---
document: 05-entry-dossier.md
title: The Entry Dossier — <lang>/<slug>.bio.json
part: 5 of 9
status: normative
depends_on: [01-data-model.md, 02-value-domains.md, 03-catalogue-index.md]
---

# 5. The Entry Dossier — `<lang>/<slug>.bio.json`

**Location:** `<catalogue-root>/<lang>/` + the basename of the row's `json`
value · **Cardinality:** one per entry **per declared content language** ·
**Media type:** `application/json`, UTF-8

The dossier holds the **structured facts** of one entry in one language: names,
places, dates, relations, career data, the gallery and the document list. The
long-form prose lives in the companion article; identity and classification live
in the catalogue index.

A dossier exists ⟺ its entry's `index.json` row declares a `json` path. An entry
without one is a **page** and has no dossier at all — which is a normal state,
not a missing file.

---

## 5.1 Location, naming, and the companion article

Both files of an edition are named by the index row and live side by side:

| Declared in `index.json` | Edition `ru` | Edition `de` |
|---|---|---|
| `"md": "/andres-segovia.bio.md"` | `<root>/ru/andres-segovia.bio.md` | `<root>/de/andres-segovia.bio.md` |
| `"json": "/andres-segovia.bio.json"` | `<root>/ru/andres-segovia.bio.json` | `<root>/de/andres-segovia.bio.json` |

**Format requirement.** For every code in the row's `lang` list, **both** files
MUST exist. There is no cross-language fallback for a missing edition file.

**Format requirement.** The dossier's basename is taken from the row's `json`
field, which is **independent of `md`**. It usually matches, but need not: two
rows may share one dossier while having different articles and different slugs.

The article's markup is out of scope for this specification. What the dossier
guarantees about it is only its **location**, as tabulated above.

---

## 5.2 Document shape

**Format requirement.** The root value MUST be a JSON **object** with the
following members:

```json
{
  "metadata": { },
  "media": {
    "photos": [ ],
    "music":  [ ]
  },
  "documents": [ ]
}
```

| Member | Req. | JSON type | Purpose |
|---|:--:|---|---|
| `metadata` | ● | object | Names, places, dates, relations, career, score, source URL. |
| `media` | ○ | object | `photos` and `music` arrays for the gallery. |
| `documents` | ○ | array | Documents, transcripts, scans, external references. |

**Format requirement — the one hard structural rule.** A dossier MUST contain a
top-level `metadata` object. A document without it — including a document whose
root is an array, or which places metadata members at the root — is **not a
dossier**.

**Consumer behaviour.** A document lacking a top-level `metadata` object MUST be
discarded in its entirety, exactly as if the file were absent: its `media` and
`documents` are not salvaged. The entry remains a biography (that is decided by
the index) and renders with empty structured data.

`metadata` MAY be an empty object; that is a well-formed, minimally informative
dossier. `media` and `documents` MAY be absent, and their arrays MAY be empty;
writing them out empty is the RECOMMENDED house style, because it makes the
three-section shape visible in every file.

---

## 5.3 What MUST NOT appear in a dossier

**Format requirement.** The following members MUST NOT be present, at the root
or inside `metadata`:

| Forbidden member | Where the fact belongs |
|---|---|
| `id` | `index.json` — `id` |
| `title` | `index.json` — `title`, and `index-<lang>.json` for the display name |
| `type` | `index.json` — `type` |
| `gender` | `index.json` — `gender` |
| `country` | `index.json` — `country` |
| `img` | `index.json` — `img` |
| `bio` | the article file |
| `dataStatus` | withdrawn; no replacement |
| any path to the article | `index.json` — `md` |

These are the fields removed in format version 2. They are the reliable
signature of a version 1 document.

**Consumer behaviour.** A consumer MUST ignore them silently rather than fail. A
validator MUST report them as errors: while inert, they are a second copy of a
fact that will drift out of step with the authoritative one.

---

## 5.4 `metadata` — field reference

Every member is OPTIONAL. A consumer MUST NOT require any of them, and MUST
render an absent value as an **absent row**, never as an empty label.

### 5.4.1 Identity components

| Field | JSON type | Domain | Class | Meaning |
|---|---|---|---|---|
| `forename` | string | [`VD-LOCALIZED`](02-value-domains.md) | L1 | Given name, in this edition's language. |
| `surname` | string | [`VD-LOCALIZED`](02-value-domains.md) | L1 | Family name, in this edition's language. |
| `birthname` | string | [`VD-LOCALIZED`](02-value-domains.md) | L1 | Full birth name or complete legal name. |
| `birthplace` | string | [`VD-LOCALIZED`](02-value-domains.md) | L1 | Place of birth, as prose (`"Linares, Spain"`). |
| `deathplace` | string | [`VD-LOCALIZED`](02-value-domains.md) | L1 | Place of death, as prose. |

**Reference behaviour.** `forename` and `surname` compose the header of an open
biography, on two typographic lines. They are therefore the practical minimum
content of a dossier.

**Format requirement — the roster convention.** A collective entry MAY carry a
comma-separated list in `forename` with the shared family name in `surname`:

```json
"forename": "Sergey,Viktor,Alexander,Konstantin",
"surname":  "Tavrovsky"
```

This is a supported convention, not a defect. It pairs with
`gender: "mixed"` in the index row, and it is the one case in which a display
name may legitimately differ in shape from `forename + " " + surname`.

**Format requirement.** `birthplace` and `deathplace` are prose, and their
components are localized: `"Линарес, Испания"` in Russian, `"Linares, Spanien"`
in German. They are **not** parsed, and no country code is derived from them —
the country is an index fact.

### 5.4.2 `dates`

```json
"dates": {
  "born": "21.02.1893",
  "died": "02.06.1987",
  "activeFrom": "01.01.1909",
  "activeTo": "02.06.1987"
}
```

| Field | JSON type | Domain | Class | Meaning |
|---|---|---|---|---|
| `born` | string | [`VD-DATE`](02-value-domains.md) | L0 | Date of birth. |
| `died` | string | [`VD-DATE`](02-value-domains.md) | L0 | Date of death. |
| `activeFrom` | string | [`VD-DATE`](02-value-domains.md) | L0 | Start of the documented active period. |
| `activeTo` | string | [`VD-DATE`](02-value-domains.md) | L0 | End of the documented active period. |

**Format requirement.**

- Format is `DD.MM.YYYY`. It is **not** ISO 8601, and MUST NOT be handed to a
  locale-dependent date parser.
- `dates` is **language-invariant**: byte-identical in every edition of the
  entry.
- Dates MUST NOT be mirrored into `index.json`. This dossier is their only home.
- Every member is optional. A living person has no `died`; an undocumented
  active period has neither `activeFrom` nor `activeTo`.
- An approximate or partial date is **not representable** and MUST be omitted
  rather than approximated into a false precision.

**Consumer behaviour.** Derived quantities:

| Derived value | Rule |
|---|---|
| displayed date | the parsed triple rendered in the reader's locale |
| age | full years from `born` to `died`, or to today when `died` is absent |
| lifespan line | `born` year, an em dash, `died` year or an ellipsis |
| active period | `activeFrom` and `activeTo`, each replaced by an ellipsis when absent; rendered only if at least one is present |
| anniversary | an entry whose `born` (else `died`) has today's day **and** month, and whose elapsed whole years are ≥ 1 |

Because `born`/`died` drive cross-entry features (date filters, "on this day"),
a consumer that offers them necessarily reads many dossiers. That is the
intended cost of keeping dates out of the index.

### 5.4.3 Relations and career

All values are [`VD-CSV-LIST`](02-value-domains.md): a **comma-separated string**,
never a JSON array.

| Field | Class | Meaning | Reference rendering |
|---|---|---|---|
| `relatives` | L1 | Related persons. | comma-joined line |
| `instruments` | L1 | Instruments played. | chips |
| `genres` | L1 | Musical genres. | chips |
| `bands` | L1 | Bands, ensembles, orchestras. | chips |
| `awards` | L1 | Awards and distinctions. | comma-joined line |
| `teachers` | L1 | Teachers and mentors. | comma-joined line |
| `disciples` | L1 | Students and notable pupils. | comma-joined line |
| `jobs` | L1 | Professions and professional roles. | chips |

**Format requirement.** A single item MUST NOT contain a comma: there is no
escape mechanism, and the item would be split. Rephrase instead.

**Format requirement.** These are L1 — translate them per edition. Common nouns
are translated (`"Gitarrist"` / `"Гитарист"`); proper nouns that are not
conventionally translated are not (`"Band of Gypsys"`).

**Producer requirement.** A value that is genuinely a single item MAY be written
as a plain string with no comma (`"instruments": "classical guitar"`); it
normalizes to a one-element list.

### 5.4.4 `ranking`

| Field | JSON type | Domain | Class |
|---|---|---|---|
| `ranking` | **number** | [`VD-RANKING`](02-value-domains.md) | L0 |

A project-defined editorial score, 0–100, identical in every edition. It MUST be
a JSON number: a quoted `"96"` is discarded by a conforming consumer.

### 5.4.5 `url`

| Field | JSON type | Domain | Class |
|---|---|---|---|
| `url` | string | [`VD-URL`](02-value-domains.md) | L0 |

The entry's canonical external source.

**Reference behaviour.** `url` is **not** rendered among the attributes. It is
presented in the Documents view as a trailing *source* row, after the authored
`documents` items. Consequently, repeating the same URL as a `documents` entry
produces a visible duplicate.

### 5.4.6 Unknown members

**Format requirement.** A consumer MUST NOT reject a dossier because
`metadata` carries members not listed here, and a producer editing an existing
file MUST preserve them.

**Consumer behaviour.** Unknown members are retained in the parsed object but
are **not rendered**: the reference reader draws a fixed, curated set of rows.
Adding a member does not make it appear in the interface.

---

## 5.5 `media`

```json
"media": {
  "photos": [
    { "label": "Main portrait",   "target": "photo/s/segovia_01.jpg" },
    { "label": "Rehearsal, 1958", "target": "photo/s/segovia_02.jpg" }
  ],
  "music": [
    { "label": "Julia Florida", "target": "music/mp/juliaflorida.mp3" }
  ]
}
```

### Item schema (identical for `photos` and `music`)

| Field | Req. | JSON type | Domain | Class | Meaning |
|---|:--:|---|---|---|---|
| `label` | ● | string | [`VD-LABEL`](02-value-domains.md) | **L1** | Caption / track title. Displayed. Translated per edition. |
| `target` | ● | string | [`VD-TARGET`](02-value-domains.md) | **L0** | Location of the resource. Identical in every edition. |

**Format requirement.** The L1/L0 split within a single item is the point of the
design: the *caption* is translated, the *file* is shared. A German edition must
never point at a different photograph than the Russian one merely because its
caption differs.

**Format requirement.** Array order is significant: it is the display order.

**Reference behaviour — the gallery composition.**

```text
[index.json img, if declared]  ←─ leads the gallery, labelled with the display name
media.photos[0…n]              ←─ in array order
```

The *synthetic* default portrait (the gender fallback) is chrome and does not
appear in the gallery. Therefore the first `media.photos` item is **not**
automatically the primary portrait — the portrait is the index row's `img`.

**Reference behaviour — playback selection.** The presentation of a `music` item
is chosen from the target's **file extension** alone, per the table in
[`VD-TARGET`](02-value-domains.md): `.mid`/`.midi` are synthesized; the common
audio extensions are played by the built-in player; `.txt` is opened as
tablature; anything else is attempted as audio and will fail silently if the
browser cannot decode it.

**Producer requirement.** Use formats browsers actually decode (`.mp3`, `.ogg`,
`.wav`, `.m4a`, `.flac`). Legacy container formats such as `.wma` are matched by
no rule, are attempted as native audio, and will not play in most environments.

---

## 5.6 `documents`

```json
"documents": [
  {
    "label": "Concert programme, Moscow 1957",
    "type": "SCAN",
    "target": "articles/segovia/programme_1957.jpg"
  },
  {
    "label": "Recordings list",
    "type": "DISCOGRAPHY",
    "target": "embedded"
  }
]
```

### Item schema

| Field | Req. | JSON type | Domain | Class | Meaning |
|---|:--:|---|---|---|---|
| `label` | ● | string | [`VD-LABEL`](02-value-domains.md) | **L1** | Display title. Translated per edition. |
| `type` | ○ | string | [`VD-ENUM-DOCTYPE`](02-value-domains.md) | **L0** | Symbolic category. Uppercase. Never translated. |
| `target` | ● | string | [`VD-TARGET`](02-value-domains.md) | **L0** | Location, or the sentinel `embedded`. |

**Format requirement.** `type` is a **symbol**, not a caption: it is an
uppercase token, identical in every edition. The reader-visible title of the
document is `label`. The vocabulary is open; a consumer MUST render unknown
values with a generic presentation rather than dropping the item.

### The `embedded` sentinel

**Format requirement.** `target: "embedded"` declares that the document has no
separate location: its content is part of the entry's article. The value is
matched **exactly**, lowercase; `"Embedded"` is an ordinary relative path.

**Consumer behaviour.** An `embedded` item is rendered as a **non-interactive**
row — it announces that the document exists and is reproduced in the article. It
MUST NOT be turned into a link, and no request is issued for it.

### Presentation selection

**Consumer behaviour.** The presentation of a non-`embedded` item is chosen
from the target, in this order:

| Test | Presentation |
|---|---|
| `target == "embedded"` | inert row |
| the path ends in an image extension | opened in an in-page image viewer |
| the path ends in `.txt` | opened in an in-page text/tablature viewer |
| otherwise | a link opened in a new browsing context, with referrer and opener protection |

The badge distinguishing a local archive resource from an external one is
derived from the target's form (absolute URL vs base-relative path), not from
`type`.

---

## 5.7 Localization summary for the whole document

The single table an author needs when creating a new edition by copying an
existing one.

| Path | Class | On copy to a new language |
|---|:--:|---|
| `metadata.forename` | L1 | translate |
| `metadata.surname` | L1 | translate |
| `metadata.birthname` | L1 | translate |
| `metadata.birthplace` | L1 | translate |
| `metadata.deathplace` | L1 | translate |
| `metadata.relatives` | L1 | translate (personal names: use the target language's conventional spelling) |
| `metadata.instruments` | L1 | translate |
| `metadata.genres` | L1 | translate |
| `metadata.bands` | L1 | translate common nouns only; keep proper names |
| `metadata.awards` | L1 | translate where an established form exists; keep proper names |
| `metadata.teachers` | L1 | translate |
| `metadata.disciples` | L1 | translate |
| `metadata.jobs` | L1 | translate |
| `metadata.dates.*` | **L0** | **copy verbatim** |
| `metadata.ranking` | **L0** | **copy verbatim** |
| `metadata.url` | **L0** | **copy verbatim** |
| `media.photos[].label` | L1 | translate |
| `media.photos[].target` | **L0** | **copy verbatim** |
| `media.music[].label` | L1 | translate |
| `media.music[].target` | **L0** | **copy verbatim** |
| `documents[].label` | L1 | translate |
| `documents[].type` | **L0** | **copy verbatim** |
| `documents[].target` | **L0** | **copy verbatim** |

**Detection heuristic for a botched copy (informative).** A non-Latin-script
edition (`ru`, `zh`, `ja`, `ko`) whose prose is pure ASCII, or a Latin-script
edition holding Cyrillic, is almost certainly an untranslated copy.

---

## 5.8 Failure semantics

**Consumer behaviour.**

| Condition | Disposition |
|---|---|
| file absent, or the request fails | the entry keeps its declared kind and renders with empty structured data |
| the body is not valid JSON | as above — treated as absent |
| root is not an object | as above |
| no top-level `metadata` object | **the whole document is discarded**, including `media` and `documents` |
| `media` absent, or not an object | treated as `{ "photos": [], "music": [] }` |
| `photos` / `music` absent, or not arrays | treated as empty |
| `documents` absent, or not an array | treated as empty |
| an item missing `target` | not renderable; the item is skipped |
| an item missing `label` | renders with an empty caption; producers MUST supply one |
| `ranking` not a number | field treated as absent |
| a date that fails the grammar | that date treated as absent |
| a forbidden version 1 member | ignored |
| an unknown member | ignored, preserved on edit |

A dossier never invalidates its entry: the worst outcome is an entry that
displays only what the index knows about it.

---

## 5.9 Complete example — two editions of one entry

Both files are named `andres-segovia.bio.json`; they differ only in their
directory and in their **L1** values. Compare them line by line: every L0 value
is identical.

### `<root>/ru/andres-segovia.bio.json`

```json
{
  "metadata": {
    "forename": "Андрес",
    "surname": "Сеговия",
    "birthname": "Андрес Сеговия Торрес",
    "birthplace": "Линарес, Испания",
    "deathplace": "Мадрид, Испания",
    "dates": {
      "born": "21.02.1893",
      "died": "02.06.1987",
      "activeFrom": "01.01.1909",
      "activeTo": "02.06.1987"
    },
    "instruments": "классическая гитара",
    "genres": "классика",
    "bands": "Сольный исполнитель",
    "awards": "Премия «Грэмми» за вклад в музыку,Маркиз де Салобренья",
    "teachers": "В основном самоучка",
    "disciples": "Джон Уильямс,Кристофер Паркенинг",
    "jobs": "Гитарист,Педагог,Редактор,Аранжировщик",
    "ranking": 96,
    "url": "https://www.example.org/hall-of-fame/segovia"
  },
  "media": {
    "photos": [
      { "label": "Основной портрет", "target": "photo/s/segovia_01.jpg" }
    ],
    "music": []
  },
  "documents": [
    {
      "label": "Биография в справочнике Guitar Foundation",
      "type": "REFERENCE",
      "target": "https://www.example.org/hall-of-fame/segovia"
    }
  ]
}
```

### `<root>/de/andres-segovia.bio.json`

```json
{
  "metadata": {
    "forename": "Andrés",
    "surname": "Segovia",
    "birthname": "Andrés Segovia Torres",
    "birthplace": "Linares, Spanien",
    "deathplace": "Madrid, Spanien",
    "dates": {
      "born": "21.02.1893",
      "died": "02.06.1987",
      "activeFrom": "01.01.1909",
      "activeTo": "02.06.1987"
    },
    "instruments": "Konzertgitarre",
    "genres": "Klassik",
    "bands": "Solokünstler",
    "awards": "Grammy Lifetime Achievement Award,Marqués de Salobreña",
    "teachers": "Überwiegend Autodidakt",
    "disciples": "John Williams,Christopher Parkening",
    "jobs": "Gitarrist,Lehrer,Herausgeber,Arrangeur",
    "ranking": 96,
    "url": "https://www.example.org/hall-of-fame/segovia"
  },
  "media": {
    "photos": [
      { "label": "Hauptporträt", "target": "photo/s/segovia_01.jpg" }
    ],
    "music": []
  },
  "documents": [
    {
      "label": "Biografie im Verzeichnis der Guitar Foundation",
      "type": "REFERENCE",
      "target": "https://www.example.org/hall-of-fame/segovia"
    }
  ]
}
```

Note `"target": "photo/s/segovia_01.jpg"` in both: one photograph, two captions.

---

## 5.10 Minimal valid dossier

```json
{
  "metadata": {
    "forename": "Forename",
    "surname": "Surname"
  },
  "media": {
    "photos": [],
    "music": []
  },
  "documents": []
}
```

Structurally, `{"metadata":{}}` also conforms. `forename`/`surname` are the
practical minimum, because they compose the header of an open biography.

---

## 5.11 Anti-patterns

| Anti-pattern | Why it is wrong | Correct form |
|---|---|---|
| `"genres": ["classical", "folk"]` | Multi-value fields are comma-separated **strings** in this version. | `"genres": "classical,folk"` |
| `"ranking": "96"` | Must be a JSON number; a string is discarded. | `"ranking": 96` |
| `"dates": {"born": "1893-02-21"}` | Wrong grammar; treated as absent. | `"born": "21.02.1893"` |
| `"born": "1893"` | Partial dates are not representable. | Omit the field. |
| `"birthplace": "Linares, Spain"` in the German edition | L1 value left untranslated. | `"Linares, Spanien"` |
| Different `"ranking"` in two editions | L0 values must be identical. | Copy verbatim. |
| Different `"target"` in two editions | Media is shared; only the label is translated. | Copy verbatim. |
| `"country": "es"` inside the dossier | Classification belongs to the index. | Remove; set it in `index.json`. |
| `"title": "Andrés Segovia"` inside the dossier | Display names belong to `index-<lang>.json`. | Remove. |
| `"target": "Embedded"` | The sentinel is matched exactly, lowercase. | `"target": "embedded"` |
| Repeating `metadata.url` as a `documents` item | The source row is synthesized from `url`; the item duplicates it. | Keep one of the two. |
| Placing a photograph in `<root>/de/photo/x.jpg` | Media must not live in a language directory. | Put it under the resource base and reference it from both editions. |
