import type { ChatMessage } from '../llm/types.js';
import type { RenderedPrompt } from './types.js';

export interface PromptSection {
  /** Rendered as a `## heading` above the body. */
  title?: string;
  body: string;
  /**
   * Volatile sections change from document to document and are always emitted
   * last, after every stable section, so the prompt-cache prefix stays intact.
   */
  volatile?: boolean;
  /** Wrap the body in a fenced block with this info string. */
  fence?: string;
}

/**
 * Assembles the wire messages.
 *
 * The single rule this class exists to enforce: **stable text first, volatile
 * text last**. Providers cache on the longest common token prefix, so a run over
 * a thousand documents pays for the system prompt and the instructions once — as
 * long as nothing document-specific (a path, a counter, a timestamp) ever leaks
 * into the prefix. Keeping the assembly in one place is what makes that
 * property testable instead of aspirational.
 */
export class MessageBuilder {
  static build(prompt: RenderedPrompt, sections: readonly PromptSection[] = []): ChatMessage[] {
    const stable = sections.filter((section) => !section.volatile);
    const volatileSections = sections.filter((section) => section.volatile);

    const stableContent = [prompt.instructions, ...stable.map(renderSection)]
      .filter((part) => part.length > 0)
      .join('\n\n');
    const volatileContent = volatileSections.map(renderSection).filter(Boolean).join('\n\n');

    return [
      { role: 'system', content: prompt.system },
      // The explicit breakpoint includes the system message and every stable
      // instruction while excluding the per-document payload that follows.
      { role: 'user', content: stableContent, cacheBreakpoint: true },
      ...(volatileContent ? [{ role: 'user' as const, content: volatileContent }] : []),
    ];
  }
}

function renderSection(section: PromptSection): string {
  const body = section.fence ? `\`\`\`${section.fence}\n${section.body}\n\`\`\`` : section.body;
  return section.title ? `## ${section.title}\n\n${body}` : body;
}
