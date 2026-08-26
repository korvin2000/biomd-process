/**
 * Which fragments of a document are actually *in* the language being translated.
 *
 * A Russian article about a guitarist is not written entirely in Russian. It
 * quotes the Latin spelling of every name it introduces, it lists a discography
 * in the language the records were pressed in, and it prints work titles as
 * their composers wrote them:
 *
 * ```
 * Plays Domenico Scarlatti · Allegro vivo · The Fall of Birds
 * 'Amadeus' Guitar Duo · Fantasia · Joaquin Turina – Sevillana
 * ```
 *
 * None of that should be translated — `external/`'s own rule for names and
 * titles says so, and every translation prompt in this repo repeats it. But an
 * instruction is a request, obeyed on most calls and not on all of them, and it
 * is paid for on every fragment either way. A fragment with no letter of the
 * source script in it cannot be a sentence of the source language, so the
 * cheapest and most reliable way to leave it alone is not to send it.
 *
 * On this corpus that is 11% of the fragments — and every one of the 33 in
 * `input/ru` is a work title, a composer's name, an album, or a link label.
 *
 * A *mixed* fragment is a different matter and is always sent: "Играл на гитаре
 * Pedro Maldonado" is Russian prose with a Spanish name in it, and the name's
 * survival is the prompt's business.
 */

/** An alphabet, and the languages written in it. */
interface Script {
  /** How the alphabet is named in a note a person has to read. */
  name: string;
  /** Matches when the text contains at least one letter of this alphabet. */
  letters: RegExp;
}

const HAS_LETTER = /\p{L}/u;

const CYRILLIC: Script = { name: 'Cyrillic', letters: /\p{Script=Cyrillic}/u };
const GREEK: Script = { name: 'Greek', letters: /\p{Script=Greek}/u };
const HEBREW: Script = { name: 'Hebrew', letters: /\p{Script=Hebrew}/u };
const ARABIC: Script = { name: 'Arabic', letters: /\p{Script=Arabic}/u };
/** CJK and Korean: any of their scripts counts, and kana is script evidence too. */
const CJK: Script = {
  name: 'CJK',
  letters: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
};

