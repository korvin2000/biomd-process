/**
 * Latin/ASCII renderings of a name.
 *
 * `Catalog-Index.md` §5.3 wants `title` in plain ASCII, and §10 wants aliases
 * that let a Latin query reach an entry whose every localized name is in another
 * script. Two different jobs, two different mechanisms:
 *
 *  - **Folding** (`Andrés` → `Andres`) is lossless-enough and universal: strip
 *    the combining marks, then hand-map the letters that carry no mark (`ø`,
 *    `ł`, `ß`, `æ`). Every Latin-script language is covered by one table.
 *  - **Transliteration** (`Сеговия` → `Segoviya`) is per-script and lossy, and
 *    only Cyrillic is worth doing here. The guide is explicit that CJK has no
 *    algorithmic path back to a romanization — 塞戈维亚 will never yield
 *    "Segovia" — so that case is left to the extraction hint, which comes from a
 *    model that has actually read the article.
 */

/** Latin letters that survive `NFD` intact and therefore need naming. */
const LATIN_FOLD: Record<string, string> = {
  æ: 'ae',
  Æ: 'Ae',
  œ: 'oe',
  Œ: 'Oe',
  ø: 'o',
  Ø: 'O',
  ð: 'd',
  Ð: 'D',
  þ: 'th',
  Þ: 'Th',
  ß: 'ss',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ħ: 'h',
  Ħ: 'H',
  ı: 'i',
  ŋ: 'n',
  Ŋ: 'N',
};

/** Practical Russian romanization: readable, not a reversible standard. */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Ukrainian / Belarusian letters a guitar catalogue will meet sooner or later.
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'w',
};

const LATIN = /\p{Script=Latin}/u;
const CYRILLIC_SCRIPT = /\p{Script=Cyrillic}/u;

/** True when every letter is Latin — the test `title` has to pass. */
export function isLatinScript(value: string): boolean {
  const letters = [...value].filter((char) => /\p{L}/u.test(char));
  return letters.length > 0 && letters.every((char) => LATIN.test(char));
}

export function hasCyrillic(value: string): boolean {
  return CYRILLIC_SCRIPT.test(value);
}

/** `Andrés Segovia` → `Andres Segovia`. Non-Latin characters are left alone. */
export function foldToAscii(value: string): string {
  const mapped = [...value].map((char) => LATIN_FOLD[char] ?? char).join('');
  return mapped.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

/** `Андрес Сеговия` → `Andres Segoviya`. Returns `undefined` for other scripts. */
export function romanizeCyrillic(value: string): string | undefined {
  if (!hasCyrillic(value)) return undefined;

  let result = '';
  for (const char of value) {
    const lower = char.toLowerCase();
    const mapped = CYRILLIC[lower];

    if (mapped === undefined) {
      result += char;
      continue;
    }
    if (mapped === '') continue;
    result += char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return foldToAscii(result).replace(/\s+/g, ' ').trim() || undefined;
}

/**
 * Best ASCII rendering available, or `undefined` when there is none.
 *
 * Order matters: a name already written in Latin script only needs folding, and
 * folding is far more faithful than transliterating a translation of it.
 */
export function toAscii(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const folded = foldToAscii(trimmed);
  if (isAscii(folded)) return folded;

  return romanizeCyrillic(trimmed);
}

export function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(value);
}
