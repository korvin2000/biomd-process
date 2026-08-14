/**
 * Structural fingerprint of a Markdown document.
 *
 * Translation must change the words and nothing else. Comparing the skeleton of
 * the source with the skeleton of the translation catches the failures models
 * actually make — a dropped `:::` container, a heading turned into bold text, a
 * rewritten URL, an invented paragraph — without a diff of the prose itself.
 *
 * TODO(domain): footnote ids, once the corpus has any.
 */

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const CONTAINER = /^\s*:::\s*(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const KEY_VALUE = /^\s*([A-Za-z][\w-]*)\s*:\s*(.+)$/;
const UNORDERED = /^\s*[-*+]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const BLOCKQUOTE = /^\s*>\s?/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const IMAGE = /!\[[^\]]*\]\(([^)\s]+)/g;
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)/g;

export interface SkeletonComparison {
  ok: boolean;
  /** Human-readable first divergences, capped so an error stays readable. */
  differences: string[];
  sourceLength: number;
  targetLength: number;
}

/**
 * How much divergence counts as "the same document".
 *
 * - `strict` — token for token. The right default: in segment mode the skeleton
 *   *cannot* legitimately change, because it was never sent, so any difference
 *   is a bug on this side rather than a translator's licence.
 * - `lenient` — for whole-document mode, where a translator may legitimately
 *   join two short paragraphs into one. Runs of consecutive body-text lines
 *   collapse to a single token, so re-flowing prose passes. Headings,
 *   containers, fences, rules, tables, list markers and every link and image
 *   target are still compared exactly — those are never a stylistic choice.
 *   The price is that deleting one of two adjacent paragraphs also passes,
 *   which is why this is opt-in.
 */
export type SkeletonMode = 'strict' | 'lenient';

export interface CompareOptions {
  mode?: SkeletonMode;
  maxDifferences?: number;
}

/** Tokens that stand for a run of prose rather than a structural element. */
const FLOWABLE = new Set(['p', 'quote']);

export function markdownSkeleton(content: string): string[] {
  const tokens: string[] = [];
  const lines = content.split('\n');
  let fenceMarker: string | undefined;

  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (fence) {
      if (fenceMarker === undefined) {
        fenceMarker = fence[1];
        tokens.push(`fence:${(fence[2] ?? '').trim()}`);
      } else {
        fenceMarker = undefined;
        tokens.push('fence:end');
      }
      continue;
    }
    // Code content is not translated, so it contributes nothing but its extent.
    if (fenceMarker !== undefined) continue;
    if (line.trim() === '') continue;

    const container = CONTAINER.exec(line);
    if (container) {
      tokens.push((container[1] ?? '') === '' ? 'container:end' : `container:${container[1]}`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      tokens.push(`h${(heading[1] ?? '#').length}`);
      pushInline(tokens, heading[2] ?? '');
      continue;
    }

    if (RULE.test(line)) {
      tokens.push('rule');
      continue;
    }
    if (TABLE_ROW.test(line)) {
      tokens.push(`tr:${(line.match(/\|/g)?.length ?? 1) - 1}`);
      continue;
    }
    if (BLOCKQUOTE.test(line)) tokens.push('quote');
    else if (UNORDERED.test(line)) tokens.push('li');
    else if (ORDERED.test(line)) tokens.push('oli');
    else {
      const keyValue = KEY_VALUE.exec(line);
      // Inside container blocks, `src:`/`position:` are syntax, not prose.
      if (keyValue && isSyntaxKey(keyValue[1] ?? '')) tokens.push(`kv:${keyValue[1]}`);
      else tokens.push('p');
    }
    pushInline(tokens, line);
  }

  return tokens;
}

/**
 * Compares two skeletons and reports where they first diverge.
 * Reported positions are token indices, which map to "the Nth structural
 * element" — precise enough to point a human at the paragraph.
 */
export function compareSkeletons(source: string, target: string, options: CompareOptions = {}): SkeletonComparison {
  const { mode = 'strict', maxDifferences = 5 } = options;
  const a = collapse(markdownSkeleton(source), mode);
  const b = collapse(markdownSkeleton(target), mode);
  const differences: string[] = [];

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length && differences.length < maxDifferences; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    differences.push(`#${i}: expected ${left ?? '(end)'}, got ${right ?? '(end)'}`);
  }

  return {
    ok: differences.length === 0 && a.length === b.length,
    differences,
    sourceLength: a.length,
    targetLength: b.length,
  };
}

/** In `lenient` mode a run of body-text tokens counts as one re-flowable block. */
function collapse(tokens: readonly string[], mode: SkeletonMode): string[] {
  if (mode === 'strict') return [...tokens];

  const result: string[] = [];
  for (const token of tokens) {
    if (FLOWABLE.has(token) && result.at(-1) === 'text+') continue;
    result.push(FLOWABLE.has(token) ? 'text+' : token);
  }
  return result;
}

/** Targets of links and images must survive translation byte for byte. */
function pushInline(tokens: string[], text: string): void {
  for (const match of text.matchAll(IMAGE)) tokens.push(`img:${match[1]}`);
  for (const match of text.matchAll(LINK)) tokens.push(`link:${match[1]}`);
}

const SYNTAX_KEYS = new Set(['src', 'position', 'size', 'align', 'width', 'height', 'target', 'type', 'id']);

function isSyntaxKey(key: string): boolean {
  return SYNTAX_KEYS.has(key.toLowerCase());
}
