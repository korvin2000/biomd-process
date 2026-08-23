/**
 * A model-free regression check for a translated corpus.
 *
 * `translation/IMPROVE_SUGGESTIONS.md` asks for a fixed suite of "hard metrics —
 * should be near 100%", separate from any judgement about the prose. This is
 * that suite. Everything it reports is a fact about two files:
 *
 *   - **leak**            source-script characters left in translatable prose
 *   - **structure**       the Markdown skeleton differs from the source's
 *   - **lost targets**    a link or image URL that did not survive
 *   - **hardBreakΔ**      trailing-backslash line breaks gained or lost
 *   - **emphasisΔ**       `**`/`==`/`~~` markers gained or lost
 *   - **dashΔ**           `–` silently swapped for `—` or the reverse
 *   - **punct-in-quote**  a comma pulled inside a closing quotation mark
 *   - **titlesKept**      Latin-script quoted titles the source already printed
 *
 * The last three are invisible to the structure guard and were each a real
 * regression: a substituted dash reflows every line of an interview, and a
 * replaced title loses the name a record was released under.
 *
 * Usage:
 *
 *   npm run score -- input/ru out
 *   npm run score -- .scratch/tcorpus/ru .scratch/tout/seg-new .scratch/tout/seg-old
 *
 * The first argument is the source directory; each one after it is an output
 * directory holding the translated editions (a `<lang>/` subdirectory is found
 * automatically, or point at it directly).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { imagePattern, linkPattern } from '../src/documents/markdown/inline.js';
import { compareSkeletons } from '../src/documents/markdown/skeleton.js';
import { extractTextSpans } from '../src/documents/markdown/textSpans.js';

/** Characters of a source script that must not survive into the translation. */
const SOURCE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}]/gu;

interface Score {
  doc: string;
  ok: boolean;
  leakChars: number;
  leakSamples: string[];
  structure: string;
  lostTargets: string[];
  hardBreaks: [number, number];
  emphasis: [number, number];
  dashes: [number, number, number, number];
  commaInside: number;
  keptTitles: [number, number];
  lostTitles: string[];
}

function targetsOf(text: string): string[] {
  return [
    ...[...text.matchAll(linkPattern())].map((match) => `link:${match[2]}`),
    ...[...text.matchAll(imagePattern())].map((match) => `img:${match[2]}`),
  ];
}

const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

