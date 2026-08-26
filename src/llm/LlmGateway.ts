import type { Capability, ReliabilityConfig } from '../config/schema.js';
import {
  AllTargetsFailedError,
  CircuitBreakerRegistry,
  countsTowardCircuit,
  disablesTarget,
  ErrorClassifier,
  LlmCallError,
  RetryPolicy,
} from '../reliability/index.js';
import type { Router } from '../routing/Router.js';
import type { RoutingRequest } from '../routing/types.js';
import type { TargetStatsRegistry } from '../routing/TargetStats.js';
import { withTimeout } from '../shared/async.js';
import type { BudgetGuard } from './Budget.js';
import { addUsage, resolveCost } from './CostCalculator.js';
import type { LaneRegistry } from './Lanes.js';
import type { LlmClientFactory } from './LlmClientFactory.js';
import type { ModelRegistry } from './ModelRegistry.js';
import { EMPTY_USAGE, type CompletionRequest, type CompletionResponse, type ModelTarget, type TokenUsage } from './types.js';

export type ValidationVerdict = { ok: true } | { ok: false; reason: string; retryable?: boolean };

/**
 * How one *attempt at a task* differs from the attempt before it.
 *
 * Set by the orchestrator's task-level fallback and by no pipeline: a pipeline
 * knows how to do its job, not how many times it has already tried. Everything
 * here is deliberately a nudge to the existing machinery rather than a new
 * path through it — a different head to the same fallback chain, the same
 * chain, the same retries.
 */
export interface AttemptTuning {
  /** Targets an earlier attempt already used; demoted, never removed. */
  avoid?: ReadonlySet<string>;
  /** Routing strategy for this attempt, overriding the pool's own. */
  strategy?: string;
  /** Temperature for this attempt, overriding both model config and caller. */
  temperature?: number;
}

export interface GatewayCallOptions {
  /** Which pipeline is asking — used for routing and journalling. */
  pipeline: string;
  /** Routing pool name; `default` when omitted. */
  pool?: string;
  /**
   * The task's variant — the target language for `translate` and `localize`.
   * Read by `llm.routing.pools.<pool>.prefer`, which is how a language gets the
   * model that renders it best.
   */
  variant?: string;
  requiredCapabilities?: readonly Capability[];
  /** Drives routing decisions; the caller already knows its prompt size. */
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  /**
   * Measurements of this payload beyond its size, for strategies that rank on
   * what is being sent. Forwarded to routing untouched and ignored by every
   * built-in strategy. See {@link RoutingRequest.signals}.
   */
  signals?: Readonly<Record<string, number>>;
  signal?: AbortSignal;
  /**
   * Domain check on a syntactically fine response. A rejection is treated as a
   * call failure, so it participates in retry and fallback like any other.
   */
  validate?: (response: CompletionResponse) => ValidationVerdict;
  correlation?: Record<string, string>;
  /** Set by the orchestrator between task attempts; absent on a first attempt. */
  tuning?: AttemptTuning;
}

/**
 * What a pipeline is allowed to ask of the gateway.
 *
 * Narrow on purpose: it is the seam the orchestrator wraps to carry
 * {@link AttemptTuning} into every call a task makes, without any pipeline
 * having to know that task-level fallback exists.
 */
export interface LlmPort {
  complete(request: CompletionRequest, options: GatewayCallOptions): Promise<GatewayResult>;
  plan(options: GatewayCallOptions): ModelTarget[];
}

