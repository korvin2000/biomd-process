import type { AttemptTuning, GatewayCallOptions, GatewayResult, LlmPort } from '../llm/LlmGateway.js';
import type { CompletionRequest, ModelTarget } from '../llm/types.js';
import { AllTargetsFailedError } from '../reliability/index.js';

/**
 * One attempt at a task, as its pipeline sees it.
 *
 * Wraps the gateway so that every call the task makes carries this attempt's
 * {@link AttemptTuning}, and remembers which targets answered so the *next*
 * attempt can lead with somebody else.
 *
 * The wrapping is what keeps task-level fallback out of the pipelines
 * altogether. A pipeline knows how to do its job; it has no business knowing
 * how many times it has already tried, and `extract`, `translate`, `websearch`
 * and `localize` all got this without a line changing in any of them.
 */
export class AttemptScope implements LlmPort {
  /** Targets that served — or tried to serve — this attempt. */
  readonly used = new Set<string>();

  private calls = 0;

  constructor(
    private readonly inner: LlmPort,
    private readonly tuning: AttemptTuning,
  ) {}

  /**
   * Whether this attempt got as far as asking a model.
   *
   * The test that decides if retrying is worth anything: a task that failed
   * without calling anything failed deterministically — an unreadable source, a
   * bad path template — and running it twice more only spends wall-clock to
   * arrive at the same place.
   */
  get calledModel(): boolean {
    return this.calls > 0;
  }

  async complete(request: CompletionRequest, options: GatewayCallOptions): Promise<GatewayResult> {
    this.calls += 1;
    try {
      const result = await this.inner.complete(request, { ...options, tuning: this.tuning });
      for (const attempt of result.attempts) this.used.add(attempt.target);
      return result;
    } catch (error: unknown) {
      // A call that exhausted its chain still names who was asked, and those are
      // exactly the targets the next attempt should not lead with either.
      if (error instanceof AllTargetsFailedError) {
        for (const failure of error.failures) {
          const target = failure.details['target'];
          if (typeof target === 'string') this.used.add(target);
        }
      }
      throw error;
    }
  }

  plan(options: GatewayCallOptions): ModelTarget[] {
    return this.inner.plan({ ...options, tuning: this.tuning });
  }
}
