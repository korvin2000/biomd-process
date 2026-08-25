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