export interface AttemptRecord {
  target: string;
  modelId: string;
  /** The name the endpoint knows the model by — what the provider actually served. */
  modelName: string;
  endpointId: string;
  /**
   * The task this call belongs to, taken from the request's `correlationId`.
   *
   * The gateway is the only place that knows which target answered and the
   * orchestrator is the only place that knows a task is finished; this is the
   * key that joins the two, and every pipeline already sets it.
   */
  correlationId?: string;
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

/** What every incident says: who was asking, about what, and what went wrong. */
export interface IncidentInfo {
  pipeline: string;
  /** The task, from the request's `correlationId` — what makes an incident traceable to a file. */
  correlationId?: string;
  kind: string;
  message: string;
}

export interface RetryInfo extends IncidentInfo {
  target: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface FallbackInfo extends IncidentInfo {
  from: string;
  to: string;
}

export interface TargetDownInfo extends IncidentInfo {
  target: string;
}

export interface GatewayObserver {
  onAttempt?(record: AttemptRecord, options: GatewayCallOptions): void;
  onRetry?(info: RetryInfo): void;
  onFallback?(info: FallbackInfo): void;
  /**
   * A target this run has given up on, reported **once** per target.
   *
   * The failure mode this exists for: a mis-named or unauthorized model fails
   * its first few calls, the breaker opens, and every subsequent request skips
   * it in silence — so a pool whose free first choice is dead spends the whole
   * run on the paid second choice, with nothing in the output saying so. A
   * fallback is a normal event and a target that never works is not.
   */
  onTargetDown?(info: TargetDownInfo): void;
}

/**
 * The single door to every LLM call.
 *
 * Responsibilities, in order: budget check → route → (per target) rate limit →
 * circuit breaker → timeout → retry → validate → account. Nothing else in the
 * codebase talks to a provider, which is what makes cost, reliability and
 * observability uniform rather than sprinkled across pipelines.
 */
export class LlmGateway implements LlmPort {
  private readonly classifier = new ErrorClassifier();
  private readonly retry: RetryPolicy;
  /** Targets already announced as down, so the warning is one line and not one per call. */
  private readonly reportedDown = new Set<string>();
  /**
   * Deduped separately from `reportedDown`. An open breaker is recoverable and a
   * disabled target is not; sharing one set lets the recoverable notice consume
   * the one-shot slot and swallow the announcement that the target later died
   * for good — which is the single line this whole mechanism exists to print.
   */
  private readonly reportedCircuitOpen = new Set<string>();
  /** Targets conclusively unusable for the remainder of this run. */
  private readonly unavailableTargets = new Set<string>();

  constructor(
    private readonly registry: ModelRegistry,
    private readonly router: Router,
    private readonly clients: LlmClientFactory,
    private readonly breakers: CircuitBreakerRegistry,
    private readonly lanes: LaneRegistry,
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
      // "The pool is empty" is the wrong sentence when a `preferMode: restrict`
      // variant is what emptied it: the pool is full of models, and none of them
      // is one this variant is allowed to use. Naming the variant is the
      // difference between a two-minute fix and an afternoon.
      const pool = options.pool ?? 'default';
      const reason = options.variant
        ? `No model target for variant "${options.variant}" in pool "${pool}". ` +
          'Under `preferMode: restrict` a variant may use only the models its `prefer` list names, ' +
          'and none of them is currently usable — check the list, their capabilities and their health.'
        : `Routing pool "${pool}" is empty`;
      throw new AllTargetsFailedError('No model targets available for this task', [
        new LlmCallError('model_unavailable', reason),
      ]);
    }

    const attempts: AttemptRecord[] = [];
    const failures: LlmCallError[] = [];

    // Under `preferMode: wait` the head of the chain is not a ranking decision
    // but an availability one, and answering it may mean holding a slot.
    const head = await this.headOfChain(chain, options);
    let held = head.held;

    for (const [index, target] of head.chain.entries()) {
      // The slot was won for one specific target. Reaching any other means that
      // target failed, so the slot is no longer ours to keep.
      if (held && held.target.key !== target.key) {
        held.release();
        held = undefined;
      }
      if (this.unavailableTargets.has(target.key)) {
        failures.push(
          new LlmCallError('model_unavailable', `Target disabled for this run: ${target.key}`, {
            target: target.key,
          }),
        );
        continue;
      }
      if (!this.breakers.canAttempt(target.key)) {
        // Skipping a target with an open breaker is correct and used to be
        // completely silent — which is how a whole run can be served by the
        // fallback without anyone noticing. Say it once.
        this.announceCircuitOpen(target, options, request, `Circuit open for ${target.key}`);
        failures.push(new LlmCallError('circuit_open', `Circuit open for ${target.key}`, { target: target.key }));
        continue;
      }

      /**
       * Claimed here, and *here* specifically: the first iteration of this loop
       * runs in the same tick as the ranking that produced the chain, so no
       * other caller can slip between "this endpoint looks free" and "this
       * endpoint is mine". Falling back moves the claim with the call, which is
       * what keeps the count honest when a target dies mid-run.
       */
      const claim = this.lanes.claim(options.pool, target);

      const reserved = held?.target.key === target.key ? held.release : undefined;
      held = undefined;

      try {
        const response = await this.callTarget(target, request, options, attempts, reserved);
        this.breakers.recordSuccess(target.key);
        return this.buildResult(response, target, attempts);
      } catch (error: unknown) {
        const failure = this.classifier.classify(error, target.key);
        failures.push(failure);
        // A request-specific failure proves the endpoint answered, so it must not
        // count against the target's health — but it is *not* evidence of health
        // either, and `recordSuccess` is `entries.delete(key)`: a full state wipe
        // that closes an open breaker and erases the failures counted so far. A
        // target alternating `server` with `response_format` would then never
        // reach its threshold, and a failed half-open probe would restore full
        // traffic to a dead endpoint. Only a real success clears the record.
        if (countsTowardCircuit(failure.kind)) this.breakers.recordFailure(target.key);

        // Announce only a target we really stop using. Request-specific failures
        // must not create a false TARGET DOWN event.
        if (disablesTarget(failure.kind)) {
          this.unavailableTargets.add(target.key);
          this.announceDown(target, options, request, failure.kind, failure.message);
        } else if (this.breakers.stateOf(target.key) === 'open') {
          this.announceCircuitOpen(target, options, request, failure.message);
        }

        if (!this.shouldFallback(failure)) break;

        const next = chain[index + 1];
        if (next) {
          this.observer.onFallback?.({
            pipeline: options.pipeline,
            ...(request.correlationId ? { correlationId: request.correlationId } : {}),
            from: target.key,
            to: next.key,
            kind: failure.kind,
            message: failure.message,
          });
        }
      } finally {
        claim();
      }
    }

