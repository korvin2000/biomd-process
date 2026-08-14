import { describe, expect, it } from 'vitest';

import { Segmenter } from '../src/documents/Segmenter.js';
import { splitBlocks } from '../src/documents/markdown/blocks.js';
import { compareSkeletons, markdownSkeleton } from '../src/documents/markdown/skeleton.js';
import { HeuristicTokenEstimator } from '../src/llm/TokenEstimator.js';
import type { SourceDocument } from '../src/documents/types.js';

const estimator = new HeuristicTokenEstimator(4);
const segmenter = new Segmenter(estimator);

function doc(content: string): SourceDocument {
  return {
    id: 'ru/test',
    slug: 'test',
    language: 'ru',
    absolutePath: '/tmp/test.bio.md',
    relativePath: 'ru/test.bio.md',
    content,
    contentHash: 'hash',
    bytes: content.length,
    estimatedTokens: estimator.estimateText(content),
  };
}

const SAMPLE = `# Title

::: lead

Lead paragraph.

:::

::: image
src: https://example.org/a.jpg
position: left
caption: A caption
:::

## Section

Body text here.

\`\`\`js
const x = 1;
// ::: this is not a container
\`\`\`

[A link](https://example.org/source)

---
`;

describe('splitBlocks', () => {
  it('keeps a container block whole, including its closing marker', () => {
    const container = splitBlocks(SAMPLE).find((block) => block.containerName === 'lead');
    expect(container?.text).toContain('Lead paragraph.');
    expect(container?.text.trimEnd().endsWith(':::')).toBe(true);
  });

  it('keeps a fenced code block whole and does not read ::: inside it', () => {
    const fence = splitBlocks(SAMPLE).find((block) => block.kind === 'fence');
    expect(fence?.text).toContain('const x = 1;');
    expect(fence?.text).toContain('// ::: this is not a container');
  });

  it('gives each heading its own block with the right level', () => {
    const headings = splitBlocks(SAMPLE).filter((block) => block.kind === 'heading');
    expect(headings.map((block) => block.headingLevel)).toEqual([1, 2]);
  });

  it('produces offsets that map back to the source', () => {
    for (const block of splitBlocks(SAMPLE)) {
      expect(SAMPLE.slice(block.start, block.end)).toBe(block.text);
    }
  });
});

describe('Segmenter', () => {
  it('returns the whole document untruncated when it fits', () => {
    const segment = segmenter.head(doc(SAMPLE), 10_000);
    expect(segment.truncated).toBe(false);
    expect(segment.text).toBe(SAMPLE);
  });

  it('cuts the head at a block boundary, never mid-container', () => {
    const segment = segmenter.head(doc(SAMPLE), 20);
    expect(segment.truncated).toBe(true);
    const opens = (segment.text.match(/^::: \S+/gm) ?? []).length;
    const closes = (segment.text.match(/^:::\s*$/gm) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('chunks a long document into segments that each stay under the budget', () => {
    const long = doc(Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\nParagraph ${i}.`).join('\n\n'));
    const chunks = segmenter.chunks(long, { maxTokens: 60, overlapTokens: 0, splitOn: 'heading' });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.estimatedTokens <= 80)).toBe(true);
    expect(chunks.map((chunk, index) => chunk.label === `chunk ${index + 1}/${chunks.length}`).every(Boolean)).toBe(true);
  });

  it('keeps every chunk non-empty and in document order', () => {
    const long = doc(Array.from({ length: 12 }, (_, i) => `## S${i}\n\nText ${i}.`).join('\n\n'));
    const chunks = segmenter.chunks(long, { maxTokens: 40, overlapTokens: 10, splitOn: 'heading' });

    expect(chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
    expect([...chunks].sort((a, b) => a.start - b.start).map((c) => c.index)).toEqual(chunks.map((c) => c.index));
  });
});

describe('markdown skeleton', () => {
  it('is identical for a faithful translation', () => {
    const translated = SAMPLE.replace('Lead paragraph.', 'Ведущий абзац.')
      .replace('Body text here.', 'Текст здесь.')
      .replace('A caption', 'Подпись')
      .replace('# Title', '# Заголовок')
      .replace('## Section', '## Раздел')
      .replace('[A link]', '[Ссылка]');

    expect(compareSkeletons(SAMPLE, translated).ok).toBe(true);
  });

  it('detects a dropped container block', () => {
    const broken = SAMPLE.replace('::: lead\n', '').replace('\n:::\n\n::: image', '\n\n::: image');
    expect(compareSkeletons(SAMPLE, broken).ok).toBe(false);
  });

  it('detects a rewritten link target', () => {
    const broken = SAMPLE.replace('https://example.org/source', 'https://example.org/istochnik');
    const comparison = compareSkeletons(SAMPLE, broken);
    expect(comparison.ok).toBe(false);
    expect(comparison.differences.join(' ')).toContain('istochnik');
  });

  it('detects a heading demoted to a paragraph', () => {
    const broken = SAMPLE.replace('## Section', 'Section');
    expect(compareSkeletons(SAMPLE, broken).ok).toBe(false);
  });

  it('treats container key/value lines as syntax, not prose', () => {
    const tokens = markdownSkeleton('::: image\nsrc: /a.jpg\ncaption: Hello\n:::');
    expect(tokens).toContain('kv:src');
    expect(tokens).not.toContain('kv:caption');
  });
});
