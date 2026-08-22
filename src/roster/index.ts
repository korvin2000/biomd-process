/**
 * The name roster: a second opinion about who an article is about.
 *
 * Everything the roster format means lives here, the way `src/images` owns the
 * image index and `src/domain` owns the published one. It depends on `domain`
 * (for the collective vocabulary) and on `shared`, and on nothing else.
 */

export * from './types.js';
export * from './entry.js';
export * from './NameRosterStore.js';
