import type { ContextConfig } from '../config/schema.js';
import type { ChatMessage } from './types.js';

/**
 * Token counting seam.
 *
 * Exact counts are impossible across providers anyway (every family tokenizes
 * differently), and pulling in a tokenizer would add megabytes for an estimate
 * we only use to *fit* and *rank*. The heuristic is deliberately conservative;
 * swap in a tiktoken-backed implementation here if a corpus needs it.
 */
export interface TokenEstimator {
  estimateText(text: string): number;
  estimateMessages(messages: readonly ChatMessage[]): number;
  /** Characters that fit in `tokens` — used to cut a document to a budget. */
  charsForTokens(tokens: number): number;
}

/** Per-message envelope (role, separators) charged by chat APIs. */
const MESSAGE_OVERHEAD_TOKENS = 4;
const REPLY_PRIMING_TOKENS = 3;

export class HeuristicTokenEstimator implements TokenEstimator {
  constructor(private readonly charsPerToken: number) {
    if (charsPerToken <= 0) throw new RangeError('charsPerToken must be positive');
  }

  static fromConfig(config: ContextConfig): HeuristicTokenEstimator {
    return new HeuristicTokenEstimator(config.tokenEstimator.charsPerToken);
  }

  estimateText(text: string): number {
    if (!text) return 0;
    // Dense scripts (Cyrillic, CJK) cost more tokens per character than Latin;
    // scale the divisor by the share of non-ASCII characters.
    const nonAscii = countNonAscii(text) / text.length;
    const effective = this.charsPerToken * (1 - 0.45 * nonAscii);
    return Math.ceil(text.length / Math.max(1, effective));
  }

  estimateMessages(messages: readonly ChatMessage[]): number {
    return (
      messages.reduce((sum, message) => sum + this.estimateText(message.content) + MESSAGE_OVERHEAD_TOKENS, 0) +
      REPLY_PRIMING_TOKENS
    );
  }

  charsForTokens(tokens: number): number {
    return Math.max(0, Math.floor(tokens * this.charsPerToken));
  }
}

function countNonAscii(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) count += 1;
  }
  return count;
}
