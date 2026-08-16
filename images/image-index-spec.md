# Biography Avatar Image Index — JSON Format & Selection Guide

## 1. Purpose

This document defines the JSON index format used to describe images and explains how to parse and rank them when selecting the best image of a person for use as a biography avatar/profile photograph.

The index is intended for heuristic or rule-based selection. It separates two different questions:

1. **Identity match** — how likely is the image related to the requested person?
2. **Avatar suitability** — how suitable is the image itself as a profile/biography image?

A high filename/name match alone is not enough: an image may contain sheet music, a group photo, a distant full-body figure, or another unsuitable subject.

---

## 2. Top-level JSON structure

```json
{
  "schemaVersion": 1,
  "images": [
    {
      "relPath": "artists/Andreas_Segovia.jpg",
      "fileName": "Andreas_Segovia.jpg",

      "nameTokens": ["Andreas", "Segovia"],
      "nameTokensRu": ["Андрес", "Сеговия"],

      "image": {
        "width": 1200,
        "height": 1600,
        "aspect": "3:4",
        "orientation": "portrait",
        "mp": 1.9
      },

      "color": {
        "mode": "color",
        "count": 1832
      },

      "meta": {
        "title": "Andrés Segovia",
        "description": "Portrait of guitarist Andrés Segovia",
        "keywords": ["Andrés Segovia", "guitarist", "classical guitar"],
        "people": ["Andrés Segovia"],
        "ocr": ""
      },

      "ai": {
        "class": "portrait",
        "confidence": 0.98,
        "faceCount": 1,
        "faceCoverage": 0.31
      }
    }
  ]
}
```

---

## 3. Field semantics

### `schemaVersion`

Integer version of the index format.

Use it before parsing records so future incompatible schema changes can be handled explicitly.

---

## 4. File identity fields

### `relPath`

```json
"relPath": "artists/Andreas_Segovia.jpg"
```

Path relative to the directory that was scanned.

Use `/` as the path separator in the JSON index regardless of operating system.

This is the canonical location of the image.

### `fileName`

```json
"fileName": "Andreas_Segovia.jpg"
```

Original filename including extension.

### `nameTokens`

```json
"nameTokens": ["Andreas", "Segovia"]
```

Tokens extracted from the filename without its extension.

Typical separators:

- whitespace
- `_`
- `-`
- `.`

Example:

```text
Andreas_Segovia-portrait.1935.jpg
```

becomes approximately:

```json
["Andreas", "Segovia", "portrait", "1935"]
```

These tokens are primarily useful for person-name matching.

### `nameTokensRu`

```json
"nameTokensRu": ["Андрес", "Сеговия"]
```

Russian localized/transliterated equivalents of meaningful filename tokens.

For personal names, this means **name localization/transliteration**, not literal word-for-word translation.

Example:

```text
Johann Sebastian Bach
→
Иоганн Себастьян Бах
```

---

# 5. Image geometry

```json
"image": {
  "width": 1200,
  "height": 1600,
  "aspect": "3:4",
  "orientation": "portrait",
  "mp": 1.9
}
```

### `width` / `height`

Original image dimensions in pixels.

These describe the source file, not a resized copy used for AI inference.

### `aspect`

Approximate conventional aspect ratio, for example:

```text
1:1
4:3
3:4
3:2
2:3
5:4
4:5
16:9
9:16
```

It is a coarse classification. Exact geometry is always available from `width / height`.

### `orientation`

Enum:

```text
portrait
landscape
square
```

For biography avatars, `portrait` should normally be preferred.

Recommended order:

```text
portrait > square > landscape
```

unless the application has a different crop strategy.

### `mp`

Megapixels:

```text
width × height / 1,000,000
```

Example:

```text
1200 × 1600 = 1.92 MP
```

stored approximately as:

```json
"mp": 1.9
```

Use this as a quality/resolution signal, not as an identity signal.

---

# 6. Color information

```json
"color": {
  "mode": "color",
  "count": 1832
}
```

### `mode`

Enum:

```text
color
bw
unknown
```

Default avatar preference:

```text
color > bw > unknown
```

This preference should be relatively weak compared with identity and face-related signals.

A good black-and-white portrait of the correct person must rank above a weak or uncertain color candidate.

### `count`

Estimated number of colors.

This can help identify:

- very limited-palette graphics;
- scans;
- line art;
- monochrome material;
- photographs.

Do not treat raw color count as a strong ranking factor because JPEG compression and antialiasing can produce many technically distinct colors.

---

# 7. Embedded textual metadata

