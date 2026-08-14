import type { Capability, ReliabilityConfig } from '../config/schema.js';
import {
  AllTargetsFailedError,
  CircuitBreakerRegistry,
  ErrorClassifier,
  LlmCallError,
  RateLimiterRegistry,
  RetryPolicy,
} from '../reliability/index.js';
import type { Router } from '../routing/Router.js';
import type { TargetStatsRegistry } from '../routing/TargetStats.js';
import { withTimeout } from '../shared/async.js';
import type { BudgetGuard } from './Budget.js';
import { addUsage, resolveCost } from './CostCalculator.js';
import type { LlmClientFactory } from './LlmClientFactory.js';
import type { ModelRegistry } from './ModelRegistry.js';
import { EMPTY_USAGE, type CompletionRequest, type CompletionResponse, type ModelTarget, type TokenUsage } from './types.js';

export type ValidationVerdict = { ok: true } | { ok: false; reason: string; retryable?: boolean };

export interface GatewayCallOptions {
  /** Which pipeline is asking — used for routing and journalling. */
  pipeline: string;
  /** Routing pool name; `default` when omitted. */
  pool?: string;
  requiredCapabilities?: readonly Capability[];
  /** Drives routing decisions; the caller already knows its prompt size. */
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  signal?: AbortSignal;
  /**
   * Domain check on a syntactically fine response. A rejection is treated as a
   * call failure, so it participates in retry and fallback like any other.
   */
  validate?: (response: CompletionResponse) => ValidationVerdict;
  correlation?: Record<string, string>;
}

export interface AttemptRecord {
  target: string;
  modelId: string;
  endpointId: string;
  attempt: number;
  outcome: 'success' | 'error';
  latencyMs: number;
  usage: TokenUsage;
  costUsd: number;
  errorKind?: string;
  message?: string;
}

export interface GatewayResult {
  response: CompletionResponse;
  target: ModelTarget;
  /** Cost of the successful call only. */
  costUsd: number;
  /** Usage across every attempt, including the failed ones we still paid for. */
  totalUsage: TokenUsage;
  totalCostUsd: number;
  attempts: AttemptRecord[];
}

export interface GatewayObserver {
  onAttempt?(record: AttemptRecord, options: GatewayCallOptions): void;
  onRetry?(info: { target: string; attempt: number; delayMs: number; kind: string; message: string }): void;
  onFallback?(info: { from: string; to: string; kind: string; message: string }): void;
}

/**
 * The single door to every LLM call.
 *
 * Responsibilities, in order: budget check → route → (per target) rate limit →
 * circuit breaker → timeout → retry → validate → account. Nothing else in the
 * codebase talks to a provider, which is what makes cost, reliability and
 * observability uniform rather than sprinkled across pipelines.
 */
