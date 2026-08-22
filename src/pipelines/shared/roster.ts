/**
 * The roster lookup, in one place.
 *
 * Three pipelines ask the same question — "does the roster know this article?"
 * — with the same two config values, and the answer is the same object every
 * time because the store caches the file. Keeping the call here means a change
 * to the join (a slug convention, a second key) lands once.
 */

import type { AppConfig } from '../../config/schema.js';
import type { NameRosterStore } from '../../roster/NameRosterStore.js';
import type { RosterEntry } from '../../roster/types.js';

/**
 * The roster's entry for one document, or `undefined`.
 *
 * `undefined` is the *normal* answer for about a quarter of this corpus: the
 * roster covers 739 of roughly a thousand articles. Nothing may depend on it.
 */
export async function rosterEntryFor(
  item: { slug: string },
  config: AppConfig,
  store: NameRosterStore,
): Promise<RosterEntry | undefined> {
  if (!config.roster.file.trim()) return undefined;

  const roster = await store.load(config.roster.file, {
    slugSuffix: config.input.slugSuffix,
    language: config.roster.language,
  });
  return roster.bySlug.get(item.slug);
}
