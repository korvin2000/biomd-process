/**
 * The name roster — an extracted index of the corpus's own name list.
 *
 * This is an **input** format, like `images/artists.json` and unlike anything in
 * `src/domain`: it is not published, it is not normative, and it is not
 * guaranteed to be right. It is a hand-maintained list that the site was built
 * from, so it knows things no reading of one article can — the family name of a
 * person the article only ever calls by a patronymic, the spelling variant a
 * reader is likely to type, the collective's own title.
 *
 * It is also wrong in places (`authors.bio.md` is a page title split across the
 * name columns), incomplete (739 records against a corpus of about a thousand),
 * and written in exactly one language. Every consumer therefore treats it as a
 * *second opinion*: it fills a gap the article left, it contributes a search
 * alias, and it never overwrites a fact the article states.
 */

import type { EnsembleResolution } from '../domain/vocabulary.js';

/** One record of `names.json`, exactly as the file carries it. */
export interface RawRosterRecord {
  fullname?: string;
  surname?: string;
  forename?: string;
  patronymic?: string;
  url?: string;
  aliases?: string[];
}

/** A record after normalization, with everything a consumer needs precomputed. */
export interface RosterEntry {
  /** The article this names: `am_trio.bio.md`. */
  file: string;
  /** The article's slug: `am_trio`. The join key. */
  slug: string;
  /** The roster's own spelling, in its own order (`Носкова Е. Н.`). */
  fullName: string;
  /** Present only when {@link personName} — the parts read as a person's name. */
  surname?: string;
  /**
   * Given name, with the patronymic appended when the roster carries one:
   * `Е. Н.`. The dossier has no patronymic member and inventing one would put a
   * non-format field into a published document, so it travels with the forename
   * — which is also how these articles write it.
   */
  forename?: string;
  patronymic?: string;
  /** Hand-authored alternative spellings, pseudonyms and second names. */
  aliases: readonly string[];
  /** Natural reading order: `Е. Н. Носкова`, or the collective's own title. */
  displayName: string;
  /** Whether the entry names a collective, and how many people it has. */
  ensemble: EnsembleResolution;
  /**
   * False when the name columns do not read as a person's name.
   *
   * `authors.bio.md` is filed as surname `"Музыкальные пристрастия –"`, forename
   * `"музыка"`, patronymic `"гитариста"` — a page title chopped into three
   * columns. Publishing that as somebody's family name is worse than publishing
   * nothing, so such an entry keeps its {@link fullName} and its aliases (both
   * still usable as search text) and contributes no name components at all.
   */
  personName: boolean;
}

export interface NameRoster {
  entries: readonly RosterEntry[];
  /** Slug → entry. The only lookup any consumer needs. */
  bySlug: ReadonlyMap<string, RosterEntry>;
  /** The language the roster is written in; its names belong to that edition. */
  language: string;
  /** Where it was read from, for diagnostics. */
  source: string;
  /** Records dropped as unusable, so a silent load failure is still visible. */
  skipped: number;
  /** Records whose name columns did not read as a person's name. */
  nonNameRecords: number;
}

/** The empty roster — what every consumer sees when the feature is off. */
export const EMPTY_ROSTER: NameRoster = {
  entries: [],
  bySlug: new Map(),
  language: '',
  source: '(none)',
  skipped: 0,
  nonNameRecords: 0,
};
