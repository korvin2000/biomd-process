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

/** Language codes whose prose is written in Cyrillic. */
const CYRILLIC_LANGUAGES = new Set(['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'ky', 'mn', 'tg']);
const GREEK_LANGUAGES = new Set(['el']);
const HEBREW_LANGUAGES = new Set(['he', 'yi']);
const ARABIC_LANGUAGES = new Set(['ar', 'fa', 'ur', 'ps']);
/** CJK and Korean: any of their scripts counts, and kana is script evidence too. */
const CJK_LANGUAGES = new Set(['ja', 'zh', 'ko']);

const HAS_LETTER = /\p{L}/u;
const HAS_CYRILLIC = /\p{Script=Cyrillic}/u;
const HAS_GREEK = /\p{Script=Greek}/u;
const HAS_HEBREW = /\p{Script=Hebrew}/u;
const HAS_ARABIC = /\p{Script=Arabic}/u;
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

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
  return script.test(text);
}

/** The script test for a language, or `undefined` when it is written in Latin. */
function scriptOfLanguage(language: string): RegExp | undefined {
  const code = language.toLowerCase().split(/[-_]/)[0] ?? '';
  if (CYRILLIC_LANGUAGES.has(code)) return HAS_CYRILLIC;
  if (GREEK_LANGUAGES.has(code)) return HAS_GREEK;
  if (HEBREW_LANGUAGES.has(code)) return HAS_HEBREW;
  if (ARABIC_LANGUAGES.has(code)) return HAS_ARABIC;
  if (CJK_LANGUAGES.has(code)) return HAS_CJK;
  return undefined;
}

/** True when the language has an alphabet of its own, so the rule can apply at all. */
export function hasOwnScript(language: string): boolean {
  return scriptOfLanguage(language) !== undefined;
}
