---
document: 09-worked-examples.md
title: Worked Examples
part: 9 of 9
status: informative (the files themselves are conforming and may be used as fixtures)
depends_on: [03-catalogue-index.md, 04-localized-name-index.md, 05-entry-dossier.md, 06-path-resolution.md]
---

# 9. Worked Examples

A complete, internally consistent miniature catalogue, followed by an annotated
counter-example. Every file below conforms to this specification and may be used
as a conformance fixture.

Deployment parameters assumed throughout:

```text
CATALOGUE_BASE = ""        (the site root)
RESOURCE_BASE  = "/pages"
primary language = ru
```

---

## 9.1 File tree

```text
<catalogue-root>/
├── index.json
├── index-ru.json
├── index-en.json
├── index-de.json
├── index-zh.json
│
├── ru/
│   ├── agustin-barrios.bio.md
│   ├── agustin-barrios.bio.json
│   ├── barrios-alternate.bio.md          ← different article, shared dossier
│   ├── andres-segovia.bio.md
│   ├── andres-segovia.bio.json
│   ├── authors.bio.md
│   ├── authors.bio.json
│   └── about.md                          ← a page: no dossier
│
├── de/
│   ├── andres-segovia.bio.md
│   ├── andres-segovia.bio.json
│   ├── authors.bio.md
│   └── authors.bio.json
│
├── en/
│   └── about.md
│
└── photos/                               ← referenced by index.json `img`
    ├── agustin-barrios.jpg
    ├── andres-segovia.jpg
    ├── authors.jpg
    ├── default-male.svg
    ├── default-female.svg
    └── default-mixed.svg
```

Separately, outside the catalogue root:

```text
/pages/                                   ← RESOURCE_BASE
├── photo/a/barrios_01.jpg
├── music/mp/juliaflorida.mp3
├── music/tab/la_catedral.txt
└── articles/about_us/rg_2002.jpg

/main/                                    ← reachable only via the "^" anchor
└── scans/programme_1957.jpg
```

---

## 9.2 `index.json`

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
    "id": "2",
    "title": "Agustin Barrios Mangore - alternate layout",
    "lang": "ru",
    "type": "guitarist",
    "md": "/barrios-alternate.bio.md",
    "json": "/agustin-barrios.bio.json"
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

What each row demonstrates:

| Row | Demonstrates |
|---|---|
| `1` | The complete ordinary biography: every optional field present, one edition. |
| `2` | A **shared dossier** (§1.6): its own `id`, its own slug, the same `json`. It omits `gender`, `country` and `img` because it is an alternate view, not a second person. |
| `3` | Two content editions; `ru` first, so `ru` is the original and the fallback edition. |
| `4` | A **collective** (`gender: "mixed"`), whose dossier uses the roster convention. |
| `12` | A **page**: no `json`, therefore no tabs. `hidden`, therefore out of the grid, search and facets — while `#/about` still opens it. Correctly omits `gender` and `img`. |

---

## 9.3 The name indices

### `index-ru.json` — the primary language

```json
{
  "1": ["Агустин Барриос", "Барриос", "Баррьос", "Барриос Мангоре", "Мангоре", "Агустин Пио Барриос Феррейра"],
  "2": ["Агустин Барриос — вариант вёрстки"],
  "3": ["Андрес Сеговия", "Сеговия", "Сеговия Андрес", "Андрэс Сеговия"],
  "4": ["Авторы проекта", "Тавровские", "Авторы"],
  "12": ["О проекте"]
}
```

- `"2"` carries a display name that deliberately distinguishes it from `"1"`,
  because both render the same dossier.
- `"12"` is a hidden entry: unsearchable, but its header still needs a name.

### `index-en.json` — short, not empty

```json
{
  "1": ["Agustín Barrios Mangoré", "Barrios", "Nitsuga Mangoré", "Agustin Pio Barrios Ferreira"],
  "3": ["Andrés Segovia", "Segovia", "Andres Segovia Torres"],
  "12": ["About the Project"]
}
```

- `"4"` is absent: its English name would be exactly the Latin `title`
  (`Project Authors`) and it carries no aliases, so the entry would be dead
  weight (`INV-14`).
- `"1"` and `"3"` are present because their `[0]` is diacritically correct and
  differs from `title`, **and** they carry aliases.

