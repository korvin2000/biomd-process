/**
 * The catalogue data format, implemented once.
 *
 * `external/` is the normative specification of a format this tool *produces*
 * but does not own: a separate reader application consumes it. Everything the
 * format requires — value grammars, enumerations, referential rules, the
 * version 1 migration, the invariant catalogue — lives in this directory and
 * nowhere else, so that `core`, `routing` and `reliability` stay ignorant of
 * guitarists, and so that a specification change has exactly one landing site.
 */

export * from './types.js';
export * from './values.js';
export * from './vocabulary.js';
export * from './countries.js';
export * from './dossier.js';
export * from './catalog.js';
export * from './validate.js';
