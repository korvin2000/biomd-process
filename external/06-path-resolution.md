---
document: 06-path-resolution.md
title: Path and URL Resolution
part: 6 of 9
status: normative
depends_on: [02-value-domains.md, 03-catalogue-index.md, 05-entry-dossier.md]
---

# 6. Path and URL Resolution

Every path-valued field in this format resolves against one of **two
independent bases**. Knowing which base applies to which field is the whole of
the subject, and getting it wrong is the most common integration defect.

---

## 6.1 The two bases

| Base | Symbol | Default | Contains |
|---|---|---|---|
| **Catalogue base** | `CATALOGUE_BASE` | `/` (the site root) | `index.json`, `index-<lang>.json`, the language directories, and the assets referenced by `img` |
| **Resource base** | `RESOURCE_BASE` | `/pages` | The shared media archive: every `target` written inside a dossier |

**Format requirement.** The two are configured independently and MUST NOT be
assumed to coincide. A deployment may serve the application from `/fable/` while
its photographs stay at `/pages/`; another may put both at the site root.

**Consumer behaviour.** `RESOURCE_BASE` MAY be an absolute URL
(`https://cdn.example.org/archive`) or a path (`/pages`). A trailing slash is
insignificant. An empty value or `/` means "the origin root".

---

## 6.2 Which base applies to which field

| Field | Base | Language-injected? | Domain |
|---|---|:--:|---|
| `index.json` itself | catalogue | no | — |
| `index-<lang>.json` | catalogue | no (the language is in the file name) | — |
| `index.json` → `md` | catalogue | **yes** | `VD-PATH-CONTENT` |
| `index.json` → `json` | catalogue | **yes** | `VD-PATH-CONTENT` |
| `index.json` → `img` | catalogue | no | `VD-PATH-ASSET` |
| dossier → `media.photos[].target` | **resource** | no | `VD-TARGET` |
| dossier → `media.music[].target` | **resource** | no | `VD-TARGET` |
| dossier → `documents[].target` | **resource** | no | `VD-TARGET` |
| dossier → `metadata.url` | **resource** (in practice: absolute, so unchanged) | no | `VD-URL` |

> **The trap, stated once.** `img: "photos/x.jpg"` and a dossier
> `target: "photos/x.jpg"` are **different files**. With the default
> configuration the first resolves to `/photos/x.jpg` and the second to
> `/pages/photos/x.jpg`. Both spellings look identical in a diff.

---

## 6.3 Resolving a catalogue path

Applies to `md`, `json`, `img`, and to the index files themselves.

```text
resolveCatalogue(p):
    if p is empty                    → return p
    if p is an absolute or
       protocol-relative URL         → return p unchanged
    return CATALOGUE_BASE + "/" + stripLeadingSlashes(p)
```

Leading slashes are stripped before joining, so `"/photos/x.jpg"` and
`"photos/x.jpg"` produce the same result. The leading-slash conventions of
`VD-PATH-CONTENT` (with) and `VD-PATH-ASSET` (without) are therefore
**stylistic**: they exist so that a reader of the JSON can tell the two field
kinds apart at a glance.

| Input | `CATALOGUE_BASE = ""` | `CATALOGUE_BASE = "/fable"` |
|---|---|---|
| `/index.json` | `/index.json` | `/fable/index.json` |
| `photos/x.jpg` | `/photos/x.jpg` | `/fable/photos/x.jpg` |
| `/photos/x.jpg` | `/photos/x.jpg` | `/fable/photos/x.jpg` |
| `https://cdn.example.org/x.jpg` | unchanged | unchanged |

---

## 6.4 Language injection

Applies to `md` and `json` **only**, and is performed **before** §6.3.

```text
localize(p, lang):
    if p is empty                    → return p
    if p is an absolute or
       protocol-relative URL         → return p unchanged     ← not localized
    return "/" + lang + "/" + stripLeadingSlashes(p)
```

| `md` | `lang` | Localized | Then resolved (`CATALOGUE_BASE = ""`) |
|---|---|---|---|
| `/andres-segovia.bio.md` | `ru` | `/ru/andres-segovia.bio.md` | `/ru/andres-segovia.bio.md` |
| `/andres-segovia.bio.md` | `de` | `/de/andres-segovia.bio.md` | `/de/andres-segovia.bio.md` |
| `/series/part-2.bio.md` | `en` | `/en/series/part-2.bio.md` | `/en/series/part-2.bio.md` |
| `https://cdn.example.org/a.md` | `de` | unchanged | unchanged |

**Format requirement.** Because injection is unconditional prefixing, the
authored value MUST NOT already contain the language directory. `"/ru/x.bio.md"`
resolves to `/ru/ru/x.bio.md`.

**Format requirement.** Language injection applies to **no other field**. `img`
and every dossier `target` are shared by all editions by construction.

---

## 6.5 Resolving a resource target

Applies to every `target` inside a dossier, and to a relative `metadata.url`.

### 6.5.1 Algorithm (normative)

```text
resolveResource(p):
 1  if p is empty                                → return p
 2  if p matches /^(?:[a-z][a-z0-9+.-]*:|\/\/|[?#])/i
        → return p unchanged                        # opaque: URI scheme,
                                                    # protocol-relative,
                                                    # bare query or fragment
 3  (path, suffix) ← split p at the first "?" or "#"    # suffix is preserved verbatim
 4  anchored ← path starts with "^"
 5  rel ← stripLeadingSlashes(anchored ? path without "^" : path)
        split into segments on "/"
 6  prefix ← []                                    if anchored
            []                                     if rel already begins with
                                                      RESOURCE_BASE's own segments
            RESOURCE_BASE's segments               otherwise
 7  segments ← collapse(prefix ++ rel)
        collapse drops "" and ".", and pops the previous segment on ".."
        (a ".." with nothing to pop is discarded — the root is never escaped)
 8  return RESOURCE_ORIGIN + "/" + join(segments, "/") + suffix
```

