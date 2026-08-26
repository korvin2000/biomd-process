# Prompts — the rules that had to be got right, not merely stated

Templates live in `prompts/<task>/{system.md,user.md}` (Eta — conventions, whitespace and ASI traps
in [prompts/README.md](../../prompts/README.md)), mapped by `prompts.templates` so a directory can
be renamed without touching code.

**Both files hash into `promptVersion`, which feeds the task fingerprint** — so editing a template
is a tracked change that correctly invalidates already-completed work, and correctly starts a fresh
translation-memory namespace.

Inspect without spending anything:

```bash
npm run biomd -- prompts show translateSegments --messages
```

`translateSegments` / `localize` templates answer a `{hash: text}` table and **must return exactly
the same keys**. Instructions inviting merging, splitting or reordering fragments surface as
validation failures and retries.

---

## Names and titles: the four rules, in precedence order

The corpus contains every combination, and the wrong rule quietly destroys a fact.

**1. A name or title already printed in another language *is* that name.**
These discographies are bilingual — `"Craft Of Emptiness" (Магия Пустоты)` gives the released title
first and a Russian gloss after it. Keep the printed form and translate the bracket.

> A rule saying only "romanize a source-script title" produced
> `"Magiya Pustoty. Muzikal'naya Meditatsiya" (Magic of Emptiness…)` and threw the album's real name
> away — on **eleven of `krylov`'s thirteen records**.

**2. A personal or place name is rendered, never translated** — from the **source spelling**, never
from the subject's nationality.

> A Russian article about a Ukrainian guitarist spells his name in Russian, and a model reading
> `Александр Викторович ТАВРОВСКИЙ (род. … Переяслав-Хмельницкий, Киевская обл., Украина)` is very
> willing to answer `Oleksandr Viktorovych TAVROVSKYI` — a form no source in the corpus contains,
> arrived at by romanizing through a language that is nowhere in the request. Plausible, and wrong.
>
> The rule that invited it was the sensible-sounding "where a person is known by a Latin spelling,
> that spelling is the answer": **nationality is not the same thing as publication.** Every
> translation and localization prompt now states the constraint with the three examples that matter
> (`Александр` → `Alexander`, never `Oleksandr`), and the exception stays exactly where it was — a
> Latin spelling the person is actually published under still wins.

**3. A title appearing only in the source script is romanized and glossed once.**
`"Загадки на святки"` → `"Zagadki na svyatki" (Riddles for the Yuletide)`. Ordinary bibliographic
practice (CMOS 11.9), and what the reader needs: the romanized form is what a search finds, the
gloss is what a reader understands.

It applies to an ensemble too — `"Консонанс"` → `"Konsonans" (Consonance)` — and **not** to a name
that merely describes, where "the state philharmonic" is words rather than a title.

**4. The gloss never nests and never splits a link.**
`["Название"](⟦1⟧)` → `["Nazvanie"](⟦1⟧) (The Title)`, because `[label] (gloss) (⟦1⟧)` is what a
model does otherwise — every character preserved, the mask token present, and the link destroyed.
`displacedMasks` catches that deterministically, so it becomes one repaired fragment instead of a
failed document.

## Punctuation is a mark, not a style

`«Золотые гитары мира», проходившем` → `"Golden Guitars of the World", held` — **the comma stands
where the source put it.**

Saying only "use the target language's punctuation" invites the American convention of pulling the
comma inside the quote, which is a different sentence. The same rule keeps `–` from becoming `—`:
measured over thirteen articles, stating it explicitly cut dash substitutions from **97 to 35**.

## Two traps around the templates themselves

**A bad rendering is cached.** `useTranslationMemory: persistent` re-serves it verbatim until the
prompt version changes. Editing the prompt *does* start a fresh namespace — the stale file just
lingers in `run.memoryDir`.

**A template must name a language once.** `<%= it.sourceLanguageName || it.sourceLanguage %>` is an
Eta fallback that can never fire, because `languageName()` already falls back to the code — but it
*reads* like two languages being offered, in a file whose entire job is to be unambiguous.

## A prompt for one model

`prompts/<task>/<modelId>/<the same file name>` shadows the file beside it, for
that model and nobody else. Convention only — nothing in the config names it.
Full mechanics: [prompts/README.md](../../prompts/README.md).

The measurement that produced it. Twenty documents from `manual/`, stratified
across the complexity range, translated ru → es by `minimax-m3` alone:

