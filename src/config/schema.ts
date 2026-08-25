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

/**
 * Reasoning is a **cost** setting, not just a quality one: reasoning tokens are
 * billed at the output rate and can easily outweigh the answer itself.
 *
 * The two fields therefore mean different things:
 *
 * - `dialect: none` (the default) — never send a reasoning parameter at all.
 *   Whatever the model does by default is what you get.
 * - any other `dialect` — the model *is* told what to do: `enabled: true` asks it
 *   to reason at `effort`, and `enabled: false` asks it **not to**, which is the
 *   only way to stop a model that reasons unless told otherwise.
 *
 * Note that `exclude` only hides the traces from the response. The tokens are
 * still generated and still billed; to stop paying for them, disable reasoning.
 */
export const reasoningSchema = z.object({
  enabled: z.boolean().default(false),
  effort: z.enum(['minimal', 'low', 'medium', 'high']).default('medium'),
  dialect: reasoningDialectSchema.default('none'),
  /** Upper bound on thinking tokens, for dialects that accept one. */
  maxTokens: z.number().int().positive().optional(),
  /** Keep reasoning traces out of the parsed answer. Does not make them free. */
  exclude: z.boolean().default(true),
}).strict();

export const capabilitySchema = z.enum([
  'json_schema',
  'json_object',
  'tools',
  'reasoning',
  'prompt_cache',
  'vision',
  /**
   * The model can search the web as part of answering — a hosted search model
   * (`perplexity/sonar`, `*-search-preview`), a gateway plugin (OpenRouter's
   * `plugins: [{ id: "web" }]` or an `:online` model suffix), or a server-side
   * tool. Declared per model, and `tasks.websearch` routes only to targets that
   * have it: a model without search answers the same questions from memory,
   * confidently and without a source.
   */
  'web_search',
]);

export const pricingSchema = z.object({
  inputPer1M: z.number().nonnegative().default(0),
  outputPer1M: z.number().nonnegative().default(0),
  /** Price of a cache hit on input tokens; defaults to `inputPer1M` when absent. */
  cachedInputPer1M: z.number().nonnegative().optional(),
  /** Price of input written to a cache; defaults to the ordinary input rate. */
  cacheWriteInputPer1M: z.number().nonnegative().optional(),
  reasoningPer1M: z.number().nonnegative().optional(),
}).strict();

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
  /**
   * Floor on the gap between two requests to this endpoint; 0 = none.
   *
   * `requestsPerMinute` is a budget and this is an interval, and only the
   * interval says what a gateway that mishandles simultaneous arrivals needs
   * to hear: a token bucket starts full, so `requestsPerMinute: 60` lets sixty
   * requests leave in the same millisecond. Applies across concurrent slots,
   * so `maxConcurrent: 2` with a 100ms spacing dispatches at t=0 and t=100.
   */
  minRequestSpacingMs: z.number().int().nonnegative().default(0),
  /**
   * Ask for the answer as a stream and reassemble it here.
   *
   * A transport detail everywhere except on a gateway whose buffered path is
   * broken, where it is the difference between correct output and another
   * request's answer. `omniroute` returns the *other* in-flight request's
   * completion when two overlap and `stream: false` — measured 2026-08-24, 5 of
   * 5 rounds, and unaffected by how far apart the requests are sent, because
   * what collides is the overlap rather than the arrival. Streamed, the same
   * pairs answer correctly 15 of 15.
   *
   * Costs nothing on a healthy endpoint: the response is reassembled into the
   * same shape, usage and finish reason included.
   */
  stream: z.boolean().default(false),
  /** Send Responses prompt_cache_key/options/breakpoints; false for gateways that reject them. */
  responsesPromptCache: z.boolean().default(false),
  usage: z
    .object({
      /**
       * Standard APIs report cached tokens inside prompt_tokens. Some gateways
       * add them a second time; declare that quirk so accounting can normalize it.
       */
      chatCachedTokens: z.enum(['included', 'additional']).default('included'),
    })
    .strict()
    .default({}),
  enabled: z.boolean().default(true),
}).strict();

/**
 * Provider preference, for a gateway that serves one model name from many
 * hosts.
 *
 * This is not a throughput setting, it is a *correctness* one, and OpenRouter
 * is where it bites. `deepseek/deepseek-v4-flash-0731` is one model id served
 * by twenty-nine providers, and **their sampling support differs**: measured
 * 2026-08-24, nine of the twenty-nine honour `top_k` *and* `min_p` *and*
 * `response_format`, and the other twenty accept the request and quietly drop
 * whichever field they do not implement. A run therefore looks identical
 * whether the parameters were applied or ignored — the same 200, the same
 * German, the same bill — and which of the two happened is decided by which
 * host had capacity that second.
 *
 * So the providers that can honour the sampling are named here, in preference
 * order, and:
 *
 *  - **`requireParameters: true`** is the setting that makes a dropped
 *    parameter *audible*. It tells the gateway to route only to a provider
 *    supporting every field in the request, so an unsupported `min_p` comes
 *    back as `404 No endpoints found that can handle the requested
 *    parameters` instead of as a silently different sampler. Turn it on for
 *    any target whose `params` carry something beyond `temperature`.
 *  - **`allowFallbacks: false`** pins the run to `order`/`only` and nothing
 *    else. Leave it unset for a batch — the list is then a preference with the
 *    rest of the market behind it, which is what a thousand articles want —
 *    and set it when an experiment must not silently change hosts mid-run.
 *
 * Slugs are the gateway's own (`deepinfra/fp8`, `ambient/fp4`, `together`);
 * `GET /api/v1/models/<author>/<slug>/endpoints` lists them with the
 * `supported_parameters` each one actually implements. Every field is omitted
 * from the wire when empty, so this whole block costs nothing on an endpoint
 * that has never heard of it.
 */
export const providerRoutingSchema = z
  .object({
    /** Preferred providers, best first; others may still serve unless `allowFallbacks: false`. */
    order: z.array(z.string().min(1)).default([]),
    /** Hard whitelist: only these providers, ever. */
    only: z.array(z.string().min(1)).default([]),
    /** Never route here. */
    ignore: z.array(z.string().min(1)).default([]),
    /** `false` pins routing to `order`/`only`; a failure there fails the call. */
    allowFallbacks: z.boolean().optional(),
    /** Route only to providers that support every parameter in the request. */
    requireParameters: z.boolean().optional(),
    /** Order the remaining candidates by one axis instead of the gateway default. */
    sort: z.enum(['price', 'throughput', 'latency']).optional(),
    /** Accept only these weight quantizations, e.g. `[bf16, fp8]`. */
    quantizations: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({})
  .superRefine((provider, ctx) => {
    // A slug that is both required and forbidden is a typo with a silent
    // outcome: the gateway resolves it one way and the file says the other.
    const ignored = new Set(provider.ignore);
    for (const list of ['order', 'only'] as const) {
      for (const [index, slug] of provider[list].entries()) {
        if (ignored.has(slug)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [list, index],
            message: `Provider "${slug}" is listed in both "${list}" and "ignore".`,
          });
        }
      }
    }
  });

