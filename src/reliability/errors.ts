import { AppError, type ErrorDetails } from '../shared/errors.js';

/**
 * Failure kinds an LLM call can produce. The taxonomy exists so that retry,
 * fallback and context-escalation decisions are made from a small, testable
 * enum instead of by matching provider message strings at the call site.
 */
export type LlmErrorKind =
  /** 429 / explicit rate limiting — retry after backoff, same target. */
  | 'rate_limit'
  /** Request exceeded its deadline. */
  | 'timeout'
  /** Socket/DNS/TLS failure before a response. */
  | 'network'
  /** 5xx from the endpoint. */
  | 'server'
  /** 401/403 — the key is wrong; retrying is pointless, another endpoint may work. */
  | 'auth'
  /** 400-class request error we caused; neither retry nor fallback will help. */
  | 'invalid_request'
  /** Prompt did not fit. Signals the caller to shrink its context, not to retry as-is. */
  | 'context_length'
  /** Provider refused to answer on policy grounds. */
  | 'content_filter'
  /** Billing/quota exhausted on this endpoint — fall back, do not retry. */
  | 'quota'
  /** Model unknown or temporarily unavailable at this endpoint. */
  | 'model_unavailable'
  /** Call succeeded but the body could not be parsed or failed validation. */
  | 'response_format'
  /**
   * The answer hit the model's own output ceiling and stops mid-sentence.
   *
   * Distinct from `response_format` because the remedy is the opposite one:
   * the payload was fine and the model was willing, so re-asking it produces the
   * identical cut every time. Only a wider target — or less to say — helps.
   */
  | 'output_truncated'
  /** Local guard tripped (circuit open). */
  | 'circuit_open'
  | 'unknown';

export interface Disposition {
  /** Worth trying again against the same model target. */
  retryable: boolean;
  /** Worth trying the next model target. */
  fallbackable: boolean;
}

const DISPOSITIONS: Record<LlmErrorKind, Disposition> = {
  rate_limit: { retryable: true, fallbackable: true },
  timeout: { retryable: true, fallbackable: true },
  network: { retryable: true, fallbackable: true },
  server: { retryable: true, fallbackable: true },
  auth: { retryable: false, fallbackable: true },
  invalid_request: { retryable: false, fallbackable: false },
  context_length: { retryable: false, fallbackable: true },
  content_filter: { retryable: false, fallbackable: true },
  quota: { retryable: false, fallbackable: true },
  model_unavailable: { retryable: false, fallbackable: true },
  response_format: { retryable: true, fallbackable: true },
  output_truncated: { retryable: false, fallbackable: true },
  circuit_open: { retryable: false, fallbackable: true },
  unknown: { retryable: false, fallbackable: true },
};

export function dispositionOf(kind: LlmErrorKind): Disposition {
  return DISPOSITIONS[kind];
}

/** Failures that say the target is unhealthy, rather than that one request was unsuitable. */
const CIRCUIT_FAILURES = new Set<LlmErrorKind>([
  'rate_limit',
  'timeout',
  'network',
  'server',
  'auth',
  'quota',
  'model_unavailable',
]);

export function countsTowardCircuit(kind: LlmErrorKind): boolean {
  return CIRCUIT_FAILURES.has(kind);
}

/**
 * Target-scoped failures for which another request in the same run cannot help,
 * and the target is therefore written off until the process exits.
 *
 * `model_unavailable` is deliberately **not** here, however conclusive its name
 * sounds. It is the classification for a bare 404 and for `no healthy
 * deployment`, and `omniroute` produces both intermittently for a model listed
 * in its own `/v1/models` — working again minutes later. Writing the target off
 * permanently on one such window is how a free-first pool spends the rest of a
 * corpus on the paid fallback. The circuit breaker already covers it: repeated
 * occurrences open it, and a cool-down lets the target prove itself again.
 */
export function disablesTarget(kind: LlmErrorKind): boolean {
  return kind === 'auth' || kind === 'quota';
}

export class LlmCallError extends AppError {
  readonly code = 'E_LLM_CALL';

  private readonly dispositionOverride: Partial<Disposition> | undefined;

  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    options: {
      details?: ErrorDetails;
      cause?: unknown;
      status?: number;
      /** Seconds the server asked us to wait, when it said so. */
      retryAfterMs?: number;
      target?: string;
      /** Narrows the default disposition — e.g. a validator that knows a retry is pointless. */
      disposition?: Partial<Disposition>;
    } = {},
  ) {
    super(message, {
      cause: options.cause,
      details: {
        ...options.details,
        kind,
        status: options.status,
        retryAfterMs: options.retryAfterMs,
        target: options.target,
      },
    });
    this.dispositionOverride = options.disposition;
  }

  get disposition(): Disposition {
    return { ...dispositionOf(this.kind), ...this.dispositionOverride };
  }

  get retryAfterMs(): number | undefined {
    return this.details.retryAfterMs as number | undefined;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), kind: this.kind };
  }
}

/** Raised when every candidate target has been exhausted. */
export class AllTargetsFailedError extends AppError {
  readonly code = 'E_LLM_EXHAUSTED';

  constructor(
    message: string,
    readonly failures: LlmCallError[],
  ) {
    super(message, {
      details: { attempts: failures.map((f) => ({ target: f.details.target, kind: f.kind, message: f.message })) },
      cause: failures.at(-1),
    });
  }

  /** The most informative failure — the last one that was not a plain transport error. */
  get primary(): LlmCallError | undefined {
    return this.failures.find((f) => f.kind !== 'network' && f.kind !== 'unknown') ?? this.failures.at(-1);
  }
}

/**
 * True when a call died because the answer did not fit, at any point in the
 * fallback chain.
 *
 * A caller that can make its request *smaller* — a batch it may split, a
 * document it may chunk — wants to know this, because doing so is cheaper than
 * the escalation the gateway has already tried. Everything else should leave the
 * error alone.
 */
export function isOutputTruncated(error: unknown): boolean {
  if (error instanceof LlmCallError) return error.kind === 'output_truncated';
  if (error instanceof AllTargetsFailedError) {
    return error.failures.some((failure) => failure.kind === 'output_truncated');
  }
  return false;
}
