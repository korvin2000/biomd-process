import { z } from 'zod';

/**
 * The single source of truth for configuration.
 *
 * Every field has a default wherever a sane default exists, so a minimal config
 * file stays short. Anything without a default is genuinely required (there is
 * no reasonable guess for an endpoint URL or a model name).
 */

const identifier = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'must be a slug: letters, digits, dot, dash, underscore');

const languageCode = z
  .string()
  .min(2)
  .max(12)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'must be a BCP-47-ish language code, e.g. "en", "pt-BR"');

// ---------------------------------------------------------------------------
// LLM endpoints and models
// ---------------------------------------------------------------------------

export const reasoningDialectSchema = z.enum([
  /** `reasoning_effort: "low" | ...` — OpenAI o-series, most gateways. */
  'reasoning_effort',
  /** `reasoning: { effort, max_tokens }` — OpenRouter. */
  'reasoning',
  /** `thinking: { type, budget_tokens }` — Anthropic-style gateways. */
  'thinking',
  /** Model does not accept reasoning parameters. */
  'none',
]);

export const reasoningSchema = z.object({
  enabled: z.boolean().default(false),
  effort: z.enum(['minimal', 'low', 'medium', 'high']).default('medium'),
  dialect: reasoningDialectSchema.default('reasoning_effort'),
  /** Upper bound on thinking tokens, for dialects that accept one. */
  maxTokens: z.number().int().positive().optional(),
  /** Keep reasoning traces out of the parsed answer. Costs nothing to leave on. */
  exclude: z.boolean().default(true),
});

export const capabilitySchema = z.enum([
  'json_schema',
  'json_object',
  'tools',
  'reasoning',
  'prompt_cache',
  'vision',
]);

export const pricingSchema = z.object({
  inputPer1M: z.number().nonnegative().default(0),
  outputPer1M: z.number().nonnegative().default(0),
  /** Price of a cache hit on input tokens; defaults to `inputPer1M` when absent. */
  cachedInputPer1M: z.number().nonnegative().optional(),
  reasoningPer1M: z.number().nonnegative().optional(),
});

export const endpointSchema = z.object({
  id: identifier,
  /** OpenAI-compatible base URL, e.g. http://localhost:4000/v1 */
  baseUrl: z.string().url(),
  apiKey: z.string().default(''),
  organization: z.string().optional(),
  /** Extra headers — e.g. OpenRouter's HTTP-Referer / X-Title. */
  headers: z.record(z.string()).default({}),
  /** Extra query parameters appended to every request. */
  query: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
  /** Per-endpoint concurrency ceiling; 0 = inherit run concurrency. */
  maxConcurrent: z.number().int().nonnegative().default(0),
  /** Client-side throttle; 0 = unlimited. */
  requestsPerMinute: z.number().int().nonnegative().default(0),
  enabled: z.boolean().default(true),
});

export const modelSchema = z.object({
  /** Local alias used by pools and logs. */
  id: identifier,
  /** Endpoint id this model is served from. */
  endpoint: identifier,
  /** Model name as the endpoint knows it, e.g. "openai/gpt-4o-mini". */
  model: z.string().min(1),
  contextWindow: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(4096),
  /** Reasoning-era models reject `max_tokens`; some gateways reject the new name. */
  maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  pricing: pricingSchema.default({}),
  reasoning: reasoningSchema.default({}),
  capabilities: z.array(capabilitySchema).default([]),
  /** Free-form labels usable by custom routing strategies. */
  tags: z.array(z.string()).default([]),
  /** Sampling and friends, merged over `llm.defaults.params`. */
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      frequencyPenalty: z.number().min(-2).max(2).optional(),
      presencePenalty: z.number().min(-2).max(2).optional(),
      seed: z.number().int().optional(),
      stop: z.array(z.string()).optional(),
      /** Escape hatch for endpoint-specific parameters. */
      extra: z.record(z.unknown()).optional(),
    })
    .default({}),
  /** Relative preference for strategies that need a tie-break. Higher wins. */
  weight: z.number().default(1),
  enabled: z.boolean().default(true),
});