/** Language code (before any region suffix) to the alphabet its prose is written in. */
const SCRIPTS: ReadonlyMap<string, Script> = new Map([
  ...['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'ky', 'mn', 'tg'].map((code) => [code, CYRILLIC] as const),
  ...['el'].map((code) => [code, GREEK] as const),
  ...['he', 'yi'].map((code) => [code, HEBREW] as const),
  ...['ar', 'fa', 'ur', 'ps'].map((code) => [code, ARABIC] as const),
  ...['ja', 'zh', 'ko'].map((code) => [code, CJK] as const),
]);

/**
 * Is this fragment worth sending to a translator?
 *
 * `false` means "copy it through unchanged": it has no words at all, or it has
 * no words *in the source language's script*.
 *
 * A language written in the Latin alphabet gets the weaker test — there is no
 * way to tell an English sentence from an Italian work title by script alone,
 * and refusing to translate every Latin fragment of an English article would
 * refuse the article. The rule pays off exactly where the corpus needs it, on a
 * source language whose alphabet is its own.
 */
export function isTranslatable(text: string, sourceLanguage: string): boolean {
  if (!HAS_LETTER.test(text)) return false;

  const script = scriptOfLanguage(sourceLanguage);
  if (!script) return true;
  return script.letters.test(text);
}

/** The alphabet a language is written in, or `undefined` when that alphabet is Latin. */
function scriptOfLanguage(language: string): Script | undefined {
  return SCRIPTS.get(language.toLowerCase().split(/[-_]/)[0] ?? '');
}

/** True when the language has an alphabet of its own, so the rule can apply at all. */
export function hasOwnScript(language: string): boolean {
  return scriptOfLanguage(language) !== undefined;
}

/** A single word built out of two alphabets — always a machine's mistake. */
const MIXED_WORD = /[\p{Script=Cyrillic}\p{Script=Greek}][\p{Script=Latin}]|[\p{Script=Latin}][\p{Script=Cyrillic}\p{Script=Greek}]/u;

/**
 * Words that changed alphabet halfway through.
 *
 * `"Авель Карлеvaro"` is what `abiton`'s dossier published for Abel Carlevaro:
 * a model transliterating a name it half-recognized, stopping in the middle. A
 * *sentence* mixing alphabets is ordinary here — "Играл на гитаре Pedro
 * Maldonado" is Russian prose with a Spanish name in it — so the test is per
 * word, and within one word the mixture is never intentional. No human writes
 * it, no source contains it, and it survives into the published catalogue as a
 * name no reader can search for.
 *
 * Reported rather than repaired: which half is right is not knowable from here,
 * and dropping the field would lose a teacher the article really does name.
 * `biomd report --notes alphabets` lists them.
 */
export function mixedScriptWords(text: string): string[] {
  return [...text.matchAll(/\p{L}[\p{L}\p{M}'’-]*/gu)]
    .map((match) => match[0])
    .filter((word) => MIXED_WORD.test(word));
}

/**
 * The mixed-alphabet words a *translation* introduced.
 *
 * Extraction reads an article and can only pass a mixture through; translation
 * and localization romanize, which is where the mixture is actually made —
 * `Синчук` → `Sinчuk`, `ХВАН` → `KHВAN`, `Карлеваро` → `Карлеvaro`. The letter
 * left behind is either one with no single-letter counterpart (`ч`, `щ`, `ж`)
 * or one shaped like a Latin letter it is not (`В`, `Р`, `Н`).
 *
 * Subtracting the source is what makes the note honest: a corpus typo is the
 * article's, and reporting it here as the model's would send someone looking in
 * the wrong place. Reported and never repaired, for the reason
 * `mixedScriptWords` gives — which half is right is not knowable from here.
 */
export function introducedMixedScriptWords(source: string, output: string): string[] {
  const inherited = new Set(mixedScriptWords(source));
  return [...new Set(mixedScriptWords(output))].filter((word) => !inherited.has(word));
}

/** The one-line account of a half-transliterated word, as the run notes phrase it. */
export function halfTransliteratedNote(words: readonly string[]): string {
  const subject = words.length === 1 ? 'A word changed' : `${words.length} words changed`;
  return `${subject} alphabet halfway through: ${words.join(', ')}. Half-transliterated by the model; check it.`;
}

/**
 * A value the model was paid for and did not answer.
 *
 * `isTranslatable` decides what is worth *sending*; this decides whether what
 * came back is an answer. They are the same script test pointed in opposite
 * directions, and the second one is needed because a fragment can be sent,
 * charged for, and returned exactly as it went out.
 *
 * Two conditions have to hold before either test below means anything:
 *
 *  - the **source** language has an alphabet of its own, so "unchanged" is
 *    visible at all — nothing here can tell an English sentence from an
 *    untranslated Italian one;
 *  - the **target** language is not written in that same alphabet, or the test
 *    would reject every correct ru → uk translation ever made.
 *
 * ## Byte-identical to what was sent
 *
 * The precise test, and the one that catches an untranslated *sentence*. A
 * fragment with no words in the source language never reaches a model —
 * `isTranslatable` answers it locally — so a fragment that does contain them
 * and comes back character for character was not worked on. Measured: eight
 * lines of one Spanish edition, whole paragraphs of Russian, every one of them
 * byte-identical to its source line.
 *
 * ## Every letter still in the source alphabet
 *
 * The blunter test, and the one that catches an untranslated *name*. Nineteen
 * values across twenty documents came back this way, twelve of them a person's
 * name standing alone as a heading or a photo caption — which is how a Spanish
 * page ends up with `# Наталья Липницкая` at the top of it. It catches a
 * near-copy the first test misses, at the price of only seeing values with no
 * other alphabet in them at all.
 *
 * One letter from anywhere else acquits the second test: `Наталья Липницкая
 * (Natalia Lipnitskaya)` is a gloss, which is a judgement about style, and
 * `Дебюсси` → `Debussи` is a half-transliteration, which
 * {@link introducedMixedScriptWords} owns. Digits and punctuation are not
 * letters and never decide anything, so `Наталья Липницкая (2003)` is judged on
 * its two words and not on its year.
 *
 * Both are safe enough to reject a batch over — meaning to hand it to the next
 * model in the chain — because a correct answer fails neither. It is rendered,
 * or romanized and glossed, and either way it differs from what was sent.
 */
export function untranslatedReason(
  source: string,
  translation: string,
  sourceLanguage: string,
  targetLanguage: string,
): string | undefined {
  const script = scriptOfLanguage(sourceLanguage);
  if (!script) return undefined;
  if (scriptOfLanguage(targetLanguage) === script) return undefined;

  if (script.letters.test(source) && source.trim() === translation.trim()) {
    return `came back exactly as it was sent ("${clip(translation)}") — nothing was translated`;
  }

  if (!script.letters.test(translation)) return undefined;
  for (const letter of translation.match(/\p{L}/gu) ?? []) {
    if (!script.letters.test(letter)) return undefined;
  }
  return (
    `every letter is still ${script.name} ("${clip(translation)}") — the value came back untranslated; ` +
    'a name is rendered into the target alphabet, never copied'
  );
}

/** Enough of a value to recognize it in a note, without pasting a paragraph into one. */
function clip(text: string, limit = 60): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
