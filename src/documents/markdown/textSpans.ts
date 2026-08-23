import { classifyFence } from './fences.js';
import { linkTargetPattern } from './inline.js';

export type SpanKind = 'heading' | 'paragraph' | 'listItem' | 'quote' | 'tableCell' | 'attribute' | 'verse';

/** What to do with the contents of a fenced block. */
export type FencePolicy = 'auto' | 'code' | 'text';

export interface SpanOptions {
  /**
   * `auto` (default) classifies each fence by what is in it; `code` restores
   * the old behaviour of never translating a fence; `text` translates every
   * one. See {@link classifyFence} for why the default is not `code`.
   */
  fencedBlocks?: FencePolicy;
}

export interface TextSpan {
  /** Absolute character offsets into the source document. */
  start: number;
  end: number;
  /** The translatable text, with link and image targets masked out. */
  text: string;
  kind: SpanKind;
  /** Mask token → the original target it stands for. */
  masks: Map<string, string>;
}

/**
 * Lifts the translatable prose out of a Markdown document.
 *
 * The model is sent text, never markup. Heading hashes, list bullets, table
 * pipes, `:::` containers and their `src:`/`position:`/`size:` attributes,
 * fenced code and every URL stay behind and are spliced back locally.
 *
 * On `examples/ru` that removes ~18% of the bytes before anything is billed
 * (9–26% per document, depending on how much markup it carries) — worthwhile,
 * but the structural guarantee is the bigger prize: a `:::` block that is never
 * sent cannot come back unbalanced, so no retry or model escalation is ever
 * spent repairing one.
 *
 * Inline emphasis stays *inside* the span. Splitting a sentence at every `**`
 * would save a few characters and wreck the translation; models handle inline
 * emphasis correctly and the structure check catches it if they do not.
 */

const FENCE = /^\s*(`{3,}|~{3,})/;
const CONTAINER = /^\s*:::/;
const HEADING = /^(\s*#{1,6}\s+)(.*\S)\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*\S)\s*$/;
const QUOTE = /^(\s*>\s?)(.*\S)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;
const ATTRIBUTE = /^(\s*([A-Za-z][\w-]*)\s*:\s*)(\S.*?)\s*$/;

/** Container attributes whose value is displayed text rather than syntax. */
const PROSE_ATTRIBUTES = new Set(['caption', 'title', 'alt', 'label', 'text']);

export function extractTextSpans(markdown: string, options: SpanOptions = {}): TextSpan[] {
  const policy = options.fencedBlocks ?? 'auto';
  const spans: TextSpan[] = [];
  const lines = markdown.split('\n');
  let offset = 0;
  let fenceMarker: string | undefined;
  let fenceInfo = '';
  /** The open fence's lines, held until its closing marker settles what it is. */
  let fenced: Array<{ line: string; start: number }> = [];

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '';
      if (fenceMarker === undefined) {
        fenceMarker = marker;
        fenceInfo = line.trim().slice(marker.length);
        fenced = [];
      } else if (marker.startsWith(fenceMarker[0] ?? '`')) {
        spans.push(...fenceSpans(fenceInfo, fenced, policy));
        fenceMarker = undefined;
        fenceInfo = '';
        fenced = [];
      }
      continue;
    }
    // A fence's lines are held rather than skipped: whether they are code or a
    // poem is not knowable until the block has been read whole.
    if (fenceMarker !== undefined) {
      fenced.push({ line, start: lineStart });
      continue;
    }
    if (line.trim() === '' || CONTAINER.test(line) || RULE.test(line)) continue;

    const span = spanOf(line, lineStart);
    if (span) spans.push(span);
    else if (TABLE_ROW.test(line) && !TABLE_DIVIDER.test(line)) spans.push(...tableCells(line, lineStart));
  }

  // A fence left open at end of file was never a block; treat it as prose lines.
  if (fenceMarker !== undefined) spans.push(...fenceSpans(fenceInfo, fenced, policy));
  return spans;
}

/**
 * The translatable lines of one fenced block, or none if it holds code.
 *
 * Verse is translated **line for line**: one source line is one span, so the
 * splice puts every translation back on its own line and the poem's shape —
 * which is half of what a poem is — survives without the model being asked to
 * preserve it. A blank line inside a stanza is structure, not text, and is
 * never sent.
 */
function fenceSpans(info: string, fenced: readonly { line: string; start: number }[], policy: FencePolicy): TextSpan[] {
  if (policy === 'code') return [];
  if (policy === 'auto' && classifyFence(info, fenced.map((entry) => entry.line)) === 'code') return [];

  const spans: TextSpan[] = [];
  for (const { line, start } of fenced) {
    if (line.trim() === '') continue;
    const trimmed = line.replace(/\s+$/, '');
    const leading = trimmed.length - trimmed.trimStart().length;
    const text = trimmed.slice(leading);
    if (text) spans.push(makeSpan(trimmed.slice(0, leading), text, start, 'verse'));
  }
  return spans;
}

/**
 * Rebuilds the document with translated spans.
 *
 * Splices from the end so earlier offsets stay valid, and restores every masked
 * target — so URLs come back byte-identical no matter what the model did.
 */
