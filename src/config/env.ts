/**
 * `${VAR}` / `${VAR:-fallback}` interpolation over an already-parsed config tree.
 *
 * Working on the parsed tree rather than the raw text keeps YAML types intact
 * (numbers stay numbers) and avoids mangling `${...}` that happens to appear
 * inside a prompt path or a glob.
 */

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface InterpolationResult<T> {
  value: T;
  /** Names referenced by the config but absent from the environment. */
  missing: string[];
}

export function interpolateEnv<T>(input: T, env: NodeJS.ProcessEnv = process.env): InterpolationResult<T> {
  const missing = new Set<string>();
  const value = walk(input, env, missing) as T;
  return { value, missing: [...missing].sort() };
}

function walk(node: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof node === 'string') return substitute(node, env, missing);
  if (Array.isArray(node)) return node.map((item) => walk(item, env, missing));
  if (node && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      result[key] = walk(item, env, missing);
    }
    return result;
  }
  return node;
}

function substitute(text: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return text.replace(REFERENCE, (_match, name: string, fallback: string | undefined) => {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return '';
  });
}
