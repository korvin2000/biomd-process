import { describe, expect, it } from 'vitest';

import { placeholdersOf, renderPathTemplate } from '../src/io/PathTemplate.js';
import { MessageBuilder } from '../src/prompts/MessageBuilder.js';
import { extractJsonBlock } from '../src/shared/json.js';
import { readCatalogue } from '../src/io/CatalogueReader.js';
import { estimateCost } from '../src/llm/CostCalculator.js';
import { Workspace } from './helpers/workspace.js';
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
    expect(messages[1]).toMatchObject({ role: 'user', cacheBreakpoint: true });
    expect(messages[1]?.content).toContain('GLOSS');
    expect(messages[1]?.content.startsWith('INSTRUCTIONS')).toBe(true);
    expect(messages[2]).toMatchObject({ role: 'user' });
    expect(messages[2]?.content).toContain('DOC');
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

describe('prompt versioning', () => {
  it('includes global prompt variables in the version hash', async () => {
    const workspace = await Workspace.create();
    try {
      await workspace.writeDefaultPrompts();
      const first = workspace.app({ prompts: { dir: 'prompts', variables: { projectName: 'A' } } });
      const second = workspace.app({ prompts: { dir: 'prompts', variables: { projectName: 'B' } } });
      await expect(first.prompts.versionOf('extract')).resolves.not.toBe(await second.prompts.versionOf('extract'));
    } finally {
      await workspace.destroy();
    }
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

describe('reading a published catalogue', () => {
  it('sorts the files into index, name indices and dossiers, keeping the raw bytes', async () => {
    const workspace = await Workspace.create();
    try {
      await workspace.writeFile('site/index.json', '[{"id":"1","md":"/a.bio.md"}]');
      await workspace.writeFile('site/index-ru.json', '{"1":["А"]}');
      await workspace.writeFile('site/ru/a.bio.json', '{"metadata":{}}');
      await workspace.writeFile('site/ru/a.bio.md', '# A');
      await workspace.writeFile('site/photos/a.jpg', 'not really a jpeg');

      const snapshot = await readCatalogue(workspace.path('site'), { supportedLanguages: ['ru', 'en'] });

      expect(snapshot.index.value).toEqual([{ id: '1', md: '/a.bio.md' }]);
      expect(snapshot.index.raw).toContain('"id"');
      expect([...snapshot.names.keys()]).toEqual(['ru']);
      expect([...snapshot.dossiers.keys()]).toEqual(['ru/a.bio.json']);
      expect(snapshot.files.has('photos/a.jpg')).toBe(true);
    } finally {
      await workspace.destroy();
    }
  });

  it('records an unparseable file rather than failing the read', async () => {
    const workspace = await Workspace.create();
    try {
      await workspace.writeFile('site/index.json', '[{"id":');
      const snapshot = await readCatalogue(workspace.path('site'), { supportedLanguages: ['ru'] });
      expect(snapshot.index.value).toBeUndefined();
      expect(snapshot.index.raw).toBe('[{"id":');
    } finally {
      await workspace.destroy();
    }
  });
});

describe('cost and tokens', () => {
  it('bills cached input tokens at the cache rate', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 900_000, cacheWritePromptTokens: 0, reasoningTokens: 0, totalTokens: 1_000_000 };
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