### `index-de.json` — partial coverage is valid

```json
{
  "3": ["Andrés Segovia", "Segovia"],
  "4": ["Die Autoren des Projekts", "Tavrovski"]
}
```

Entries `1`, `2` and `12` display their Latin `title` to a German reader. This
is an incrementally completable state, not an error.

### `index-zh.json` — a language with no content editions

```json
{
  "1": ["奥古斯丁·巴里奥斯", "巴里奥斯"],
  "3": ["安德烈斯·塞戈维亚", "塞戈维亚"]
}
```

No `zh/` directory exists and none is needed. A Chinese reader finds these
entries by their Chinese names and reads the Russian editions.

---

## 9.4 A dossier with rich media — `ru/agustin-barrios.bio.json`

```json
{
  "metadata": {
    "forename": "Агустин",
    "surname": "Барриос",
    "birthname": "Агустин Пио Барриос Феррейра",
    "birthplace": "Мисьонес, Парагвай",
    "deathplace": "Сан-Сальвадор, Сальвадор",
    "dates": {
      "born": "05.05.1885",
      "died": "07.08.1944",
      "activeFrom": "01.01.1900",
      "activeTo": "07.08.1944"
    },
    "instruments": "классическая гитара",
    "genres": "классика,парагвайский фольклор",
    "teachers": "Густаво Соса Эскалада",
    "jobs": "Гитарист,Композитор,Педагог",
    "ranking": 94,
    "url": "https://example.org/reference/barrios"
  },
  "media": {
    "photos": [
      { "label": "Портрет, 1920-е", "target": "photo/a/barrios_01.jpg" }
    ],
    "music": [
      { "label": "Julia Florida", "target": "music/mp/juliaflorida.mp3" },
      { "label": "La Catedral — табулатура", "target": "music/tab/la_catedral.txt" }
    ]
  },
  "documents": [
    {
      "label": "Концертная программа, 1957",
      "type": "SCAN",
      "target": "^/main/scans/programme_1957.jpg"
    },
    {
      "label": "Список записей",
      "type": "DISCOGRAPHY",
      "target": "embedded"
    },
    {
      "label": "Статья в справочнике",
      "type": "REFERENCE",
      "target": "https://example.org/reference/barrios"
    }
  ]
}
```

Points of interest:

| Element | Why it is written this way |
|---|---|
| `"target": "music/mp/juliaflorida.mp3"` | Base-relative: resolves under `RESOURCE_BASE`. The `.mp3` extension is what selects the audio player. |
| `"target": "music/tab/la_catedral.txt"` | A `.txt` target in `music` is a tablature, opened in a text viewer rather than played. |
| `"target": "^/main/scans/programme_1957.jpg"` | The `^` anchor escapes the resource base; the image extension selects the in-page image viewer. |
| `"target": "embedded"` | The document is reproduced inside the article; the row is rendered but inert. |
| `"label": "La Catedral — табулатура"` | The work title is a proper noun and stays Latin; the descriptive word around it is localized. |
| `url` **and** a `REFERENCE` document pointing at the same URL | Tolerated but redundant: a source row is synthesized from `url` (`INV-27`). Keep one. |

---

## 9.5 The roster convention — `authors.bio.json`, two editions

### `ru/authors.bio.json`

```json
{
  "metadata": {
    "forename": "Сергей,Виктор,Александр,Константин",
    "surname": "Тавровские",
    "birthname": "Коллектив проекта «Гитаристы и композиторы»",
    "birthplace": "Украина и Польша",
    "dates": {
      "activeFrom": "01.01.2001"
    },
    "relatives": "Сергей Тавровский,Виктор Тавровский,Александр Тавровский",
    "instruments": "классическая гитара",
    "genres": "классика,просветительство",
    "bands": "Проект «Гитаристы и композиторы»",
    "jobs": "Гитарист,Педагог,Программист",
    "ranking": 65,
    "url": "https://example.org/about-us"
  },
  "media": {
    "photos": [
      { "label": "Сергей Тавровский", "target": "photo/t/tavrovsky_s.jpg" }
    ],
    "music": []
  },
  "documents": [
    {
      "label": "Печатный отзыв, 2002",
      "type": "SCAN",
      "target": "articles/about_us/rg_2002.jpg"
    }
  ]
}
```