export const modelSchema = z.object({
  /** Local alias used by pools and logs. */
  id: identifier,
  /** Endpoint id this model is served from. */
  endpoint: identifier,
  /** Model name as the endpoint knows it, e.g. "openai/gpt-4o-mini". */
  model: z.string().min(1),
  /** Wire API used for this target. Web-search tools require Responses. */
  apiFormat: z.enum(['chat_completions', 'responses']).default('chat_completions'),
  /** How this target obtains web results; required when `web_search` is declared. */
  webSearchMode: z.enum(['responses_tool', 'hosted', 'online', 'plugin']).optional(),
  contextWindow: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(4096),
  /** Reasoning-era models reject `max_tokens`; some gateways reject the new name. */
  maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  pricing: pricingSchema.default({}),
  reasoning: reasoningSchema.default({}),
  capabilities: z.array(capabilitySchema).default([]),
  /** Free-form labels usable by custom routing strategies. */
  tags: z.array(z.string()).default([]),
  /** Which of the endpoint's providers may serve this model. */
  provider: providerRoutingSchema,
  /** Sampling and friends, merged over `llm.defaults.params`. */
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      /**
       * Nucleus's two companions, first-class because they are the two a
       * gateway is most likely to accept and not apply — see
       * {@link providerRoutingSchema}. `topK: 0` disables the cutoff.
       */
      topK: z.number().int().min(0).optional(),
      minP: z.number().min(0).max(1).optional(),
      frequencyPenalty: z.number().min(-2).max(2).optional(),
      presencePenalty: z.number().min(-2).max(2).optional(),
      seed: z.number().int().optional(),
      stop: z.array(z.string()).optional(),
      /** Escape hatch for endpoint-specific parameters. */
      extra: z.record(z.unknown()).optional(),
    })
    .strict()
    .default({}),
  /** Relative preference for strategies that need a tie-break. Higher wins. */
  weight: z.number().default(1),
  enabled: z.boolean().default(true),
}).strict();

/**
 * One routing pool: the models a task may use, plus the three things that are
 * genuinely per-pool rather than per-run.
 *
 * The shorthand — a bare list of model ids — is still the whole story for most
 * pools and is what every existing config file contains. The expanded form adds
 * only what a *global* setting cannot express:
 *
 *  - **`strategy`** — extraction wants the cheapest model that can do the job;
 *    a web search wants the declared order (the free searchers first, the paid
 *    one behind them); translation wants the load spread. One global strategy
 *    forces all three to agree, and they have no reason to.
 *  - **`maxConcurrent`** — a *lane*: how many of this endpoint's concurrent
 *    slots this pool may hold at once. The endpoint's own `maxConcurrent` is a
 *    hard cap on the provider; this is how that cap is shared out, so one
 *    endpoint that happens to allow three parallel requests cannot swallow the
 *    whole corpus while two other endpoints sit idle.
 *  - **`prefer`** — the model to try first for a given task variant, which for
 *    `translate` and `localize` is the **target language**. A Chinese
 *    open-weights model renders Chinese and Japanese better than a Western one
 *    does, and the reverse is true for European languages; that is a fact about
 *    the language, not about the run.
 */
const poolSchema = z.object({
  /** Candidate models, in declaration order. Empty = every enabled model. */
  models: z.array(identifier).default([]),
  /** Registered strategy id; falls back to `llm.routing.strategy`. */
  strategy: identifier.optional(),
  /** Strategy-specific knobs, merged over `llm.routing.options`. */
  options: z.record(z.unknown()).default({}),
  /**
   * Concurrent requests this pool may have in flight on a given endpoint, by
   * endpoint id. 0 or absent = only the endpoint's own limit applies.
   *
   * The sum across pools may not exceed the endpoint's `maxConcurrent`: a lane
   * divides a cap, it never raises one.
   */
  maxConcurrent: z.record(z.number().int().nonnegative()).default({}),
  /**
   * Task variant → the models to try first for it. For `translate` and
   * `localize` the variant is the target language code.
   *
   * Never an addition to this pool: every id named here must also be in
   * `models`, so a preference can never route somewhere the pool does not
   * allow. Order inside the list is the order they are tried.
   */
  prefer: z.record(z.array(identifier)).default({}),
  /**
   * What a `prefer` list means when the variant matches.
   *
   *  - `reorder` (the default) floats the listed models to the front and keeps
   *    the rest of the pool behind them. A preference is then a quality
   *    statement with the whole pool still catching a listed model that is
   *    down, and preferring a model can never make a variant unroutable.
   *  - `restrict` treats the list as the *entire* chain for that variant.
   *    Nothing else in the pool may serve it.
   *
   * `restrict` is the stronger claim and the sharper edge: the list becomes the
   * variant's whole fallback chain, so a one-entry list is a pool of one — it
   * has no chain at all, and every transient failure becomes a failed document.
   * A variant whose listed models are all unusable fails loudly rather than
   * quietly borrowing a model the config did not choose, which is the point.
   * Variants with no `prefer` entry are unaffected and use the full pool.
   */
  /**
   * Task variant → models that may **never** serve it, whatever else says so.
   *
   * A veto, applied last and to every tier: an excluded model is dropped from
   * the preference list, from the rest of the pool, and from the final wait. A
   * separate map rather than a marker inside `prefer` because YAML reads a
   * leading `!` as a tag — `[a, !b]` parses to `['a', '']` with only a warning,
   * so the veto would vanish silently. `providerRoutingSchema` splits
   * `order`/`ignore` for the same reason.
   */
  exclude: z.record(z.array(identifier)).default({}),
  /**
   * What a `prefer` list means when the variant matches.
   *
   *  - `reorder` (the default) floats the listed models to the front and keeps
   *    the rest of the pool behind them. A preference is then a quality
   *    statement with the whole pool still catching a listed model that is
   *    down, and preferring a model can never make a variant unroutable.
   *  - `restrict` treats the list as the *entire* chain for that variant.
   *    Nothing else in the pool may serve it.
   *  - `wait` treats the list as a first tier worth queueing for: a preferred
   *    model is used when one is free, waited on for `preferWaitMs` when none
   *    is, and only then does the rest of the pool get the request.
   *
   * `restrict` is the stronger claim and the sharper edge: the list becomes the
   * variant's whole fallback chain, so a one-entry list is a pool of one — it
   * has no chain at all, and every transient failure becomes a failed document.
   * `wait` has no such edge, because the rest of the pool is still behind it.
   * Variants with no `prefer` entry are unaffected and use the full pool.
   */
  preferMode: z.enum(['reorder', 'restrict', 'wait']).default('reorder'),
  /**
   * How long `preferMode: wait` queues for a preferred model before widening.
   *
   * Spent per call, and spent *idle*: the task holds one of `run.concurrency`'s
   * workers while it waits, so a value large enough to matter is also large
   * enough to stall the run. Seconds, not minutes.
   *
   * Expiry widens the choice; it never fails the call. If the rest of the pool
   * is busy too, the call waits for whichever allowed model frees first —
   * "nothing preferred was free" is a reason to look further, never a reason to
   * give up on a document.
   */
  preferWaitMs: z.number().int().nonnegative().default(30_000),
}).strict();

