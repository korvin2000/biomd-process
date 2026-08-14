export interface SourceDocument {
  /** Stable work-item id — `<lang>/<slug>`. */
  id: string;
  slug: string;
  /** Language of this document, from config or inferred from the path. */
  language: string;
  absolutePath: string;
  /** Path relative to the input base dir; what the journal and the UI show. */
  relativePath: string;
  content: string;
  contentHash: string;
  bytes: number;
  estimatedTokens: number;
}

/** A slice of a document handed to one LLM call. */
export interface DocumentSegment {
  /** 0-based position among the segments of one attempt. */
  index: number;
  total: number;
  /** Human label for prompts and logs, e.g. `head`, `chunk 2/5`. */
  label: string;
  text: string;
  estimatedTokens: number;
  /** Character offsets into the source document. */
  start: number;
  end: number;
  /** True when content was dropped to fit a budget. */
  truncated: boolean;
}

export type ContextAttemptKind = 'full' | 'head' | 'head-tail' | 'chunked';

/**
 * One rung of the escalation ladder: a concrete way to present the document to
 * the model, with its estimated cost. A pipeline walks these in order and stops
 * at the first one whose result it accepts.
 */
export interface ContextAttempt {
  id: string;
  kind: ContextAttemptKind;
  segments: DocumentSegment[];
  estimatedInputTokens: number;
  /** True when the attempt does not carry the whole document. */
  partial: boolean;
  description: string;
}

export interface ContextBudget {
  /** Input tokens available for the document itself, overhead already deducted. */
  maxDocumentTokens: number;
  /** Tokens the rendered prompt costs before the document is added. */
  promptOverheadTokens: number;
}

export interface ContextStrategy {
  readonly id: string;
  readonly description: string;
  plan(document: SourceDocument, budget: ContextBudget): ContextAttempt[];
}