`RESOURCE_ORIGIN` is the scheme-and-host part of `RESOURCE_BASE`, or the empty
string when the base is a plain path.

### 6.5.2 Worked results, with `RESOURCE_BASE = "/pages"`

| Target | Resolves to | Note |
|---|---|---|
| `photo/a/x.jpg` | `/pages/photo/a/x.jpg` | the ordinary form |
| `/photo/a/x.jpg` | `/pages/photo/a/x.jpg` | leading slash is insignificant |
| `photo/a/x.jpg?v=2` | `/pages/photo/a/x.jpg?v=2` | query preserved |
| `photo/a/x.jpg#p3` | `/pages/photo/a/x.jpg#p3` | fragment preserved |
| `^/main/x.jpg` | `/main/x.jpg` | anchored: escapes the base |
| `/../main/x.jpg` | `/main/x.jpg` | `..` climbs out of the base |
| `../../../x.jpg` | `/x.jpg` | surplus `..` is clamped at the root |
| `pages/photo/a/x.jpg` | `/pages/photo/a/x.jpg` | **legacy allowance**, see §6.5.4 |
| `https://example.org/x.jpg` | unchanged | opaque |
| `//cdn.example.org/x.jpg` | unchanged | opaque |
| `mailto:someone@example.org` | unchanged | opaque |

With `RESOURCE_BASE = "https://cdn.example.org/archive"`:

| Target | Resolves to |
|---|---|
| `photo/a/x.jpg` | `https://cdn.example.org/archive/photo/a/x.jpg` |
| `^/main/x.jpg` | `https://cdn.example.org/main/x.jpg` |

### 6.5.3 `^` versus `..`

Both leave the resource base; they differ in robustness.

**Producer requirement.** Prefer `^`. It anchors at the resource **origin**
regardless of how deep the base is configured. `..` must match the base segment
for segment: a target written as `/../main/x.jpg` against a one-segment base
`/pages` silently resolves elsewhere if the base is later reconfigured to
`/a/pages`.

### 6.5.4 The legacy prefix allowance

**Consumer behaviour.** If a target's leading segments already spell out the
resource base's own segments, the base is **not** prepended a second time:
`pages/photo/a/x.jpg` resolves to `/pages/photo/a/x.jpg`, not
`/pages/pages/photo/a/x.jpg`.

This exists so that content migrated from a site where the base was written into
every path keeps resolving.

**Format requirement.** New content MUST NOT use this form. It carries a real
cost: a genuine directory named after the base's last segment, sitting *inside*
the base, is unaddressable — `pages/pages/x.jpg` cannot be expressed.

---

## 6.6 Resolution of `metadata.url`

**Consumer behaviour.** `metadata.url` passes through the resource resolver.
Because a conforming value is an absolute URL, step 2 of the algorithm returns
it unchanged and the base is never applied.

**Format requirement.** Do not exploit this by writing a relative `url`: the
field means "the external source of this entry", and a relative value silently
becomes an archive path.

---

## 6.7 Complete resolution trace

Given:

- `CATALOGUE_BASE = "/fable"`, `RESOURCE_BASE = "/pages"`, reader language `de`
- index row:

```json
{
  "id": "3",
  "title": "Andres Segovia",
  "lang": "ru,de",
  "type": "guitarist",
  "country": "es",
  "md":   "/andres-segovia.bio.md",
  "json": "/andres-segovia.bio.json",
  "img":  "photos/andres-segovia.jpg"
}
```

- dossier `media.photos[0].target = "photo/s/segovia_01.jpg"`
- dossier `documents[0].target = "^/main/scans/programme.jpg"`

Resolution:

| What | Steps | Final URL |
|---|---|---|
| the index | catalogue base | `/fable/index.json` |
| the name index | catalogue base | `/fable/index-de.json` |
| slug | basename of `md`, strip `.bio.md` | `andres-segovia` |
| route | `#/<slug>` | `/fable/#/andres-segovia` |
| article | localize(`de`) → catalogue base | `/fable/de/andres-segovia.bio.md` |
| dossier | localize(`de`) → catalogue base | `/fable/de/andres-segovia.bio.json` |
| portrait | catalogue base, no localization | `/fable/photos/andres-segovia.jpg` |
| gallery photo | resource base | `/pages/photo/s/segovia_01.jpg` |
| document scan | resource base, anchored | `/main/scans/programme.jpg` |

Note that the portrait and the gallery photo resolve into two entirely different
URL spaces, exactly as intended: one is part of the deployed catalogue, the
other part of the shared archive.

---

## 6.8 Consumer requirements for path handling

- A consumer MUST NOT pass an authored path to a URL constructor before applying
  the algorithms above: `..` collapsing is performed explicitly so that the
  emitted URL says what it means, and the `^` form has no meaning to a generic
  URL parser.
- A consumer MUST percent-decode the route fragment (`#/<slug>`) before matching
  it against slugs, and MUST reject a decoded slug that does not match
  `[A-Za-z0-9_.-]+`.
- A consumer SHOULD treat a failed media request as a per-item failure: hide the
  item, keep the rest of the view.
- A consumer MUST NOT rewrite an authored path in place (for example by
  normalizing `^` away in an editor round-trip). Authored form is preserved;
  only the derived request URL is computed.