```json
"meta": {
  "title": "Andrés Segovia",
  "description": "Portrait of guitarist Andrés Segovia",
  "keywords": ["Andrés Segovia", "guitarist"],
  "people": ["Andrés Segovia"],
  "ocr": ""
}
```

### `title`

Image title extracted from metadata.

Useful for person-name matching.

### `description`

Human-readable image description.

Useful for detecting names and semantic context.

### `keywords`

Metadata keywords/tags.

### `people`

Names of people explicitly identified as appearing in the image.

This is normally the strongest textual identity signal.

Example:

```json
"people": ["Andrés Segovia"]
```

### `ocr`

Text detected visually inside the image.

OCR can help identify:

- captions;
- names;
- labels;
- book/page scans;
- posters;
- sheet music.

OCR is useful but should normally have lower trust than explicit embedded metadata.

---

# 8. AI block

```json
"ai": {
  "class": "portrait",
  "confidence": 0.98,
  "faceCount": 1,
  "faceCoverage": 0.31
}
```

The `ai` block describes the visual suitability of the image.

It should be one of the most important parts of avatar selection.

## `ai.class`

Enum:

```text
portrait
upper_body
full_body
group
sheet_music
other
unknown
```

Meaning:

| Class | Meaning | Typical avatar value |
|---|---|---|
| `portrait` | face/head/shoulders or close portrait | excellent |
| `upper_body` | one main person, torso/upper body visible | very good |
| `full_body` | one main person shown almost completely | acceptable |
| `group` | multiple people are visually present | poor |
| `sheet_music` | sheet music / score | reject |
| `other` | another type of image | poor |
| `unknown` | uncertain classification | poor/uncertain |

Default semantic preference:

```text
portrait > upper_body > full_body >>> group > other > unknown >>> sheet_music
```

`sheet_music` should normally be rejected as an avatar candidate.

---

## `ai.confidence`

```json
"confidence": 0.98
```

Confidence in the semantic classification, in the range:

```text
0.0 ... 1.0
```

Use confidence to adjust trust in `ai.class`, not as an independent avatar-quality score.

For example:

```text
portrait @ 0.99
```

is more trustworthy than:

```text
portrait @ 0.51
```

Do not let a small confidence difference override much stronger evidence such as exact identity match or correct face count.

---

## `ai.faceCount`

Number of detected faces.

For biography/avatar selection, this is a very strong signal.

### Highest-priority visual candidates

Prefer images where:

```text
ai.class ∈ {portrait, upper_body, full_body}
AND
ai.faceCount == 1
```

Examples:

```json
{"class":"portrait","faceCount":1}
{"class":"upper_body","faceCount":1}
{"class":"full_body","faceCount":1}
```

These are the normal Tier-1 avatar candidates.

Within this tier:

```text
portrait > upper_body > full_body
```

---

## Lower-priority visual candidates

### Tier 2A

```text
ai.class ∈ {portrait, upper_body, full_body}
AND
ai.faceCount == 0
```

These remain plausible because:

- the face detector may have failed;
- the image may be old, blurred, small, stylized, damaged or rotated;
- the semantic classifier may still correctly recognize a person.

Do not reject them automatically.

### Tier 2B

```text
ai.class ∈ {group, other, unknown}
AND
ai.faceCount == 1
```

These are also plausible but suspicious.

Examples:

- classifier incorrectly called a portrait `other`;
- a nominal group image effectively contains one visible/detected person;
- AI classification is uncertain.

They should normally rank below:

```text
portrait/upper_body/full_body + faceCount == 1
```

### Lower tiers

```text
faceCount > 1
```

strongly reduces avatar suitability.

A group image may still be usable only when no better candidate exists and cropping is possible.

```text
sheet_music
```

should normally be rejected regardless of face-related noise.

---

# 9. `ai.faceCoverage`

```json
"faceCoverage": 0.31
```

Defined approximately as:

```text
area of largest detected face / total image area
```

Range:

```text
0.0 ... 1.0
```

It indicates how much of the image is occupied by the main face.

This is especially useful when several candidates have:

```text
faceCount == 1
```

### Recommended use

If several candidates are otherwise comparable, prefer the one with larger useful `faceCoverage`.

Example:

```text
candidate A: faceCount=1, faceCoverage=0.08
candidate B: faceCount=1, faceCoverage=0.27
candidate C: faceCount=1, faceCoverage=0.41
```

Normally:

```text
C > B > A
```

because the subject is more prominent.

However, do not blindly maximize the value. Extremely high coverage may mean an excessively tight crop.

