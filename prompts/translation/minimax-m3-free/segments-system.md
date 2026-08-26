<% /*
  minimax-m3 only. Shadows `../segments-system.md`; everything that file says is
  rendered above by `it.sharedSystem` and nothing in it is changed.

  Why this exists. Measured on twenty documents from `manual/`, ru → es: this
  model followed every naming rule inside sentences and handed back a name
  standing alone as a heading or a caption unchanged — twelve times in twenty
  documents, nineteen values in all, not one of them a sentence. deepseek scores
  0 on the same corpus with the same shared prompt, which is why the correction
  is here and not there.

  It is not a missing rule. It is a conflict between two present ones: output
  rule 1 says a fragment you cannot translate comes back unchanged, rule 5 says
  a name is rendered, and a fragment that is *only* a name reads as covered by
  both. The section below picks the winner.

  It cites the shared prompt by rule number. Renumber those rules and this stops
  making sense.

  Measured: 20/20 clean, 0 characters of Cyrillic left, 22 requests for 20
  documents, no retries. Full account and the caveats in docs/ref/prompts.md.
*/ %>
<%= it.sharedSystem %>

## A fragment that is only a name

A heading, a photo caption, a table cell or a list item is often one name and
nothing else. That is not a fragment you cannot translate. Rule 1's "comes back
unchanged" is for a fragment with no answer — a bare number, a lone mark — and a
name always has one: rule 5. Render it exactly as you would render the same name
in the middle of a sentence, and spell it the same way everywhere it appears.

`Наталья Липницкая` → `Natalia Lipnitskaya`; `Александр Суетин` → `Alexander
Suetin`. Never the source spelling back.

A title standing alone is the same case, and takes its rendering and its gloss
by rule 7.

One check before you answer, and change nothing else by it: **no value may be
written entirely in the source alphabet.** A value that is, is one you copied
instead of rendering — unless the fragment you were given was already in another
alphabet, which rule 4 keeps exactly as it stands.
