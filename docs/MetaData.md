# MetaData.json Guide

**Version:** 2.0 · **Date:** 2026-07-31

## Purpose

A metadata file stores the **dossier** of one biography entry: the structured
facts behind the **Lore / Attributes**, **Gallery** and **Documents** tabs. The
biography text itself lives in the companion Markdown article.

On disk the file is named after its entry and lives in a per-language
directory: `pages/<lang>/<slug>.bio.json`. "MetaData.json" is the name of the
*format*, not of the file.

### What is **not** here (moved to `index.json` in v2)

`id`, `title`, `gender`, `type`, `country` and `bio` are **not** metadata
fields. Identity, classification and paths belong to the catalogue index —
see [`Catalog-Index.md`](Catalog-Index.md) — and the display name in each
language belongs to `index-<lang>.json`. Keeping a second copy here caused the
two to disagree.

`dataStatus` was a fixture annotation and is gone.

### Localization — read this before authoring

**A metadata file is a per-language *edition*, not a translation of a canonical
original.** Every prose field in `metadata` must be authored in the language of
the directory it sits in:

`forename`, `surname`, `birthname`, `birthplace`, `deathplace`, `relatives`,
`instruments`, `genres`, `bands`, `awards`, `teachers`, `disciples`, `jobs`
— and every `label` in `media.photos`, `media.music` and `documents`, since
those are displayed text too. Their `target`s are **not** localized: media and
documents are shared by all editions.

Proper nouns keep their own spelling: band names (`Band of Gypsys`), work
titles (`La Catedral`) and award names that are not conventionally translated
stay as they are, in every edition.

So `pages/ru/andres-segovia.bio.json` holds `"forename": "Андрес"`, and
`pages/de/andres-segovia.bio.json` holds `"forename": "Andrés"`. The codex
header and the Lore tab render these values directly — there is no runtime
translation layer, and there must not be one.

Only three fields are **language-invariant** and therefore identical in every
edition of an entry: `dates`, `ranking`, `url`.

---

## Top-level structure

```json
{
  "metadata": {},
  "media": {
    "photos": [],
    "music": []
  },
  "documents": []
}
```

| Section | Purpose |
|---|---|
| `metadata` | Names, places, dates, relationships, career data, and the external source URL |
| `media.photos` | Images displayed in the Gallery tab |
| `media.music` | Audio files or music links |
| `documents` | Documents, transcripts, dossiers, scans, or embedded records |

---

## LLM authoring rules

When creating or modifying `MetaData.json`:

1. Output valid UTF-8 JSON only.
2. Use double quotes around keys and string values.
3. Do not add comments or trailing commas.
4. Preserve the three top-level sections: `metadata`, `media`, and `documents`.
5. Do not invent unknown biographical facts. Omit an optional field or use `null` when the application supports it.
6. **Write every prose field in the language of the directory the file is in.** Do not copy an edition and leave it untranslated.
7. Use `DD.MM.YYYY` for dates unless the project later standardizes another format.
8. Keep `dates`, `ranking` and `url` **identical across all editions** of the same entry; they are language-invariant.
9. Store file references as relative project paths whenever possible.
10. Preserve Unicode names and titles without transliteration. The Latin form of a name belongs in `index.json`'s `title`, not here.
11. Treat comma-separated fields as lists encoded in a string. Do not split names containing commas unless the source format explicitly uses commas as separators.
12. Unknown fields should be preserved when editing an existing file.
13. Do not add `id`, `title`, `gender`, `type`, `country`, `bio` or `dataStatus` — they belong to [`Catalog-Index.md`](Catalog-Index.md) and are rejected by `lint:content`.

---

## `metadata`

### Core identity fields

All of these are **language-scoped**: authored in the edition's own language.

| Field | Type | Expected meaning |
|---|---:|---|
| `forename` | string | Given name, in this edition's language. Rendered as the codex `<h1>`. |
| `surname` | string | Family name, in this edition's language. Rendered as the codex `<h2>`. |
| `birthname` | string | Full birth name or complete legal name. |
| `birthplace` | string | Place of birth. |
| `deathplace` | string | Place of death. |

> A collective or roster entry may carry a comma-separated list in `forename`
> (`"Сергей,Виктор,Александр"`) with the family name in `surname`. The renderer
> wraps such lists deliberately; this is a supported convention, not a defect.