| | clean | source script left in | requests | retries | failed | dashΔ | titles kept |
|---|---|---|---|---|---|---|---|
| shared prompt, no check | 15/20 | 273 chars | — | — | — | 45 | 21/21 |
| shared prompt + the check | 17/19 | 874 chars | 28 | 3 | 1 | 39 | 15/16 |
| **+ this model's override** | **20/20** | **0** | **21** | **0** | **0** | 50 | 20/21 |
| `deepseek`, shared prompt | 20/20 | 0 | — | — | — | 18 | 21/21 |

**One run per row, so read the columns differently.** The leak column moved 273
→ 0 and held at 0 across two different drafts of the override; that is the
effect. `dashΔ` (45 → 39 → 50) and `titles kept` (21/21 → 15/16 → 20/21) move by
about that much between two runs of *the same* arm, so nothing in them is
attributable yet. The same discipline as
[adaptive-routing.md](adaptive-routing.md): state a stochastic measurement as a
distribution, and do not fit to one sample.

The middle row's 874 characters are one document where the model returned whole
paragraphs verbatim — a worse roll of the same model, not something the check
caused. That row is what motivated the identity test described below.

## What belongs in an override, and what does not

The first draft of `minimax-m3/segments-system.md` opened by telling the model
that nineteen of its values had come back in the source alphabet. That is an
audit finding addressed to a person: the model cannot act on it, cannot check
it, and pays for it on every call. Two more things went the same way — a heading
saying "for this model only", which leaks a routing arrangement the model has no
use for, and "read your own values back", an open-ended self-review where a
single named check was wanted.

**The reasoning belongs in an Eta comment**, which never reaches the model:
`<% /* … */ %>`. (Eta 3 has no `<%# … %>` form — it is a syntax error.) The
override now carries its own why in one, and what the model reads is a rule, two
examples and one check.

`deepseek` scores 0 of 20 on the shared prompt, which is why the correction
belongs to one model rather than to the task. What the override says is not a
new rule — every rule it needs was already in the shared prompt and was already
being followed *inside sentences*. It resolves a **conflict between two of
them**: output rule 1 says a fragment you cannot translate comes back unchanged,
rule 5 says a name is rendered, and a fragment that is *nothing but* a name
reads as covered by both. `minimax-m3` resolved it the wrong way twelve times in
twenty documents, always on a heading or a caption, never in prose.

> Look for the contradiction before adding a rule. A model that follows a rule
> in one place and not another is usually not ignoring it.

## Checks, because an instruction is a request

A prompt cannot be relied on, and three of these rules now have a check behind
them that costs nothing when the model complies:

| Caught | Where | On failure |
|---|---|---|
| a value byte-identical to the fragment sent | `untranslatedReason` | re-asked, then handed to the next model |
| a value whose every letter is still in the source alphabet | `untranslatedReason` | re-asked, then handed to the next model |
| a word that changed alphabet halfway through | `introducedMixedScriptWords` | re-asked; **published with a note** if it survives |

The split in the last column is the whole design. The first two are *wrong* and
another model demonstrably gets them right, so reaching that model is worth
failing the call for. The third is *worse*, not wrong — which half of `Debussи`
is right is not knowable from here — so it is only ever re-asked, and a document
is never lost over it.

Both halves of `untranslatedReason` were needed, and a live run is what proved
it. The alphabet test catches a name and misses a sentence: eight lines of
Russian prose reached one Spanish edition, every one of them carrying a Latin
word — a competition, an album, a composer — that acquitted it. The identity
test catches those exactly, because a fragment with no source-language words in
it is answered locally and never sent at all.

## What the prompt is *not* for

The poems in `garcia_lorca.bio.md` are translated equally well by every prompt version tested,
because getting them translated **at all** was a span-extraction fix, not a prompt fix.

> Before assuming a translation defect is a prompt defect, check whether the text reached the model.
> `extractTextSpans` plus a Cyrillic count over the result answers that for nothing.

## Measuring a prompt change

The translation regression suite is model-free and separate from `vitest`:

```bash
npm run score -- input/ru out
```

It reports the invariants a structure guard cannot see — source-script text left in the prose, a
substituted dash, punctuation pulled inside a quotation mark, a Latin title the translation replaced
— and is what any prompt change should be measured against **before and after**.

The measured A/B behind the current prompts is in
[docs/findings-analysis.md](../findings-analysis.md). Superseded prompt versions are kept under
`prompts/translation/experiments/` for comparison.
