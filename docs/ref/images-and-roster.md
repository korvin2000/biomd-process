# The two extra input sources — `src/images` and `src/roster`

Both are read, never written. Both own an input format the way `src/domain` owns the output one,
and both hand their answer to a pipeline that is only wiring.

---

# `src/images` — the portrait matcher

Format spec: [images/image-index-spec.md](../../images/image-index-spec.md). Module table:
[source-map.md](source-map.md#srcimages--the-portrait-matcher-llm-free).

It depends on `domain` (romanization, asset paths, the collective vocabulary) and `shared`, and on
nothing else — no config, no filesystem beyond one JSON read, no LLM. `PortraitPipeline` assembles
what is known about the person and writes the answer to a hint file; everything else lives here.

## What the real index actually contains

The specification's own weight table assumes the opposite of each of these, which is why the code
looks the way it does:

| Observation | Consequence in the code |
|---|---|
| `meta.people`, `meta.title` and `ocr` are **empty in every record**; `meta.description` holds an XMP dump and `meta.keywords` EXIF rationals | the junk guard in `ImageIndexStore`, and identity resting on the **path** |
| `photo/<letter>/` is the initial of the subject the file is **filed under** — `photo/b/buek_segovia.jpg` is Buek's photograph, an excellent picture of Segovia and a wrong avatar for him | that single signal is worth **−0.30** |
| a directory can be a person (`almeida_laurindo/4lalm07.jpg`, no usable filename tokens) **or** a discography (`paco_de_lucia/siroco.jpg`) | a directory match scores below a filename match, and an unexplained proper noun in the filename is penalized |
| `pena_cd05_1993.jpg` is a record sleeve that classifies as `portrait`, one face, high confidence | release markers are excluded by default. Note `\b` never fires before `_cd` — `_` is a word character |
| `nameTokensRu` is a list of **alternative spellings** (`сеговия|сеговиа|зеговия`), not additional people | only **Latin** filename tokens can name a second subject |
| `ai.confidence` is low across the board (median **0.54** for `portrait`) and images are small (median **0.04 MP**) | confidence modulates trust in the class rather than gating; the resolution term is log-scaled and bounded |

## Three rules that must survive any edit

1. **Identity first, always** (§16). Picture quality never compensates for a weak name match — the
   acceptance threshold is applied to the **identity score alone**.
2. **The key is lexicographic, not a weighted sum** (§14), with identity banded to 0.1 and
   `faceCoverage` ahead of the hybrid score. Otherwise colour and megapixels quietly outvote "you
   can actually see the subject's face".
3. **Below the threshold, write nothing.** See
   [pipelines §portrait](pipelines.md#portrait--llm-free).

## The two additions the real corpus forced

Of the thirteen articles in `input/ru`, **nine are collectives**. Before these, the matcher found a
usable portrait for **three** of the thirteen — and one of the three was a photograph of one member
of a duo. It now finds **ten**; the three it declines are the three the archive genuinely has
nothing for (two with no file at all, one with nothing but scans of his editions).

**The subject shape** — `src/images/subject.ts`. Every threshold in `suitability.ts` was calibrated
for a soloist: one face ideal, two a penalty, `group` nearly disqualifying, and a coverage window
assuming a head fills the frame. All of it is exactly wrong for a quartet, whose correct photograph
has four small faces in it — `photo/t/trio_ural.jpg` scored identity **0.97** and was then discarded
as visual tier 3. So the expectation is an **input**: `faceFit` rates the count against it, the
class tables invert (`group` high, `portrait` low — a `portrait` of an ensemble is a picture of one
member), the coverage window divides by the number of people, and the orientation preference flips,
because a line-up is a wide photograph.

> **The expectation is an input, not an inference from the picture.** `faceCount` decides how well
> a candidate fits the subject; it never decides *what the subject is*. That comes from the title,
> through `resolveEnsemble`, and a wrong answer there is visible in the hint file's
> `searched.subject` rather than buried in a score.

**The article's own images** — `NameQuery.articleImages`. Whoever wrote the entry chose the picture
that opens it, which is the closest thing to a curated answer the corpus holds — and the only
evidence that survives a filename the name index cannot reach: `photo/k/kag.jpg` is the Classical
Guitarists' Ensemble, and no amount of matching turns `classicalag` into `kag`.

The **first** image scores **0.95**; a later one scores **0.86**, deliberately *below* the
acceptance threshold, because a biography's later pictures are its teachers, its colleagues and its
record sleeves as often as they are its subject — one of those wins only with a name match behind
it. The images come from the same scanner that harvests the gallery, via `HarvestResult.imageTargets`,
which unlike `photos` does not require a caption.

## Not attempted, deliberately

Telling two people with the same name apart. `photo/w/john_williams/` cannot be resolved by filename
analysis, and a heuristic that guessed would be wrong **silently**. The answer there is a curated
`img` in `index.json`, which this pipeline never overwrites.

## Tuning

`tasks.portrait` thresholds are tuned through the CLI, which prints the whole ranking with its
reasoning:

```bash
npm run biomd -- portrait "Trio Ural" --top 20 --min-identity 0.4 --json
```

---

# `src/roster` — the name roster

`NameRosterStore` reads `data/names.json` once per run and hands out a slug-keyed index; `entry.ts`
decides the two questions the file itself does not answer.

**What it is:** `{fullname, surname, forename, patronymic?, url, aliases?}` per article — **739
records against a corpus of about a thousand**, written in Russian and in the catalogue's own order
(`Носкова Е. Н.`).

**What it knows that no reading of one article can:** the family name behind a byline of initials,
the pseudonym (`Инсаров` for a man the catalogue files under `Черножуков`), the spelling variant a
reader will actually type (`Баццотти` beside `Баззотти`), and a collective's own title.

**What it also is: wrong in places.** `authors.bio.md` is filed as surname `"Музыкальные
пристрастия –"`, forename `"музыка"`, patronymic `"гитариста"` — a page title chopped into three
columns — and `di_meola.bio.md` has the given and family names swapped. So `isNamePart` refuses a
column whose words are not capitalized words, initials or particles, and such a record contributes
its `fullName` and its aliases (still usable as search text) and **no name components at all**.

## Three consumers, one rule between them: fill a gap, never overwrite a fact

| Consumer | Takes | Note |
|---|---|---|
| `extract` | `forename` / `surname` via `mergeDossier` | adds the roster's keys to the **satisfied** set, so a partial answer is not rejected over a name this side already has. `roster.reportConflicts` notes a disagreement instead of resolving it — the article is what the entry is about |
| `portrait` | every spelling as `extraNames` | for a collective this is often the only searchable name there is |
| `catalog` | the hand-authored aliases — the best in the system, because a person wrote them | **for the roster's own language only** |

`roster.language` is what keeps that last rule honest, and the mechanism is the shape of the value:
`catalog` hands `displayNamesOf` a map keyed by language holding exactly **one** entry, so an
English name index cannot pick the aliases up even by accident.

## Configuration

`roster:` sits at the config root rather than under a task, because `extract`, `portrait` and
`catalog` all read it: `file`, `language`, `fillMetadata`, `aliases`, `nameHints`, `reportConflicts`.

**An empty `file` turns it off entirely, which is the default.** A configured file that is missing
is an **error** — a mistyped path and a deliberately absent roster must not look the same.