/** A pool is either a bare model list (the shorthand) or the expanded object. */
const poolEntrySchema = z
  .union([z.array(identifier), poolSchema])
  .transform((value) => (Array.isArray(value) ? poolSchema.parse({ models: value }) : value));

export const routingSchema = z.object({
  /** Registered strategy id: cost-optimized | context-optimized | sequential | round-robin | least-busy | … */
  strategy: identifier.default('cost-optimized'),
  /**
   * Named candidate pools. `default` is used by any task without its own pool.
   * An empty pool list means "every enabled model".
   *
   * Each value is either `[model, model, …]` or the expanded object described
   * on {@link poolSchema}.
   */
  pools: z.record(poolEntrySchema).default({}),
  /**
   * What to do with a target that cannot serve a request — either the prompt
   * does not fit its context window, or the expected answer does not fit its
   * `maxOutputTokens`.
   *
   * `demote` (the default, and the historical behaviour) ranks it behind every
   * target that can, and still calls it when nothing else is left.
   *
   * `skip` drops it from the chain entirely, so a model with an 8K output
   * ceiling is never asked for a 13K answer: the call that would be cut off
   * mid-sentence, retried on the identical payload and only then escalated is
   * never made at all. Requires the pool to contain something wider — with a
   * single-model pool the two settings are the same call either way.
   */
  onOverflow: z.enum(['demote', 'skip']).default('demote'),
  /** Strategy-specific knobs, validated by the strategy itself. */
  options: z.record(z.unknown()).default({}),
}).strict();

export type PoolConfig = z.infer<typeof poolSchema>;

export const llmSchema = z.object({
  endpoints: z.array(endpointSchema).min(1),
  models: z.array(modelSchema).min(1),
  routing: routingSchema.default({}),
  defaults: z
    .object({
      timeoutMs: z.number().int().positive().default(120_000),
      params: z
        .object({
          temperature: z.number().min(0).max(2).optional(),
          topP: z.number().min(0).max(1).optional(),
        })
        .strict()
        .default({}),
    })
    .strict()
    .default({}),
}).strict();

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
      .strict()
      .default({}),
    fallback: z
      .object({
        /** How many distinct model targets a single logical call may try. */
        maxTargets: z.number().int().min(1).max(10).default(3),
        /** Try the next target when the response fails domain validation. */
        onValidationFailure: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /**
     * Fallback one level up from a call: re-run a whole **task** on a different
     * model when it failed.
     *
     * The gateway's chain answers "this call failed". It cannot answer "every
     * call succeeded and the document they add up to is broken" — a translation
     * whose spliced result no longer matches the source skeleton, an extraction
     * that parsed and made no sense. Those arrive as a pipeline error long after
     * the last HTTP 200, and used to end the task then and there while two
     * perfectly good models sat unasked.
     *
     * A task is retried only when it actually called a model: a failure with no
     * call behind it is deterministic, and re-running it three times only
     * spends wall-clock to reach the same place.
     */
    taskFallback: z
      .object({
        /** Attempts per task, in total. `1` disables task-level fallback. */
        maxAttempts: z.number().int().min(1).max(5).default(3),
        /**
         * The last attempt, when every model in the pool has already failed the
         * task. There is no fresh model left to try, so the only thing left to
         * vary is *how* one is asked: `least-failures` picks whichever has been
         * steadiest this run, and a low temperature trades the flair that a
         * translation wants for the literalness that a structural guard wants.
         */
        lastAttempt: z
          .object({
            strategy: identifier.optional(),
            temperature: z.number().min(0).max(2).optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    circuitBreaker: z
      .object({
        enabled: z.boolean().default(true),
        failureThreshold: z.number().int().min(1).default(5),
        resetAfterMs: z.number().int().positive().default(30_000),
        halfOpenMaxCalls: z.number().int().min(1).default(1),
      })
      .strict()
      .default({}),
  })
  .strict()
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
      .strict()
      .default({}),
    onExceeded: z.enum(['stop', 'warn']).default('stop'),
  })
  .strict()
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
      .strict()
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
      .strict()
      .default({}),
    chunking: z
      .object({
        maxTokens: z.number().int().positive().default(2500),
        overlapTokens: z.number().int().nonnegative().default(150),
        /** Preferred split boundary; falls back down the list when needed. */
        splitOn: z.enum(['heading', 'paragraph', 'line']).default('heading'),
      })
      .strict()
      .default({}),
    options: z.record(z.unknown()).default({}),
  })
  .strict()
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
}).strict();

/**
 * The name roster — a second input source, beside the corpus and the image
 * index.
 *
 * It is an extracted index of the site's own name list: article file → full
 * name, family name, given name, patronymic, alternative spellings. It is
 * hand-maintained, incomplete and occasionally wrong, so every consumer treats
 * it as corroboration rather than as authority: it fills a gap the article left
 * and it never overwrites a fact the article states.
 *
 * It sits at the root rather than under a task because three of them read it.
 */
