import type { Capability } from '../../config/schema.js';
import type { ContextAttempt, DocumentSegment } from '../../documents/types.js';
import { usableInputTokens, type ResponseFormat } from '../../llm/types.js';
import { addUsage } from '../../llm/CostCalculator.js';
import { EMPTY_USAGE, type TokenUsage } from '../../llm/types.js';
import type { PromptSection } from '../../prompts/MessageBuilder.js';
import { MessageBuilder } from '../../prompts/MessageBuilder.js';
import type { PromptVariables } from '../../prompts/types.js';
import { isAbortError } from '../../shared/async.js';
import { AbortedError, BudgetExceededError, PipelineError, errorMessage } from '../../shared/errors.js';
import { soleItem, type ExecutionContext, type PlannedTask } from '../../core/types.js';

export interface ParsedOk<T> {
  ok: true;
  value: T;
  /** Anything the parser silently fixed and the user should still be told about. */
  notes?: string[];
}
export interface ParsedFail {
  ok: false;
  reason: string;
  /** False when retrying the same call cannot help (a structural mismatch). */
  retryable?: boolean;
}
export type Parsed<T> = ParsedOk<T> | ParsedFail;

export interface EscalationSpec<T> {
  task: PlannedTask;
  context: ExecutionContext;
  /** Prompt template id and routing pool for this task type. */
  promptId: string;
  pool?: string;
  contextStrategyId: string;
  /**
   * How much of the document an answer is allowed to be based on.
   *
   * `any` (the default) walks the strategy's ladder as planned — the cheap
   * truncated rungs first, which is right for a task that looks for a *specific*
   * fact and can tell when it has found it.
   *
   * `whole` drops every rung that does not carry the entire document. A harvest
   * task — "answer every key this article supports" — cannot tell "the article
   * does not say" apart from "we did not send the part that says it", so a
   * truncated rung there is not a cheap win but a silently incomplete answer.
   * Skipping those rungs at plan time is also what keeps it free: rejecting them
   * after the call would bill for a reading that was never usable.
   */
  coverage?: 'any' | 'whole';
  requiredCapabilities?: readonly Capability[];
  responseFormat?: ResponseFormat;
  expectedOutputTokens: number;
  /** Per-attempt, per-segment template variables. */
  variables(attempt: ContextAttempt, segment: DocumentSegment): PromptVariables;
  /** How the document segment is presented; always emitted last. */
  section(segment: DocumentSegment): PromptSection;
  parse(text: string, segment: DocumentSegment, attempt: ContextAttempt): Parsed<T>;
  /** Combines per-segment results of a chunked attempt. */
  merge(parts: T[], attempt: ContextAttempt): T;
  /** Final gate. Rejecting moves to the next, more expensive attempt. */
  accept(value: T, attempt: ContextAttempt): { ok: true } | { ok: false; reason: string };
}

export interface EscalationResult<T> {
  value: T;
  attempt: ContextAttempt;
  usage: TokenUsage;
  costUsd: number;
  notes: string[];
}

/**
 * The escalation loop both pipelines share.
 *
 * Walks the context strategy's attempts cheapest-first and returns the first
 * result that passes `accept`. This is where the token savings actually happen:
 * a document whose head is enough never pays for its body, and only the
 * documents that genuinely need the whole text (or a chunked pass) cost more.
 */
export async function runWithEscalation<T>(spec: EscalationSpec<T>): Promise<EscalationResult<T>> {
  const { context, task } = spec;
  const document = soleItem(task);

  const prompt = await context.prompts.render(spec.promptId, spec.variables(placeholderAttempt(), placeholderSegment()));
  const overhead = context.estimator.estimateMessages(MessageBuilder.build(prompt, []));
  const budget = {
    maxDocumentTokens: Math.max(0, (await maxInputTokens(spec)) - overhead),
    promptOverheadTokens: overhead,
  };

  const strategy = context.contexts.get(spec.contextStrategyId);
  const attempts = coveringAttempts(strategy.plan(document, budget), spec.coverage ?? 'any');
  const notes: string[] = [];

  let usage: TokenUsage = { ...EMPTY_USAGE };
  let costUsd = 0;
  let lastReason = 'no attempt produced an acceptable result';

  for (const [index, attempt] of attempts.entries()) {
    context.logger.debug(`Context attempt "${attempt.id}": ${attempt.description}`, {
      taskId: task.taskId,
      segments: attempt.segments.length,
      estimatedInputTokens: attempt.estimatedInputTokens,
    });

    /**
     * On the last rung there is no cheaper recourse left, so acceptance moves
     * *into* the call, where a rejection becomes a normal validation failure and
     * gets the retry-then-fall-back-to-a-stronger-model treatment. On earlier
     * rungs it stays out here, because escalating the context is cheaper than
     * escalating the model.
     */
    const isFinal = index === attempts.length - 1;

    try {
      const parts: T[] = [];
      const parseNotes: string[] = [];
      for (const segment of attempt.segments) {
        const outcome = await callSegment(spec, attempt, segment, isFinal && attempt.segments.length === 1);
        usage = addUsage(usage, outcome.usage);
        costUsd += outcome.costUsd;
        parts.push(outcome.value);
        parseNotes.push(...outcome.notes);
      }

      const merged = spec.merge(parts, attempt);
      const verdict = spec.accept(merged, attempt);
      if (verdict.ok) {
        // Only the accepted attempt's fixes are worth reporting; a rejected
        // attempt's notes describe a document that was thrown away.
        notes.push(...dedupe(parseNotes));
        return { value: merged, attempt, usage, costUsd, notes };
      }

      lastReason = verdict.reason;
      notes.push(`Attempt "${attempt.id}" rejected: ${verdict.reason}`);
    } catch (error: unknown) {
      if (error instanceof AbortedError || error instanceof BudgetExceededError || isAbortError(error)) throw error;
      lastReason = errorMessage(error);
      notes.push(`Attempt "${attempt.id}" failed: ${lastReason}`);
      context.logger.debug(`Escalating past attempt "${attempt.id}"`, { reason: lastReason });
    }
  }

  throw new PipelineError(`${spec.task.pipeline} exhausted every context attempt: ${lastReason}`, {
    details: {
      taskId: task.taskId,
      document: document.relativePath,
      attempts: attempts.map((attempt) => attempt.id),
      notes,
    },
  });
}

