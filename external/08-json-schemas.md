---
document: 08-json-schemas.md
title: Machine-Readable Schemas
part: 8 of 9
status: normative (structural subset)
depends_on: [03-catalogue-index.md, 04-localized-name-index.md, 05-entry-dossier.md]
---

# 8. Machine-Readable Schemas

JSON Schema (draft 2020-12) definitions for the three document types. They
encode the **structural** subset of this specification: types, requiredness,
grammars expressible as regular expressions, and the forbidden-member rules.

They are written to the **producer** contract — strict, so that a file which
validates is conforming. Consumers are deliberately more lenient (see
[`07-authoring-and-validation.md` §7.4](07-authoring-and-validation.md)); a file
that fails validation here may still render.

§8.5 lists precisely what these schemas cannot check.

---

## 8.1 `index.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/catalogue/schemas/index.json",
  "title": "Catalogue index",
  "description": "Identity, classification and routing layer of the catalogue.",
  "type": "array",
  "items": { "$ref": "#/$defs/entryRow" },

  "$defs": {
    "entryRow": {
      "type": "object",
      "required": ["id", "title", "type", "md"],
      "propertyNames": {
        "not": { "enum": ["born", "died", "dates", "forename", "surname"] }
      },
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^(?:0|[1-9][0-9]*)$",
          "description": "VD-ID. Stable decimal string; join key to index-<lang>.json."
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "description": "VD-LATIN. Latin fallback name and last-resort search key."
        },
        "type": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9_-]*$",
          "description": "VD-ENUM-TYPE. Open craft vocabulary; 'hidden' is reserved.",
          "examples": ["guitarist", "musician", "composer", "conductor", "luthier", "guitar-historian", "publisher", "hidden"]
        },
        "md": {
          "type": "string",
          "pattern": "^/[^?#]*\\.md$",
          "description": "VD-PATH-CONTENT. Root-relative article path; no language directory."
        },
        "json": {
          "type": "string",
          "pattern": "^/[^?#]*\\.json$",
          "description": "VD-PATH-CONTENT. Root-relative dossier path. Present <=> biography."
        },
        "lang": {
          "type": "string",
          "pattern": "^[a-z]{2}(?:,[a-z]{2})*$",
          "description": "VD-LANGLIST. Comma-separated ISO 639-1 codes; first = original.",
          "examples": ["ru", "ru,de", "ru,en,de"]
        },
        "gender": {
          "enum": ["m", "f", "mixed"],
          "description": "VD-ENUM-GENDER."
        },
        "country": {
          "type": "string",
          "pattern": "^[a-z]{2}$",
          "description": "VD-COUNTRY. ISO 3166-1 alpha-2, authored lowercase."
        },
        "img": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?:[a-z][a-z0-9+.-]*:|//|[^/?#])[^?#]*$",
          "description": "VD-PATH-ASSET. Bucket-relative portrait, or an absolute URL. Never localized."
        }
      }
    }
  }
}
```

**Notes.**

- `additionalProperties` is intentionally left open: unknown members MUST be
  tolerated. `propertyNames` still forbids the members that belong to another
  file (`INV-6`).
- The `lang` pattern rejects spaces around commas. Consumers tolerate them; the
  canonical authored form has none.
- `img`'s pattern admits an absolute URL, a protocol-relative URL, or a path
  that does **not** begin with `/` — the bucket-relative house style. A leading
  slash resolves identically but is rejected here so that the visual distinction
  from `md`/`json` is preserved.

---

## 8.2 `index-<lang>.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/catalogue/schemas/index-lang.json",
  "title": "Localized name index",
  "description": "id -> [display name, ...search-only aliases] for one UI language.",
  "type": "object",
  "propertyNames": {
    "pattern": "^(?:0|[1-9][0-9]*)$",
    "description": "VD-ID. Must match an id in index.json (not checkable here)."
  },
  "additionalProperties": {
    "type": "array",
    "minItems": 1,
    "description": "[0] is the rendered display name; [1...] are search-only aliases.",
    "items": {
      "type": "string",
      "minLength": 1,
      "pattern": "\\S",
      "description": "VD-NAME. Natural orthography of this language; never transliterated."
    }
  }
}
```

**Notes.**

- `minItems: 1` encodes "an empty array is not a way to say *no name*"; omit the
  key instead.
- The `pattern: "\\S"` requirement rejects whitespace-only names, which
  consumers drop anyway.
- Uniqueness of aliases within an array (`INV-28`) is not expressible; JSON
  Schema's `uniqueItems` would only catch exact duplicates, not
  case-folding-equal ones.

---

## 8.3 `<lang>/<slug>.bio.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/catalogue/schemas/entry-dossier.json",
  "title": "Entry dossier",
  "description": "Structured facts of one entry in one language.",
  "type": "object",
  "required": ["metadata"],
  "propertyNames": { "$ref": "#/$defs/notAnIndexFact" },
  "properties": {
    "metadata": { "$ref": "#/$defs/metadata" },
    "media": { "$ref": "#/$defs/media" },
    "documents": {
      "type": "array",
      "items": { "$ref": "#/$defs/documentItem" }
    }
  },

  "$defs": {
    "notAnIndexFact": {
      "not": {
        "enum": ["id", "title", "type", "gender", "country", "img", "bio", "dataStatus"]
      },
      "description": "Members withdrawn in format version 2; they belong to index.json."
    },

    "localizedText": {
      "type": "string",
      "minLength": 1,
      "description": "VD-LOCALIZED. L1: authored in the language of this file's directory."
    },

    "csvList": {
      "type": "string",
      "minLength": 1,
      "description": "VD-CSV-LIST. L1. Comma-separated items; an item may not contain a comma.",
      "examples": ["classical", "flamenco,jazz fusion,world music"]
    },

    "date": {
      "type": "string",
      "pattern": "^[0-9]{1,2}\\.[0-9]{1,2}\\.[0-9]{4}$",
      "description": "VD-DATE. L0. DD.MM.YYYY. Not ISO 8601.",
      "examples": ["21.02.1893", "5.5.1885"]
    },

    "target": {
      "type": "string",
      "minLength": 1,
      "description": "VD-TARGET. L0. Resolved against the resource base; '^' anchors at its origin."
    },

    "metadata": {
      "type": "object",
      "propertyNames": { "$ref": "#/$defs/notAnIndexFact" },
      "properties": {
        "forename":   { "$ref": "#/$defs/localizedText" },
        "surname":    { "$ref": "#/$defs/localizedText" },
        "birthname":  { "$ref": "#/$defs/localizedText" },
        "birthplace": { "$ref": "#/$defs/localizedText" },
        "deathplace": { "$ref": "#/$defs/localizedText" },

        "dates": {
          "type": "object",
          "properties": {
            "born":       { "$ref": "#/$defs/date" },
            "died":       { "$ref": "#/$defs/date" },
            "activeFrom": { "$ref": "#/$defs/date" },
            "activeTo":   { "$ref": "#/$defs/date" }
          },
          "additionalProperties": false
        },

        "relatives":   { "$ref": "#/$defs/csvList" },
        "instruments": { "$ref": "#/$defs/csvList" },
        "genres":      { "$ref": "#/$defs/csvList" },
        "bands":       { "$ref": "#/$defs/csvList" },
        "awards":      { "$ref": "#/$defs/csvList" },
        "teachers":    { "$ref": "#/$defs/csvList" },
        "disciples":   { "$ref": "#/$defs/csvList" },
        "jobs":        { "$ref": "#/$defs/csvList" },

        "ranking": {
          "type": "number",
          "minimum": 0,
          "maximum": 100,
          "description": "VD-RANKING. L0. Editorial score."
        },
        "url": {
          "type": "string",
          "format": "uri",
          "pattern": "^https?://",
          "description": "VD-URL. L0. Absolute external source URL."
        }
      }
    },

    "media": {
      "type": "object",
      "properties": {
        "photos": { "type": "array", "items": { "$ref": "#/$defs/mediaItem" } },
        "music":  { "type": "array", "items": { "$ref": "#/$defs/mediaItem" } }
      },
      "additionalProperties": false
    },

    "mediaItem": {
      "type": "object",
      "required": ["label", "target"],
      "properties": {
        "label":  { "$ref": "#/$defs/localizedText" },
        "target": { "$ref": "#/$defs/target" }
      }
    },

    "documentItem": {
      "type": "object",
      "required": ["label", "target"],
      "properties": {
        "label": { "$ref": "#/$defs/localizedText" },
        "type": {
          "type": "string",
          "pattern": "^[A-Z][A-Z0-9_]*$",
          "description": "VD-ENUM-DOCTYPE. L0. Open uppercase vocabulary.",
          "examples": ["TRANSCRIPT", "DOSSIER", "ARTICLE", "REFERENCE", "SCAN", "DISCOGRAPHY"]
        },
        "target": {
          "$ref": "#/$defs/target",
          "description": "VD-TARGET, or the exact sentinel 'embedded'."
        }
      }
    }
  }
}
```

**Notes.**

- `required: ["metadata"]` encodes the one hard structural rule: a document
  without it is not a dossier and is discarded whole.
- `dates` and `media` use `additionalProperties: false` because their member
  sets are closed. `metadata` and the item objects do not, because unknown
  members must be tolerated and preserved.
- The forbidden-member rule is applied at **both** the root and inside
  `metadata`, which is where version 1 leftovers actually appear.
- `documents[].type` is optional; when present it must be an uppercase symbol.

---

## 8.4 TypeScript type declarations

Equivalent structural types, for consumers written in TypeScript. They describe
the **parsed** shape; normalization (case, trimming, list splitting, date
parsing) happens after.

```ts
/** One row of index.json. */
export interface EntryRow {
  /** VD-ID — stable decimal string; join key to index-<lang>.json. */
  id: string;
  /** VD-LATIN — Latin fallback name. */
  title: string;
  /** VD-ENUM-TYPE — craft, or the reserved value "hidden". */
  type: string;
  /** VD-PATH-CONTENT — root-relative article path; basename yields the slug. */
  md: string;
  /** VD-LANGLIST — "ru,de"; first code is the original language. Absent => primary. */
  lang?: string;
  /** VD-ENUM-GENDER. */
  gender?: "m" | "f" | "mixed";
  /** VD-COUNTRY — ISO 3166-1 alpha-2, authored lowercase. */
  country?: string;
  /** VD-PATH-CONTENT — root-relative dossier path. Present <=> biography. */
  json?: string;
  /** VD-PATH-ASSET — bucket-relative portrait; never localized. */
  img?: string;
  /** Unknown members are tolerated and must be preserved on edit. */
  [key: string]: unknown;
}

