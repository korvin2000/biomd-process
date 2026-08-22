import { describe, expect, it } from 'vitest';

import { Segmenter } from '../src/documents/Segmenter.js';
import { splitBlocks } from '../src/documents/markdown/blocks.js';
import { compareSkeletons, markdownSkeleton } from '../src/documents/markdown/skeleton.js';
import { applyTextSpans, extractTextSpans } from '../src/documents/markdown/textSpans.js';
import { readTitle } from '../src/documents/markdown/title.js';
import { hasOwnScript, isTranslatable } from '../src/pipelines/shared/script.js';
import { StructureGuard } from '../src/pipelines/translation/StructureGuard.js';
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

describe('what the article calls itself', () => {
  it('joins an H1 split over two lines, which is how this corpus centres a title', () => {
    const title = readTitle('::: align\nposition: center\n\n# Амстердамское\n\n# гитарное трио\n\n:::\n');
    expect(title.title).toBe('Амстердамское гитарное трио');
    expect(title.lines).toEqual(['Амстердамское', 'гитарное трио']);
  });

  it('falls back to a centred block when the article has no heading at all', () => {
    const title = readTitle('::: align\nposition: center\n\nКвартет гитаристов **"КИÏВ"**\n\n:::\n');
    expect(title.title).toBe('Квартет гитаристов "КИÏВ"');
  });

  it('reads the lead, and ignores a section heading further down', () => {
    const title = readTitle('# Армик\n\n::: lead\nАрмик — американский гитарист.\n:::\n\n## ДИСКОГРАФИЯ\n\n- Malaga\n');
    expect(title.title).toBe('Армик');
    expect(title.lead).toBe('Армик — американский гитарист.');
  });

  it('caps the lead where it was asked to', () => {
    const title = readTitle('# X\n\n::: lead\n' + 'а'.repeat(500) + '\n:::\n', { leadChars: 100 });
    expect(title.lead).toHaveLength(100);
  });
});

describe('translatable prose', () => {
  it('leaves the line-ending hard break outside the span, so it cannot be lost', () => {
    const source = '**СТИНБЕРГЕН, Эстер**(Esther Steenbergen)\\\n';
    const spans = extractTextSpans(source);
    expect(spans[0]?.text).toBe('**СТИНБЕРГЕН, Эстер**(Esther Steenbergen)');

    const rebuilt = applyTextSpans(source, spans, new Map([[spans[0]!.text, '**STEENBERGEN, Esther**']]));
    expect(rebuilt).toBe('**STEENBERGEN, Esther**\\\n');
  });

  it('keeps an escaped backslash inside the text', () => {
    expect(extractTextSpans('a path C:\\\\\n')[0]?.text).toBe('a path C:\\\\');
  });

  it('sends a fragment written in the source language and nothing else', () => {
    expect(isTranslatable('Родился в Линаресе', 'ru')).toBe(true);
    // Every Latin-only fragment in this corpus is a work title, a composer or a
    // link label — 11% of them, and not one is a sentence of the article.
    expect(isTranslatable('Plays Domenico Scarlatti', 'ru')).toBe(false);
    expect(isTranslatable('Allegro vivo', 'ru')).toBe(false);
    // Mixed prose is prose: the name's survival is the prompt's business.
    expect(isTranslatable('Играл на гитаре Pedro Maldonado', 'ru')).toBe(true);
    expect(isTranslatable('1994', 'ru')).toBe(false);
  });

  it('does nothing at all for a source language written in Latin', () => {
    expect(hasOwnScript('ru')).toBe(true);
    expect(hasOwnScript('en')).toBe(false);
    expect(isTranslatable('Plays Domenico Scarlatti', 'en')).toBe(true);
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

describe('markdown skeleton, lenient mode', () => {
  const SOURCE = '## Section\n\nOne sentence.\n\nAnother sentence.\n\n[A link](https://example.org/a)\n';

  it('tolerates a translator joining two adjacent paragraphs', () => {
    const reflowed = '## Section\n\nOne sentence. Another sentence.\n\n[A link](https://example.org/a)\n';
    expect(compareSkeletons(SOURCE, reflowed).ok).toBe(false);
    expect(compareSkeletons(SOURCE, reflowed, { mode: 'lenient' }).ok).toBe(true);
  });

  it('still refuses a lost heading', () => {
    const broken = SOURCE.replace('## Section', 'Section');
    expect(compareSkeletons(SOURCE, broken, { mode: 'lenient' }).ok).toBe(false);
  });

  it('still refuses a rewritten link target', () => {
    const broken = SOURCE.replace('https://example.org/a', 'https://example.org/b');
    expect(compareSkeletons(SOURCE, broken, { mode: 'lenient' }).ok).toBe(false);
  });
});

describe('StructureGuard strictness', () => {
  const source = '# Title\n\nOne.\n\nTwo.\n';
  const reflowed = '# Title\n\nOne. Two.\n';

  it('maps the legacy booleans onto strict and off', () => {
    expect(new StructureGuard(true).verify(source, reflowed).ok).toBe(false);
    expect(new StructureGuard(false).verify(source, reflowed).ok).toBe(true);
  });

  it('accepts re-flowed prose when told to be lenient', () => {
    expect(new StructureGuard('lenient').verify(source, reflowed).ok).toBe(true);
  });
});
