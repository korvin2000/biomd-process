import type { TokenEstimator } from '../llm/TokenEstimator.js';
import { splitBlocks, type MarkdownBlock } from './markdown/blocks.js';
import type { DocumentSegment, SourceDocument } from './types.js';

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
  splitOn: 'heading' | 'paragraph' | 'line';
}

/**
 * Cuts documents into segments along block boundaries.
 *
 * Every cut is made between atomic blocks (see `markdown/blocks.ts`), so no
 * segment ever ends inside a fenced code block or an unclosed `:::` container.
 */
export class Segmenter {
  constructor(private readonly estimator: TokenEstimator) {}

  full(document: SourceDocument): DocumentSegment {
    return this.segment(document.content, {
      index: 0,
      total: 1,
      label: 'full',
      start: 0,
      end: document.content.length,
      truncated: false,
    });
  }

  /** Leading slice under `maxTokens`, cut at the last block boundary that fits. */
  head(document: SourceDocument, maxTokens: number): DocumentSegment {
    const end = this.boundaryWithin(document.content, maxTokens);
    return this.segment(document.content.slice(0, end), {
      index: 0,
      total: 1,
      label: 'head',
      start: 0,
      end,
      truncated: end < document.content.length,
    });
  }

  /**
   * Head plus tail with the middle elided. Biographies put identity at the top
   * and sources, awards and links at the bottom, so the two ends together often
   * carry the metadata the middle narrative does not.
   */
  headAndTail(document: SourceDocument, headTokens: number, tailTokens: number): DocumentSegment {
    const content = document.content;
    const headEnd = this.boundaryWithin(content, headTokens);
    const tailStart = this.boundaryFromEnd(content, tailTokens);

    if (tailStart <= headEnd) return this.head(document, headTokens + tailTokens);

    const text = `${content.slice(0, headEnd)}\n\n[…]\n\n${content.slice(tailStart)}`;
    return this.segment(text, {
      index: 0,
      total: 1,
      label: 'head+tail',
      start: 0,
      end: content.length,
      truncated: true,
    });
  }

  /** Sequential chunks under `maxTokens`, with optional block-level overlap. */
  chunks(document: SourceDocument, options: ChunkOptions): DocumentSegment[] {
    const blocks = splitBlocks(document.content);
    if (blocks.length === 0) return [this.full(document)];

    const groups = this.groupBlocks(blocks, options);
    const withOverlap = options.overlapTokens > 0 ? this.applyOverlap(groups, options.overlapTokens) : groups;

    return withOverlap.map((group, index) =>
      this.segment(group.map((block) => block.text).join('\n\n'), {
        index,
        total: withOverlap.length,
        label: `chunk ${index + 1}/${withOverlap.length}`,
        start: group[0]?.start ?? 0,
        end: group.at(-1)?.end ?? document.content.length,
        truncated: false,
      }),
    );
  }

  private groupBlocks(blocks: MarkdownBlock[], options: ChunkOptions): MarkdownBlock[][] {
    const groups: MarkdownBlock[][] = [];
    let current: MarkdownBlock[] = [];
    let currentTokens = 0;

    for (const block of blocks) {
      const tokens = this.estimator.estimateText(block.text);
      const wouldOverflow = currentTokens + tokens > options.maxTokens && current.length > 0;
      const preferredBreak =
        options.splitOn === 'heading' && block.kind === 'heading' && currentTokens >= options.maxTokens / 2;

      if (wouldOverflow || preferredBreak) {
        groups.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(block);
      currentTokens += tokens;
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  /** Prepends trailing blocks of the previous group so context is not lost at a seam. */
  private applyOverlap(groups: MarkdownBlock[][], overlapTokens: number): MarkdownBlock[][] {
    return groups.map((group, index) => {
      if (index === 0) return group;
      const previous = groups[index - 1] ?? [];
      const carried: MarkdownBlock[] = [];
      let tokens = 0;

      for (let i = previous.length - 1; i >= 0; i -= 1) {
        const block = previous[i];
        if (!block) break;
        const cost = this.estimator.estimateText(block.text);
        if (tokens + cost > overlapTokens) break;
        carried.unshift(block);
        tokens += cost;
      }
      return [...carried, ...group];
    });
  }

  /** Largest prefix length whose token estimate stays within `maxTokens`. */
  private boundaryWithin(content: string, maxTokens: number): number {
    if (this.estimator.estimateText(content) <= maxTokens) return content.length;

    const blocks = splitBlocks(content);
    let end = 0;
    let tokens = 0;
    for (const block of blocks) {
      const cost = this.estimator.estimateText(block.text);
      if (tokens + cost > maxTokens) break;
      tokens += cost;
      end = block.end;
    }
    // A single oversized block: fall back to a raw character cut.
    return end > 0 ? end : Math.min(content.length, this.estimator.charsForTokens(maxTokens));
  }

  private boundaryFromEnd(content: string, maxTokens: number): number {
    if (maxTokens <= 0) return content.length;

    const blocks = splitBlocks(content);
    let start = content.length;
    let tokens = 0;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      if (!block) break;
      const cost = this.estimator.estimateText(block.text);
      if (tokens + cost > maxTokens) break;
      tokens += cost;
      start = block.start;
    }
    return start;
  }

  private segment(text: string, meta: Omit<DocumentSegment, 'text' | 'estimatedTokens'>): DocumentSegment {
    return { ...meta, text, estimatedTokens: this.estimator.estimateText(text) };
  }
}