export const rosterSchema = z
  .object({
    /** Relative to `project.rootDir`. Empty disables the roster entirely. */
    file: z.string().default(''),
    /**
     * The language the roster is written in.
     *
     * Its names are not translations: a Russian roster's aliases belong to
     * `index-ru.json` and to the Russian dossier, and putting them in an
     * English one would publish Cyrillic under an English name.
     */
    language: languageCode.default('ru'),
    /**
     * Supply `forename`/`surname` the article did not yield.
     *
     * Gap-filling only, in the same sense as `mergeDossier`: a value the
     * extraction produced is never replaced, and a disagreement is reported as
     * a note rather than silently resolved.
     */
    fillMetadata: z.boolean().default(true),
    /**
     * Contribute the roster's hand-authored alternative spellings and its own
     * name order to `index-<lang>.json`, for its own language.
     */
    aliases: z.boolean().default(true),
    /** Feed the roster's spellings to the portrait matcher as extra name evidence. */
    nameHints: z.boolean().default(true),
    /**
     * Also report a roster name that contradicts what was extracted.
     *
     * Off by default for a reason: on a corpus of a thousand articles the roster
     * and the extractor will disagree about hundreds of abbreviations
     * (`Е.` against `Евгений`), and a note per document is noise. Turn it on for
     * a QA pass.
     */
    reportConflicts: z.boolean().default(false),
  })
  .strict()
  .default({});

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
      // Internal hand-off from `extract` to `catalog`, not part of the published
      // format — dot-prefixed so the consuming site ignores the directory.
      catalogHints: '.hints/{slug}.json',
      // The chosen portrait, plus the runners-up and why they lost. Internal.
      portraitHints: '.hints/{slug}.portrait.json',
      // Classification the web supplied that `index.json` owns. Internal.
      websearchHints: '.hints/{slug}.web.json',
    }),
  onExisting: z.enum(['skip', 'overwrite', 'fail']).default('overwrite'),
  /** Pretty-print JSON artifacts. */
  jsonIndent: z.number().int().min(0).max(8).default(2),
  /** Trailing newline on every written artifact. */
  finalNewline: z.boolean().default(true),
}).strict();

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

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

/**
 * Fields the format guide encodes as comma-separated lists. Shared by three
 * places that must agree about them: extraction normalizes their punctuation,
 * chunk merge unions them instead of taking the first chunk's, and localization
 * translates their items individually so `Guitarist` is billed once per run.
 */
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

/** How long a translation cache lives. `true`/`false` stay valid as `run`/`off`. */
const memoryLifetime = z
  .union([z.boolean(), z.enum(['off', 'run', 'persistent'])])
  .default('run')
  .transform((value) => (typeof value === 'boolean' ? (value ? 'run' : 'off') : value));

const taskBase = z.object({
  enabled: z.boolean().default(false),
  /** Routing pool name; falls back to `default`. */
  pool: identifier.optional(),
  /** Per-task override of the global context strategy. */
  contextStrategy: identifier.optional(),
  /** Extra variables handed to this task's prompt templates. */
  promptVariables: z.record(z.unknown()).default({}),
}).strict();

export const extractTaskSchema = taskBase
  .extend({
    outputChannel: z.string().default('metadata'),
    /** Fail the task when the model returns none of these fields. */
    requiredFields: z.array(z.string()).default([]),
    /**
     * The field card sent to the model, by key. Empty means the built-in card
     * (`DEFAULT_FIELDS` in `src/pipelines/extraction/FlatFields.ts`). Naming
     * fewer fields is the most direct cost lever there is: the card *is* the
     * prompt, and the answer is one line per key.
     *
     * `ranking` is available but deliberately absent from the default: it is a
     * project-defined editorial score, so a model answering it is guessing.
     */
    fields: z.array(z.string()).default([]),
    /**
     * Read the **whole** article, skipping the context ladder's truncated rungs.
     *
     * Extraction is a harvest, not a lookup: the question is "answer every key
     * this article supports", and a model that was sent the first 1500 tokens
     * answers it for the first 1500 tokens. It cannot report that it never saw
     * the sentence naming the teachers, the award and the instruments — those
     * keys simply come back absent, indistinguishable from an article that does
     * not state them. Biographies put identity in the lead and everything else
     * wherever the prose reached it.
     *
     * So the truncated rungs of whatever `context.strategy` is configured
     * (`truncation-first`, `staged`) are dropped for this task and the ladder
     * starts at the first rung that carries the whole document — which is also
     * why this costs nothing rather than double-billing: the cheap call that
     * would have been rejected is never made. An article too large for any
     * window still degrades to a chunked pass, and `mergeFlat` unions the parts.
     *
     * `false` restores the cheap head-first behaviour for a corpus whose
     * articles really do state everything in their opening paragraphs.
     */
    readWholeDocument: z.boolean().default(true),
    /**
     * What to do when an **authored** `<slug>.bio.json` exists beside the
     * article.
     *
     * Only that one. This tool's own output is deliberately not an input to
     * this decision (`findSourceDossier`): a run that saw the file it wrote last
     * time would decide the entry is "already extracted" and re-plan on every
     * run forever. Whether the output is already up to date is what `--resume`
     * and `run.skipExistingOutputs` answer, without the feedback loop.
     *
     * - `reuse` (default) — do not call a model at all. The file is normalized,
     *   migrated to version 2 and re-emitted. Zero tokens.
     * - `complete` — ask only for the fields it is missing, and merge without
     *   ever overwriting a value it already has.
     * - `rebuild` — ignore it and extract from scratch.
     */
    onExistingDossier: z.enum(['reuse', 'complete', 'rebuild']).default('reuse'),
    /**
     * The gallery is parsed out of the article's own `::: image` containers and
     * tablature tables instead of being asked for. It costs nothing, and a
     * harvested `target` is the path the article actually contains rather than
     * one a model retyped.
     */
    harvest: z
      .object({
        photos: z.boolean().default(true),
        music: z.boolean().default(true),
        /** Ceiling per list — a discography table can hold a hundred rows. */
        maxItems: z.number().int().positive().default(60),
      })
      .strict()
      .default({}),
    /**
     * Write the classification a model noticed but a dossier may not keep
     * (`type`, `gender`, `country`, Latin `title`) to the `catalogHints`
     * channel, where `catalog` picks it up. Costs four short lines: the article
     * was read for the dossier anyway.
     */
    emitCatalogHints: z.boolean().default(true),
    hintsChannel: z.string().default('catalogHints'),
  })
  .strict()
  .default({});

