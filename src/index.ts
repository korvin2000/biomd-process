/**
 * Public API.
 *
 * The CLI is one consumer of this surface, not a privileged one: a host
 * application can load a config, register its own pipelines or routing
 * strategies, and drive a run itself.
 */
export * from './app/index.js';
export * from './config/index.js';
export * from './core/index.js';
export * from './llm/index.js';
export * from './routing/index.js';
export * from './reliability/index.js';
export * from './prompts/index.js';
export * from './documents/index.js';
export * from './domain/index.js';
export * from './io/index.js';
export * from './state/index.js';
export * from './observability/index.js';
export * from './pipelines/index.js';
export {
  AppError,
  ConfigError,
  PipelineError,
  PlanningError,
  IoError,
  BudgetExceededError,
  AbortedError,
  TimeoutError,
  serializeError,
} from './shared/errors.js';
export type { JsonObject, JsonValue } from './shared/json.js';