    // A slot won for a target the loop never reached — every entry after it was
    // skipped by a breaker, say — is still ours until we say otherwise.
    held?.release();

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

  private announceDown(
    target: ModelTarget,
    options: GatewayCallOptions,
    request: CompletionRequest,
    kind: string,
    message: string,
  ): void {
    if (this.reportedDown.has(target.key)) return;
    this.reportedDown.add(target.key);
    this.observer.onTargetDown?.({
      target: target.key,
      pipeline: options.pipeline,
      ...(request.correlationId ? { correlationId: request.correlationId } : {}),
      kind,
      message,
    });
  }

  private announceCircuitOpen(
    target: ModelTarget,
    options: GatewayCallOptions,
    request: CompletionRequest,
    message: string,
  ): void {
    if (this.reportedCircuitOpen.has(target.key) || this.reportedDown.has(target.key)) return;
    this.reportedCircuitOpen.add(target.key);
    this.observer.onTargetDown?.({
      target: target.key,
      pipeline: options.pipeline,
      ...(request.correlationId ? { correlationId: request.correlationId } : {}),
      kind: 'circuit_open',
      message,
    });
  }

  private routingRequest(options: GatewayCallOptions): RoutingRequest {
    return {
      pipeline: options.pipeline,
      pool: options.pool,
      variant: options.variant,
      estimatedInputTokens: options.estimatedInputTokens,
      expectedOutputTokens: options.expectedOutputTokens,
      requiredCapabilities: options.requiredCapabilities ?? [],
      ...(options.signals ? { signals: options.signals } : {}),
      ...(options.tuning?.avoid ? { avoid: options.tuning.avoid } : {}),
      ...(options.tuning?.strategy ? { strategy: options.tuning.strategy } : {}),
    };
  }

  private chainFor(options: GatewayCallOptions): ModelTarget[] {
    const candidates = this.registry.pool(options.pool);
    const ranked = this.router.select(candidates, this.routingRequest(options));
    return ranked.slice(0, this.reliability.fallback.maxTargets);
  }

