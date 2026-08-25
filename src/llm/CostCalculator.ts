import type { Pricing } from '../config/schema.js';
import type { CompletionResponse, ModelTarget, TokenUsage } from './types.js';

const PER_TOKEN = 1_000_000;

/**
 * Estimated USD cost of one call. Cached input tokens are billed at their own
 * (much lower) rate when the model declares one — that difference is the whole
 * point of building cache-friendly prompts, so it must show up in the numbers.
 */
export function estimateCost(usage: TokenUsage, pricing: Pricing): number {
  const cached = Math.min(usage.cachedPromptTokens, usage.promptTokens);
  const cacheWrite = Math.min(usage.cacheWritePromptTokens ?? 0, Math.max(0, usage.promptTokens - cached));
  const fresh = Math.max(0, usage.promptTokens - cached - cacheWrite);
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;
  const cacheWriteRate = pricing.cacheWriteInputPer1M ?? pricing.inputPer1M;
  const reasoningRate = pricing.reasoningPer1M ?? pricing.outputPer1M;

  // Providers report reasoning tokens inside completion tokens; only charge the
  // difference when a separate reasoning rate is configured.
  const billableCompletion = Math.max(0, usage.completionTokens - usage.reasoningTokens);

  return (
    (fresh * pricing.inputPer1M +
      cached * cachedRate +
      cacheWrite * cacheWriteRate +
      billableCompletion * pricing.outputPer1M +
      usage.reasoningTokens * reasoningRate) /
    PER_TOKEN
  );
}

/** Provider-reported cost wins when available; our pricing table is a fallback. */
export function resolveCost(response: CompletionResponse, target: ModelTarget): number {
  return response.providerCostUsd ?? estimateCost(response.usage, target.pricing);
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedPromptTokens: a.cachedPromptTokens + b.cachedPromptTokens,
    cacheWritePromptTokens: (a.cacheWritePromptTokens ?? 0) + (b.cacheWritePromptTokens ?? 0),
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
