---
document: 04-localized-name-index.md
title: The Localized Name Index — index-<lang>.json
part: 4 of 9
status: normative
depends_on: [01-data-model.md, 02-value-domains.md, 03-catalogue-index.md]
---

# 4. The Localized Name Index — `index-<lang>.json`

**Location:** `<catalogue-root>/index-<lang>.json` · **Cardinality:** zero or one
per UI language · **Media type:** `application/json`, UTF-8

One small file per user-interface language. It answers a single question for
every entry it mentions: *what is this entry called in this language, and what
else might a reader type to find it?*

Nothing else belongs here. The file carries no paths, no classification and no
dates — only names.

---

## 4.1 Document shape

**Format requirement.** The root value MUST be a JSON **object** whose keys are
`id` values from `index.json` ([`VD-ID`](02-value-domains.md)) and whose values
are non-empty arrays of strings ([`VD-NAME`](02-value-domains.md)).

```json
{
  "3": ["Андрес Сеговия", "Сеговия", "Сеговия Андрес", "Андрэс Сеговия"],
  "5": ["Джанго Рейнхардт", "Рейнхардт", "Джанго", "Жан Рейнхардт"]
}
```

### The array contract

| Position | Role | Rendered? | Searched? |
|---|---|---|---|
| `[0]` | **the display name** in this language | yes — everywhere the entry is named | yes, at the highest weight |
| `[1…]` | **search aliases** | **never** | yes, at a lower weight |

**Format requirement.** The array MUST contain at least one element. Element
`[0]` is the only element a reader ever sees; elements `[1…]` exist exclusively
to make the entry findable.

---

## 4.2 File naming and language coverage

**Format requirement.** `<lang>` is a single [`VD-LANG`](02-value-domains.md)
code, lowercase: `index-en.json`, `index-ru.json`, `index-zh.json`. Chinese is
`zh`, never `ch`.

**Format requirement.** A name index MAY exist for a language in which **no
content edition** exists, and this is a first-class use of the format, not a
degenerate one: it makes the catalogue searchable in more languages than it is
written in. A reader searching in Chinese finds 安德烈斯·塞戈维亚 and opens the
Russian edition of that entry.

**Consumer behaviour.** A missing `index-<lang>.json` is **normal and is not an
error**. Its absence means: every entry displays its Latin `title` in that
language. A consumer MUST NOT report a failure, and MUST NOT block rendering on
this request.

---

## 4.3 The resolution chain for a display name

Given a UI language `L` and an entry with identifier `id`:

```text
index-<L>.json[id][0]         ── the localized display name
      │ file missing, or id absent, or array empty, or [0] not a usable string
      ▼
index.json.title              ── the Latin fallback
      │ absent or empty
      ▼
index.json.id                 ── last resort (a producer must never allow this)
```

**Reference behaviour — one deliberate exception.** Inside an opened
**biography**, the header is composed from the dossier's `forename` and
`surname` of the edition being read, not from this chain. Those values are
already in the correct language by construction, and they let the header show
the given name and family name on separate typographic lines. The two sources
are expected to agree; when they do not, the grid and the header disagree
visibly. See `INV-15`.

Pages (entries with no dossier) always use the chain above.

---

## 4.4 What belongs in `[0]` — the display name

**Format requirement.** The natural, fully-orthographic form of the name in that
language, in that language's script:

| Language | `[0]` |
|---|---|
| `ru` | `"Андрес Сеговия"` |
| `de` | `"Andrés Segovia"` |
| `en` | `"Andrés Segovia"` |
| `zh` | `"安德烈斯·塞戈维亚"` |
| `ja` | `"アンドレス・セゴビア"` |

Diacritics MUST be written in full: the diacritic-free spelling belongs in
`index.json.title`, and readers still find the entry because consumers fold
diacritics before matching.

For a collective entry, `[0]` is the collective's title
(`"Die Autoren des Projekts"`), not a person's name.

---

## 4.5 What belongs in `[1…]` — the aliases

Aliases are the mechanism that makes multilingual search work **without**
transliteration. They are cheap: adding one is a content change with no code
change and no rebuild.

**Producer requirement.** Author an alias for every form a reader plausibly
types:

| Alias kind | Example (for `[0] = "Андрес Сеговия"`) |
|---|---|
| family name alone | `"Сеговия"` |
| inverted order | `"Сеговия Андрес"` |
| full legal / birth name | `"Андрес Сеговия Торрес"` |
| common misspelling | `"Андрэс Сеговия"` |
| stage or professional name | `"Nitsuga Mangoré"` |
| alternate romanization | `"Jovan Jovicic"` alongside `"Jovan Jovičić"` |
| native-script variant | `"Јован Јовичић"` |

**Producer requirement.** Aliases MUST NOT be used to store information other
than names: no dates, no roles, no descriptions. They are matched as plain text
and would produce nonsensical hits.

**Producer requirement.** Aliases SHOULD NOT duplicate `[0]` or each other after
case folding: a duplicate adds nothing and consumers deduplicate anyway.

### Why aliases, and not transliteration

