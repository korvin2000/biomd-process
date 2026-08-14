export type PromptVariables = Record<string, unknown>;

export interface RenderedPrompt {
  /** Stable across documents — the prompt-cache prefix. */
  system: string;
  /** Stable instructions; the volatile document is added by the MessageBuilder. */
  instructions: string;
  /** Hash of the raw template sources; feeds the task fingerprint. */
  version: string;
}

export interface TemplateEngine {
  render(source: string, variables: PromptVariables): string;
}