export class LlmGateway {
  private readonly classifier = new ErrorClassifier();
  private readonly retry: RetryPolicy;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly router: Router,
    private readonly clients: LlmClientFactory,
    private readonly breakers: CircuitBreakerRegistry,
    private readonly limiters: RateLimiterRegistry,
    private readonly stats: TargetStatsRegistry,
    private readonly budget: BudgetGuard,
    private readonly reliability: ReliabilityConfig,
    private readonly observer: GatewayObserver = {},
  ) {
    this.retry = new RetryPolicy(reliability.retry);
  }

  /** Candidate chain for a pool, for `--dry-run` and `biomd models`. */
  plan(options: GatewayCallOptions): ModelTarget[] {
    return this.chainFor(options);
  }

  async complete(request: CompletionRequest, options: GatewayCallOptions): Promise<GatewayResult> {
    const chain = this.chainFor(options);
    if (chain.length === 0) {
      throw new AllTargetsFailedError('No model targets available for this task', [
        new LlmCallError('model_unavailable', `Routing pool "${options.pool ?? 'default'}" is empty`),
      ]);
    }

    const attempts: AttemptRecord[] = [];
    const failures: LlmCallError[] = [];

    for (const [index, target] of chain.entries()) {
      if (!this.breakers.canAttempt(target.key)) {
        failures.push(new LlmCallError('circuit_open', `Circuit open for ${target.key}`, { target: target.key }));
        continue;
      }

      try {
        const response = await this.callTarget(target, request, options, attempts);
        this.breakers.recordSuccess(target.key);
        return this.buildResult(response, target, attempts);
      } catch (error: unknown) {
        const failure = this.classifier.classify(error, target.key);
        failures.push(failure);
        this.breakers.recordFailure(target.key);

        if (!this.shouldFallback(failure)) break;

        const next = chain[index + 1];
        if (next) {
          this.observer.onFallback?.({
            from: target.key,
            to: next.key,
            kind: failure.kind,
            message: failure.message,
          });
        }
      }
    }

    // The per-target list says *what* failed; the last message says *why*, and
    // without it a validation failure reads as an anonymous "response_format".
    const detail = failures.at(-1)?.message;
    throw new AllTargetsFailedError(
      `All ${chain.length} model target(s) failed for ${options.pipeline}: ` +
        failures.map((f) => `${f.details.target ?? '?'} (${f.kind})`).join(', ') +
        (detail ? `. Last error: ${detail}` : ''),
      failures,
    );
  }

  private chainFor(options: GatewayCallOptions): ModelTarget[] {
    const candidates = this.registry.pool(options.pool);
    const ranked = this.router.select(candidates, {
      pipeline: options.pipeline,
      estimatedInputTokens: options.estimatedInputTokens,
      expectedOutputTokens: options.expectedOutputTokens,
      requiredCapabilities: options.requiredCapabilities ?? [],
    });
    return ranked.slice(0, this.reliability.fallback.maxTargets);
  }

  private shouldFallback(failure: LlmCallError): boolean {
    if (!failure.disposition.fallbackable) return false;
    if (failure.kind === 'response_format' && !this.reliability.fallback.onValidationFailure) return false;
    return true;
  }

  private async callTarget(
    target: ModelTarget,
    request: CompletionRequest,
    options: GatewayCallOptions,
    attempts: AttemptRecord[],
  ): Promise<CompletionResponse> {
    const limiter = this.limiters.for(target.endpointId, {
      requestsPerMinute: target.endpoint.requestsPerMinute,
      maxConcurrent: target.endpoint.maxConcurrent,
    });

    return this.retry.run(
      async (attempt) => {
        this.budget.assertAvailable();

        const record: AttemptRecord = {
          target: target.key,
          modelId: target.modelId,
          endpointId: target.endpointId,
          attempt,
          outcome: 'error',
          latencyMs: 0,
          usage: { ...EMPTY_USAGE },
          costUsd: 0,
        };
        const startedAt = Date.now();
        const release = await limiter.acquire(options.signal);

        try {
          const response = await withTimeout(
            target.timeoutMs,
            (signal) =>
              this.clients
                .for(target.endpointId)
                .complete(target, this.withTargetParams(target, request), { signal, timeoutMs: target.timeoutMs }),
            { signal: options.signal, label: `${options.pipeline} → ${target.key}` },
          );

          record.usage = response.usage;
          record.costUsd = resolveCost(response, target);
          this.budget.record(response.usage, record.costUsd);

          if (response.finishReason === 'length') {
            throw new LlmCallError('response_format', 'Response was cut off by the output token limit', {
              target: target.key,
            });
          }

          const verdict = options.validate?.(response) ?? { ok: true as const };
          if (!verdict.ok) {
            throw new LlmCallError('response_format', verdict.reason, {
              target: target.key,
              disposition: verdict.retryable === false ? { retryable: false } : undefined,
            });
          }

          record.outcome = 'success';
          this.stats.recordSuccess(target.key, Date.now() - startedAt, record.costUsd);
          return response;
        } catch (error: unknown) {
          const failure = this.classifier.classify(error, target.key);
          record.errorKind = failure.kind;
          record.message = failure.message;
          this.stats.recordFailure(target.key);
          throw failure;
        } finally {
          record.latencyMs = Date.now() - startedAt;
          attempts.push(record);
          this.observer.onAttempt?.(record, options);
          release();
        }
      },
      {
        signal: options.signal,
        onRetry: (info) =>
          this.observer.onRetry?.({
            target: target.key,
            attempt: info.attempt,
            delayMs: Math.round(info.delayMs),
            kind: info.error.kind,
            message: info.error.message,
          }),
      },
    );
  }

  /** Model-level params from config, with the caller's request winning. */
  private withTargetParams(target: ModelTarget, request: CompletionRequest): CompletionRequest {
    return {
      ...request,
      params: {
        ...target.params,
        maxOutputTokens: target.maxOutputTokens,
        ...request.params,
      },
    };
  }

  private buildResult(response: CompletionResponse, target: ModelTarget, attempts: AttemptRecord[]): GatewayResult {
    const totalUsage = attempts.reduce<TokenUsage>((sum, record) => addUsage(sum, record.usage), { ...EMPTY_USAGE });
    const totalCostUsd = attempts.reduce((sum, record) => sum + record.costUsd, 0);
    return {
      response,
      target,
      costUsd: resolveCost(response, target),
      totalUsage,
      totalCostUsd,
      attempts: [...attempts],
    };
  }
}
