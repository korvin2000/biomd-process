import { describe, expect, it } from 'vitest';

import { harvestMedia } from '../src/documents/markdown/media.js';

const ARTICLE = [
  '# Агустин Барриос',
  '',
  '::: lead',
  '',
  'Вступление, не содержащее медиа.',
  '',
  ':::',
  '',
  '::: image',
  'src: photo/b/barrios.jpg',
  'position: right',
  'size: small',
  'caption: Агустин Барриос',
  ':::',
  '',
  '::: images',
  'columns: 2',
  '',
  '::: image',
  'src: photo/b/barrios1.jpg',
  'caption: Barrios — CD (1)',
  ':::',
  '',
  '::: image',
  'src: photo/b/barrios2.jpg',
  'caption: Barrios — CD (2)',
  ':::',
  '',
  ':::',
  '',
  '![Портрет 1920-х](photo/b/barrios_am.jpg)',
  '',
  '| Пьеса | Табулатура | Аудио |',
  '| --- | --- | --- |',
  '| Julia Florida (Barcarola) | [TAB](music/tab/abmjulf.txt) | [MP3](music/mp/juliaflorida.mp3) |',
  '| La Catedral | [TAB](music/tab/abmcat.txt) | [MIDI](music/midi/abmcat.mid) |',
  '',
  'See also [the alternate layout](/#/barrios-alternate) and [note](#1).',
  '',
  'Источник: [www.evafampas.gr](http://www.evafampas.gr/biosen.html)',
  '',
  'Написать: [ras1@bezeqint.net](mailto:ras1@bezeqint.net), позвонить [+972](tel:+972000000).',
  '',
  // Escaped brackets inside a label: `\\[` reaches the scanner as `\[`, which is
  // what this corpus writes and what `inline.ts` exists to read.
  '[Алехо КАРПЕНТЬЕР \\[ОБ ЭЙТОРЕ ВИЛА-ЛОБОСЕ\\]](/#/villa-lobos1)',
  '',
  '[Программка \\[1957\\]](articles/programme.pdf) и [диплом](scans/diploma.docx).',
  '',
  '| Диссертация | [DOC](papers/thesis.doc) | [Аннотация](papers/abstract.rtf) |',
  '',
  'Обложка [крупным планом](photo/b/barrios_cover.jpg).',
  '',
  'Не документ: [ноты](music/tab/abmjulf.txt), [страница](/#/barrios), [сноска](#2),',
  '[индекс](index.php), [каталог](catalog/), [сайт](//cdn.example.org/page.html).',
  '',
  '```markdown',
  '::: image',
  'src: photo/not-real.jpg',
  'caption: inside a fence, shown rather than used',
  ':::',
  '```',
].join('\r\n');

describe('harvesting the gallery from the article', () => {
  const result = harvestMedia(ARTICLE);

  it('reads a ::: image container, including the ones nested inside ::: images', () => {
    expect(result.photos.map((photo) => photo.target)).toEqual([
      'photo/b/barrios.jpg',
      'photo/b/barrios1.jpg',
      'photo/b/barrios2.jpg',
      'photo/b/barrios_am.jpg',
    ]);
  });

  it('uses the caption as the label, which is the L1 half of the item', () => {
    expect(result.photos[0]).toEqual({ label: 'Агустин Барриос', target: 'photo/b/barrios.jpg' });
  });

  it('labels a tablature row from the work title, qualified by the link text', () => {
    expect(result.music).toEqual([
      { label: 'Julia Florida (Barcarola) — TAB', target: 'music/tab/abmjulf.txt' },
      { label: 'Julia Florida (Barcarola) — MP3', target: 'music/mp/juliaflorida.mp3' },
      { label: 'La Catedral — TAB', target: 'music/tab/abmcat.txt' },
      { label: 'La Catedral — MIDI', target: 'music/midi/abmcat.mid' },
    ]);
  });

  it('ignores navigation links and anchors', () => {
    const targets = [...result.photos, ...result.music].map((item) => item.target);
    expect(targets).not.toContain('/#/barrios-alternate');
    expect(targets).not.toContain('#1');
  });

  it('ignores a container inside a fenced block, where the syntax is shown rather than used', () => {
    expect(result.photos.map((photo) => photo.target)).not.toContain('photo/not-real.jpg');
  });

  it('survives CRLF, which is what a Windows checkout actually contains', () => {
    expect(result.photos.length).toBeGreaterThan(0);
  });

  it('honours the per-list ceiling and says that it did', () => {
    const capped = harvestMedia(ARTICLE, { photos: true, music: true, documents: true, maxItems: 2 });
    expect(capped.photos).toHaveLength(2);
    expect(capped.notes.join(' ')).toMatch(/only the first 2/);
  });

  it('collects nothing when every switch is off', () => {
    const off = harvestMedia(ARTICLE, { photos: false, music: false, documents: false, maxItems: 60 });
    expect(off.photos).toHaveLength(0);
    expect(off.music).toHaveLength(0);
    expect(off.documents).toHaveLength(0);
  });

  it('deduplicates by target, because array order is display order', () => {
    const twice = harvestMedia(['![A](photo/x.jpg)', '![B](photo/x.jpg)'].join('\n'));
    expect(twice.photos).toHaveLength(1);
  });
});