/** index-<lang>.json — id -> [display name, ...search-only aliases]. */
export type NameIndex = Record<string, string[]>;

/** VD-DATE values, all optional. */
export interface EntryDates {
  born?: string;
  died?: string;
  activeFrom?: string;
  activeTo?: string;
}

export interface EntryMeta {
  forename?: string;
  surname?: string;
  birthname?: string;
  birthplace?: string;
  deathplace?: string;
  dates?: EntryDates;
  /** Comma-separated lists (VD-CSV-LIST). */
  relatives?: string;
  instruments?: string;
  genres?: string;
  bands?: string;
  awards?: string;
  teachers?: string;
  disciples?: string;
  jobs?: string;
  /** L0 — identical in every edition. */
  ranking?: number;
  url?: string;
  [key: string]: unknown;
}

export interface MediaItem {
  /** L1 — translated per edition. */
  label: string;
  /** L0 — identical in every edition. */
  target: string;
}

export interface DocumentItem {
  label: string;
  /** Uppercase symbolic category; open set. */
  type?: string;
  /** "embedded" | base-relative path | absolute URL. */
  target: string;
}

export interface EntryDossier {
  metadata: EntryMeta;
  media?: { photos?: MediaItem[]; music?: MediaItem[] };
  documents?: DocumentItem[];
}
```

---

## 8.5 What the schemas cannot check

Validation against §8.1–8.3 is necessary but **not sufficient**. The following
invariants require a validator that reads more than one document, or that knows
something JSON Schema cannot express.

| Not checkable | Invariant | Why |
|---|---|---|
| `id` uniqueness across rows | `INV-1` | Requires cross-item state. |
| Slug uniqueness, and slug derivation itself | `INV-3`, `INV-4` | The slug is derived, not a member. |
| Every `index-<lang>.json` key matches an `id` | `INV-12` | Cross-document reference. |
| Declared editions exist on disk | `INV-8`, `INV-23` | Requires the filesystem. |
| `country` is a **known** region, not merely two letters | `INV-9` | Requires the ISO register. |
| `lang` codes are supported by the deployment | `INV-11` | Requires deployment configuration. |
| Calendar validity of a date (`31.02.1900`) | `INV-21` | Beyond a regular expression. |
| L0 values identical across editions | `INV-17` | Cross-document comparison. |
| L1 values genuinely translated | `INV-18` | Requires language detection. |
| Display name agrees with `forename`+`surname` | `INV-15`, `INV-16` | Cross-document, with documented exceptions. |
| Items of a comma list contain no comma | — | The separator and the content share a character. |
| No duplicate object keys in the source text | `INV-26` | Lost before the schema sees the document. |
| A `target` resolves to something that exists | — | Requires network or filesystem access. |

A complete validator therefore performs three passes: schema validation, then
cross-document reference checking, then filesystem/asset existence checking.
