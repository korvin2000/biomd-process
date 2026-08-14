/**
 * Error taxonomy shared by every layer.
 *
 * Rules:
 *  - every thrown error carries a stable machine-readable `code`;
 *  - `details` is JSON-serializable so errors can be written to the run journal;
 *  - the original error is always kept in `cause`, never swallowed.
 */

import type { JsonObject } from './json.js';

export type ErrorDetails = Record<string, unknown>;

export abstract class AppError extends Error {
  abstract readonly code: string;

  readonly details: ErrorDetails;

  constructor(message: string, options: { details?: ErrorDetails; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.details = options.details ?? {};
    Error.captureStackTrace?.(this, new.target);
  }

  /** Journal-friendly projection. Never includes the stack by default. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      cause: describeCause(this.cause),
    };
  }
}

/** Configuration could not be read, parsed or validated. */
export class ConfigError extends AppError {
  readonly code = 'E_CONFIG';
}

/** A job could not be planned (bad input globs, unknown pipeline, …). */
export class PlanningError extends AppError {
  readonly code = 'E_PLANNING';
}

/** A pipeline failed for a domain reason (unparseable response, failed validation). */
export class PipelineError extends AppError {
  readonly code = 'E_PIPELINE';
}

/** Filesystem or path-template failure. */
export class IoError extends AppError {
  readonly code = 'E_IO';
}

/** A configured budget (requests / tokens / cost) was exhausted. */
export class BudgetExceededError extends AppError {
  readonly code = 'E_BUDGET';
}

/** Operation aborted by signal (Ctrl-C, shutdown, budget stop). */
export class AbortedError extends AppError {
  readonly code = 'E_ABORTED';
}

/** An operation exceeded its allotted time. */
export class TimeoutError extends AppError {
  readonly code = 'E_TIMEOUT';
}

export function describeCause(cause: unknown): unknown {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof AppError) return cause.toJSON();
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return String(cause);
}

/** Best-effort human message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

/**
 * Journal-friendly projection for any thrown value.
 *
 * The JSON round-trip is deliberate: it drops `undefined`, flattens anything a
 * provider attached to an error object, and guarantees the result can be written
 * to the JSONL journal without a serializer surprise on an error path.
 */
export function serializeError(error: unknown): JsonObject {
  const base =
    error instanceof AppError
      ? error.toJSON()
      : error instanceof Error
        ? { name: error.name, code: 'E_UNKNOWN', message: error.message, cause: describeCause(error.cause) }
        : { name: 'NonError', code: 'E_UNKNOWN', message: String(error) };

  try {
    return JSON.parse(JSON.stringify(base)) as JsonObject;
  } catch {
    return { name: 'UnserializableError', code: 'E_UNKNOWN', message: errorMessage(error) };
  }
}
