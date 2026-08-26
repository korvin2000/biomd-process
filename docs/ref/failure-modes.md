# Failure modes — the ways a clean-looking run is wrong

Every entry here was found on a real run that reported success. None of it is discoverable
from the code before it bites you; that is the whole reason this file exists.

**The organising principle:** a pool is a fallback chain, so its purpose is to make one
target dying survivable — which also makes a first choice that never works *invisible*.
The run completes, every document is produced, and the only trace is the bill.

## Before any real run over the corpus

```bash
npm run biomd -- models --probe
```

Sends one tiny completion to every declared target and reports who answered; exits 1 on any
failure. Reading the endpoint's `/v1/models` is **not** a substitute — `cx/gpt-5.6-luna` was
listed the whole time it was rejecting every completion.

Afterwards, read the run summary's **target health table** for any target that served **0** of
its requests, and `grep ' ! ' progress.log` for the incident list.

## Endpoint faults

| Fault | Symptom | Fix / state |
|---|---|---|
| **`omniroute` coalesces overlapping buffered requests** | the second request receives the first's completion verbatim; measured 5 rounds of 5. A 2000 ms stagger changes nothing — what collides is the *overlap*, not the arrival, so `minRequestSpacingMs` alone is not a fix | **`stream: true` on the endpoint** (schema field; `collectStream` reassembles). Correct 15/15 with streaming on. `maxConcurrent: 3` is only safe *because* of it — **if streaming is ever turned off, `maxConcurrent` must go back to 1** |
| **`omniroute` caches responses** | an identical body returns in ~15–50 ms with no model attribution | add a nonce when probing by hand, or a re-run looks implausibly fast and a "pass" is a cache hit |
| **`omniroute` rejects `reasoning: {enabled: false}`** | `Unknown parameter` | use `dialect: reasoning_effort`, which it accepts and which genuinely suppresses reasoning |
| **`omniroute` intermittently 404s** `No active credentials for provider: omniroute` | for a model present in its own `/v1/models` listing, working again minutes later. Once took `or-search` out mid-run, opened the breaker, and sent 37 web searches to the paid `or-osearch` with no line saying so | this is the failure `--probe` and the target-health table exist to make audible |
| **`openai/*:online` models reject `response_format`** (measured on `openai/gpt-5.6-luna:online`) | `400 Web Search cannot be used with JSON mode`; `websearch` sends `json_object` on every call, so the paid fallback failed 100% of the time | the transport now sends `response_format` only to a target that **declares** the matching capability (`json_object` / `json_schema`). Take `json_object` off `or-osearch` and it works — the prompt asks for JSON and every parser here strips a fence |
| **`google/gemini-3.7-flash` has no web search** | asked for Gérard Abiton's date of birth it returned `18.06.1954`, confidence 0.95, sourced to a `data.bnf.fr` URL that resolves to a record for somebody else and carries no date at all, while French Wikipedia states only the year. In the same twelve-document test it "found" more fields than any real search model, because inventing is faster than searching | keep `web_search` off its capability list. `tasks.websearch.requireWebSearchCapability` is the gate, and **it is only as honest as the capability list** |
| **a `web_search` capability on ordinary Chat did not enable search** | `search-std` fabricated a current GitHub SHA and cited the exact API URL it had not opened; `search-mx` and `search-safe` admitted live access was unavailable | fixed: OmniRoute search targets use Responses with a required hosted tool; no completed `web_search_call` means validation failure, and model-authored URLs must occur in provider source evidence |

The crosstalk damage is worth understanding rather than just preventing: on 2026-08-23 Aguado's
date of death and Spanish Wikipedia URL were written into Anido's and Amigo's dossiers at
confidence 0.98, citing a page about the wrong man. `translate` catches crosstalk incidentally —
content-hash keys stop matching, surfacing as `response_format`. **`websearch` cannot**: the
answer is well-formed sourced prose about a real guitarist, just the wrong one. Runtime tool evidence
now rejects a non-search answer, and `requireVerifiedSource` rejects a citation the provider never
opened — but neither catches the *right* page about the *wrong* person, and
**`biomd.config.yaml` still sets `onDateConflict: prefer-precise`**, which lets a sharper crosstalk
date overwrite a correct coarser one. The schema default is `report`; the live file overrides it.
Changing that overrides published data, so it is a decision, not a cleanup.

