import { Eta } from 'eta';

import { PipelineError } from '../shared/errors.js';
import type { PromptVariables, TemplateEngine } from './types.js';

/**
 * Eta-backed renderer. Templates use `<%= it.name %>` and the usual control
 * flow; anything beyond simple substitution belongs in the pipeline, not in a
 * prompt file.
 *
 * `autoTrim: false` matters: prompts are whitespace-sensitive and a template
 * engine silently eating newlines changes the prompt — and therefore the cache
 * prefix — behind the author's back.
 */
export class EtaTemplateEngine implements TemplateEngine {
  private readonly eta = new Eta({ autoTrim: false, autoEscape: false, rmWhitespace: false });

  render(source: string, variables: PromptVariables): string {
    try {
      return this.eta.renderString(source, variables);
    } catch (error: unknown) {
      throw new PipelineError('Prompt template failed to render', {
        details: { variables: Object.keys(variables) },
        cause: error,
      });
    }
  }
}
