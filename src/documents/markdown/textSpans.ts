export type SpanKind = 'heading' | 'paragraph' | 'listItem' | 'quote' | 'tableCell' | 'attribute';

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
/** `[text](target)` and `![alt](target)` — only the target is masked. */
const LINK_TARGET = /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;

/** Container attributes whose value is displayed text rather than syntax. */
const PROSE_ATTRIBUTES = new Set(['caption', 'title', 'alt', 'label', 'text']);

export function extractTextSpans(markdown: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const lines = markdown.split('\n');
  let offset = 0;
  let fenceMarker: string | undefined;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '';
      if (fenceMarker === undefined) fenceMarker = marker;
      else if (marker.startsWith(fenceMarker[0] ?? '`')) fenceMarker = undefined;
      continue;
    }
    // Code is not prose: never sent, never touched.
    if (fenceMarker !== undefined) continue;
    if (line.trim() === '' || CONTAINER.test(line) || RULE.test(line)) continue;

    const span = spanOf(line, lineStart);
    if (span) spans.push(span);
    else if (TABLE_ROW.test(line) && !TABLE_DIVIDER.test(line)) spans.push(...tableCells(line, lineStart));
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

function makeSpan(prefix: string, text: string, lineStart: number, kind: SpanKind): TextSpan {
  return maskSpan(text, lineStart + prefix.length, kind);
}

function maskSpan(text: string, start: number, kind: SpanKind): TextSpan {
  const masks = new Map<string, string>();
  let index = 0;

  const masked = text.replace(LINK_TARGET, (_match, open: string, target: string, close: string) => {
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
