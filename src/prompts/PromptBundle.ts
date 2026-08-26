import type { ChatMessage, PromptCacheRequest, RequestVariant } from '../llm/types.js';
import { MessageBuilder, type PromptSection } from './MessageBuilder.js';
import type { PromptRepository } from './PromptRepository.js';
import type { PromptVariables } from './types.js';

/** Everything a prompt decides about a request, ready to be spread into one. */
export interface PromptBundle {
  messages: ChatMessage[];
  promptCache: PromptCacheRequest;
  /** Present only when this task has per-model templates; keyed by model id. */
  variants?: Record<string, RequestVariant>;
}

/**
 * Renders a task's prompt for every model that could answer, in one object.
 *
 * A pipeline builds its request before routing runs, so it cannot know which
 * model will serve the call — and after a fallback it may be a model the first
 * attempt never considered. The shape that survives both is to carry every
 * rendering along and let the gateway pick at dispatch, which is what
 * {@link ../llm/types.js#CompletionRequest.variants} is for.
 *
 * Cost is one extra template pass per override per call. There are normally
 * none, in which case this is exactly what the call site did before: render,
 * build, key the cache.
 *
 * One imprecision worth knowing: `estimatedInputTokens` is measured by the
 * caller on `messages`, the shared rendering. A model whose override is the
 * shared prompt plus a few lines is therefore estimated a few tokens short —
 * harmless for routing and for a context-window fit check, and not harmless if
 * an override is ever written as a wholesale replacement of a different size.
 */
export async function buildPromptBundle(
  prompts: PromptRepository,
  promptId: string,
  variables: PromptVariables,
  sections: readonly PromptSection[],
): Promise<PromptBundle> {
  const shared = await prompts.render(promptId, variables);
  const bundle: PromptBundle = {
    messages: MessageBuilder.build(shared, sections),
    promptCache: { key: `${promptId}:${shared.version}`, mode: 'explicit' },
  };

  const modelIds = await prompts.variantsOf(promptId);
  if (modelIds.length === 0) return bundle;

  const variants: Record<string, RequestVariant> = {};
  for (const modelId of modelIds) {
    const rendered = await prompts.render(promptId, variables, modelId);
    variants[modelId] = {
      messages: MessageBuilder.build(rendered, sections),
      promptCache: { key: `${promptId}@${modelId}:${rendered.version}`, mode: 'explicit' },
    };
  }
  return { ...bundle, variants };
}