### `de/authors.bio.json`

```json
{
  "metadata": {
    "forename": "Sergej,Viktor,Alexander,Konstantin",
    "surname": "Tavrovski",
    "birthname": "Das Team des Projekts «Gitarristen und Komponisten»",
    "birthplace": "Ukraine und Polen",
    "dates": {
      "activeFrom": "01.01.2001"
    },
    "relatives": "Sergej Tavrovski,Viktor Tavrovski,Alexander Tavrovski",
    "instruments": "Konzertgitarre",
    "genres": "Klassik,Bildungsarbeit",
    "bands": "Projekt «Gitarristen und Komponisten»",
    "jobs": "Gitarrist,Lehrer,Programmierer",
    "ranking": 65,
    "url": "https://example.org/about-us"
  },
  "media": {
    "photos": [
      { "label": "Sergej Tavrovski", "target": "photo/t/tavrovsky_s.jpg" }
    ],
    "music": []
  },
  "documents": [
    {
      "label": "Gedruckte Rezension, 2002",
      "type": "SCAN",
      "target": "articles/about_us/rg_2002.jpg"
    }
  ]
}
```

Compare the two:

| Property | Russian | German | Class |
|---|---|---|---|
| `forename` | `Сергей,Виктор,…` | `Sergej,Viktor,…` | L1 — translated |
| `dates.activeFrom` | `01.01.2001` | `01.01.2001` | **L0 — identical** |
| `ranking` | `65` | `65` | **L0 — identical** |
| `url` | `https://example.org/about-us` | same | **L0 — identical** |
| `photos[0].label` | `Сергей Тавровский` | `Sergej Tavrovski` | L1 — translated |
| `photos[0].target` | `photo/t/tavrovsky_s.jpg` | **same** | **L0 — identical** |
| `documents[0].type` | `SCAN` | `SCAN` | **L0 — identical** |

Note also `INV-16`: the display name for id `4` is `Авторы проекта`, which does
**not** equal `forename + " " + surname`. That is correct and MUST NOT be
flagged, because `forename` is a comma-list — the roster convention.

---

## 9.6 Full resolution table

Derived from §9.2–9.5 with the deployment parameters at the top of this
document.

### Catalogue-level

| Resource | URL |
|---|---|
| index | `/index.json` |
| name index (reader language `de`) | `/index-de.json` |

### Entry `3` (Andres Segovia), reader language `de`

| Resource | Derivation | URL |
|---|---|---|
| slug | basename of `md`, minus `.bio.md` | `andres-segovia` |
| route | `#/<slug>` | `/#/andres-segovia` |
| edition | `de` ∈ `lang` | `de` |
| article | localize + catalogue base | `/de/andres-segovia.bio.md` |
| dossier | localize + catalogue base | `/de/andres-segovia.bio.json` |
| portrait | catalogue base, no localization | `/photos/andres-segovia.jpg` |

### Entry `3`, reader language `en` (no English edition)

| Resource | Derivation | URL |
|---|---|---|
| edition | `en` ∉ `lang` ⇒ first listed | `ru` |
| article | | `/ru/andres-segovia.bio.md` |
| dossier | | `/ru/andres-segovia.bio.json` |
| display name | `index-en.json["3"][0]` | `Andrés Segovia` |

The reader sees an English interface, an English name, and a Russian article:
the two language axes are independent.

### Entry `1` (Barrios), media targets

| Authored target | URL |
|---|---|
| `photo/a/barrios_01.jpg` | `/pages/photo/a/barrios_01.jpg` |
| `music/mp/juliaflorida.mp3` | `/pages/music/mp/juliaflorida.mp3` |
| `music/tab/la_catedral.txt` | `/pages/music/tab/la_catedral.txt` |
| `^/main/scans/programme_1957.jpg` | `/main/scans/programme_1957.jpg` |
| `embedded` | *(no request — inert row)* |
| `https://example.org/reference/barrios` | unchanged |

Contrast the first row with the portrait of the same entry:

| Field | Authored | URL |
|---|---|---|
| `index.json` → `img` | `photos/agustin-barrios.jpg` | `/photos/agustin-barrios.jpg` |
| dossier → `photos[0].target` | `photo/a/barrios_01.jpg` | `/pages/photo/a/barrios_01.jpg` |

