import type { ContextConfig } from '../../config/schema.js';
import type { Segmenter } from '../Segmenter.js';
import type { ContextAttempt, ContextBudget, ContextStrategy, DocumentSegment, SourceDocument } from '../types.js';

export interface ContextStrategyDeps {
  segmenter: Segmenter;
  config: ContextConfig;
}

export type ContextStrategyFactory = (deps: ContextStrategyDeps) => ContextStrategy;

/**
 * Escalation ladders.
 *
 * Each strategy returns attempts ordered cheapest-first. The pipeline stops at
 * the first attempt it accepts, so on a typical corpus most documents never pay
 * for the expensive rungs — that is where the token savings come from, not from
 * shaving words off the prompt.
 */

/** One call with the whole document. Simplest, most accurate, most expensive. */
export const fullStrategy: ContextStrategyFactory = () => ({
  id: 'full',
  description: 'Send the whole document in a single call.',
  plan(document, budget) {
    return [attempt('full', 'full', [segmentFull(document)], budget, `whole document (${document.estimatedTokens} tok)`)];
  },
});

/**
 * Head slice first, whole document only if the cheap attempt is rejected.
 *
 * The default. Biographical articles state identity, dates and places in their
 * first paragraphs; for most documents the head is enough and the rest is never
 * paid for.
 */
export const truncationFirstStrategy: ContextStrategyFactory = ({ segmenter, config }) => ({
  id: 'truncation-first',
  description: 'Try a leading slice first; fall back to the whole document.',
  plan(document, budget) {
    const headTokens = Math.min(config.truncation.headTokens, budget.maxDocumentTokens);
    const head = segmenter.head(document, headTokens);

    // Nothing was cut — a second, identical attempt would just be a second bill.
    if (!head.truncated) return [attempt('full', 'full', [head], budget, 'whole document (fits the head budget)')];

    return [
      attempt('head', 'head', [head], budget, `first ~${headTokens} tokens`),
      attempt('full', 'full', [segmentFull(document)], budget, 'whole document'),
    ];
  },
});

/**
 * Split into token-bounded chunks and merge the per-chunk results.
 *
 * For documents that exceed every available context window, and for translation,
 * where each chunk must be produced in full anyway.
 */
export const chunkedStrategy: ContextStrategyFactory = ({ segmenter, config }) => ({
  id: 'chunked',
  description: 'Split into token-bounded chunks and merge the results.',
  plan(document, budget) {
    if (document.estimatedTokens <= budget.maxDocumentTokens) {
      return [attempt('full', 'full', [segmentFull(document)], budget, 'whole document (fits in one call)')];
    }
    const maxTokens = Math.min(config.chunking.maxTokens, budget.maxDocumentTokens);
    const segments = segmenter.chunks(document, { ...config.chunking, maxTokens });
    return [attempt('chunked', 'chunked', segments, budget, `${segments.length} chunks of ≤${maxTokens} tokens`)];
  },
});

/**
 * The full ladder: head → head+tail → chunked.
 *
 * Use when extraction quality matters and documents vary a lot in size; costs
 * one cheap call for easy documents and degrades gracefully for hard ones.
 */
export const stagedStrategy: ContextStrategyFactory = (deps) => ({
  id: 'staged',
  description: 'Escalate head → head+tail → chunked, stopping at the first accepted result.',
  plan(document, budget) {
    const { segmenter, config } = deps;
    const headTokens = Math.min(config.truncation.headTokens, budget.maxDocumentTokens);
    const head = segmenter.head(document, headTokens);
    if (!head.truncated) {
      return [attempt('full', 'full', [head], budget, 'whole document (fits the head budget)')];
    }

    const tailTokens = config.truncation.tailTokens || Math.floor(headTokens / 2);
    const headTail = segmenter.headAndTail(document, headTokens, tailTokens);

    const attempts: ContextAttempt[] = [
      attempt('head', 'head', [head], budget, `first ~${headTokens} tokens`),
      attempt('head-tail', 'head-tail', [headTail], budget, `first ~${headTokens} + last ~${tailTokens} tokens`),
    ];

    if (document.estimatedTokens <= budget.maxDocumentTokens) {
      attempts.push(attempt('full', 'full', [segmentFull(document)], budget, 'whole document'));
    } else {
      const maxTokens = Math.min(config.chunking.maxTokens, budget.maxDocumentTokens);
      const chunks = segmenter.chunks(document, { ...config.chunking, maxTokens });
      attempts.push(attempt('chunked', 'chunked', chunks, budget, `${chunks.length} chunks`));
    }
    return attempts;
  },
});

export const builtinContextStrategies: Readonly<Record<string, ContextStrategyFactory>> = {
  full: fullStrategy,
  'truncation-first': truncationFirstStrategy,
  chunked: chunkedStrategy,
  staged: stagedStrategy,
};

function segmentFull(document: SourceDocument): DocumentSegment {
  return {
    index: 0,
    total: 1,
    label: 'full',
    text: document.content,
    estimatedTokens: document.estimatedTokens,
    start: 0,
    end: document.content.length,
    truncated: false,
  };
}

function attempt(
  id: string,
  kind: ContextAttempt['kind'],
  segments: DocumentSegment[],
  budget: ContextBudget,
  description: string,
): ContextAttempt {
  const documentTokens = segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
  return {
    id,
    kind,
    segments,
    estimatedInputTokens: documentTokens + budget.promptOverheadTokens * segments.length,
    partial: segments.some((segment) => segment.truncated),
    description,
  };
}