## Questions that should never be asked

**`deathplace` for a living person.** `findGaps` used to ask whenever the field was empty — which
is every living guitarist in the corpus. "Where did Roberto Aussel die?" is a question a search
model answers (*Сен-Эрблен, Франция*, confidence 0.95), and it was published into the dossier of
a man who is alive. `died` had a liveness gate from the start; `deathplace` now shares it on both
sides — not asked unless a death is on record or the liveness check is running, and dropped by
`filterLiveness` when the answer does not explicitly say `dead`.

**Anything personal about a collective.** A quartet has no date of birth, and a search model asked
for one *answers* — the founding year dressed as a birthday, a member's home town as the
ensemble's. When `resolveEnsemble` reads a collective in the title, `born`/`died`/`birthplace`/
`deathplace` leave the question list and the liveness rule never fires.

## Silent-drop bugs, all fixed, all worth not reintroducing

| Bug | Why nothing noticed |
|---|---|
| **`ObserverHub` dropped `onTargetDown`** | `GatewayObserver`'s methods are optional and the hub is what the gateway talks to. Every mechanism built on the event — the metrics counter, the zero-request call-out, the `llm.target_down` journal record — was dead from the day it was written |
| **`AppLogger` spread caller fields *over* the record envelope** | a caller passing `{message: …}` (the fallback observer did, carrying the provider's own text) replaced the line saying *what happened* with the one saying *why*. The JSONL recorded `"404 No active credentials…"` and never named the target that died. **The envelope is written last** |
| **`catalog` and `websearch` skipped forever** | both *update* a file that exists from the end of run 1, and `run.skipExistingOutputs` reads existence as "done". A catalogue that could never pick up a new article; a web search that ran once per corpus. Neither failed — they stopped happening. `TaskSeed.mergesOutput` exempts them |
| **retired tasks counted as done on resume** | only `resume` and `existing-output` mean the artifact is on disk. Counting `dependency-failed` made the next resume skip it forever: one failed translation produced a catalogue that could never be built again. **Add a skip reason to `isTaskDone` only if it means the file exists** |
| **a corpus-scope dependency retired the whole catalogue** | one document failing one translation cost 200 good entries their rows. `catalog`'s five dependencies are now *ordering only* (`optional: true`); it reads disk, not the plan |
| **44% of `garcia_lorca.bio.md` left untranslated** | the article sets poems in a bare ``` fence and `extractTextSpans` skipped every fence. The skeleton guard ignores fenced content, so it passed every check with half of it still in Russian |
| **five private copies of the link regex** | they agreed until a label held an escaped bracket. `[\[ \* \]](#1)` — this corpus's footnote marker — was matched by none: `textSpans` sent the anchor to the model in the one mode whose premise is that a URL never reaches one, and `skeleton` miscounted, so `albert → en` failed the strict guard and published no English edition |
| **`bitetti → en`, `blackmore → de`, `belousov → es` died on structural drift** | a fragment answered as `1. Estudio guitarra…` is an ordered list item once spliced back. Invisible to the `{hash: text}` contract, caught only by the whole-document guard — after every call was paid for |
| **nine calls re-asking for a right answer** | `27 марта 2002 г.` → `27. März 2002` is correct *and* starts a line with an ordered-list marker. `escapeBlockMarker` takes the backslash at splice time instead of asking. Same document: four calls, no retries |
| **five Spanish editions carried Russian headings** | `minimax-m3` obeyed the naming rules inside sentences and returned a name standing alone as a heading or a caption unchanged — twelve times in twenty documents. Every structural check passed: the key was answered, the skeleton matched, the placeholders survived. Only a human reading the page would see `# Наталья Липницкая` at the top of it. Now `untranslatedReason` rejects a value whose every letter is still in the source alphabet, and `prompts/translation/minimax-m3/` corrects the rule conflict that caused it |
| **eleven editions of one article could not be produced** | `**Danсa dos Tons**` is a Portuguese album title with one Cyrillic `с` mistyped into it. That letter satisfied `isTranslatable`, so the title was sent; every model handed it back as the work title it is, which satisfied the byte-identical half of `untranslatedReason`, so every answer was rejected — down the whole pool, then a second task attempt, in each of eleven target languages. 39 `response_format` errors, 30 retries, 22 fallbacks, no article. Two fixes: evidence of the source language is now a **word** (`withoutMixedWords`), and on the last task attempt the check **reports** rather than rejects (`untranslatedNote`) |
| **whole Russian paragraphs survived the alphabet check** | eight lines of one edition, each carrying a Latin word — a competition, an album, a composer — which acquitted it. Caught by testing for a value **byte-identical to the fragment sent**: a fragment with no source-language words in it is answered locally and never sent, so identity can only mean nothing was done |
| **`Авель Карлеvaro`** | a model transliterating Abel Carlevaro's name and stopping halfway. A *sentence* mixing alphabets is ordinary here; a *word* never is. `mixedScriptWords` reports it (`biomd report --notes alphabets`) rather than repairing — which half is right is not knowable from here |
| **`aleksandrov` published no dates at all** | the article gives both calendars in one line — `род. 11(23).12.1818, ум. 24.12.1884 / 05.01.1885` — and neither form parsed. `parseDate` now reduces a bracketed or slashed alternative to the form printed first |
| **`Oleksandr Viktorovych TAVROVSKYI`** | a Russian article about a Ukrainian guitarist, romanized through a language nowhere in the request. Plausible, and in no source in the corpus. **Romanize from the source language, never from nationality** |
| **eleven of `krylov`'s thirteen album titles destroyed** | a rule saying only "romanize a source-script title" turned `"Craft Of Emptiness" (Магия Пустоты)` into `"Magiya Pustoty…" (Magic of Emptiness…)` — throwing away the name the record was released under |
| **Armik's birth year stayed wrong through clean runs** | article says `1950`, the web says `25.07.1949`. The truthful answer arrived *contradicting* the record rather than refining it, the old rule dropped it, and nothing said a question had been asked and unanswered |
| **`output.onExisting: skip` billed the whole corpus** | it is a promise the *writer* makes, so a task whose output existed ran, was billed, then had its answer discarded with a warning. Ruinous after a prompt edit, which invalidates every fingerprint. Now read at **plan** time |
| **`biomd -c f.yaml config check` processed the whole corpus** | parsed as `run` with two ignorable extra arguments. `run` now sets `allowExcessArguments(false)`. **Options go after the subcommand** |

## Traps that are still live

- **A bad rendering is cached.** `useTranslationMemory: persistent` re-serves it verbatim until
  `promptVersion` changes — editing the prompt does start a fresh namespace, but the stale file
  lingers in `run.memoryDir`.
- **A retry must not be served the previous attempt's answers** — they are what failed. Without
  `ExecutionContext.attempt`, every fragment is a memory hit, no model is called, and attempt 2
  rebuilds the identical broken document for free.
- **`tasks.catalog.refresh` is empty by default and `upsert` only fills empty members.** Change
  `tasks.portrait.assetPrefix` and every row keeps the old `img` forever, silently. Switch
  `refresh` on for the run that fixes it, then switch it back off.
- **A truncated first rung turns "the document is silent" into a claim the run cannot support**,
  and hands `websearch` a question the article had already answered. This is why a harvest
  declares `coverage: 'whole'`.
- **Two dates of the same precision that disagree are two claims about a person.** Preferring one
  by provenance alone publishes a coin toss — precision is the only discriminator
  `onDateConflict: prefer-precise` acts on.