**Reference behaviour.** A consumer expands a Cyrillic query into Latin
transliteration variants and tests them against ASCII-only fields — that is what
lets `Сеговия` reach the Latin `title` `Andres Segovia`. No mechanism works in
the other direction, and none exists for CJK at all: 塞戈维亚 has no
romanization path back to *Segovia* that any generic algorithm will find.
Therefore:

- for a **CJK** language index, `[0]` alone is often sufficient, because the
  reader types the native form;
- to make a Latin query reach a CJK entry, an **alias** must supply the Latin
  form explicitly.

### Match weighting

**Reference behaviour.** Fields are weighted `display name > alias > Latin title
and slug`, and each match is graded by position (exact > prefix > word-start >
interior > transliterated). Consequently:

- an alias will not outrank a genuine display-name match;
- a very short alias (one or two characters) matches almost everything and
  degrades ranking for the whole catalogue — do not author one;
- adding the same alias to many entries makes all of them tie.

---

## 4.6 When to omit an entry

**Format requirement.** Omit an `id` entirely when **both**:

1. its localized name equals the Latin `title`, **and**
2. it carries no aliases.

A lone `["Django Reinhardt"]` under a row already titled `Django Reinhardt` is
dead weight: the fallback chain produces exactly the same string.

By contrast, `["Django Reinhardt", "Reinhardt", "Jean Reinhardt"]` is correct
and MUST NOT be flagged: `[0]` may legitimately repeat `title` when the entry
exists for the sake of its aliases. This is why the English name index of a
Latin-script catalogue is *short*, not *empty*.

**Producer requirement.** `hidden` entries SHOULD still be named here. They are
excluded from search, but a reader who follows a link to one sees the header,
and the header needs a name.

---

## 4.7 Normalization and failure semantics

**Consumer behaviour.**

| Condition | Disposition |
|---|---|
| file missing / not fetchable | no localized names for that language; fall back to `title`. Not an error. |
| root is not an object (e.g. an array) | the whole file is ignored; fall back to `title`. |
| value is not an array | that `id` is ignored. |
| array element is not a non-empty string | that element is dropped. |
| all elements dropped | that `id` is ignored. |
| key does not match any `id` in `index.json` | harmless at runtime (never looked up); a validator MUST report it — it is almost always a renumbered or deleted entry. |
| duplicate key in the JSON text | MUST NOT be authored. Parsers keep the last occurrence, so the earlier names vanish silently. |

Values are trimmed on read; a name that is only whitespace is treated as absent.

---

## 4.8 Complete examples

### `index-ru.json` — the primary language, richly aliased

```json
{
  "1": ["Агустин Барриос", "Барриос", "Баррьос", "Барриос Мангоре", "Мангоре", "Агустин Пио Барриос Феррейра"],
  "3": ["Андрес Сеговия", "Сеговия", "Сеговия Андрес", "Андрэс Сеговия"],
  "4": ["Авторы проекта", "Тавровские", "Авторы"],
  "5": ["Джанго Рейнхардт", "Рейнхардт", "Джанго", "Джанго Райнхардт", "Жан Рейнхардт"],
  "12": ["О проекте"]
}
```

### `index-en.json` — short, because `[0]` often equals `title`

```json
{
  "1": ["Agustín Barrios Mangoré", "Barrios", "Nitsuga Mangoré", "Agustin Pio Barrios Ferreira"],
  "3": ["Andrés Segovia", "Segovia", "Andres Segovia Torres"],
  "5": ["Django Reinhardt", "Reinhardt", "Jean Reinhardt"]
}
```

Every entry here earns its place through either a diacritic-correct `[0]` that
differs from the ASCII `title`, or through aliases, or both. Entries whose
English name is exactly their `title` and which need no alias are absent.

### `index-zh.json` — a language with no content editions

```json
{
  "1": ["奥古斯丁·巴里奥斯", "巴里奥斯"],
  "3": ["安德烈斯·塞戈维亚", "塞戈维亚"],
  "5": ["强哥·莱恩哈特", "莱恩哈特"]
}
```

No `zh/` directory needs to exist for this file to be useful.

### `index-de.json` — a partially covered language

```json
{
  "3": ["Andrés Segovia", "Segovia"],
  "4": ["Die Autoren des Projekts", "Tavrovski"]
}
```

Entries not listed display their Latin `title` to a German reader. This is a
valid, incrementally completable state — not an error.

---

## 4.9 Anti-patterns

| Anti-pattern | Why it is wrong |
|---|---|
| `{"3": "Андрес Сеговия"}` | The value must be an **array**, even for a single name. |
| `{3: [...]}` | Not valid JSON; and the key must be the string form of the `id`. |
| `{"03": [...]}` | `"03"` and `"3"` are different keys; the join silently fails. |
| Adding a description to `[0]`: `"Андрес Сеговия — гитарист"` | `[0]` is rendered verbatim as the name. Classification comes from `index.json`. |
| Putting the localized name in the dossier instead | The dossier holds name **components** (`forename`, `surname`); the display name belongs here. |
| A one-character alias, e.g. `"С"` | Matches nearly everything; degrades ranking catalogue-wide. |
| Keying by slug instead of `id` | The join key is `id`. A slug key never matches. |
| Adding an id that no longer exists in `index.json` | Never rendered; usually the fossil of a renumbering that also broke live entries. |