Identity fields that used to live here — `id`, `title`, `gender`, `type`,
`country` — are now in `index.json`. See [`Catalog-Index.md`](Catalog-Index.md) §2.

### Dates

```json
"dates": {
  "born": "11.02.1920",
  "died": "11.02.1990",
  "activeFrom": "11.02.1940",
  "activeTo": "11.02.1980"
}
```

| Field | Type | Meaning |
|---|---:|---|
| `born` | string | Date of birth |
| `died` | string | Date of death |
| `activeFrom` | string | Beginning of the documented active period |
| `activeTo` | string | End of the documented active period |

Dates may be absent for living persons or when the source is unknown. A parser must not assume that every date exists.

`dates` is **language-invariant**: identical in every edition of the entry.

This file is the **only** home for dates — they are deliberately not mirrored
into `index.json`, and a row there carrying `born`/`died`/`dates` is a
validation error. See [`Catalog-Index.md`](Catalog-Index.md) §4.3.

### Relationships and career

| Field | Type | Expected meaning |
|---|---:|---|
| `relatives` | string | Related persons; currently represented as one value or a comma-separated list |
| `instruments` | string | Instrument names, potentially comma-separated |
| `genres` | string | Musical genres, comma-separated |
| `bands` | string | Bands, ensembles, or orchestras |
| `awards` | string | Awards and distinctions |
| `teachers` | string | Teachers or mentors |
| `disciples` | string | Students, disciples, or notable pupils |
| `jobs` | string | Professions and professional roles |
| `ranking` | number | Project-specific score, `0–100`. **Language-invariant.** |
| `url` | string | External reference or canonical source URL. **Language-invariant.** |

Everything above except `ranking` and `url` is **language-scoped**: translate
`instruments`, `genres`, `bands`, `awards`, `teachers`, `disciples`, `jobs` and
`relatives` per edition. Do not leave English values in a Russian edition and
expect the application to translate them — it will not.

The path to the biography article is **not** stored here. It is `index.json`'s
`md` field, and the article for this edition is the sibling file in the same
directory.

The current file uses strings for multi-value fields. A future normalized format may use arrays, but parsers should support the current representation first.

Example list normalization:

```text
"rock,pop" → ["rock", "pop"]
```

Recommended parsing rule:

```text
split by comma → trim whitespace → remove empty values
```

---

## `media`

### Photos

```json
"photos": [
  {
    "label": "main Photo",
    "target": "/characters/vesper-reed.jpg"
  }
]
```

| Field | Type | Meaning |
|---|---:|---|
| `label` | string | Human-readable caption or image role |
| `target` | string | Relative path or URL of the image |

The first photo may be treated as the primary portrait when no explicit `primary` flag exists.

### Music

```json
"music": [
  {
    "label": "Love song",
    "target": "/music/song.mp3"
  }
]
```

| Field | Type | Meaning |
|---|---:|---|
| `label` | string | Track title or descriptive label |
| `target` | string | Relative path or URL of an audio resource |

A renderer should determine playback support from the file extension or returned MIME type rather than from the label.

---

## `documents`

```json
"documents": [
  {
    "label": "Expulsion hearing",
    "type": "TRANSCRIPT",
    "target": "embedded"
  }
]
```

| Field | Type | Meaning |
|---|---:|---|
| `label` | string | Display title |
| `type` | string | Document category, preferably an uppercase symbolic value |
| `target` | string | File path, URL, document identifier, slug, or the special value `embedded` |

Observed document types:

- `TRANSCRIPT`
- `DOSSIER`

The application should not hard-code only these two values. Unknown document types should still be displayed using a generic document icon and label.

Suggested interpretation of `target`:

| Value form | Interpretation |
|---|---|
| `embedded` | Document content is stored or rendered inside the biography entry |
| Relative path | Load a local file |
| Absolute URL | Open or fetch an external resource |
| Slug or identifier | Resolve through the application's document registry |

---

## Recommended complete template

