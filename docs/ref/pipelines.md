# The six pipelines — contracts and conditions

One section each: what it reads, what it returns, what makes it *not* run, and the rule that is
easy to break. Entry points and helper files: [source-map.md](source-map.md#srcpipelines--the-six-tasks).

With every pipeline on, `ru/paco.bio.md` produces:

```
out/ru/paco.bio.json    dossier extracted from the article, completed from the web
out/en/paco.bio.md      translated article
out/en/paco.bio.json    dossier localized into English
out/index.json          catalogue index (incl. the chosen portrait) + index-en.json, index-ru.json
out/.hints/paco.*.json  internal hand-offs: classification, web answers, the portrait choice
```

## `extract`

**Reads** the article. **Writes** `out/<lang>/<slug>.bio.json` plus a classification hint.

- Sends a **flat card of ~22 short keys** with `response_format: json_object` and assembles the
  dossier locally (`buildDossier` owns the shape — see
  [cost-mechanisms §6](cost-mechanisms.md#6-ask-for-facts-not-for-a-schema--srcpipelinesextractionflatfieldsts)).
- Declares `coverage: 'whole'`: a harvest cannot tell an article's silence from an unsent sentence,
  so every partial context attempt is dropped **at plan time**.
- `tasks.extract.onExistingDossier: reuse` (default) re-emits an **authored** `<slug>.bio.json`
  beside the article — normalized and migrated to v2 — for **zero tokens**. `complete` asks only
  for the missing keys. This tool's own previous output deliberately does not count as authored
  (`findSourceDossier`), or the task would re-plan itself every run.
- Merges the roster's `forename`/`surname` through `mergeDossier` **and adds those keys to the
  satisfied set**, so a partial answer is not rejected — and retried, and escalated — over a name
  this side already has.
- Classification (`type`/`gender`/`country`/`title`) goes to `out/.hints/`, never into the dossier
  (`INV-7`).
- **`media` and `documents` are parsed, never asked for** (`harvestMedia`, `src/documents/markdown/media.ts`)
  — zero tokens, and the `target` is the path the article contains rather than one a model retyped.
  `documents` takes every link to another host plus the local links to a printable document; a
  `mailto:` is an action rather than a resource, and a link repeating `metadata.url` is dropped
  because `external/05` §5.4.5 already shows that one as the trailing source row.

## `websearch`

Runs after `extract`, before `localize`/`portrait`/`catalog`, and **rewrites the dossier in place**
(`overwrite: true` on the `metadata` channel). Everything about it is conditional.

- **`findGaps` computes the questions from the dossier.** No gaps → no call, no artifact, zero
  cost. `country` is checked against the `catalogHints` file, since it is not a dossier member.
- **The liveness rule:** born ≥ `tasks.websearch.livenessAgeYears` ago (**78** by default, and a
  year-only birth date is enough) with no `died` turns the absence into a question. The answer
  contract is `status: alive | dead | unknown`, and a date of death is written **only** when the
  answer explicitly says `dead`. Silence is not evidence of death; `filterLiveness` drops a date
  arriving without the status — and drops `deathplace` with it.
- **`parseWebAnswer` refuses far more than it accepts:** every value goes through the same domain
  normalizer as an extraction, a source URL is required (`requireSource`), confidence is a floor,
  and a value contradicting the record is rejected rather than merged.
- **A date is the exception** (`upgradePrecision`), because "contradicts" was hiding a correction. An article saying
  "born about 1950" is sometimes simply wrong, so the truthful answer arrives *contradicting* the
  record instead of refining it. `tasks.websearch.onDateConflict` decides, out loud:

  | Value | Behaviour |
  |---|---|
  | `prefer-precise` (default) | a **strictly more precise** sourced date replaces the coarser one, disagreeing year included — implemented by clearing the recorded value so `mergeDossier` fills the gap in its ordinary way |
  | `report` | the record stands; the candidate goes to `out/.hints/<slug>.web.json` as a `conflicts[]` entry with its source, for a person to settle |
  | `ignore` | dropped with a note. Pre-existing behaviour, kept for reproducibility |

  **Precision is the whole discriminator and has to be.** Two dates of the same precision that
  disagree are two claims about a person; preferring one by provenance publishes a coin toss.
  `sharpensDate` is the weaker sibling of `refinesDate` — "does this carry more information" rather
  than "is this the same fact read more closely" — and nothing in the domain acts on it, because
  deciding a sourced day beats an unsourced year is a policy about whom to trust.

- **The answer is written in the edition's language.** The dossier being completed is
  `out/<lang>/<slug>.bio.json`, so a prose value belongs in *that* language however English the
  sources were; `localize` then carries it into every other edition. The one value that stays in
  the machine tongue is `country`, a token (`VD-COUNTRY`) rather than prose.

  Keeping those straight is not pedantry: telling a model once that countries are ISO 3166-1
  alpha-2 gets `"birthplace": "Melbourne, au"` published as a caption. `normalizePlace` spells a
  bare code back out through `countryName`, and fires only where the code is unambiguous — alpha-3
  always, alpha-2 only when it agrees with the country already established — because a two-letter
  token after a city name is usually *not* a country: `Nashville, TN`, `Adelaide, SA`,
  `Recife, PE`, `Los Angeles, CA`. A country spelled as a word is never touched.

- **A collective is asked nothing personal** — see
  [domain-format](domain-format.md#a-collective-is-a-value-not-a-special-case). `country` and `url`
  are what remain, and they are real questions about an ensemble.
- **The article is never sent.** The wire carries an identity card of ~8 short lines — name, known
  dates, instruments, jobs — plus, optionally, the lead paragraph capped at
  `tasks.websearch.contextChars` (default **600**), which exists solely to tell namesakes apart.
- **Routing requires the `web_search` capability** by default
  (`requireWebSearchCapability`). A model without search answers these questions anyway, fluently
  and without a source. **The gate is only as honest as the capability list** — see
  [failure-modes](failure-modes.md#endpoint-faults).

## `translate`

**Reads** the article. **Writes** `out/<lang>/<slug>.bio.md`, one task per target language.

- `tasks.translate.mode: segments` (default) sends a flat `{contentHash: text}` table and requires
  exactly the same keys back. `document` sends the whole article for when surrounding context
  matters more than cost.
- `StructureGuard` compares `markdownSkeleton` of source and translation. **It ignores fenced
  content** — which is how 44% of one article stayed in Russian without a single check failing.
- Everything about what is sent, masked, repaired, narrowed and escaped is in
  [cost-mechanisms §3–4](cost-mechanisms.md#3-send-prose-not-documents).
- Naming and punctuation rules the prompt must carry: [prompts.md](prompts.md).

## `localize`

**Reads** the dossier `extract`/`websearch` produced. **Writes** `out/<lang>/<slug>.bio.json`.

- `StringTable` sends only the prose members. `dates`, `ranking`, `url`, media targets and unknown
  fields **never leave the machine** — which is what makes them language-invariant *by
  construction*.
- Same `{hash: text}` contract, same repair ladder, same naming rules as `translate`.
- `websearch` is an **optional** dependency: it only ever adds to a dossier that already exists.

## `portrait` — LLM-free

**Reads** `images/artists.json`, the dossier, the roster, and the article's own embedded images.
**Writes** `out/.hints/<slug>.portrait.json`; `catalog` puts the value into `img`.

- No model, no vision call, and the resulting path points at a file that exists.
- All the logic is in `src/images` — see [images-and-roster.md](images-and-roster.md).
- **Below the acceptance threshold it writes nothing.** `external/03` §3.4.9 already specifies the
  fallback (`photos/default-male.svg` etc. by gender), and those synthetic assets are deliberately
  kept out of the gallery, which a value written into `img` would not be.
  `tasks.portrait.onLowConfidence: default` exists for a deployment that disagrees.
- Tune it with the CLI, not by reading scores out of a run:

  ```bash
  npm run biomd -- portrait "Andrés Segovia" --all --json
  ```

## `catalog` — LLM-free, corpus scope

**Reads** the disk — every dossier, every hint file, the existing `index.json`, the roster.
**Writes** `out/index.json` and `out/index-<lang>.json`.

- **Its five dependencies are ordering only** (`optional: true`). It reads disk rather than the
  plan, so a language whose translation failed is simply absent from that entry's editions instead
  of costing the whole corpus its catalogue.
- It **merges**, never rebuilds: ids, row order, unknown members and hand-edits all survive. See
  [domain-format](domain-format.md#the-catalogue-is-updated-never-rebuilt).
- It declares `mergesOutput`, because its file exists from the end of run 1 and says nothing about
  whether this run's work is in it — without that flag `run.skipExistingOutputs` skips it forever.
- The roster's hand-authored aliases are taken **for the roster's own language only**. They are
  variant spellings, not translations, and `Кривенко В.М.` under an English heading is not a
  localization. The mechanism is the shape of the value: `catalog` hands `displayNamesOf` a map
  keyed by language holding exactly one entry, so an English name index cannot pick them up even
  by accident.