async function callSegment<T>(
  spec: EscalationSpec<T>,
  attempt: ContextAttempt,
  segment: DocumentSegment,
  checkAcceptance: boolean,
): Promise<{ value: T; usage: TokenUsage; costUsd: number; notes: string[] }> {
  const { context, task } = spec;
  const prompt = await context.prompts.render(spec.promptId, spec.variables(attempt, segment));
  const messages = MessageBuilder.build(prompt, [spec.section(segment)]);

  // The parse result of the accepted response, captured by the validator so the
  // response is parsed exactly once even though validation happens inside the gateway.
  let parsed: ParsedOk<T> | undefined;

  const result = await context.llm.complete(
    {
      messages,
      responseFormat: spec.responseFormat,
      correlationId: task.taskId,
      promptCache: { key: `${spec.promptId}:${prompt.version}`, mode: 'explicit' },
    },
    {
      pipeline: task.pipeline,
      pool: spec.pool,
      variant: task.variant,
      requiredCapabilities: spec.requiredCapabilities,
      estimatedInputTokens: context.estimator.estimateMessages(messages),
      expectedOutputTokens: spec.expectedOutputTokens,
      signal: context.signal,
      validate: (response) => {
        parsed = undefined;
        const outcome = spec.parse(response.text, segment, attempt);
        if (!outcome.ok) return { ok: false, reason: outcome.reason, retryable: outcome.retryable };

        if (checkAcceptance) {
          const verdict = spec.accept(outcome.value, attempt);
          if (!verdict.ok) return { ok: false, reason: verdict.reason };
        }

        parsed = outcome;
        return { ok: true };
      },
    },
  );

  if (!parsed) {
    throw new PipelineError('Response passed validation but produced no value', { details: { taskId: task.taskId } });
  }
  return { value: parsed.value, usage: result.totalUsage, costUsd: result.totalCostUsd, notes: parsed.notes ?? [] };
}

function dedupe(notes: readonly string[]): string[] {
  return [...new Set(notes)];
}

/**
 * The rungs that are allowed to answer, under this spec's coverage rule.
 *
 * Every built-in strategy ends with an attempt that carries the whole document
 * (`full`, or `chunked` when it does not fit a window), so the filter normally
 * leaves at least one. A custom strategy that offers nothing but truncated
 * attempts keeps its plan rather than being left with nothing to run — a
 * partial reading is still better than no reading, and the pipeline says so in
 * its notes.
 */
function coveringAttempts(attempts: ContextAttempt[], coverage: 'any' | 'whole'): ContextAttempt[] {
  if (coverage === 'any') return attempts;
  const whole = attempts.filter((attempt) => !attempt.partial);
  return whole.length > 0 ? whole : attempts;
}

/** Largest usable input window across the routing pool this task will use. */
async function maxInputTokens(spec: EscalationSpec<unknown>): Promise<number> {
  const { context } = spec;
  const targets = context.llm.plan({
    pipeline: spec.task.pipeline,
    pool: spec.pool,
    variant: spec.task.variant,
    estimatedInputTokens: 0,
    expectedOutputTokens: spec.expectedOutputTokens,
    requiredCapabilities: spec.requiredCapabilities,
  });

  const fitting = {
    reserveOutputTokens: Math.max(context.config.context.reserveOutputTokens, spec.expectedOutputTokens),
    safetyMarginRatio: context.config.context.safetyMarginRatio,
  };
  return targets.reduce((max, target) => Math.max(max, usableInputTokens(target, fitting)), 0);
}

/** Variables are needed before the first attempt exists, only to size the prompt. */
function placeholderAttempt(): ContextAttempt {
  return { id: 'full', kind: 'full', segments: [], estimatedInputTokens: 0, partial: false, description: '' };
}

function placeholderSegment(): DocumentSegment {
  return { index: 0, total: 1, label: 'full', text: '', estimatedTokens: 0, start: 0, end: 0, truncated: false };
}