export const translateTaskSchema = taskBase
  .extend({
    outputChannel: z.string().default('translation'),
    targetLanguages: z.array(languageCode).default([]),
    /** Never translate a document into the language it is already in. */
    skipSourceLanguage: z.boolean().default(true),
    /**
     * Copy the source article into the output tree as its original edition.
     *
     * `INV-8` requires a file for every code in a row's `lang`, the first one
     * included. When `input.baseDir` and `output.baseDir` are different
     * directories, nothing else puts the original there and the catalogue
     * declares an edition that cannot load. Costs nothing — no model is called.
     * Turn it off when the corpus already *is* the catalogue root.
     */
    copySourceArticle: z.boolean().default(true),
    /**
     * Reject a translation whose Markdown skeleton diverges from the source.
     * `strict` compares token for token — right for `segments` mode, where the
     * skeleton was never sent and so cannot legitimately change. `lenient` lets
     * a translator re-flow adjacent paragraphs but still refuses a lost heading,
     * container, table or URL. `off` disables the check. `true`/`false` are
     * accepted as `strict`/`off`.
     */
    verifyStructure: z
      .union([z.boolean(), z.enum(['off', 'lenient', 'strict'])])
      .default('strict')
      .transform((value) => (typeof value === 'boolean' ? (value ? 'strict' : 'off') : value)),
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
    /**
     * What to do with a fragment that is not written in the source language.
     *
     * A Russian article prints work titles, discographies and Latin spellings of
     * names as their own languages write them: `Plays Domenico Scarlatti`,
     * `Allegro vivo`, `'Amadeus' Guitar Duo`. `keep` (the default) never sends a
     * fragment with no letter of the source script in it — which is both cheaper
     * and more reliable than asking a model not to translate it, because an
     * instruction is obeyed on most calls and a fragment that was never sent is
     * obeyed on all of them.
     *
     * A *mixed* fragment is always sent: "Играл на гитаре Pedro Maldonado" is
     * Russian prose, and keeping the name intact is the prompt's job.
     *
     * The rule needs a source language with an alphabet of its own, so it does
     * nothing at all for a Latin-script corpus.
     */
    foreignFragments: z.enum(['keep', 'translate']).default('keep'),
    /**
     * What a ``` fence contains.
     *
     * The pipeline used to answer "code" and skip it, which is right for a
     * program and wrong for this corpus: a bare fence is how these articles set
     * *verse*. On `garcia_lorca.bio.md` that left 44% of the Russian text
     * untranslated, silently — the structure guard ignores fenced content, so
     * the article passed every check with half of it still in Russian.
     *
     *   auto  (default) classify each block by what is in it: an info string
     *         naming a language, tablature and ASCII rules are code; lines of
     *         words are verse, translated one span per line so the shape of the
     *         poem is preserved by the splice rather than by the model
     *   code  never translate a fence (the behaviour before this setting)
     *   text  always translate one
     */
    fencedBlocks: z.enum(['auto', 'code', 'text']).default('auto'),
    /**
     * Characters of the article's title and lead sent with each batch, so the
     * fragments arrive with a subject. `0` sends nothing.
     *
     * Cheap and cache-safe: it rides in the volatile part of the message, after
     * the instructions, so the cached prefix is untouched.
     */
    contextChars: z.number().int().nonnegative().default(300),
    /**
     * Follow-up calls that re-ask **only** for the fragments an answer left out.
     * Models routinely return 39 of 40 keys; repairing the one is far cheaper
     * than re-sending the batch. `0` restores all-or-nothing retries.
     */
    repairAttempts: z.number().int().min(0).max(3).default(1),
    /**
     * Reuse the translation of an identical span. `run` keeps the cache for one
     * run; `persistent` also writes it to `run.memoryDir`, so a re-run over a
     * grown corpus pays only for what is new. The file is keyed by prompt
     * version, so editing a prompt starts a fresh cache rather than handing back
     * the strings the edit was meant to change. `true`/`false` mean `run`/`off`.
     */
    useTranslationMemory: memoryLifetime,
  })
  .default({});

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
    /** Follow-up calls that re-ask only for the values an answer left out. */
    repairAttempts: z.number().int().min(0).max(3).default(1),
    /** Reuse a translation of the same source string. See `tasks.translate`. */
    useTranslationMemory: memoryLifetime,
  })
  .default({});

/**
 * Filling the gaps an article does not contain, from the web.
 *
 * Every default here is set to keep the task cheap and quiet: it asks only
 * about fields that are genuinely absent, it never sends the article, and it
 * refuses an answer that arrives without a source.
 */
export const webSearchTaskSchema = taskBase
  .extend({
    /** The dossier is rewritten in place, so this is `extract`'s channel. */
    outputChannel: z.string().default('metadata'),
    /** `country` belongs to `index.json`, so it travels on its own hint channel. */
    hintsChannel: z.string().default('websearchHints'),
    /** Which facts this task may go looking for. */
    fields: z
      .array(z.enum(['born', 'died', 'birthplace', 'deathplace', 'country', 'url']))
      .default(['born', 'died', 'birthplace', 'deathplace', 'country']),
    /**
     * Route only to models that declare the `web_search` capability.
     *
     * Leaving this on is what separates "searched and found" from "recalled and
     * asserted": a model without search will answer these questions anyway.
     */
    requireWebSearchCapability: z.boolean().default(true),
    /** Drop any value that arrives without a usable source URL. */
    requireSource: z.boolean().default(true),
    /**
     * Also require that the cited URL appears in the provider's own search
     * evidence — the pages it reports having consulted — and not merely in the
     * model's prose.
     *
     * A separate setting from `requireSource` because it is a separate claim and
     * a much stronger one: the first asks the answer to name a page, the second
     * asks the *provider* to confirm it opened that page. It is also the one
     * that can silently cost a whole run's fields if a gateway reports redirect
     * URLs rather than the pages behind them, so it must be turnable off on its
     * own. Comparison is by `sourceKey`, not by string equality.
     */
    requireVerifiedSource: z.boolean().default(true),
    /** Drop any value the answer itself rates below this. */
    minConfidence: z.number().min(0).max(1).default(0.7),
    /**
     * Age past which an undated death becomes a question.
     *
     * Not a claim that anyone has died — it is the age past which "the article
     * does not mention a death" stops being evidence that there was none,
     * because the article may simply predate it.
     */
    livenessAgeYears: z.number().int().min(1).max(130).default(78),
    /** Also ask for a sharper form of a date already known to the year or month. */
    upgradePrecision: z.boolean().default(false),
    /**
     * What to do when a sourced web date disagrees with the date on record.
     *
     * `upgradePrecision` asks for the sharper form of a date the article gave
     * to the year — and the article is sometimes simply wrong about that year.
     * "Born about 1950" against a cited `25.07.1949` is not two competing facts
     * of equal standing: one is a decade-rounded approximation and the other is
     * a full date with a page behind it.
     *
     *  - `prefer-precise` lets a **strictly more precise** sourced
     *    date replace the coarser one, disagreeing year included. A date of the
     *    same precision, or a coarser one, never overwrites anything: two
     *    day-precision dates that disagree are a real conflict, not an upgrade.
     *  - `report` (the default) never overwrites. The dossier keeps what the article said and
     *    the rejected candidate is written to the hint file with its source, so
     *    a human can settle it.
     *  - `ignore` drops a contradicting answer without recording it — the
     *    behaviour before this setting existed, kept only for reproducibility.
     *
     * Every branch says what it did in the run notes; none of them is silent.
     */
    onDateConflict: z.enum(['prefer-precise', 'report', 'ignore']).default('report'),
    /**
     * `lead` sends the article's opening paragraph so a namesake can be told
     * apart; `none` sends only the fact table. The article itself is never sent.
     */
    includeContext: z.enum(['none', 'lead']).default('lead'),
    contextChars: z.number().int().nonnegative().default(600),
    /** `url` fills an empty `metadata.url` from the best source; `none` keeps provenance in the run log only. */
    recordSources: z.enum(['none', 'url']).default('none'),
  })
  .default({});

