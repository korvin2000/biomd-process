export type BlockKind = 'heading' | 'container' | 'fence' | 'text' | 'blank' | 'rule';

export interface MarkdownBlock {
  kind: BlockKind;
  text: string;
  /** Character offsets into the source. */
  start: number;
  end: number;
  /** 1–6 for headings. */
  headingLevel?: number;
  /** Container name for `::: name` blocks. */
  containerName?: string;
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const CONTAINER = /^(\s*):::\s*(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+\S/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Splits Markdown into *atomic* blocks — the smallest units a chunker may
 * reorder or separate without corrupting the document.
 *
 * The two things that must never be cut are fenced code and the project's
 * `::: name … :::` container blocks (including nesting): a chunk that opens a
 * container without closing it produces a translation that cannot be reassembled.
 * That is why this is a purpose-built scanner rather than a general Markdown AST —
 * the container syntax is not standard Markdown, and the guarantee we need is
 * structural, not semantic.
 */
export function splitBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const offsets = lineOffsets(lines);
  const blocks: MarkdownBlock[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const end = findFenceEnd(lines, index, fence[2] ?? '```');
      blocks.push(makeBlock('fence', lines, offsets, index, end));
      index = end + 1;
      continue;
    }

    const container = CONTAINER.exec(line);
    if (container && (container[2] ?? '') !== '') {
      const end = findContainerEnd(lines, index);
      blocks.push({
        ...makeBlock('container', lines, offsets, index, end),
        containerName: container[2],
      });
      index = end + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        ...makeBlock('heading', lines, offsets, index, index),
        headingLevel: (heading[1] ?? '#').length,
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(makeBlock('rule', lines, offsets, index, index));
      index += 1;
      continue;
    }

    const end = findTextEnd(lines, index);
    blocks.push(makeBlock('text', lines, offsets, index, end));
    index = end + 1;
  }

  return blocks;
}

function findFenceEnd(lines: string[], start: number, marker: string): number {
  const char = marker[0] ?? '`';
  for (let i = start + 1; i < lines.length; i += 1) {
    const candidate = FENCE.exec(lines[i] ?? '');
    if (candidate && (candidate[2] ?? '').startsWith(char) && (candidate[2] ?? '').length >= marker.length) {
      return i;
    }
  }
  return lines.length - 1; // unterminated fence: swallow the rest, never split it
}

/** Matches the closing bare `:::`, honouring nested named containers. */
function findContainerEnd(lines: string[], start: number): number {
  let depth = 0;
  let inFence = false;
  let fenceMarker = '';

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2] ?? '';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker.startsWith(fenceMarker[0] ?? '`')) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const container = CONTAINER.exec(line);
    if (!container) continue;

    if ((container[2] ?? '') === '') {
      depth -= 1;
      if (depth <= 0) return i;
    } else {
      depth += 1;
    }
  }
  return lines.length - 1;
}

/** A text block runs until a blank line or the start of another block kind. */
function findTextEnd(lines: string[], start: number): number {
  let i = start;
  while (i + 1 < lines.length) {
    const next = lines[i + 1] ?? '';
    if (next.trim() === '' || HEADING.test(next) || FENCE.test(next) || CONTAINER.test(next) || RULE.test(next)) {
      break;
    }
    i += 1;
  }
  return i;
}

function makeBlock(
  kind: BlockKind,
  lines: string[],
  offsets: number[],
  startLine: number,
  endLine: number,
): MarkdownBlock {
  const start = offsets[startLine] ?? 0;
  const lastLine = lines[endLine] ?? '';
  const end = (offsets[endLine] ?? 0) + lastLine.length;
  return { kind, text: lines.slice(startLine, endLine + 1).join('\n'), start, end };
}

function lineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let position = 0;
  for (const line of lines) {
    offsets.push(position);
    position += line.length + 1;
  }
  return offsets;
}