Treat it as a ranking feature, not an absolute rule.

---

# 10. Identity matching

Avatar suitability must only be evaluated after determining whether the image is likely to belong to the requested person.

For a requested person, for example:

```text
Andrés Segovia
Андрес Сеговия
```

normalize the query into comparable name tokens and aliases.

Example:

```json
{
  "latin": ["andres", "segovia"],
  "ru": ["андрес", "сеговия"]
}
```

Recommended preprocessing:

1. Unicode normalize.
2. Case-fold/lowercase.
3. Normalize whitespace.
4. Ignore punctuation where appropriate.
5. Optionally normalize diacritics for secondary matching:
   `Andrés` → `Andres`.
6. Compare complete names and token sets.
7. Avoid weak substring matching that can create false positives.

---

# 11. Recommended identity signal priority

Approximate order from strongest to weakest:

```text
meta.people exact/alias match
    >
full filename/nameTokens person-name match
    >
nameTokensRu match
    >
meta.title match
    >
meta.keywords match
    >
meta.description match
    >
OCR match
```

Possible conceptual weights:

```text
meta.people       100
nameTokens         90
nameTokensRu       90
meta.title         75
meta.keywords      55
meta.description   40
ocr                25
```

These are starting values only and should be tuned against real data.

Do not use visual suitability to compensate for a weak identity match.

A beautiful portrait of the wrong person is not a valid candidate.

---

# 12. Recommended selection pipeline

Use a staged pipeline rather than one flat score.

## Stage 1 — Find identity candidates

For each indexed image:

```text
identityScore = match(personName, aliases, image textual/name fields)
```

Discard or strongly penalize records with insufficient identity evidence.

This produces:

```text
identityCandidates[]
```

---

## Stage 2 — Hard exclusions

Normally reject:

```text
ai.class == sheet_music
```

Also strongly reject obviously unusable records such as:

```text
very tiny image
corrupt image
non-person semantic class with no identity evidence
```

---

## Stage 3 — Visual priority tiers

### Tier 1 — preferred

```text
class ∈ {portrait, upper_body, full_body}
AND
faceCount == 1
```

Sub-order:

```text
portrait
>
upper_body
>
full_body
```

### Tier 2 — acceptable fallback

Either:

```text
class ∈ {portrait, upper_body, full_body}
AND
faceCount == 0
```

or:

```text
class ∈ {group, other, unknown}
AND
faceCount == 1
```

### Tier 3 — weak fallback

Examples:

```text
class == group AND faceCount > 1
class ∈ {other, unknown} AND faceCount == 0
```

### Reject / near-reject

```text
class == sheet_music
```

unless a very unusual application explicitly asks for it.

---

# 13. Ranking inside the same tier

Once candidates have the same identity quality and visual tier, rank them approximately by:

```text
1. stronger identity match
2. preferred AI class
3. faceCount == 1
4. useful higher faceCoverage
5. portrait orientation
6. higher AI confidence
7. color image
8. adequate resolution / megapixels
9. square orientation
10. landscape orientation
```

Recommended default orientation preference:

```text
portrait > square > landscape
```

Recommended color preference:

```text
color > bw > unknown
```

But both are secondary signals.

---

# 14. Suggested lexicographic ranking key

For predictable behavior, a lexicographic tuple is often safer than putting everything into one arbitrary weighted score.

Conceptually:

```python
rank = (
    identity_tier,
    visual_tier,
    class_rank,
    face_rank,
    face_coverage_rank,
    orientation_rank,
    confidence_rank,
    color_rank,
    resolution_rank,
)
```

Sort descending where higher values mean better candidates.

Example class ranking:

```text
portrait    = 5
upper_body  = 4
full_body   = 3
group       = 2
other       = 1
unknown     = 0
sheet_music = -100
```

Example face ranking:

```text
faceCount == 1  -> 3
faceCount == 0  -> 1
faceCount > 1   -> 0
```

This makes important priorities explicit and prevents a minor advantage such as higher megapixels from overriding the fact that another image contains exactly one detected face.

---

# 15. Optional hybrid score

A weighted score can be used *inside a priority tier*:

```text
avatarScore =
    classScore
  + faceScore
  + faceCoverageScore
  + orientationScore
  + colorScore
  + resolutionScore
  + confidenceAdjustment
```

Illustrative values:

```text
class:
  portrait      +40
  upper_body    +32
  full_body     +22
  group          +2
  other           0
  unknown         0
  sheet_music   -100

face:
  faceCount == 1    +40
  faceCount == 0      0
  faceCount > 1     -25

orientation:
  portrait       +8
  square         +4
  landscape       0

color:
  color          +4
  bw              0
  unknown        -1
```