describe('harvesting the documents list from the article', () => {
  const result = harvestMedia(ARTICLE);
  const targets = result.documents.map((item) => item.target);

  it('takes every link to a page on another host', () => {
    expect(result.documents).toContainEqual({
      label: 'www.evafampas.gr',
      target: 'http://www.evafampas.gr/biosen.html',
    });
    // Protocol-relative is another host too: the scheme is inherited, not absent.
    expect(targets).toContain('//cdn.example.org/page.html');
  });

  it('takes a local link only when it points at a printable document', () => {
    expect(targets).toContain('articles/programme.pdf');
    expect(targets).toContain('scans/diploma.docx');
    // Same tree, nothing printable behind it.
    expect(targets).not.toContain('index.php');
    expect(targets).not.toContain('catalog/');
  });

  it('reads an escaped bracket inside the label as part of the label', () => {
    // `\[1957\]` used to end the label early and leave the target unparsed —
    // the defect `inline.ts` exists to prevent.
    const programme = result.documents.find((item) => item.target === 'articles/programme.pdf');
    expect(programme?.label).toBe('Программка [1957]');
  });

  it('leaves a mailto: and a tel: alone — they are actions, not resources', () => {
    expect(targets).not.toContain('mailto:ras1@bezeqint.net');
    expect(targets).not.toContain('tel:+972000000');
    expect(result.documents.map((item) => item.label)).not.toContain('ras1@bezeqint.net');
  });

  it('leaves navigation inside this catalogue alone, escaped label or not', () => {
    expect(targets).not.toContain('/#/villa-lobos1');
    expect(targets).not.toContain('/#/barrios-alternate');
    expect(targets).not.toContain('#1');
  });

  it('does not claim what the other two lists already own', () => {
    expect(targets).not.toContain('photo/b/barrios_cover.jpg');
    expect(targets).not.toContain('music/mp/juliaflorida.mp3');
    expect(targets).not.toContain('music/tab/abmjulf.txt');
  });

  it('labels a document in a table from the row, the way audio is labelled', () => {
    expect(result.documents).toContainEqual({ label: 'Диссертация — DOC', target: 'papers/thesis.doc' });
    expect(result.documents).toContainEqual({ label: 'Диссертация — Аннотация', target: 'papers/abstract.rtf' });
  });

  it('collects nothing when the switch is off', () => {
    const off = harvestMedia(ARTICLE, { photos: true, music: true, documents: false, maxItems: 60 });
    expect(off.documents).toHaveLength(0);
    expect(off.photos.length).toBeGreaterThan(0);
  });

  it('skips a fenced block, where the syntax is shown rather than used', () => {
    const fenced = ['```markdown', '[doc](http://example.org/a.html)', '```'].join('\n');
    expect(harvestMedia(fenced).documents).toHaveLength(0);
  });

  it('drops a link whose text is empty, because `label` is required', () => {
    expect(harvestMedia('[](http://example.org/a.html)').documents).toHaveLength(0);
  });
});