/**
 * Portrait selection from an existing image index. Promptless and LLM-free:
 * the whole decision is name matching plus the index's own `ai` block.
 */
export const portraitTaskSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** The image index (`images/artists.json`), relative to `project.rootDir`. */
    indexFile: z.string().default('images/artists.json'),
    /**
     * Prepended to the index's `relPath` to make a `VD-PATH-ASSET` value.
     *
     * `img` resolves against the **catalogue root**, so this is where the
     * scanned image tree sits under it: `pages/` + `photo/s/x.jpg` →
     * `pages/photo/s/x.jpg`.
     */
    assetPrefix: z.string().default('pages/'),
    outputChannel: z.string().default('portraitHints'),
    /**
     * How sure the matcher must be that the picture shows *this* person.
     *
     * The score is identity only: a beautiful portrait of the wrong person is
     * not a candidate, and picture quality never compensates for a weak name
     * match (`image-index-spec.md` §16). 0.9 accepts a clean family-name match
     * on a file the archive files under this person, and refuses a fuzzy one
     * with no corroboration.
     */
    minIdentity: z.number().min(0).max(1).default(0.9),
    /** Worst visual tier allowed to win: 1 = one face and a person class. */
    maxTier: z.number().int().min(1).max(4).default(2),
    /** Smaller than this on the short side and there is nothing to crop. */
    minPixels: z.number().int().nonnegative().default(80),
    /** A record sleeve is artwork with a name printed on it, not a photograph. */
    excludeReleaseCovers: z.boolean().default(true),
    /** Runners-up kept in the hint file, for tuning and for review. */
    keepCandidates: z.number().int().min(0).max(50).default(8),
    /**
     * What to publish when nothing clears `minIdentity`.
     *
     * `omit` (default) writes no `img`, which is what `external/03` §3.4.9
     * already specifies: the reader substitutes the gender default, and those
     * synthetic assets stay out of the entry's gallery. `default` writes the
     * asset path explicitly — visible in `index.json`, at the price of the
     * placeholder leading the gallery.
     */
    onLowConfidence: z.enum(['omit', 'default']).default('omit'),
    defaultPortraits: z
      .object({
        m: z.string().default('photos/default-male.svg'),
        f: z.string().default('photos/default-female.svg'),
        mixed: z.string().default('photos/default-mixed.svg'),
      })
      .strict()
      .default({}),
  })
  .strict()
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
    /**
     * Read the existing `index.json` and update it, rather than replacing it.
     *
     * Turning this off is destructive by design and almost never right: a run
     * over a subset of the corpus would delete every row it did not visit, and
     * with them every id that `index-<lang>.json` joins on.
     */
    merge: z.boolean().default(true),
    /** Where `extract` left the classification it noticed while reading the article. */
    hintsChannel: z.string().default('catalogHints'),
    /** Where `portrait` left the picture it chose. Read only when that task runs. */
    portraitChannel: z.string().default('portraitHints'),
    /** Where `websearch` left the classification it found. Lowest precedence. */
    websearchChannel: z.string().default('websearchHints'),
    /**
     * Search aliases beyond the display name. Aliases are what makes
     * cross-script and cross-order search work without transliteration.
     */
    generateAliases: z.boolean().default(true),
    /**
     * Which aliases are worth authoring.
     *
     * `distinct` (the default) drops every candidate that is already reachable
     * through one it keeps — the bare family name inside the full name, a value
     * equal to the row's `title`, a repeat that differs only in case. It keeps
     * the ones nothing else reaches: the inverted order, the birth name, a
     * genuinely different spelling.
     *
     * `spec` restores `external/04` §4.5 in full, including the bare surname and
     * a machine transliteration of a Cyrillic name.
     */
    aliasPolicy: z.enum(['distinct', 'spec']).default('distinct'),
    /**
     * Which name goes in `index-<lang>.json[0]`, the entry's display name.
     *
     * `[0]` is not one alias among several — it is the string the reader prints
     * under the thumbnail, and everything after it is search-only. So its order
     * is a deployment decision rather than a derivation:
     *
     *  - `roster` (the default) uses the roster's own `fullname` for the
     *    roster's language — `Абитон Жерар`, the catalogue's own heading,
     *    written by a person — and falls back to `Surname Forename` when the
     *    roster does not know the entry. Every other language keeps
     *    `Forename Surname`, because a Russian filing convention is not an
     *    English one.
     *  - `surname-first` applies `Surname Forename` to every language.
     *  - `given-first` is the old behaviour: `Forename Surname` everywhere, with
     *    the roster name demoted to an alias.
     *
     * Whatever loses this choice is not discarded — it becomes the first alias,
     * so both orders stay searchable.
     */
    displayNameOrder: z.enum(['roster', 'surname-first', 'given-first']).default('roster'),
    /**
     * Row members this run may **correct** in an index it is merging into.
     *
     * The merge exists to protect hand-edits, so an existing value normally
     * wins over anything derived — which also means a value this tool got wrong
     * last run can never be fixed by running it again. `img` is where that
     * bites: change `tasks.portrait.assetPrefix` and every row keeps the path
     * built from the old one, for ever, with no error anywhere.
     *
     * Naming a member here says "the derived value is the authority for this
     * field". Empty (the default) keeps every existing value. `displayNames`
     * is the same escape hatch for `index-<lang>.json[0]`.
     */
    refresh: z
      .array(z.enum(['img', 'title', 'type', 'gender', 'country', 'displayNames']))
      .default([]),
  })
  .strict()
  .default({});

export const tasksSchema = z
  .object({
    extract: extractTaskSchema,
    websearch: webSearchTaskSchema,
    translate: translateTaskSchema,
    localize: localizeTaskSchema,
    portrait: portraitTaskSchema,
    catalog: catalogTaskSchema,
  })
  .strict()
  .default({});

// ---------------------------------------------------------------------------
// The published format
// ---------------------------------------------------------------------------

/**
 * Deployment properties of the catalogue this tool produces.
 *
 * These are not task settings: they describe the *format's* environment — which
 * content languages exist, what an unclassified entry is called — and four
 * different pipelines plus the validator have to agree about them. See
 * `external/` for the normative specification.
 */