`faceCoverage` can add a bounded bonus, for example up to `+15`.

Resolution should also have a bounded contribution so a 20 MP group photo cannot beat a 2 MP clean portrait only because of its size.

---

# 16. Important ranking principle

Use:

```text
IDENTITY
    first
VISUAL PERSON SUITABILITY
    second
PRESENTATION QUALITY
    third
```

In other words:

```text
Is this the correct person?
    ↓
Is this image visually appropriate for one-person biography use?
    ↓
Which of the remaining images looks technically preferable?
```

Do not reverse this order.

---

# 17. Practical example

Requested person:

```text
Andrés Segovia
```

Candidates:

### A

```json
{
  "nameTokens": ["Andreas", "Segovia"],
  "ai": {
    "class": "portrait",
    "confidence": 0.97,
    "faceCount": 1,
    "faceCoverage": 0.35
  },
  "image": {
    "orientation": "portrait",
    "mp": 1.8
  },
  "color": {
    "mode": "bw"
  }
}
```

### B

```json
{
  "nameTokens": ["Andreas", "Segovia"],
  "ai": {
    "class": "group",
    "confidence": 0.94,
    "faceCount": 5,
    "faceCoverage": 0.07
  },
  "image": {
    "orientation": "landscape",
    "mp": 8.2
  },
  "color": {
    "mode": "color"
  }
}
```

### C

```json
{
  "nameTokens": ["Andreas", "Segovia"],
  "ai": {
    "class": "upper_body",
    "confidence": 0.91,
    "faceCount": 1,
    "faceCoverage": 0.24
  },
  "image": {
    "orientation": "portrait",
    "mp": 3.0
  },
  "color": {
    "mode": "color"
  }
}
```

Recommended ordering:

```text
A or C
>>
B
```

A has the strongest portrait semantics and larger face coverage.

C may win if the application applies a meaningful preference for color and resolution.

B should remain far below both despite having the highest megapixel count and being color, because it is a group photograph containing multiple faces.

---

# 18. Missing values

Consumers must tolerate partially missing optional data.

Examples:

```json
"meta": {}
```

or:

```json
"ai": {
  "class": "unknown",
  "confidence": 0.0,
  "faceCount": 0,
  "faceCoverage": 0.0
}
```

Missing or unknown values should reduce confidence, not cause the parser to fail.

Do not interpret:

```text
faceCount == 0
```

as proof that no person is present. It means only that no face was detected.

Likewise:

```text
ai.class == unknown
```

means insufficient classification confidence, not necessarily that the image is unusable.

---

# 19. Parser recommendations

A consumer should:

1. Validate `schemaVersion`.
2. Iterate through `images`.
3. Normalize the requested person's name and known aliases.
4. Compute identity evidence from `nameTokens`, `nameTokensRu`, and `meta`.
5. Reject candidates with insufficient identity evidence.
6. Apply hard semantic exclusions.
7. Assign a visual priority tier using `ai.class` and `faceCount`.
8. Rank within the tier using `faceCoverage`, orientation, confidence, color and resolution.
9. Resolve `relPath` against the configured image root.
10. Return the highest-ranked candidate, optionally including the next few candidates and their scores for diagnostics.

The selection algorithm should ideally expose its score/reasoning in machine-readable form during development, for example:

```json
{
  "relPath": "artists/Andreas_Segovia.jpg",
  "identityScore": 0.96,
  "visualTier": 1,
  "avatarScore": 91.2,
  "reasons": [
    "filename-name-match",
    "portrait",
    "single-face",
    "portrait-orientation",
    "high-face-coverage"
  ]
}
```

These diagnostics need not be stored in the permanent image index; they can be generated by the selection algorithm.

---

# 20. Summary

The index stores **facts and extracted features**, while the consuming application performs the final ranking.

The recommended hierarchy is:

```text
person-name / metadata identity match
    ↓
portrait | upper_body | full_body + faceCount == 1
    ↓
larger useful faceCoverage
    ↓
portrait orientation
    ↓
higher classification confidence
    ↓
color preference
    ↓
adequate source resolution
```

The strongest default avatar pattern is therefore:

```json
{
  "ai": {
    "class": "portrait",
    "faceCount": 1,
    "faceCoverage": "high/useful"
  },
  "image": {
    "orientation": "portrait"
  },
  "color": {
    "mode": "color"
  }
}
```

provided that the image first has strong evidence of belonging to the requested person.
