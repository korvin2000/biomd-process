export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ParseOk<T> {
  ok: true;
  value: T;
}
export interface ParseFail {
  ok: false;
  error: string;
}
export type ParseResult<T> = ParseOk<T> | ParseFail;

export function safeJsonParse<T = JsonValue>(raw: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Extracts the first complete JSON object or array from free-form model output.
 *
 * Models wrap JSON in prose or fences even when told not to; this recovers the
 * payload without a second, paid round-trip. Quote- and escape-aware so braces
 * inside strings do not end the scan early.
 */
export function extractJsonBlock(raw: string): string | undefined {
  const text = stripCodeFence(raw.trim());
  const start = firstIndexOfAny(text, ['{', '[']);
  if (start < 0) return undefined;

  const opener = text[start] as '{' | '[';
  const closer = opener === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function stripCodeFence(text: string): string {
  const fenced = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  return fenced?.[1] ?? text;
}

function firstIndexOfAny(text: string, chars: string[]): number {
  const positions = chars.map((c) => text.indexOf(c)).filter((i) => i >= 0);
  return positions.length ? Math.min(...positions) : -1;
}
