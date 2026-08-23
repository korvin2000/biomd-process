import { labelledPattern } from './inline.js';

/**
 * What the article calls itself, and what it says first.
 *
 * Two consumers need this and neither may pay a model for it:
 *
 *  - **the subject shape.** "Is this one guitarist or a quartet?" is answered by
 *    the title and never by the prose — `выступал в дуэте с Мелешко` is a
 *    sentence about one man, and a scan of the body would file him as a duo.
 *  - **the translation's context line.** A batch of twenty prose fragments
 *    translates better when the model knows the article is a biography of a
 *    Spanish luthier than when it is handed twenty sentences with no subject.
 *
 * The corpus writes its title two ways — an `# H1`, or a centered `::: align`
 * block where an H1 would be — so both are read. Nothing below the opening of
 * the document is: a `## ДИСКОГРАФИЯ` further down is a section, not a title.
 */

export interface DocumentTitle {
  /** The best single title line, with inline markup stripped. Empty when none. */
  title: string;
  /** Every title line found, in document order — an H1 split over two lines counts twice. */
  lines: string[];
  /** The first paragraph of the article's lead, with markup stripped. */
  lead: string;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const CONTAINER_OPEN = /^\s*:::\s*(\S+)\s*$/;
const CONTAINER_CLOSE = /^\s*:::\s*$/;
const HEADING = /^\s*(#{1,6})\s+(.*\S)\s*$/;
const ATTRIBUTE = /^\s*[A-Za-z][\w-]*\s*:\s*\S/;

/** How far into the document a centered block may still be the title. */
const TITLE_ZONE_LINES = 12;
/** A title is a name, not a sentence. */
const MAX_TITLE_LENGTH = 120;

export function readTitle(markdown: string, options: { leadChars?: number } = {}): DocumentTitle {
  const leadChars = options.leadChars ?? 400;
  const lines = markdown.split(/\r?\n/);

  const headings: string[] = [];
  const centered: string[] = [];
  let lead = '';

  let inFence = false;
  let fenceMarker = '';
  const containers: string[] = [];

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

    const open = CONTAINER_OPEN.exec(line);
    if (open?.[1]) {
      containers.push(open[1]);
      continue;
    }
    if (CONTAINER_CLOSE.test(line)) {
      containers.pop();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Only the top level: a level-2 heading is a section of the article.
      if ((heading[1] ?? '').length === 1) headings.push(strip(heading[2] ?? ''));
      continue;
    }

    const text = line.trim();
    if (!text || ATTRIBUTE.test(line)) continue;

    // A short line in a centered block near the top is how this corpus writes a
    // title when it does not write an H1.
    if (index < TITLE_ZONE_LINES && containers.includes('align') && text.length <= MAX_TITLE_LENGTH) {
      centered.push(strip(text));
      continue;
    }

    if (!lead && containers.includes('lead')) lead = strip(text);
  }

  // No `::: lead`? The first ordinary paragraph is the lead.
  if (!lead) lead = firstParagraph(lines);

  const titleLines = (headings.length > 0 ? headings : centered).filter(Boolean);
  return {
    title: titleLines.join(' ').trim(),
    lines: titleLines,
    lead: lead.slice(0, leadChars).trim(),
  };
}

function firstParagraph(lines: readonly string[]): string {
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    const text = line.trim();
    if (inFence || !text) continue;
    if (text.startsWith(':::') || text.startsWith('#') || ATTRIBUTE.test(line)) continue;
    if (/^([-*_])(\s*\1){2,}$/.test(text) || /^[-*+]\s/.test(text) || text.startsWith('|')) continue;
    return strip(text);
  }
  return '';
}

/**
 * Inline markup removed, the words kept.
 *
 * A title is used as *text* — matched against a word list, shown to a model as
 * context — so `**Д****е РИЖКЕ,**` has to read as `Де РИЖКЕ,` and a link has to
 * keep its label rather than its URL.
 */
export function strip(text: string): string {
  return text
    .replace(labelledPattern(), '$1')
    .replace(/[*_~=`]+/g, '')
    .replace(/\\$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
