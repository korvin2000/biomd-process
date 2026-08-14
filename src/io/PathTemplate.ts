import { IoError } from '../shared/errors.js';

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * Characters removed from a substituted value: those illegal in a Windows path
 * component, plus both separators. A substituted value must never introduce a
 * directory level of its own. Hyphens, dots and spaces are legal and are kept —
 * slugs like `paco-de-lucia` depend on it.
 */
const UNSAFE_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*', '/', '\\']);

export type PathVars = Record<string, string | number | undefined>;

/**
 * `{placeholder}` path templates.
 *
 * Output layout is a policy decision, so it lives in config rather than in the
 * pipelines. Unknown placeholders fail loudly at render time — a typo that
 * silently produced `out/{targetLang}/x.json` as a literal directory would be
 * discovered only after a full run.
 */
export function renderPathTemplate(template: string, vars: PathVars): string {
  const missing: string[] = [];

  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return sanitizeSegment(String(value));
  });

  if (missing.length > 0) {
    throw new IoError(`Path template "${template}" has unresolved placeholder(s): ${missing.join(', ')}`, {
      details: { template, missing, available: Object.keys(vars).sort() },
    });
  }
  return normalizeSlashes(rendered);
}

export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

/**
 * Values may come from a model, so they are untrusted: strip anything that
 * could escape the output directory or break a path, then collapse `..`.
 */
export function sanitizeSegment(value: string): string {
  let result = '';
  for (const char of value) {
    if (UNSAFE_CHARS.has(char)) continue;
    if ((char.codePointAt(0) ?? 0) < 0x20) continue;
    result += char;
  }
  return result.replace(/\.{2,}/g, '.').trim();
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}
