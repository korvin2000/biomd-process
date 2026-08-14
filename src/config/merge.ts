export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Layered override merge: plain objects merge recursively, everything else
 * (arrays included) replaces. Replacing arrays wholesale is intentional —
 * `--lang en,de` must mean exactly those languages, not "append to the file's list".
 */
export function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drops `undefined` leaves so CLI overrides only carry values the user actually set. */
export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(pruneUndefined) as unknown as T;
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const pruned = pruneUndefined(item);
    if (isPlainObject(pruned) && Object.keys(pruned).length === 0) continue;
    result[key] = pruned;
  }
  return result as T;
}