export const routingSchema = z.object({
  /** Registered strategy id: cost-optimized | context-optimized | sequential | round-robin | … */
  strategy: identifier.default('cost-optimized'),
  /**
   * Named candidate pools. `default` is used by any task without its own pool.
   * An empty pool list means "every enabled model".
   */
  pools: z.record(z.array(identifier)).default({}),
  /** Strategy-specific knobs, validated by the strategy itself. */
  options: z.record(z.unknown()).default({}),
});

export const llmSchema = z.object({
  endpoints: z.array(endpointSchema).min(1),
  models: z.array(modelSchema).min(1),
  routing: routingSchema.default({}),
  defaults: z
    .object({
      timeoutMs: z.number().int().positive().default(120_000),
      params: z
        .object({
          temperature: z.number().min(0).max(2).default(0.2),
          topP: z.number().min(0).max(1).optional(),
        })
        .default({}),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// Reliability
// ---------------------------------------------------------------------------

export const reliabilitySchema = z
  .object({
    retry: z
      .object({
        /** Attempts per model target, including the first one. */
        maxAttempts: z.number().int().min(1).max(10).default(3),
        initialDelayMs: z.number().int().positive().default(500),
        maxDelayMs: z.number().int().positive().default(20_000),
        factor: z.number().min(1).default(2),
        jitter: z.enum(['none', 'full', 'equal']).default('full'),
        /** Honour a server-provided Retry-After header over the computed backoff. */
        respectRetryAfter: z.boolean().default(true),
      })
      .default({}),
    fallback: z
      .object({
        /** How many distinct model targets a single logical call may try. */
        maxTargets: z.number().int().min(1).max(10).default(3),
        /** Try the next target when the response fails domain validation. */
        onValidationFailure: z.boolean().default(true),
      })
      .default({}),
    circuitBreaker: z
      .object({
        enabled: z.boolean().default(true),
        failureThreshold: z.number().int().min(1).default(5),
        resetAfterMs: z.number().int().positive().default(30_000),
        halfOpenMaxCalls: z.number().int().min(1).default(1),
      })
      .default({}),
  })
  .default({});

// ---------------------------------------------------------------------------
// Cost control
// ---------------------------------------------------------------------------

export const costSchema = z
  .object({
    /** 0 = unlimited for every budget field. */
    budget: z
      .object({
        maxRequests: z.number().int().nonnegative().default(0),
        maxTotalTokens: z.number().int().nonnegative().default(0),
        maxCostUsd: z.number().nonnegative().default(0),
      })
      .default({}),
    onExceeded: z.enum(['stop', 'warn']).default('stop'),
  })
  .default({});

// ---------------------------------------------------------------------------
// Document context handling
// ---------------------------------------------------------------------------

export const contextSchema = z
  .object({
    /** Registered context strategy id. */
    strategy: identifier.default('truncation-first'),
    tokenEstimator: z
      .object({
        type: z.enum(['heuristic']).default('heuristic'),
        /** Average characters per token; latin ≈ 4, cyrillic/cjk are denser. */
        charsPerToken: z.number().positive().default(3.2),
      })
      .default({}),
    /** Output tokens reserved inside the context window before fitting input. */
    reserveOutputTokens: z.number().int().nonnegative().default(2048),
    /** Fraction of the context window we are willing to fill. */
    safetyMarginRatio: z.number().min(0.1).max(1).default(0.9),
    truncation: z
      .object({
        headTokens: z.number().int().positive().default(1500),
        tailTokens: z.number().int().nonnegative().default(0),
      })
      .default({}),
    chunking: z
      .object({
        maxTokens: z.number().int().positive().default(2500),
        overlapTokens: z.number().int().nonnegative().default(150),
        /** Preferred split boundary; falls back down the list when needed. */
        splitOn: z.enum(['heading', 'paragraph', 'line']).default('heading'),
      })
      .default({}),
    options: z.record(z.unknown()).default({}),
  })
  .default({});

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export const inputSchema = z.object({
  /** Root the globs are resolved against, relative to `project.rootDir`. */
  baseDir: z.string().default('.'),
  include: z.array(z.string()).min(1).default(['**/*.bio.md']),
  exclude: z.array(z.string()).default(['**/node_modules/**', '**/dist/**']),
  /**
   * Source language of the corpus. `auto` infers it from the first path segment
   * under `baseDir` (`examples/ru/x.bio.md` → `ru`).
   */
  sourceLanguage: z.union([z.literal('auto'), languageCode]).default('auto'),
  /** Stripped from the filename to derive `{slug}`. */
  slugSuffix: z.string().default('.bio.md'),
  encoding: z.enum(['utf8']).default('utf8'),
  /** 0 = no limit. Useful for a cheap first pass over a big corpus. */
  limit: z.number().int().nonnegative().default(0),
});

export const outputSchema = z.object({
  baseDir: z.string().default('out'),
  /**
   * Channel → path template, relative to `baseDir`.
   * Placeholders: {slug} {lang} {sourceLang} {targetLang} {pipeline} {taskId} {runId}
   * plus anything a pipeline puts into the artifact's `pathVars`.
   * `{lang}` is always the language of the produced artifact.
   */
  channels: z
    .record(z.string().min(1))
    .default({
      metadata: '{lang}/{slug}.bio.json',
      translation: '{lang}/{slug}.bio.md',
      catalogIndex: 'index.json',
      catalogLocalizedIndex: 'index-{lang}.json',
    }),
  onExisting: z.enum(['skip', 'overwrite', 'fail']).default('overwrite'),
  /** Pretty-print JSON artifacts. */
  jsonIndent: z.number().int().min(0).max(8).default(2),
  /** Trailing newline on every written artifact. */
  finalNewline: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const taskBase = z.object({
  enabled: z.boolean().default(false),
  /** Routing pool name; falls back to `default`. */
  pool: identifier.optional(),
  /** Per-task override of the global context strategy. */
  contextStrategy: identifier.optional(),
  /** Extra variables handed to this task's prompt templates. */
  promptVariables: z.record(z.unknown()).default({}),
});

export const extractTaskSchema = taskBase
  .extend({
    outputChannel: z.string().default('metadata'),
    /** Fail the task when the model returns none of these fields. */
    requiredFields: z.array(z.string()).default([]),
    /** TODO(domain): point at a JSON Schema file to override the built-in contract. */
    schemaFile: z.string().optional(),
  })
  .default({});

export const translateTaskSchema = taskBase
  .extend({
    outputChannel: z.string().default('translation'),
    targetLanguages: z.array(languageCode).default([]),
    /** Never translate a document into the language it is already in. */
    skipSourceLanguage: z.boolean().default(true),
    /** Reject a translation whose Markdown skeleton diverges from the source. */
    verifyStructure: z.boolean().default(true),
    /**
     * `segments` sends only the translatable prose, with markup, containers,
     * code and URLs held back and spliced in locally — cheaper, and structurally
     * safe by construction. `document` sends the whole Markdown, which gives the
     * model maximum surrounding context at the cost of tokens and of trusting it
     * with the markup.
     */
    mode: z.enum(['segments', 'document']).default('segments'),
    /** Text spans per LLM call in `segments` mode. */
    maxSegmentsPerCall: z.number().int().positive().default(40),
    /** Reuse the translation of an identical span across the whole run. */
    useTranslationMemory: z.boolean().default(true),
  })
  .default({});

/**
 * Dossier fields whose values are prose and therefore translated. An allowlist,
 * because the format guide requires unknown fields to be preserved rather than
 * guessed at — and because everything absent from this list (`dates`, `ranking`,
 * `url`, every `target`) is then language-invariant *by construction*, never
 * sent to a model and never at risk of being rewritten.
 *
 * `*` matches one path segment, which is how array elements are addressed.
 */
const DEFAULT_LOCALIZABLE_FIELDS = [
  'metadata.forename',
  'metadata.surname',
  'metadata.birthname',
  'metadata.birthplace',
  'metadata.deathplace',
  'metadata.relatives',
  'metadata.instruments',
  'metadata.genres',
  'metadata.bands',
  'metadata.awards',
  'metadata.teachers',
  'metadata.disciples',
  'metadata.jobs',
  'media.photos.*.label',
  'media.music.*.label',
  'documents.*.label',
];

/** Fields the format guide encodes as comma-separated lists. */
const DEFAULT_LIST_FIELDS = [
  'metadata.relatives',
  'metadata.instruments',
  'metadata.genres',
  'metadata.bands',
  'metadata.awards',
  'metadata.teachers',
  'metadata.disciples',
  'metadata.jobs',
];

export const localizeTaskSchema = taskBase
  .extend({
    outputChannel: z.string().default('metadata'),
    /** Empty inherits `tasks.translate.targetLanguages`. */
    targetLanguages: z.array(languageCode).default([]),
    skipSourceLanguage: z.boolean().default(true),
    localizableFields: z.array(z.string()).default(DEFAULT_LOCALIZABLE_FIELDS),
    listFields: z.array(z.string()).default(DEFAULT_LIST_FIELDS),
    /** Strings per LLM call. Larger batches cost fewer requests but risk truncation. */
    maxStringsPerCall: z.number().int().positive().default(60),
    /** Reuse a translation of the same source string across the whole run. */
    useTranslationMemory: z.boolean().default(true),
  })
  .default({});

/**
 * Catalogue aggregation. Promptless and LLM-free: it reads what the other
 * pipelines produced and indexes it.
 */
export const catalogTaskSchema = z
  .object({
    enabled: z.boolean().default(false),
    indexChannel: z.string().default('catalogIndex'),
    localizedIndexChannel: z.string().default('catalogLocalizedIndex'),
    /** Emit `index-<lang>.json` display-name files alongside `index.json`. */
    localizedNames: z.boolean().default(true),
    /** Keep ids from an existing index at the output path; ids must never be reused. */
    preserveIds: z.boolean().default(true),
    /** TODO(domain): classification is not derivable from a dossier yet. */
    defaultType: z.string().default('musician'),
  })
  .default({});

export const tasksSchema = z
  .object({
    extract: extractTaskSchema,
    translate: translateTaskSchema,
    localize: localizeTaskSchema,
    catalog: catalogTaskSchema,
  })
  .default({});

/** Tasks that drive an LLM and therefore require prompt templates. */
const LLM_TASK_IDS = new Set(['extract', 'translate', 'localize']);

// ---------------------------------------------------------------------------
// Prompts, run, logging
// ---------------------------------------------------------------------------

export const promptsSchema = z
  .object({
    dir: z.string().default('prompts'),
    templates: z
      .record(z.object({ system: z.string().min(1), user: z.string().min(1) }))
      .default({
        extract: { system: 'extraction/system.md', user: 'extraction/user.md' },
        translate: { system: 'translation/system.md', user: 'translation/user.md' },
        translateSegments: { system: 'translation/segments-system.md', user: 'translation/segments-user.md' },
        localize: { system: 'localization/system.md', user: 'localization/user.md' },
      }),
    /** Variables available to every template. */
    variables: z.record(z.unknown()).default({}),
  })
  .default({});

export const runSchema = z
  .object({
    concurrency: z.number().int().min(1).max(64).default(4),
    stateDir: z.string().default('.biomd/runs'),
    /** `auto` resumes the latest unfinished run; a run id resumes that one. */
    resume: z.union([z.literal('auto'), z.literal('off'), z.string().min(1)]).default('auto'),
    dryRun: z.boolean().default(false),
    /** Stop the whole run on the first task failure. */
    failFast: z.boolean().default(false),
    /** Skip planning a task whose output file already exists. */
    skipExistingOutputs: z.boolean().default(false),
  })
  .default({});

export const loggingSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    console: z.enum(['pretty', 'json', 'off']).default('pretty'),
    /** Path to a JSONL log file; null disables file logging. */
    file: z.string().nullable().default('.biomd/logs/biomd.jsonl'),
  })
  .default({});

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const appConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    project: z
      .object({
        name: z.string().default('biomd-process'),
        /** All relative paths resolve against this, itself relative to the config file. */
        rootDir: z.string().default('.'),
      })
      .default({}),
    input: inputSchema.default({}),
    output: outputSchema.default({}),
    tasks: tasksSchema,
    llm: llmSchema,
    reliability: reliabilitySchema,
    cost: costSchema,
    context: contextSchema,
    prompts: promptsSchema,
    run: runSchema,
    logging: loggingSchema,
  })
  .strict()
  .superRefine(crossFieldChecks);

export type AppConfig = z.infer<typeof appConfigSchema>;
export type AppConfigInput = z.input<typeof appConfigSchema>;
export type EndpointConfig = z.infer<typeof endpointSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type RoutingConfig = z.infer<typeof routingSchema>;
export type ReliabilityConfig = z.infer<typeof reliabilitySchema>;
export type CostConfig = z.infer<typeof costSchema>;
export type ContextConfig = z.infer<typeof contextSchema>;
export type InputConfig = z.infer<typeof inputSchema>;
export type OutputConfig = z.infer<typeof outputSchema>;
export type TasksConfig = z.infer<typeof tasksSchema>;
export type ExtractTaskConfig = z.infer<typeof extractTaskSchema>;
export type TranslateTaskConfig = z.infer<typeof translateTaskSchema>;
export type LocalizeTaskConfig = z.infer<typeof localizeTaskSchema>;
export type CatalogTaskConfig = z.infer<typeof catalogTaskSchema>;
export type PromptsConfig = z.infer<typeof promptsSchema>;
export type RunConfig = z.infer<typeof runSchema>;
export type LoggingConfig = z.infer<typeof loggingSchema>;
export type Reasoning = z.infer<typeof reasoningSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type Pricing = z.infer<typeof pricingSchema>;

/**
 * Referential integrity that Zod cannot express field-locally: every model must
 * point at a declared endpoint, every pool at declared models, and every enabled
 * task at a declared prompt template and output channel.
 */
function crossFieldChecks(config: z.infer<typeof rawShape>, ctx: z.RefinementCtx): void {
  const endpointIds = new Set(config.llm.endpoints.map((e) => e.id));
  const modelIds = new Set(config.llm.models.map((m) => m.id));

  config.llm.models.forEach((model, index) => {
    if (!endpointIds.has(model.endpoint)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'models', index, 'endpoint'],
        message: `Unknown endpoint "${model.endpoint}". Declared: ${[...endpointIds].join(', ') || '(none)'}`,
      });
    }
  });

  const routing = config.llm.routing;
  for (const [pool, members] of Object.entries(routing.pools)) {
    members.forEach((memberId, index) => {
      if (!modelIds.has(memberId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['llm', 'routing', 'pools', pool, index],
          message: `Unknown model "${memberId}". Declared: ${[...modelIds].join(', ') || '(none)'}`,
        });
      }
    });
  }

  const requireChannel = (taskId: string, channel: string): void => {
    if (config.output.channels[channel]) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['output', 'channels', channel],
      message: `Task "${taskId}" writes to channel "${channel}", which has no path template.`,
    });
  };

  for (const [taskId, task] of Object.entries(config.tasks)) {
    if (!task.enabled) continue;

    if (LLM_TASK_IDS.has(taskId) && !config.prompts.templates[taskId]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompts', 'templates', taskId],
        message: `Task "${taskId}" is enabled but has no prompt templates.`,
      });
    }
    if ('outputChannel' in task) requireChannel(taskId, task.outputChannel);
    if ('pool' in task && task.pool && !routing.pools[task.pool]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'routing', 'pools', task.pool],
        message: `Task "${taskId}" uses routing pool "${task.pool}", which is not defined.`,
      });
    }
  }

  if (config.tasks.translate.enabled) {
    if (config.tasks.translate.targetLanguages.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tasks', 'translate', 'targetLanguages'],
        message: 'Translation is enabled but no target languages are listed.',
      });
    }
    if (config.tasks.translate.mode === 'segments' && !config.prompts.templates['translateSegments']) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompts', 'templates', 'translateSegments'],
        message: 'Segment-mode translation needs its own prompt templates (prompts.templates.translateSegments).',
      });
    }
  }

  // Localization inherits its languages from translation, so "neither is set"
  // is the only combination that leaves it with nothing to do.
  const localizeLanguages = config.tasks.localize.targetLanguages.length || config.tasks.translate.targetLanguages.length;
  if (config.tasks.localize.enabled && localizeLanguages === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tasks', 'localize', 'targetLanguages'],
      message:
        'Metadata localization is enabled but no target languages are listed, ' +
        'in tasks.localize.targetLanguages or tasks.translate.targetLanguages.',
    });
  }

  if (config.tasks.catalog.enabled) {
    requireChannel('catalog', config.tasks.catalog.indexChannel);
    if (config.tasks.catalog.localizedNames) {
      requireChannel('catalog', config.tasks.catalog.localizedIndexChannel);
    }
  }
}

/** Shape helper so `crossFieldChecks` can be typed without a circular reference. */
const rawShape = z.object({
  llm: llmSchema,
  tasks: tasksSchema,
  prompts: promptsSchema,
  output: outputSchema,
});
