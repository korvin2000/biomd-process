import { describe, expect, it } from 'vitest';

import { placeholdersOf, renderPathTemplate } from '../src/io/PathTemplate.js';
import { MessageBuilder } from '../src/prompts/MessageBuilder.js';
import { extractJsonBlock } from '../src/shared/json.js';
import { hasField, mergeMetadata } from '../src/pipelines/extraction/merge.js';
import { estimateCost } from '../src/llm/CostCalculator.js';
import { HeuristicTokenEstimator } from '../src/llm/TokenEstimator.js';

describe('path templates', () => {
  it('substitutes placeholders', () => {
    expect(renderPathTemplate('{lang}/{slug}.bio.json', { lang: 'en', slug: 'paco-de-lucia' })).toBe(
      'en/paco-de-lucia.bio.json',
    );
  });

  it('preserves hyphens and dots in values', () => {
    expect(renderPathTemplate('{slug}', { slug: 'jean-luc.v2' })).toBe('jean-luc.v2');
  });

  it('refuses to render an unresolved placeholder', () => {
    expect(() => renderPathTemplate('{lang}/{slug}', { lang: 'en' })).toThrowError(/unresolved placeholder\(s\): slug/);
  });

  it('strips separators so a value cannot add a directory level', () => {
    expect(renderPathTemplate('{slug}', { slug: '../../etc/passwd' })).toBe('.etcpasswd');
  });

  it('lists the placeholders a template uses', () => {
    expect(placeholdersOf('{lang}/{slug}.{ext}')).toEqual(['lang', 'slug', 'ext']);
  });
});

describe('MessageBuilder', () => {
  const prompt = { system: 'SYSTEM', instructions: 'INSTRUCTIONS', version: 'v1' };

  it('emits a stable system message and puts volatile content last', () => {
    const messages = MessageBuilder.build(prompt, [
      { title: 'Document', body: 'DOC', volatile: true },
      { title: 'Glossary', body: 'GLOSS' },
    ]);

    expect(messages[0]).toMatchObject({ role: 'system', content: 'SYSTEM' });
    const user = messages[1]?.content ?? '';
    expect(user.indexOf('GLOSS')).toBeLessThan(user.indexOf('DOC'));
    expect(user.startsWith('INSTRUCTIONS')).toBe(true);
  });

  it('keeps the cache prefix byte-identical across documents', () => {
    const a = MessageBuilder.build(prompt, [{ body: 'document A', volatile: true }]);
    const b = MessageBuilder.build(prompt, [{ body: 'document B', volatile: true }]);

    expect(a[0]?.content).toBe(b[0]?.content);
    const prefixA = (a[1]?.content ?? '').slice(0, 'INSTRUCTIONS'.length);
    const prefixB = (b[1]?.content ?? '').slice(0, 'INSTRUCTIONS'.length);
    expect(prefixA).toBe(prefixB);
  });
});

describe('JSON recovery', () => {
  it('extracts an object wrapped in prose', () => {
    expect(extractJsonBlock('Sure! {"a": 1} Hope that helps.')).toBe('{"a": 1}');
  });

  it('extracts an object from a fenced block', () => {
    expect(extractJsonBlock('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('is not confused by braces inside strings', () => {
    expect(extractJsonBlock('{"a": "}{", "b": 2}')).toBe('{"a": "}{", "b": 2}');
  });

  it('returns undefined when there is no JSON at all', () => {
    expect(extractJsonBlock('I cannot help with that.')).toBeUndefined();
  });
});

describe('metadata merge', () => {
  it('takes the first non-empty scalar and unions media by target', () => {
    const merged = mergeMetadata([
      { metadata: { forename: 'Пако' }, media: { photos: [{ label: 'a', target: '/a.jpg' }], music: [] }, documents: [] },
      {
        metadata: { forename: 'Paco', surname: 'де Лусия' },
        media: { photos: [{ label: 'a again', target: '/a.jpg' }, { label: 'b', target: '/b.jpg' }], music: [] },
        documents: [],
      },
    ]);

    expect(merged.metadata['forename']).toBe('Пако');
    expect(merged.metadata['surname']).toBe('де Лусия');
    expect(merged.media.photos.map((photo) => photo.target)).toEqual(['/a.jpg', '/b.jpg']);
  });

  it('resolves dot paths for required-field checks', () => {
    const document = { metadata: { forename: 'X', dates: { born: '01.01.1900' } }, media: { photos: [], music: [] }, documents: [] };
    expect(hasField(document, 'metadata.forename')).toBe(true);
    expect(hasField(document, 'metadata.dates.born')).toBe(true);
    expect(hasField(document, 'metadata.surname')).toBe(false);
  });
});

describe('cost and tokens', () => {
  it('bills cached input tokens at the cache rate', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 900_000, reasoningTokens: 0, totalTokens: 1_000_000 };
    const cost = estimateCost(usage, { inputPer1M: 10, outputPer1M: 0, cachedInputPer1M: 1 });
    expect(cost).toBeCloseTo(0.1 * 10 + 0.9 * 1, 6);
  });

  it('estimates more tokens per character for cyrillic than for latin', () => {
    const estimator = new HeuristicTokenEstimator(4);
    const latin = estimator.estimateText('a'.repeat(200));
    const cyrillic = estimator.estimateText('я'.repeat(200));
    expect(cyrillic).toBeGreaterThan(latin);
  });
});