```json
{
  "metadata": {
    "forename": "Forename",
    "surname": "Surname",
    "birthname": "Full Birth Name",
    "birthplace": "City",
    "deathplace": "City",
    "dates": {
      "born": "11.02.1920",
      "died": "11.02.1990",
      "activeFrom": "11.02.1940",
      "activeTo": "11.02.1980"
    },
    "relatives": "Person One,Person Two",
    "instruments": "guitar",
    "genres": "classical,folk",
    "bands": "Ensemble Name",
    "awards": "Award Name",
    "teachers": "Teacher Name",
    "disciples": "Student Name",
    "jobs": "Guitarist,Composer",
    "ranking": 50,
    "url": "https://example.org/source"
  },
  "media": {
    "photos": [
      {
        "label": "Main portrait",
        "target": "/images/person/main.jpg"
      }
    ],
    "music": [
      {
        "label": "Recording title",
        "target": "/music/recording.mp3"
      }
    ]
  },
  "documents": [
    {
      "label": "Document title",
      "type": "ARTICLE",
      "target": "/documents/article.pdf"
    }
  ]
}
```

---

## Minimal valid entry

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

Every field is optional — the Lore tab generates rows from whatever is present.
`forename` / `surname` are the practical minimum because the codex header
renders them.

An entry that has no dossier at all is not an error either: omit `json` from
its `index.json` row and it becomes a **page** rather than a biography
(see [`Catalog-Index.md`](Catalog-Index.md) §9).

---

## Parsing procedure

1. Read the file as UTF-8.
2. Parse it with a standard JSON parser.
3. Verify that the root value is an object.
4. Read `metadata`, `media`, and `documents` independently.
5. Do not require any field. Identity comes from `index.json`; this file is a dossier and every part of it may be missing, including the whole file.
6. Parse dates explicitly as `DD.MM.YYYY`; do not pass them directly to JavaScript `Date`.
7. Normalize comma-separated list fields only when the UI needs arrays.
8. Resolve relative media/document paths against the configurable resource
   base (default: `/pages`), independently of the application's deployment
   base. This rule applies to per-entry JSON, not to `index.json`.
9. Ignore or preserve unknown fields rather than rejecting the complete document.
10. Render missing optional values as absent rows, not as empty labels.

---

## JavaScript / TypeScript parsing example

```ts
type MetadataFile = {
  metadata: {
    forename?: string;
    surname?: string;
    dates?: {
      born?: string;
      died?: string;
      activeFrom?: string;
      activeTo?: string;
    };
    [key: string]: unknown;
  };
  media?: {
    photos?: Array<{ label: string; target: string }>;
    music?: Array<{ label: string; target: string }>;
  };
  documents?: Array<{
    label: string;
    type: string;
    target: string;
  }>;
};

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map(v => v.trim()).filter(Boolean);
  }

  if (typeof value !== "string") {
    return [];
  }

  return value.split(",").map(v => v.trim()).filter(Boolean);
}

function parseMetadata(jsonText: string): MetadataFile {
  const value: unknown = JSON.parse(jsonText);

  if (!value || typeof value !== "object") {
    throw new Error("MetaData.json root must be an object");
  }

  const data = value as Partial<MetadataFile>;

  // No field is required: a dossier is additive detail on top of index.json.
  return {
    metadata: data.metadata ?? {},
    media: {
      photos: data.media?.photos ?? [],
      music: data.media?.music ?? []
    },
    documents: data.documents ?? []
  };
}
```

---

## UI mapping

| UI tab | JSON source |
|---|---|
| `Biography` | the Markdown article named by `index.json`'s `md`, in this edition's directory |
| `Gallery` | `media.photos` and optionally `media.music` |
| `Documents` | `documents` |
| `Lore` / `Attributes` | fields inside `metadata`, plus `type`, `gender` and `country` from `index.json` |

The Lore tab should generate rows dynamically from available metadata instead of relying on a fixed set of fields. `url` is presented separately, as the source row of the Documents tab.

An entry **without** a metadata file has no tabs at all — its codex shows the
header and the article only. See [`Catalog-Index.md`](Catalog-Index.md) §9 and
[`Biography_card_Design.md`](Biography_card_Design.md).

---

## Compatibility guidance

For the current format:

- accept strings for list-like fields;
- tolerate absent optional sections, and a missing file altogether;
- accept unknown metadata keys;
- resolve local paths without rewriting them;
- avoid automatic date conversion that may change day and month order.

For a future revision, arrays would be preferable for `genres`, `instruments`, `bands`, `awards`, `teachers`, `disciples`, `jobs`, and `relatives`. Such a change should be versioned or supported alongside the current string form.