export function applyTextSpans(markdown: string, spans: readonly TextSpan[], translations: ReadonlyMap<string, string>): string {
  let result = markdown;

  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const translated = translations.get(span.text);
    if (translated === undefined) continue;
    result = result.slice(0, span.start) + unmask(translated, span.masks) + result.slice(span.end);
  }
  return result;
}

export const MASK_PATTERN = /⟦\d+⟧/g;

/** Mask tokens present in a span's text. */
export function maskTokens(text: string): string[] {
  return [...text.matchAll(MASK_PATTERN)].map((match) => match[0]);
}

/**
 * Every mask token must survive translation. A dropped token means a lost URL,
 * so this is checked before the translation is accepted rather than after the
 * document has been written.
 */
export function missingMasks(text: string, translation: string): string[] {
  return maskTokens(text).filter((token) => !translation.includes(token));
}

/** A mask sitting where it belongs: as the target of the link it was lifted from. */
const MASK_IN_TARGET = /\]\(\s*(⟦\d+⟧)(?:\s+"[^"]*")?\s*\)/g;

/**
 * Tokens that survived but stopped being a link.
 *
 * A mask is only ever created *inside* `[label](target)`, so in the translation
 * it must still be a target. Present-but-displaced is a distinct failure from
 * missing, and it is the one a model actually makes: asked to gloss a title
 * that happens to be a link's label, `gemma4-31b-local` answered
 * `["Istoriya gitary v litsakh"] (History of the Guitar in Faces) (⟦1⟧)` —
 * every character accounted for, the token present, and the link destroyed. The
 * URL came back as loose parentheses in the middle of a sentence.
 *
 * Checking it here is what makes the failure *repairable*: the batch re-asks
 * for that one fragment instead of the document failing its structure guard
 * after every call has been paid for.
 */
export function displacedMasks(text: string, translation: string): string[] {
  const anchored = new Set([...translation.matchAll(MASK_IN_TARGET)].map((match) => match[1]));
  return maskTokens(text).filter((token) => translation.includes(token) && !anchored.has(token));
}

// ---------------------------------------------------------------------------

function spanOf(line: string, lineStart: number): TextSpan | undefined {
  const heading = HEADING.exec(line);
  if (heading) return makeSpan(heading[1] ?? '', heading[2] ?? '', lineStart, 'heading');

  const quote = QUOTE.exec(line);
  if (quote) return makeSpan(quote[1] ?? '', quote[2] ?? '', lineStart, 'quote');

  const list = LIST.exec(line);
  if (list) return makeSpan(list[1] ?? '', list[2] ?? '', lineStart, 'listItem');

  const attribute = ATTRIBUTE.exec(line);
  if (attribute) {
    // `src:`, `position:`, `size:` are syntax; `caption:` is displayed text.
    if (!PROSE_ATTRIBUTES.has((attribute[2] ?? '').toLowerCase())) return undefined;
    return makeSpan(attribute[1] ?? '', attribute[3] ?? '', lineStart, 'attribute');
  }

  if (TABLE_ROW.test(line)) return undefined;

  const trimmed = line.replace(/\s+$/, '');
  const leading = trimmed.length - trimmed.trimStart().length;
  const text = trimmed.slice(leading);
  return text ? makeSpan(trimmed.slice(0, leading), text, lineStart, 'paragraph') : undefined;
}

function tableCells(line: string, lineStart: number): TextSpan[] {
  const spans: TextSpan[] = [];
  const pattern = /\|([^|\n]+)/g;

  for (const match of line.matchAll(pattern)) {
    const raw = match[1] ?? '';
    const text = raw.trim();
    if (!text) continue;

    const cellStart = (match.index ?? 0) + 1 + raw.indexOf(text);
    spans.push(maskSpan(text, lineStart + cellStart, 'tableCell'));
  }
  return spans;
}

/**
 * A span, minus the line's trailing hard break.
 *
 * `**СТИНБЕРГЕН, Эстер**(Esther Steenbergen)\\` ends in a backslash, which is
 * Markdown for "break the line here" and is markup, not words. Sending it invites
 * a model to drop it — and a dropped hard break silently joins two lines of a
 * three-member roster into one. Leaving it outside the span means the splice
 * puts it back byte for byte, like every other piece of structure.
 *
 * A doubled backslash is an escaped backslash and stays inside the text.
 */
function makeSpan(prefix: string, text: string, lineStart: number, kind: SpanKind): TextSpan {
  const body = HARD_BREAK.test(text) ? text.slice(0, -1) : text;
  return maskSpan(body, lineStart + prefix.length, kind);
}

const HARD_BREAK = /(?:^|[^\\])(?:\\{2})*\\$/;

function maskSpan(text: string, start: number, kind: SpanKind): TextSpan {
  const masks = new Map<string, string>();
  let index = 0;

  const masked = text.replace(linkTargetPattern(), (_match, open: string, target: string, close: string) => {
    index += 1;
    const token = `⟦${index}⟧`;
    masks.set(token, target);
    return `${open}${token}${close}`;
  });

  return { start, end: start + text.length, text: masked, kind, masks };
}

function unmask(text: string, masks: ReadonlyMap<string, string>): string {
  let result = text;
  for (const [token, target] of masks) result = result.split(token).join(target);
  return result;
}