Two similar-looking paths, two different URL spaces — §6.2.

### Entry `12` (About), reader language `ru`

| Resource | URL |
|---|---|
| article | `/ru/about.md` |
| dossier | *(none — `json` is absent, so the entry is a page)* |
| portrait | *(none — `img` absent and the entry is hidden; never carded)* |

### Entry `2` (shared dossier), reader language `ru`

| Resource | URL |
|---|---|
| article | `/ru/barrios-alternate.bio.md` |
| dossier | `/ru/agustin-barrios.bio.json` — **the same file entry `1` uses** |
| portrait | `/photos/default-male.svg`? **No** — `gender` is absent, so `/photos/default-mixed.svg` |

The last row is worth internalizing: the portrait fallback is driven by
`gender`, and an omitted `gender` yields the *mixed* default, not the male one.

---

## 9.7 Annotated counter-example

Every line of the following is wrong in a different way. Use it as a validator
test case.

```jsonc
// index.json — NON-CONFORMING
[
  {
    "id": 1,                                    // ✗ INV-2: must be the string "1"
    "title": "Андрес Сеговия",                  // ✗ VD-LATIN: title is the Latin fallback
    "lang": "ch",                               // ✗ INV-11: Chinese is "zh"; "ch" is dropped
    "type": "Guitarist",                        // ✗ INV-25: authored lowercase
    "gender": "male",                           // ✗ INV-10: must be m | f | mixed
    "country": "Spain",                         // ✗ INV-9: must be the alpha-2 code "es"
    "born": "21.02.1893",                       // ✗ INV-6: dates belong to the dossier
    "md": "/ru/andres-segovia.bio.md",          // ✗ language directory must not be written
    "json": "/andres-segovia.bio.json",
    "img": "/pages/photos/andres-segovia.jpg"   // ✗ img resolves against the catalogue root
  },
  {
    "id": "1",                                  // ✗ INV-1: duplicate id — this row is skipped
    "title": "Andres Segovia",
    "type": "hidden",
    "md": "/andres-segovia.md"                  // ✗ INV-3: same slug as the row above
  }
]
```

```jsonc
// index-de.json — NON-CONFORMING
{
  "3": "Andrés Segovia",                        // ✗ INV-13: the value must be an array
  "03": ["Andrés Segovia"],                     // ✗ "03" ≠ "3": the join silently fails
  "99": ["Ein gelöschter Eintrag"],             // ✗ INV-12: no such id in index.json
  "4": ["Project Authors"]                      // ✗ INV-14: equals `title`, no aliases → omit
}
```

```jsonc
// de/andres-segovia.bio.json — NON-CONFORMING
{
  "title": "Andrés Segovia",                    // ✗ INV-7: withdrawn in version 2
  "country": "es",                              // ✗ INV-7: classification lives in the index
  "metadata": {
    "forename": "Andrés",
    "surname": "Segovia",
    "birthplace": "Linares, Spain",             // ✗ INV-18: English inside the German edition
    "dates": {
      "born": "1893-02-21",                     // ✗ INV-21: must be "21.02.1893"
      "died": "1987"                            // ✗ INV-21: partial dates are not representable
    },
    "genres": ["Klassik"],                      // ✗ VD-CSV-LIST: must be the string "Klassik"
    "ranking": "96",                            // ✗ INV-20: must be the number 96
    "url": "/reference/segovia"                 // ✗ VD-URL: must be absolute
  },
  "media": {
    "photos": [
      { "label": "Hauptporträt",
        "target": "de/photo/segovia.jpg" }      // ✗ INV-23: media is never localized
    ]
  },
  "documents": [
    { "label": "Programm", "target": "Embedded" } // ✗ sentinel is exactly "embedded"
  ]
}
```

And one document that is **structurally** fatal:

```jsonc
// ru/broken.bio.json — DISCARDED WHOLE
{
  "forename": "Андрес",                         // ✗ metadata members at the root
  "surname": "Сеговия",
  "media": { "photos": [ /* … */ ] },           //   …so `media` is lost as well
  "documents": [ /* … */ ]                      //   …and `documents` too
}
```

There is no top-level `metadata` object, so a conforming consumer discards the
entire document — the media and documents are **not** salvaged. The entry still
renders as a biography with empty structured data, because its kind is declared
by `index.json`, not observed from this file.