export const catalogueSchema = z
  .object({
    /**
     * The closed set of content languages (`VD-LANG`). A code outside it is
     * dropped rather than treated as an error, exactly as a reader does.
     */
    supportedLanguages: z
      .array(z.string().regex(/^[a-z]{2}$/, 'must be a lowercase ISO 639-1 code'))
      .min(1)
      .default(['en', 'es', 'ja', 'de', 'fr', 'it', 'pt', 'ru', 'zh', 'ko']),
    /**
     * The coarsest date this catalogue publishes.
     *
     * `external/02` says a date not known to the day is not representable and
     * must be omitted — which throws away a real fact whenever an article says
     * only "born in 1885". `month` and `year` lower that floor and publish the
     * canonical form truncated from the left: `"02.1893"`, `"1893"`.
     *
     * The cost is stated once, here: VD-DATE requires a consumer to treat a
     * value outside `\d{1,2}\.\d{1,2}\.\d{4}` as **absent**, so a strict reader
     * ignores a partial date and behaves exactly as if the field had been
     * dropped. Nothing breaks; a reader that wants the year has to ask for it.
     */
    datePrecision: z.enum(['day', 'month', 'year']).default('year'),
    /** `type` for a biography nothing else classified. */
    defaultType: z.string().default('musician'),
    /**
     * `type` for an article-only entry nothing else classified. `hidden` keeps
     * technical pages ("About", "News") out of the grid, search and the facets
     * while leaving them routable — which is what that reserved value is for.
     */
    defaultPageType: z.string().default('hidden'),
    /**
     * Keep a craft outside the established vocabulary. The format's vocabulary
     * is open, so `true` is conforming; `false` is safer for machine-produced
     * values, where an unknown token is far more often an invented synonym than
     * a genuinely new craft.
     */
    allowUnknownTypes: z.boolean().default(false),
  })
  .strict()
  .default({});

/** Tasks that drive an LLM and therefore require prompt templates. */
const LLM_TASK_IDS = new Set(['extract', 'websearch', 'translate', 'localize']);

// ---------------------------------------------------------------------------
// Prompts, run, logging
// ---------------------------------------------------------------------------

export const promptsSchema = z
  .object({
    dir: z.string().default('prompts'),
    templates: z
      .record(z.object({ system: z.string().min(1), user: z.string().min(1) }).strict())
      .default({
        extract: { system: 'extraction/system.md', user: 'extraction/user.md' },
        websearch: { system: 'websearch/system.md', user: 'websearch/user.md' },
        translate: { system: 'translation/system.md', user: 'translation/user.md' },
        translateSegments: { system: 'translation/segments-system.md', user: 'translation/segments-user.md' },
        localize: { system: 'localization/system.md', user: 'localization/user.md' },
      }),
    /** Variables available to every template. */
    variables: z.record(z.unknown()).default({}),
  })
  .strict()
  .default({});

export const runSchema = z
  .object({
    concurrency: z.number().int().min(1).max(64).default(4),
    stateDir: z.string().default('.biomd/runs'),
    /** Where a `persistent` translation memory is kept. Safe to delete. */
    memoryDir: z.string().default('.biomd/memory'),
    /** `auto` resumes the latest unfinished run; a run id resumes that one. */
    resume: z.union([z.literal('auto'), z.literal('off'), z.string().min(1)]).default('auto'),
    dryRun: z.boolean().default(false),
    /** Stop the whole run on the first task failure. */
    failFast: z.boolean().default(false),
    /** Skip planning a task whose output file already exists. */
    skipExistingOutputs: z.boolean().default(false),
  })
  .strict()
  .default({});

