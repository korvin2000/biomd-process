---
paths:
  - "prompts/**/*.md"
---

# Editing a prompt template

Full account: [docs/ref/prompts.md](../../docs/ref/prompts.md). Eta conventions:
[prompts/README.md](../../prompts/README.md).

- **Editing either file of a task invalidates every fingerprint** (both hash into `promptVersion`)
  and re-plans the corpus. It also starts a fresh translation-memory namespace — which is the only
  way a cached bad rendering stops being re-served.
- **`prompts/<task>/<modelId>/<same file name>` is that model's copy of that file.** Convention,
  named nowhere in the config. It is handed the rendered shared text as `sharedSystem` /
  `sharedUser`, and the intended shape is `<%= it.sharedSystem %>` plus the correction — forking a
  hundred measured rules to change one is how two versions of a rule end up disagreeing. Overrides
  hash into the task version too, so adding one re-plans the task for **every** model.
- **A template is read by a model, so the reasoning goes in `<% /* … */ %>`.** (Eta 3 has no
  `<%# … %>`.) An audit finding — "nineteen values came back in the source alphabet" — is addressed
  to a person: unactionable, uncheckable, and billed on every call. The model reads a rule, an
  example and a named check; the why sits in the comment above them.
- **Look for the contradiction before adding a rule.** `minimax-m3` left a name in Cyrillic twelve
  times in twenty documents, always as a whole heading or caption and never inside a sentence: not
  a missing rule but two rules that both seemed to cover a fragment that is *only* a name.
- **An instruction is a request; a check is a check.** A value byte-identical to what was sent, or
  with every letter still in the source alphabet, is re-asked and then handed to the next model
  (`untranslatedReason`). A word that changed alphabet halfway through is only ever re-asked and is
  published with a note — which half is right is not knowable, and a document is worth more.
- **The four naming rules, in precedence order**: a name already printed in another language *is*
  that name → a personal or place name is rendered from the **source spelling**, never from
  nationality → a source-script-only title is romanized *and* glossed once → the gloss never nests
  and never splits a link.
- **Punctuation is a mark, not a style.** The comma stands where the source put it; do not invite
  the American convention of pulling it inside the quote. Stating this explicitly cut dash
  substitutions from 97 to 35 over thirteen articles.
- **A `{hash: text}` template must return exactly the same keys.** Anything inviting merging,
  splitting or reordering surfaces as validation failures and retries.
- **Stable instructions and volatile payload are separate user messages.** The stable message owns
  the Responses cache breakpoint; never move document-specific content before it.
- **Name a language once.** `<%= it.sourceLanguageName || it.sourceLanguage %>` is a fallback that
  can never fire and reads like two languages being offered.
- **Check the text reached the model before blaming the prompt.** `extractTextSpans` plus a script
  count answers that for nothing — the untranslated poems were a span-extraction bug.
- **Measure before and after**: `npm run score -- input/ru out`.
