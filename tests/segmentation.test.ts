import { describe, expect, it } from 'vitest';

import { applyTextSpans, displacedMasks, extractTextSpans, missingMasks } from '../src/documents/markdown/textSpans.js';
import { applyUnits, collectUnits, keyOf, type LocalizationOptions } from '../src/pipelines/localization/StringTable.js';
import { TranslationMemory } from '../src/pipelines/localization/TranslationMemory.js';
import { appConfigSchema } from '../src/config/schema.js';
import { minimalConfig } from './helpers/config.js';

const ARTICLE = `# Пако де Лусия

::: lead

Испанский гитарист и композитор.

:::

::: image
src: https://placehold.co/420x560?text=Paco
position: left
size: medium
caption: Пако де Лусия — портрет
:::

**ПАКО ДЕ ЛУСИЯ** (*Paco de Lucía*, 1947–2014) — испанский гитарист.

## Небольшая дискография

1. *Fuente y caudal*
2. *Almoraima*

> Он открыл фламенко для джаза.

\`\`\`js
const secret = "не переводить";
\`\`\`

| Год | Альбом |
|---|---|
| 1973 | Fuente y caudal |

[Официальная биография](https://fundacionpacodelucia.com/legado/)

---
`;

describe('markdown text spans', () => {
  const spans = extractTextSpans(ARTICLE);
  const allText = spans.map((span) => span.text).join('\n');

  it('rebuilds the document byte-for-byte under an identity translation', () => {
    const identity = new Map(spans.map((span) => [span.text, span.text]));
    expect(applyTextSpans(ARTICLE, spans, identity)).toBe(ARTICLE);
  });

  it('never sends structural markup', () => {
    expect(allText).not.toMatch(/^#{1,6}\s/m);
    expect(allText).not.toContain(':::');
    expect(allText).not.toMatch(/^\s*[-*+]\s/m);
    expect(allText).not.toMatch(/^\s*>\s/m);
  });

  it('never sends URLs or image sources', () => {
    expect(allText).not.toContain('https://');
    expect(allText).not.toContain('placehold.co');
    expect(allText).not.toContain('fundacionpacodelucia.com');
  });

  it('never sends code', () => {
    expect(allText).not.toContain('const secret');
    expect(allText).not.toContain('не переводить');
  });

  it('never sends container attributes that are syntax', () => {
    expect(allText).not.toContain('position:');
    expect(allText).not.toContain('size:');
    expect(allText).not.toContain('src:');
  });

  it('does send the prose that must be translated', () => {
    expect(allText).toContain('Пако де Лусия');
    expect(allText).toContain('Испанский гитарист и композитор.');
    expect(allText).toContain('Небольшая дискография');
    expect(allText).toContain('Он открыл фламенко для джаза.');
  });

  it('sends a container caption, which is displayed text', () => {
    expect(allText).toContain('Пако де Лусия — портрет');
  });

  it('keeps inline emphasis inside the fragment rather than splitting the sentence', () => {
    const sentence = spans.find((span) => span.text.includes('ПАКО ДЕ ЛУСИЯ'));
    expect(sentence?.text).toContain('**ПАКО ДЕ ЛУСИЯ**');
    expect(sentence?.text).toContain('*Paco de Lucía*');
  });

  it('masks link targets and restores them exactly', () => {
    const link = spans.find((span) => span.text.includes('Официальная биография'));
    expect(link?.text).toMatch(/\[Официальная биография\]\(⟦1⟧\)/);
    expect(link?.masks.get('⟦1⟧')).toBe('https://fundacionpacodelucia.com/legado/');

    const translated = new Map([[link!.text, '[Official biography](⟦1⟧)']]);
    expect(applyTextSpans(ARTICLE, [link!], translated)).toContain(
      '[Official biography](https://fundacionpacodelucia.com/legado/)',
    );
  });

  it('reports a dropped placeholder instead of losing the URL', () => {
    const link = spans.find((span) => span.text.includes('Официальная биография'))!;
    expect(missingMasks(link.text, '[Official biography]()')).toEqual(['⟦1⟧']);
    expect(missingMasks(link.text, '[Official biography](⟦1⟧)')).toEqual([]);
  });

  it('reports a placeholder that survived but stopped being a link', () => {
    const link = spans.find((span) => span.text.includes('Официальная биография'))!;
    // What `gemma4-31b-local` actually returned when asked to gloss a title
    // that was also a link label: nothing lost, and no link left either.
    expect(displacedMasks(link.text, '["Ofitsialnaya biografiya"] (Official biography) (⟦1⟧)')).toEqual(['⟦1⟧']);
    expect(displacedMasks(link.text, '[Official biography](⟦1⟧)')).toEqual([]);
    expect(displacedMasks(link.text, '[Official biography](⟦1⟧ "title")')).toEqual([]);
    // Missing is a different verdict from displaced, and only one applies.
    expect(displacedMasks(link.text, '[Official biography]()')).toEqual([]);
  });

  it('extracts table cells but not the divider row', () => {
    const cells = spans.filter((span) => span.kind === 'tableCell').map((span) => span.text);
    expect(cells).toContain('Альбом');
    expect(cells).not.toContain('---');
  });

  it('collapses to nothing for a document with no prose', () => {
    expect(extractTextSpans('```js\nconst a = 1;\n```\n')).toEqual([]);
  });

  describe('fenced blocks', () => {
    const POEM = '```\nКогда умру,\nСхороните меня с гитарой\n\nВ речном песке.\n```\n';

    it('translates a bare fence holding verse, one span per line', () => {
      const spans = extractTextSpans(POEM);
      expect(spans.map((span) => span.text)).toEqual(['Когда умру,', 'Схороните меня с гитарой', 'В речном песке.']);
      expect(spans.every((span) => span.kind === 'verse')).toBe(true);
    });

    it('puts a translated poem back line for line', () => {
      const spans = extractTextSpans(POEM);
      const translated = new Map(spans.map((span, index) => [span.text, `line ${index + 1}`]));
      expect(applyTextSpans(POEM, spans, translated)).toBe('```\nline 1\nline 2\n\nline 3\n```\n');
    });

    it('leaves a fence alone when its info string names a language', () => {
      expect(extractTextSpans('```python\nprint("Когда умру")\n```\n')).toEqual([]);
    });

    it('leaves tablature alone', () => {
      const tab = '```\ne|---0---2---3---|\nB|---1---3---0---|\nG|---0---2---0---|\n```\n';
      expect(extractTextSpans(tab)).toEqual([]);
    });

    it('honours an explicit policy in both directions', () => {
      expect(extractTextSpans(POEM, { fencedBlocks: 'code' })).toEqual([]);
      expect(extractTextSpans('```js\nconst a = 1;\n```\n', { fencedBlocks: 'text' })).toHaveLength(1);
    });
  });
});

describe('dossier string table', () => {
  const options: LocalizationOptions = {
    localizable: appConfigSchema.parse(minimalConfig()).tasks.localize.localizableFields,
    listFields: appConfigSchema.parse(minimalConfig()).tasks.localize.listFields,
  };

  const dossier = {
    metadata: {
      forename: 'Пако',
      surname: 'де Лусия',
      birthplace: 'Альхесирас, Испания',
      genres: 'фламенко,джаз-фьюжн',
      dates: { born: '21.12.1947', died: '25.02.2014' },
      ranking: 98,
      url: 'https://fundacionpacodelucia.com/legado/',
    },
    media: { photos: [{ label: 'Основной портрет', target: '/photos/paco.jpg' }], music: [] },
    documents: [{ label: 'Официальная биография', type: 'REFERENCE', target: 'https://example.org' }],
    unknownField: 'должно остаться как есть',
  };

  const units = collectUnits(dossier, options);
  const texts = units.map((unit) => unit.text);

  it('sends prose values', () => {
    expect(texts).toContain('Пако');
    expect(texts).toContain('Альхесирас, Испания');
    expect(texts).toContain('Основной портрет');
    expect(texts).toContain('Официальная биография');
  });

  it('never sends language-invariant fields', () => {
    expect(texts).not.toContain('21.12.1947');
    expect(texts).not.toContain('https://fundacionpacodelucia.com/legado/');
    expect(texts.join(' ')).not.toContain('98');
  });

  it('never sends media targets or document types', () => {
    expect(texts).not.toContain('/photos/paco.jpg');
    expect(texts).not.toContain('REFERENCE');
    expect(texts).not.toContain('https://example.org');
  });

  it('never sends unknown fields, which must be preserved untouched', () => {
    expect(texts).not.toContain('должно остаться как есть');
  });

  it('splits comma-separated list fields into their items', () => {
    expect(texts).toContain('фламенко');
    expect(texts).toContain('джаз-фьюжн');
    expect(texts).not.toContain('фламенко,джаз-фьюжн');
  });

  it('deduplicates identical strings by content hash', () => {
    const twice = collectUnits(
      { metadata: { forename: 'Пако', surname: 'Пако' } },
      { localizable: ['metadata.forename', 'metadata.surname'], listFields: [] },
    );
    expect(twice).toHaveLength(1);
    expect(twice[0]?.paths).toEqual(['metadata.forename', 'metadata.surname']);
  });

  it('rebuilds the dossier with invariants copied from the source', () => {
    const translations = new Map(units.map((unit) => [unit.key, unit.text.toUpperCase()]));
    const localized = applyUnits(dossier, options, translations) as typeof dossier;

    expect(localized.metadata.forename).toBe('ПАКО');
    expect(localized.metadata.genres).toBe('ФЛАМЕНКО,ДЖАЗ-ФЬЮЖН');
    expect(localized.metadata.dates).toEqual(dossier.metadata.dates);
    expect(localized.metadata.ranking).toBe(98);
    expect(localized.metadata.url).toBe(dossier.metadata.url);
    expect(localized.media.photos[0]?.target).toBe('/photos/paco.jpg');
    expect(localized.documents[0]?.type).toBe('REFERENCE');
    expect(localized.unknownField).toBe('должно остаться как есть');
  });

  it('keeps the source text for a string that came back untranslated', () => {
    const localized = applyUnits(dossier, options, new Map()) as typeof dossier;
    expect(localized.metadata.forename).toBe('Пако');
  });
});

describe('translation memory', () => {
  it('serves a repeated string from cache and counts the hit', () => {
    const memory = new TranslationMemory(true);
    const units = [{ key: keyOf('Гитарист'), text: 'Гитарист', paths: [] }];

    expect(memory.partition('en', units).unknown).toHaveLength(1);
    memory.remember('en', new Map([[units[0]!.key, 'Guitarist']]));

    const second = memory.partition('en', units);
    expect(second.unknown).toHaveLength(0);
    expect(second.known.get(units[0]!.key)).toBe('Guitarist');
    expect(memory.stats().hits).toBe(1);
  });

  it('keeps languages apart', () => {
    const memory = new TranslationMemory(true);
    const units = [{ key: keyOf('Гитарист'), text: 'Гитарист', paths: [] }];
    memory.remember('en', new Map([[units[0]!.key, 'Guitarist']]));

    expect(memory.partition('de', units).unknown).toHaveLength(1);
  });

  it('is inert when disabled', () => {
    const memory = new TranslationMemory(false);
    const units = [{ key: keyOf('Гитарист'), text: 'Гитарист', paths: [] }];
    memory.remember('en', new Map([[units[0]!.key, 'Guitarist']]));

    expect(memory.partition('en', units).unknown).toHaveLength(1);
  });
});
