import type { ExecutionContext, PlannedTask } from '../../core/types.js';
import { addUsage } from '../../llm/CostCalculator.js';
import { EMPTY_USAGE, type TokenUsage } from '../../llm/types.js';
import { MessageBuilder } from '../../prompts/MessageBuilder.js';
import type { PromptVariables } from '../../prompts/types.js';
import { PipelineError } from '../../shared/errors.js';
import { extractJsonBlock, safeJsonParse, type JsonObject } from '../../shared/json.js';
import type { LocalizationUnit } from '../localization/StringTable.js';
import type { TranslationMemory } from '../localization/TranslationMemory.js';

export interface StringBatchSpec {
  task: PlannedTask;
  context: ExecutionContext;
  promptId: string;
  pool?: string;
  targetLanguage: string;
  /** Deduplicated strings to translate, in document order. */
  units: readonly LocalizationUnit[];
  maxPerCall: number;
  memory?: TranslationMemory;
  /** Per-batch template variables, on top of the task's own. */
  variables(batch: readonly LocalizationUnit[]): PromptVariables;
  /** Extra per-string validation, e.g. "every mask token survived". */
  verify?: (unit: LocalizationUnit, translation: string) => string | undefined;
}

export interface StringBatchResult {
  translations: Map<string, string>;
  usage: TokenUsage;
  costUsd: number;
  notes: string[];
}

/**
 * Translates a set of strings as keyed batches, shared by metadata localization
 * and by segment-mode article translation.
 *
 * The model receives `{hash: text}` and must return `{hash: translation}` for
 * exactly those keys. Three properties come from that shape:
 *
 *  - only prose is billed — no markup, no URLs, no JSON scaffolding;
 *  - a dropped or invented key is a validation failure the gateway retries,
 *    rather than a silently damaged output;
 *  - keys are content hashes, so a repeated string is translated once per run
 *    (see {@link TranslationMemory}).
 */
export async function translateUnits(spec: StringBatchSpec): Promise<StringBatchResult> {
  const notes: string[] = [];
  const translations = new Map<string, string>();

  const { known, unknown } = spec.memory
    ? spec.memory.partition(spec.targetLanguage, spec.units)
    : { known: new Map<string, string>(), unknown: [...spec.units] };

  for (const [key, value] of known) translations.set(key, value);
  if (known.size > 0) {
    notes.push(`${known.size}/${spec.units.length} strings reused from the run's translation memory.`);
  }

  let usage: TokenUsage = { ...EMPTY_USAGE };
  let costUsd = 0;

  for (const batch of chunk(unknown, spec.maxPerCall)) {
    const outcome = await callBatch(spec, batch);
    usage = addUsage(usage, outcome.usage);
    costUsd += outcome.costUsd;
    for (const [key, value] of outcome.translations) translations.set(key, value);
  }

  spec.memory?.remember(spec.targetLanguage, translations);
  return { translations, usage, costUsd, notes };
}

async function callBatch(
  spec: StringBatchSpec,
  batch: readonly LocalizationUnit[],
): Promise<{ translations: Map<string, string>; usage: TokenUsage; costUsd: number }> {
  const { context, task } = spec;
  const table: Record<string, string> = Object.fromEntries(batch.map((unit) => [unit.key, unit.text]));
  const payload = JSON.stringify(table);

  const prompt = await context.prompts.render(spec.promptId, spec.variables(batch));
  const messages = MessageBuilder.build(prompt, [
    { title: 'Strings', body: payload, volatile: true, fence: 'json' },
  ]);

  let parsed: Map<string, string> | undefined;

  const result = await context.llm.complete(
    { messages, responseFormat: { type: 'json_object' }, correlationId: task.taskId },
    {
      pipeline: task.pipeline,
      pool: spec.pool,
      estimatedInputTokens: context.estimator.estimateMessages(messages),
      // The answer repeats every key and runs longer than the source.
      expectedOutputTokens: Math.ceil(context.estimator.estimateText(payload) * 1.6) + 128,
      signal: context.signal,
      validate: (response) => {
        parsed = undefined;
        const verdict = parseTable(response.text, batch, spec.verify);
        if (!verdict.ok) return { ok: false, reason: verdict.reason };
        parsed = verdict.value;
        return { ok: true };
      },
    },
  );

  if (!parsed) {
    throw new PipelineError('Batch response passed validation but produced no table', {
      details: { taskId: task.taskId, batch: batch.length },
    });
  }
  return { translations: parsed, usage: result.totalUsage, costUsd: result.totalCostUsd };
}

/**
 * The response must answer exactly the keys it was asked about. Checking that
 * turns "the model dropped half the table" into an ordinary validation failure
 * instead of a half-translated output nobody notices.
 */
function parseTable(
  text: string,
  batch: readonly LocalizationUnit[],
  verify: StringBatchSpec['verify'],
): { ok: true; value: Map<string, string> } | { ok: false; reason: string } {
  const block = extractJsonBlock(text);
  if (!block) return { ok: false, reason: 'response contained no JSON object' };

  const json = safeJsonParse<JsonObject>(block);
  if (!json.ok) return { ok: false, reason: `response was not valid JSON: ${json.error}` };
  if (!json.value || typeof json.value !== 'object' || Array.isArray(json.value)) {
    return { ok: false, reason: 'response was not a JSON object' };
  }

  const table = new Map<string, string>();
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const unit of batch) {
    const value = json.value[unit.key];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(unit.key);
      continue;
    }
    const problem = verify?.(unit, value);
    if (problem) invalid.push(`${unit.key}: ${problem}`);
    else table.set(unit.key, value);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing translation for ${missing.length} key(s): ${missing.slice(0, 5).join(', ')}`,
    };
  }
  if (invalid.length > 0) {
    return { ok: false, reason: `malformed translation for ${invalid.length} key(s): ${invalid.slice(0, 3).join('; ')}` };
  }
  return { ok: true, value: table };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}
