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
    const capped = harvestMedia(ARTICLE, { photos: true, music: true, maxItems: 2 });
    expect(capped.photos).toHaveLength(2);
    expect(capped.notes.join(' ')).toMatch(/only the first 2/);
  });

  it('collects nothing when both switches are off', () => {
    const off = harvestMedia(ARTICLE, { photos: false, music: false, maxItems: 60 });
    expect(off.photos).toHaveLength(0);
    expect(off.music).toHaveLength(0);
  });

  it('deduplicates by target, because array order is display order', () => {
    const twice = harvestMedia(['![A](photo/x.jpg)', '![B](photo/x.jpg)'].join('\n'));
    expect(twice.photos).toHaveLength(1);
  });
});
