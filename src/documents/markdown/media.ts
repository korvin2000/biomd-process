import { isAudioTarget, isImageTarget, isOpaque, targetExtension } from '../../domain/values.js';
import type { MediaItem } from '../../domain/types.js';

/**
 * The gallery, read straight out of the article.
 *
 * `media.photos` and `media.music` are pairs of a caption and a resource path —
 * and the article already contains both, spelled exactly, in its `::: image`
 * containers and its tablature tables. Asking a model to transcribe them is the
 * worst possible use of one: it costs tokens proportional to the whole document,
 * it is the field most likely to come back with an invented or subtly mistyped
 * path, and a wrong `target` is a broken image with no error anywhere.
 *
 * So they are parsed. This is not a Markdown parser — it is a scanner for the
 * three shapes this corpus actually uses:
 *
 * ```text
 * ::: image                          ![Caption](photo/x.jpg)
 * src: photo/b/barrios.jpg
 * caption: Агустин Барриос           | Julia Florida | [TAB](music/tab/jf.txt) |
 * :::
 * ```
 *
 * Fenced code is skipped, because a fence is where a document *shows* this
 * syntax rather than using it.
 */

export interface HarvestOptions {
  /** Collect `::: image` containers and inline images. */
  photos: boolean;
  /** Collect links whose target is audio, MIDI or a tablature file. */
  music: boolean;
  /** Ceiling per list — a discography table can hold a hundred rows. */
  maxItems: number;
}

export interface HarvestResult {
  photos: MediaItem[];
  music: MediaItem[];
  /**
   * Every image the article references, in document order, caption or not.
   *
   * Not the same list as {@link photos}: a gallery item needs a label
   * (`external/05` makes `label` required, and there is nowhere to invent one
   * from), so an uncaptioned `::: image` is correctly absent there. It is still
   * an image the article chose to show, which is exactly what the portrait
   * matcher wants — and in this corpus the entry's own photograph is uncaptioned
   * as often as not.
   */
  imageTargets: string[];
  notes: string[];
}

export const DEFAULT_HARVEST: HarvestOptions = { photos: true, music: true, maxItems: 60 };

const FENCE = /^\s*(`{3,}|~{3,})/;
const CONTAINER_OPEN = /^\s*:::\s*(\S+)\s*$/;
const CONTAINER_CLOSE = /^\s*:::\s*$/;
const ATTRIBUTE = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const INLINE_IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const LINK = /(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

export function harvestMedia(markdown: string, options: HarvestOptions = DEFAULT_HARVEST): HarvestResult {
  const photos = new Collector(options.maxItems);
  const music = new Collector(options.maxItems);
  const imageTargets: string[] = [];
  const seenTarget = new Set<string>();
  const sawImage = (target: string): void => {
    const clean = target.trim();
    if (!clean || clean.startsWith('#') || clean.includes('/#/')) return;
    if (seenTarget.has(clean) || imageTargets.length >= options.maxItems) return;
    seenTarget.add(clean);
    imageTargets.push(clean);
  };
  // Split on both line endings: a stray `\r` at the end of a line defeats every
  // `$`-anchored attribute pattern below, silently and on Windows only.
  const lines = markdown.split(/\r?\n/);

  let inFence = false;
  let fenceMarker = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker.startsWith(fenceMarker[0] ?? '`')) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const container = CONTAINER_OPEN.exec(line);
    if (container?.[1] === 'image' && options.photos) {
      const block = readAttributes(lines, index + 1);
      index = block.end;
      const target = block.attributes['src'];
      if (target) {
        sawImage(target);
        photos.add(block.attributes['caption'] ?? block.attributes['alt'] ?? '', target);
      }
      continue;
    }

    if (options.photos) {
      for (const match of line.matchAll(INLINE_IMAGE)) {
        sawImage(match[2] ?? '');
        photos.add(match[1] ?? '', match[2] ?? '');
      }
    }
    if (options.music) collectAudioLinks(line, music);
  }

  const notes: string[] = [];
  if (photos.truncated) notes.push(`Harvested only the first ${options.maxItems} photo(s) from the article.`);
  if (music.truncated) notes.push(`Harvested only the first ${options.maxItems} audio item(s) from the article.`);

  return { photos: photos.items, music: music.items, imageTargets, notes };
}

/**
 * Reads a container's `key: value` attribute lines up to its closing `:::`.
 *
 * Stops at a nested container too: `::: images` wraps several `::: image`
 * blocks, and consuming past the first close would swallow its siblings.
 */
function readAttributes(
  lines: readonly string[],
  start: number,
): { attributes: Record<string, string>; end: number } {
  const attributes: Record<string, string> = {};

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (CONTAINER_CLOSE.test(line) || CONTAINER_OPEN.test(line)) return { attributes, end: index };

    const attribute = ATTRIBUTE.exec(line);
    if (attribute?.[1]) attributes[attribute[1].toLowerCase()] = (attribute[2] ?? '').trim();
  }
  return { attributes, end: lines.length - 1 };
}

/**
 * Audio, MIDI and tablature links, labelled from their table row when they are
 * in one.
 *
 * `| Julia Florida | [TAB](…txt) | [MP3](…mp3) |` names the work once and links
 * it twice; the link text (`TAB`, `MP3`) is the format, not the title. So the
 * row's first cell becomes the label and the link text qualifies it — which is
 * exactly the shape the specification's own example uses
 * (`"La Catedral — табулатура"`).
 */
function collectAudioLinks(line: string, music: Collector): void {
  const row = tableCells(line);
  const title = row ? stripMarkdown(row[0] ?? '') : '';

  for (const match of line.matchAll(LINK)) {
    const label = (match[1] ?? '').trim();
    const target = match[2] ?? '';
    if (!isPlayable(target)) continue;

    music.add(title ? (label && label !== title ? `${title} — ${label}` : title) : label, target);
  }
}

/** Audio and MIDI by extension; `.txt` only where the path says tablature. */
function isPlayable(target: string): boolean {
  if (!target || target.startsWith('#')) return false;
  if (isAudioTarget(target)) return true;
  return targetExtension(target) === '.txt' && /(?:^|\/)(?:music|tab|tabs)\//i.test(target);
}

/** `| a | b |` → `["a", "b"]`; anything else is not a table row. */
function tableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

/** Emphasis, links and escapes removed — a label is plain text, never markup. */
function stripMarkdown(value: string): string {
  return value
    .replace(LINK, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\\([[\]])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Accumulates items, deduplicating by target and refusing anything that cannot
 * be rendered: array order is display order, and a duplicate target is the same
 * resource shown twice.
 */
class Collector {
  readonly items: MediaItem[] = [];
  truncated = false;
  private readonly seen = new Set<string>();

  constructor(private readonly limit: number) {}

  add(label: string, target: string): void {
    const cleanTarget = target.trim();
    const cleanLabel = stripMarkdown(label);
    if (!cleanTarget || !cleanLabel) return;
    // A cross-entry route (`/#/slug`) and a bare fragment are navigation, not media.
    if (cleanTarget.startsWith('#') || cleanTarget.includes('/#/')) return;
    if (this.seen.has(cleanTarget)) return;

    if (this.items.length >= this.limit) {
      this.truncated = true;
      return;
    }
    this.seen.add(cleanTarget);
    this.items.push({ label: cleanLabel, target: cleanTarget });
  }
}

export { isImageTarget, isOpaque };
