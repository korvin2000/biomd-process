import { hashStructure, shortHash } from '../shared/hash.js';

export interface TaskIdentity {
  workItemId: string;
  pipeline: string;
  /** Distinguishes sibling tasks of one pipeline, e.g. the target language. */
  variant?: string;
}

export interface FingerprintInputs extends TaskIdentity {
  /** Hash of the source document content. */
  sourceHash: string;
  /** Hash of the prompt templates used by this pipeline. */
  promptVersion: string;
  /**
   * Anything else that changes what a correct output looks like: the output
   * contract, required fields, structure-verification flags. Deliberately *not*
   * the model or the routing strategy — re-running a corpus because a fallback
   * model was added would be expensive and pointless.
   */
  contract: unknown;
}

/** Stable across runs: identifies "the same job", regardless of its inputs. */
export function taskIdOf(identity: TaskIdentity): string {
  return shortHash(`${identity.pipeline}|${identity.workItemId}|${identity.variant ?? ''}`, 12);
}

/**
 * Changes whenever the work would produce a different result. Resume compares
 * fingerprints, so editing a prompt or a required-field list correctly redoes
 * the affected work while an unchanged corpus costs nothing.
 */
export function fingerprintOf(inputs: FingerprintInputs): string {
  return hashStructure(
    {
      taskId: taskIdOf(inputs),
      sourceHash: inputs.sourceHash,
      promptVersion: inputs.promptVersion,
      contract: inputs.contract,
    },
    16,
  );
}
