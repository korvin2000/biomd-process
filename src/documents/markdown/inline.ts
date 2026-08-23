/**
 * The one definition of an inline link or image, shared by everything that has
 * to recognize one.
 *
 * Five modules used to carry their own copy of `\[[^\]]*\]\(…\)`, and the copies
 * agreed until a label contained an escaped bracket. `[\[ \* \]](#1)` — the
 * footnote marker this corpus writes — is a link, and `[^\]]*` cannot cross the
 * `\]` in the middle of it, so every one of those regexes read it as ordinary
 * text. The consequences were not symmetrical:
 *
 *   - `textSpans` did not mask the target, so `(#1)` was sent to the model
 *     rather than protected behind a `⟦n⟧` token — in the one mode whose whole
 *     premise is that a URL never reaches a model;
 *   - `skeleton` did not count it, so the *source* had no link there while the
 *     translation — where the model had simplified the label to `[\*]` — did.
 *     One extra structural token, and `albert → en` failed the strict guard and
 *     published no English edition at all.
 *
 * A label is CommonMark inline content, which can nest arbitrarily; matching it
 * exactly needs a parser. What it cannot contain is an *unescaped* bracket, and
 * that is the whole of the difference here: the label alternates "a backslash
 * and whatever it escapes" with "any character that is neither a backslash nor
 * a bracket", so an escaped `\]` is consumed as one unit and only a real
 * closing bracket ends the label.
 */

/** A link/image label: escaped characters count as one, brackets end it. */
const LABEL = String.raw`(?:\\.|[^\]\\])*`;

/** `![alt](target)` — the target captured. */
export const IMAGE_PATTERN = String.raw`!\[(${LABEL})\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)`;

/** `[label](target)`, never an image — label and target captured. */
export const LINK_PATTERN = String.raw`(?<!!)\[(${LABEL})\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)`;

/** Either, with the opening, the target and the closing captured separately. */
export const LINK_TARGET_PATTERN = String.raw`(!?\[${LABEL}\]\()([^)\s]+)((?:\s+"[^"]*")?\))`;

/** `[label](target)` or `![label](target)` — for reducing one to its label. */
export const LABELLED_PATTERN = String.raw`!?\[(${LABEL})\]\([^)]*\)`;

/** A fresh global regex — `lastIndex` is per-object, so these are never shared. */
export const imagePattern = (): RegExp => new RegExp(IMAGE_PATTERN, 'g');
export const linkPattern = (): RegExp => new RegExp(LINK_PATTERN, 'g');
export const linkTargetPattern = (): RegExp => new RegExp(LINK_TARGET_PATTERN, 'g');
export const labelledPattern = (): RegExp => new RegExp(LABELLED_PATTERN, 'g');