function score(sourceFile: string, targetFile: string, doc: string): Score {
  const source = readFileSync(sourceFile, 'utf8');
  const target = readFileSync(targetFile, 'utf8');

  // Leakage is measured over translatable spans only: a Russian word inside a
  // `src:` path or a fenced tablature block is not a translation failure.
  const prose = extractTextSpans(target)
    .map((span) => span.text)
    .join('\n');
  const leakChars = count(prose, SOURCE_SCRIPT);
  const leakSamples = [
    ...new Set((prose.match(/[\p{Script=Cyrillic}][\p{Script=Cyrillic}\s-]{2,40}/gu) ?? []).map((s) => s.trim())),
  ].slice(0, 4);

  const comparison = compareSkeletons(source, target, { mode: 'strict' });
  const present = new Set(targetsOf(target));
  const lost = targetsOf(source).filter((t) => !present.has(t));

  // A quoted title the source already prints in Latin script is the name a
  // record was released under, and must come back untouched.
  const latinTitles = [...new Set(source.match(/"[A-Za-z][^"\n]{4,60}"/g) ?? [])];
  const kept = latinTitles.filter((title) => target.includes(title));

  return {
    doc,
    ok: comparison.ok && leakChars === 0 && lost.length === 0,
    leakChars,
    leakSamples,
    structure: comparison.ok ? 'ok' : comparison.differences.slice(0, 2).join('; '),
    lostTargets: lost.slice(0, 3),
    hardBreaks: [count(source, /\\\n/g), count(target, /\\\n/g)],
    emphasis: [count(source, /\*\*|==|~~/g), count(target, /\*\*|==|~~/g)],
    dashes: [count(source, /–/g), count(target, /–/g), count(source, /—/g), count(target, /—/g)],
    commaInside: count(target, /[,.;:]"/g) - count(source, /[,.;:]»/g),
    keptTitles: [kept.length, latinTitles.length],
    lostTitles: latinTitles.filter((t) => !target.includes(t)).slice(0, 3),
  };
}

/** A directory of `*.bio.md`, or the one language subdirectory that holds them. */
function editionDir(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  if (readdirSync(dir).some((f) => f.endsWith('.bio.md'))) return dir;
  const sub = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory() && readdirSync(path).some((f) => f.endsWith('.bio.md')));
  return sub[0];
}

const [sourceArg, ...variants] = process.argv.slice(2);
if (!sourceArg || variants.length === 0) {
  process.stderr.write('usage: npm run score -- <sourceDir> <variantDir…>\n');
  process.exit(2);
}
const sourceDir = editionDir(sourceArg);
if (!sourceDir) {
  process.stderr.write(`no *.bio.md found under ${sourceArg}\n`);
  process.exit(2);
}

const pad = (text: string, width: number): string => text.padEnd(width).slice(0, width);
const table: Record<string, Score[]> = {};

for (const variant of variants) {
  const dir = editionDir(variant);
  if (!dir) {
    process.stdout.write(`${variant}: no translated editions found\n`);
    continue;
  }
  table[variant] = readdirSync(dir)
    .filter((file) => file.endsWith('.bio.md') && existsSync(join(sourceDir, file)))
    .map((file) => score(join(sourceDir, file), join(dir, file), file.replace('.bio.md', '')));
}

const docs = [...new Set(Object.values(table).flat().map((s) => s.doc))].sort();

process.stdout.write('\nPer document\n');
process.stdout.write(pad('DOC', 16) + variants.map((v) => pad(v.split(/[\\/]/).pop() ?? v, 20)).join('') + '\n');
for (const doc of docs) {
  let row = pad(doc, 16);
  for (const variant of variants) {
    const s = table[variant]?.find((x) => x.doc === doc);
    if (!s) {
      row += pad('— not produced', 20);
      continue;
    }
    const problems = [s.leakChars > 0 ? `leak ${s.leakChars}` : '', s.structure === 'ok' ? '' : 'STRUCTURE', s.lostTargets.length ? 'LOST URL' : '']
      .filter(Boolean)
      .join(' ');
    row += pad(problems || 'ok', 20);
  }
  process.stdout.write(row + '\n');
}

process.stdout.write('\nTotals\n');
for (const variant of variants) {
  const rows = table[variant] ?? [];
  const sum = (pick: (s: Score) => number): number => rows.reduce((n, s) => n + pick(s), 0);
  process.stdout.write(
    `${pad(variant.split(/[\\/]/).pop() ?? variant, 20)}` +
      ` docs=${rows.length}` +
      `  clean=${rows.filter((s) => s.ok).length}` +
      `  leak=${sum((s) => s.leakChars)}` +
      `  hardBreakΔ=${sum((s) => Math.abs(s.hardBreaks[0] - s.hardBreaks[1]))}` +
      `  emphasisΔ=${sum((s) => Math.abs(s.emphasis[0] - s.emphasis[1]))}` +
      `  dashΔ=${sum((s) => Math.abs(s.dashes[0] - s.dashes[1]) + Math.abs(s.dashes[2] - s.dashes[3]))}` +
      `  punct-in-quote=${sum((s) => Math.max(0, s.commaInside))}` +
      `  titlesKept=${sum((s) => s.keptTitles[0])}/${sum((s) => s.keptTitles[1])}\n`,
  );
}

const detail = (label: string, pick: (s: Score) => string[]): void => {
  const lines = variants.flatMap((variant) =>
    (table[variant] ?? []).filter((s) => pick(s).length > 0).map((s) => `${pad(variant.split(/[\\/]/).pop() ?? variant, 18)}${pad(s.doc, 16)}${pick(s).join(' | ').slice(0, 150)}`),
  );
  if (lines.length === 0) return;
  process.stdout.write(`\n${label}\n${lines.join('\n')}\n`);
};

detail('Source-script text left in the translation', (s) => s.leakSamples);
detail('Latin titles the translation replaced', (s) => s.lostTitles);
detail('Link or image targets that did not survive', (s) => s.lostTargets);
