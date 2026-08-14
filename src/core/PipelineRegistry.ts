import { ConfigError } from '../shared/errors.js';
import type { Pipeline } from './types.js';

/**
 * Registered task types. Adding a pipeline is a `register()` call plus a
 * `tasks.<id>` block in the config — no orchestrator changes.
 */
export class PipelineRegistry {
  private readonly pipelines = new Map<string, Pipeline>();

  register(pipeline: Pipeline): this {
    this.pipelines.set(pipeline.id, pipeline);
    return this;
  }

  get(id: string): Pipeline {
    const pipeline = this.pipelines.get(id);
    if (!pipeline) {
      throw new ConfigError(`Unknown pipeline "${id}". Registered: ${this.ids().join(', ')}`, {
        details: { id, registered: this.ids() },
      });
    }
    return pipeline;
  }

  has(id: string): boolean {
    return this.pipelines.has(id);
  }

  ids(): string[] {
    return [...this.pipelines.keys()];
  }

  all(): Pipeline[] {
    return [...this.pipelines.values()];
  }
}
