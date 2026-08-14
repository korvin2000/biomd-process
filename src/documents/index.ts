export type {
  ContextAttempt,
  ContextAttemptKind,
  ContextBudget,
  ContextStrategy,
  DocumentSegment,
  SourceDocument,
} from './types.js';
export { Segmenter } from './Segmenter.js';
export type { ChunkOptions } from './Segmenter.js';
export { splitBlocks } from './markdown/blocks.js';
export type { MarkdownBlock, BlockKind } from './markdown/blocks.js';
export { markdownSkeleton, compareSkeletons } from './markdown/skeleton.js';
export type { SkeletonComparison } from './markdown/skeleton.js';
export { extractTextSpans, applyTextSpans, maskTokens, missingMasks } from './markdown/textSpans.js';
export type { TextSpan, SpanKind } from './markdown/textSpans.js';
export { ContextStrategyRegistry } from './context/ContextStrategyRegistry.js';
export {
  builtinContextStrategies,
  fullStrategy,
  truncationFirstStrategy,
  chunkedStrategy,
  stagedStrategy,
} from './context/strategies.js';
export type { ContextStrategyDeps, ContextStrategyFactory } from './context/strategies.js';
