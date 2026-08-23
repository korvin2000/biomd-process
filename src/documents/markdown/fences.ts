/**
 * What is inside a fenced block.
 *
 * The whole pipeline assumed the answer was "code": `extractTextSpans` skips a
 * fence entirely and `markdownSkeleton` records only its extent. That is right
 * for a program and wrong for this corpus, which uses a bare ``` fence as a
 * *verse* container — `garcia_lorca.bio.md` carries eleven of them and every one
 * is a Russian poem. Measured on that document, **44% of its Russian text was
 * never sent to a translator**, came back in Russian, and no check anywhere
 * noticed: the skeleton ignores fenced content, so the article passed the
 * structure guard while half of it was untranslated.
 *
 * Fencing is therefore not evidence of anything on its own. What separates the
 * two cases is what the block contains, and the corpus makes that easy: not one
 * fence in it carries an info string, and the non-prose blocks that do appear
 * are guitar tablature, which looks nothing like a sentence.
 *
 * The classifier is deliberately conservative in the direction that cannot lose
 * data. Reading verse as code leaves a poem untranslated — silent, and only
 * visible to someone who reads the published article. Reading code as verse
 * sends it to a model, which is visible immediately and costs a few tokens.
 */

/** Info strings that name a machine language: never prose, whatever is in them. */
const CODE_LANGUAGES = new Set([
  'abc',
  'bash',
  'c',
  'cpp',
  'cs',
  'css',
  'diff',
  'go',
  'html',
  'ini',
  'java',
  'javascript',
  'js',
  'json',
  'jsonc',
  'kotlin',
  'ly',
  'lilypond',
  'lua',
  'make',
  'md',
  'markdown',
  'php',
  'powershell',
  'ps1',
  'python',
  'py',
  'ruby',
  'rb',
  'rust',
  'rs',
  'sh',
  'shell',
  'sql',
  'svg',
  'swift',
  'tab',
  'tablature',
  'toml',
  'ts',
  'tsx',
  'typescript',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

/** Info strings that say "this is language, not machinery". */
const PROSE_LANGUAGES = new Set(['poem', 'poetry', 'verse', 'lyrics', 'song', 'quote', 'quotation', 'prose']);

// `text`, `txt` and `plain` are in neither list on purpose. They mean "do not
// syntax-highlight this", which asserts nothing about what is inside, so they
// fall through to the content test — where a poem reads as words and a
// tablature block reads as bars and dashes.

/** A tablature line: staff letters, fret numbers and dashes, and little else. */
const TABLATURE = /^\s*[A-Ga-ge]?[b#]?\s*[|:]/;

export type FenceContent = 'code' | 'prose';

/**
 * How a fenced block should be treated.
 *
 * @param info the fence's info string (`ru` in ```` ```ru ````), possibly empty
 * @param lines the block's content lines, without the fences
 */
export function classifyFence(info: string, lines: readonly string[]): FenceContent {
  const tag = info.trim().toLowerCase().split(/[\s,{]/)[0] ?? '';
  if (tag && CODE_LANGUAGES.has(tag)) return 'code';
  if (tag && PROSE_LANGUAGES.has(tag)) return 'prose';

  const content = lines.filter((line) => line.trim() !== '');
  if (content.length === 0) return 'code';

  // Tablature and ASCII diagrams: a majority of lines built from bars, dashes
  // and fret numbers. `e|---0---2---|` is not a sentence in any language.
  const tabLines = content.filter((line) => TABLATURE.test(line) || isRuled(line)).length;
  if (tabLines * 2 >= content.length) return 'code';

  // Prose needs letters, and enough of them that the block is words rather than
  // punctuation. Verse runs short per line, so this is measured over the block —
  // and the block can be one word: a poem's title gets a fence of its own here
  // (`MEMENTO`, `ГИТАРА`), so a length floor would file the title as code and
  // publish it untranslated above its translated poem.
  const text = content.join('\n');
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 3) return 'code';
  return letters / text.length >= 0.45 ? 'prose' : 'code';
}

/** A line that is mostly rule characters — `---|---|`, `=====`, `. . . .`. */
function isRuled(line: string): boolean {
  const body = line.trim();
  if (body.length < 4) return false;
  const ruled = (body.match(/[-=_|.·~^]/g) ?? []).length;
  return ruled / body.length >= 0.5;
}