export const loggingSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    console: z.enum(['pretty', 'json', 'off']).default('pretty'),
    /** Path to a JSONL log file; null disables file logging. */
    file: z.string().nullable().default('.biomd/logs/biomd.jsonl'),
    /**
     * A plain-text progress log in the project root; null disables it.
     *
     * One line per finished task — time, task, file, and the model that
     * produced it. Everything else this tool records is written for a machine
     * to read back afterwards; this is the one surface meant to be read *while
     * the run is going*, with `tail -f` or an editor that reloads.
     */
    progressFile: z.string().nullable().default('progress.log'),
    /**
     * Floor on how often it is written, in milliseconds.
     *
     * Also a ceiling: a line that arrives just after a write is flushed when
     * the interval elapses rather than waiting for the next task, so a slow
     * document cannot leave the file looking stalled.
     */
    progressIntervalMs: z.number().int().min(0).default(30_000),
  })
  .strict()
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
      .strict()
      .default({}),
    input: inputSchema.default({}),
    roster: rosterSchema,
    output: outputSchema.default({}),
    catalogue: catalogueSchema,
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
export type ProviderRouting = z.infer<typeof providerRoutingSchema>;
export type RoutingConfig = z.infer<typeof routingSchema>;
export type ReliabilityConfig = z.infer<typeof reliabilitySchema>;
export type CostConfig = z.infer<typeof costSchema>;
export type ContextConfig = z.infer<typeof contextSchema>;
export type InputConfig = z.infer<typeof inputSchema>;
export type RosterConfig = z.infer<typeof rosterSchema>;
export type OutputConfig = z.infer<typeof outputSchema>;
export type TasksConfig = z.infer<typeof tasksSchema>;
export type CatalogueConfig = z.infer<typeof catalogueSchema>;
export type ExtractTaskConfig = z.infer<typeof extractTaskSchema>;
export type TranslateTaskConfig = z.infer<typeof translateTaskSchema>;
export type LocalizeTaskConfig = z.infer<typeof localizeTaskSchema>;
export type CatalogTaskConfig = z.infer<typeof catalogTaskSchema>;
export type PortraitTaskConfig = z.infer<typeof portraitTaskSchema>;
export type WebSearchTaskConfig = z.infer<typeof webSearchTaskSchema>;
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

  const seenEndpoints = new Set<string>();
  config.llm.endpoints.forEach((endpoint, index) => {
    if (seenEndpoints.has(endpoint.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'endpoints', index, 'id'],
        message: `Duplicate endpoint id "${endpoint.id}". Endpoint ids must be unique.`,
      });
    }
    seenEndpoints.add(endpoint.id);
  });

  const seenModels = new Set<string>();
  config.llm.models.forEach((model, index) => {
    if (seenModels.has(model.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'models', index, 'id'],
        message: `Duplicate model id "${model.id}". Model ids must be unique across endpoints.`,
      });
    }
    seenModels.add(model.id);
    if (model.capabilities.includes('web_search') && !model.webSearchMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'models', index, 'webSearchMode'],
        message: `Model "${model.id}" declares web_search but does not say how search is enabled.`,
      });
    }
    if (model.webSearchMode === 'responses_tool' && model.apiFormat !== 'responses') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'models', index, 'apiFormat'],
        message: `Model "${model.id}" uses responses_tool search and therefore needs apiFormat: responses.`,
      });
    }
    if (
      model.capabilities.includes('web_search') &&
      model.apiFormat === 'responses' &&
      model.webSearchMode !== 'responses_tool'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'models', index, 'webSearchMode'],
        message: `Responses model "${model.id}" must use webSearchMode: responses_tool for verifiable search.`,
      });
    }
    if (model.webSearchMode === 'online' && !model.model.endsWith(':online')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'models', index, 'model'],
        message: `Model "${model.id}" uses webSearchMode: online but its wire model has no :online suffix.`,
      });
    }
    if (model.webSearchMode === 'plugin' && !hasWebPlugin(model.params.extra)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'models', index, 'params', 'extra', 'plugins'],
        message: `Model "${model.id}" uses webSearchMode: plugin but params.extra.plugins has no web plugin.`,
      });
    }
  });

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
  /** Lane totals per endpoint, so a divided cap can be checked against the real one. */
  const laneTotals = new Map<string, number>();

  for (const [pool, spec] of Object.entries(routing.pools)) {
    const members = new Set(spec.models);

    spec.models.forEach((memberId, index) => {
      if (!modelIds.has(memberId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['llm', 'routing', 'pools', pool, 'models', index],
          message: `Unknown model "${memberId}". Declared: ${[...modelIds].join(', ') || '(none)'}`,
        });
      }
    });

    // A preference reorders the pool; it can never route outside it. Naming a
    // model the pool does not contain is the mistake that would otherwise look
    // like it worked — the entry is simply ignored and the language quietly
    // keeps the default ordering.
    for (const [variant, preferred] of Object.entries(spec.prefer)) {
      preferred.forEach((memberId, index) => {
        if (members.size > 0 && !members.has(memberId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['llm', 'routing', 'pools', pool, 'prefer', variant, index],
            message:
              `Model "${memberId}" is preferred for "${variant}" but is not in pool "${pool}". ` +
              'A preference reorders a pool; add the model to `models` first.',
          });
        }
      });
    }

    // Same reasoning as the preference check above, and one more failure it
    // catches: excluding a model the pool never had reads as a working veto.
    for (const [variant, excluded] of Object.entries(spec.exclude)) {
      excluded.forEach((memberId, index) => {
        if (members.size > 0 && !members.has(memberId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['llm', 'routing', 'pools', pool, 'exclude', variant, index],
            message:
              `Model "${memberId}" is excluded for "${variant}" but is not in pool "${pool}". ` +
              'The exclusion has nothing to act on; remove it, or fix the id.',
          });
        }
        if (spec.prefer[variant]?.includes(memberId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['llm', 'routing', 'pools', pool, 'exclude', variant, index],
            message:
              `Model "${memberId}" is both preferred and excluded for "${variant}". ` +
              'An exclusion is a veto and wins, so the preference is dead text — say one or the other.',
          });
        }
      });
    }

    // A variant whose whole tier is excluded routes nowhere, which is a config
    // mistake that only shows up as failed documents halfway through a run.
    for (const [variant, excluded] of Object.entries(spec.exclude)) {
      const usable = [...members].filter((memberId) => !excluded.includes(memberId));
      if (members.size > 0 && usable.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['llm', 'routing', 'pools', pool, 'exclude', variant],
          message: `Every model in pool "${pool}" is excluded for "${variant}", leaving nothing to route to.`,
        });
      }
    }

    for (const [endpointId, limit] of Object.entries(spec.maxConcurrent)) {
      if (!endpointIds.has(endpointId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['llm', 'routing', 'pools', pool, 'maxConcurrent', endpointId],
          message: `Unknown endpoint "${endpointId}". Declared: ${[...endpointIds].join(', ') || '(none)'}`,
        });
        continue;
      }
      laneTotals.set(endpointId, (laneTotals.get(endpointId) ?? 0) + limit);
    }
  }

  // A lane divides an endpoint's concurrency; it never raises it. Letting the
  // lanes add up to more than the endpoint allows would publish a promise the
  // endpoint semaphore then breaks — every pool believing it has a free slot
  // and all of them queueing on the same one.
  for (const endpoint of config.llm.endpoints) {
    const total = laneTotals.get(endpoint.id) ?? 0;
    if (endpoint.maxConcurrent > 0 && total > endpoint.maxConcurrent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'routing', 'pools'],
        message:
          `Routing lanes for endpoint "${endpoint.id}" add up to ${total} concurrent requests, ` +
          `but the endpoint allows ${endpoint.maxConcurrent}. Lower a pool's maxConcurrent.${''}`,
      });
    }
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

  if (config.tasks.extract.enabled && config.tasks.extract.emitCatalogHints) {
    requireChannel('extract', config.tasks.extract.hintsChannel);
  }

  if (config.tasks.catalog.enabled) {
    requireChannel('catalog', config.tasks.catalog.indexChannel);
    if (config.tasks.catalog.localizedNames) {
      requireChannel('catalog', config.tasks.catalog.localizedIndexChannel);
    }
    requireChannel('catalog', config.tasks.catalog.portraitChannel);
    requireChannel('catalog', config.tasks.catalog.websearchChannel);
  }

  if (config.tasks.websearch.enabled) {
    requireChannel('websearch', config.tasks.websearch.hintsChannel);

    const poolName = config.tasks.websearch.pool ?? 'default';
    const pool = routing.pools[poolName] ?? routing.pools['default'];
    const members = pool?.models.length ? new Set(pool.models) : undefined;
    const enabledEndpoints = new Set(config.llm.endpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => endpoint.id));
    const searchable = config.llm.models.filter((model) => {
      if (!model.enabled || !enabledEndpoints.has(model.endpoint)) return false;
      if (members && !members.has(model.id)) return false;
      return model.capabilities.includes('web_search') && model.webSearchMode !== undefined;
    });
    if (config.tasks.websearch.requireWebSearchCapability && searchable.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['llm', 'routing', 'pools', poolName],
        message:
          `Task "websearch" uses pool "${poolName}", but that pool has no enabled, verifiable web-search target. ` +
          'Use apiFormat: responses with the hosted web_search tool, or an explicitly hosted/:online search model.',
      });
    }
  }
}

function hasWebPlugin(extra: Record<string, unknown> | undefined): boolean {
  const plugins = extra?.['plugins'];
  return Array.isArray(plugins) && plugins.some(
    (plugin) => plugin !== null && typeof plugin === 'object' && (plugin as Record<string, unknown>)['id'] === 'web',
  );
}

/** Shape helper so `crossFieldChecks` can be typed without a circular reference. */
const rawShape = z.object({
  llm: llmSchema,
  tasks: tasksSchema,
  prompts: promptsSchema,
  output: outputSchema,
  catalogue: catalogueSchema,
});