  /**
   * Which target this call should head for, under `preferMode: wait`.
   *
   * Four questions in order, and the order is the feature:
   *
   *  1. Is one of the preferred models free **now**? Asked in the order the
   *     config listed them, because that is the only phase where the ranking
   *     the user wrote can be honoured — later phases are decided by whoever
   *     frees first, which nobody chooses.
   *  2. If none is, wait — but only for `preferWaitMs`. This is the whole point:
   *     a preferred model is worth queueing for, and not worth queueing for
   *     forever.
   *  3. The wait bought nothing, so widen: anything else still allowed that is
   *     free right now.
   *  4. Nothing anywhere is free. Wait, without a deadline, for whichever
   *     allowed model frees first. "Nothing preferred was available" is a reason
   *     to look further; it is never a reason to fail a document.
   *
   * Phases 2 and 4 come back holding a slot, which is why the result carries a
   * release: dropping it and re-acquiring would hand the slot to whichever
   * worker asked next, and the wait would have bought nothing.
   */
  private async headOfChain(
    chain: readonly ModelTarget[],
    options: GatewayCallOptions,
  ): Promise<{ chain: readonly ModelTarget[]; held?: { target: ModelTarget; release: () => void } }> {
    const plan = this.router.waitPlan(chain, this.routingRequest(options));
    if (!plan) return { chain };

    const usable = (target: ModelTarget): boolean =>
      this.breakers.canAttempt(target.key) &&
      !this.unavailableTargets.has(target.key) &&
      this.lanes.freeSlots(options.pool, target) > 0;

    const preferred = plan.preferred.filter(
      (target) => this.breakers.canAttempt(target.key) && !this.unavailableTargets.has(target.key),
    );
    const rest = plan.rest.filter(
      (target) => this.breakers.canAttempt(target.key) && !this.unavailableTargets.has(target.key),
    );

    const readyPreferred = preferred.find(usable);
    if (readyPreferred) return { chain: promote(chain, readyPreferred) };

    const waited = await this.lanes.acquireAny(options.pool, preferred, {
      waitMs: plan.waitMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (waited) return { chain: promote(chain, waited.target), held: waited };

    const readyRest = rest.find(usable);
    if (readyRest) return { chain: promote(chain, readyRest) };

    const any = await this.lanes.acquireAny(options.pool, [...preferred, ...rest], {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return any ? { chain: promote(chain, any.target), held: any } : { chain };
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
    /** A slot already held for this target's first attempt; a retry queues normally. */
    reserved?: () => void,
  ): Promise<CompletionResponse> {
    let reservation = reserved;
    return this.retry.run(
      async (attempt) => {
        this.budget.assertAvailable();

        const record: AttemptRecord = {
          target: target.key,
          modelId: target.modelId,
          modelName: target.modelName,
          endpointId: target.endpointId,
          ...(request.correlationId ? { correlationId: request.correlationId } : {}),
          attempt,
          outcome: 'error',
          latencyMs: 0,
          usage: { ...EMPTY_USAGE },
          costUsd: 0,
        };
        const startedAt = Date.now();
        // The pool's lane first, then the endpoint. Acquired per attempt rather
        // than per target, so a backoff sleep frees the slot for somebody else
        // instead of holding an endpoint idle while nobody talks to it.
        const release = reservation ?? (await this.lanes.acquire(options.pool, target, options.signal));
        reservation = undefined;

        try {
          const response = await withTimeout(
            target.timeoutMs,
            (signal) =>
              this.clients
                .for(target.endpointId)
                .complete(target, this.withTargetParams(target, request, options), {
                  signal,
                  timeoutMs: target.timeoutMs,
                }),
            { signal: options.signal, label: `${options.pipeline} → ${target.key}` },
          );

          record.usage = response.usage;
          record.costUsd = resolveCost(response, target);
          this.budget.record(response.usage, record.costUsd);

          if (response.finishReason === 'length') {
            throw new LlmCallError(
              'output_truncated',
              `Response was cut off by the output token limit (${target.maxOutputTokens} tokens on ${target.key})`,
              { target: target.key, details: { maxOutputTokens: target.maxOutputTokens } },
            );
          }

          const verdict = options.validate?.(response) ?? { ok: true as const };
          if (!verdict.ok) {
            throw new LlmCallError('response_format', verdict.reason, {
              target: target.key,
              disposition: verdict.retryable === false ? { retryable: false } : undefined,
            });
          }

          record.outcome = 'success';
          this.stats.recordSuccess(
            target.key,
            Date.now() - startedAt,
            record.costUsd,
            record.usage.completionTokens,
          );
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
            pipeline: options.pipeline,
            ...(request.correlationId ? { correlationId: request.correlationId } : {}),
            target: target.key,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            delayMs: Math.round(info.delayMs),
            kind: info.error.kind,
            message: info.error.message,
          }),
      },
    );
  }

  /**
   * The request as this target will actually receive it.
   *
   * Two substitutions, both of which can only be made here because both depend
   * on which target routing settled on: the model's own params, and — where the
   * caller supplied one — the model's own prompt. `variants` is stripped rather
   * than passed through, since it is an instruction to the gateway and not a
   * field any provider knows.
   *
   * Model-level params come from config, with the caller's request winning, and
   * the attempt's own tuning winning over both — it is the deliberate last word
   * of a task that has already failed with everyone else's settings.
   */
  private withTargetParams(
    target: ModelTarget,
    request: CompletionRequest,
    options: GatewayCallOptions,
  ): CompletionRequest {
    const { variants, ...rest } = request;
    return {
      ...rest,
      ...(variants?.[target.modelId] ?? {}),
      params: {
        ...target.params,
        maxOutputTokens: target.maxOutputTokens,
        ...request.params,
        ...(options.tuning?.temperature !== undefined ? { temperature: options.tuning.temperature } : {}),
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

/** The chain with `target` moved to the front, everything else in place. */
function promote(chain: readonly ModelTarget[], target: ModelTarget): readonly ModelTarget[] {
  return [target, ...chain.filter((candidate) => candidate.key !== target.key)];
}
