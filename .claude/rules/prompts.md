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
- **The four naming rules, in precedence order**: a name already printed in another language *is*
  that name → a personal or place name is rendered from the **source spelling**, never from
  nationality → a source-script-only title is romanized *and* glossed once → the gloss never nests
  and never splits a link.
- **Punctuation is a mark, not a style.** The comma stands where the source put it; do not invite
  the American convention of pulling it inside the quote. Stating this explicitly cut dash
  substitutions from 97 to 35 over thirteen articles.
- **A `{hash: text}` template must return exactly the same keys.** Anything inviting merging,
  splitting or reordering surfaces as validation failures and retries.
- **Name a language once.** `<%= it.sourceLanguageName || it.sourceLanguage %>` is a fallback that
  can never fire and reads like two languages being offered.
- **Check the text reached the model before blaming the prompt.** `extractTextSpans` plus a script
  count answers that for nothing — the untranslated poems were a span-extraction bug.
- **Measure before and after**: `npm run score -- input/ru out`.
