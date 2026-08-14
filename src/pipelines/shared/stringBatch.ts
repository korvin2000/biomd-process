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
  /**
   * Follow-up calls that re-ask **only** for the keys a response left out.
   * `0` restores the all-or-nothing behaviour: the first gap fails the whole batch.
   */
  repairAttempts: number;
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
 *  - a dropped or invented key is caught rather than silently written out;
 *  - keys are content hashes, so a repeated string is translated once per run
 *    (see {@link TranslationMemory}).
 */
export async function translateUnits(spec: StringBatchSpec): Promise<StringBatchResult> {
  const notes: string[] = [];
  const translations = new Map<string, string>();

  // A fragment with no letters — a year span, a lone placeholder, a bare
  // identifier — has no words to translate. Answering it locally removes both
  // the tokens and the most common reason a model drops a key.
  const [wordless, translatable] = partition(spec.units, (unit) => !hasLetters(unit.text));
  for (const unit of wordless) translations.set(unit.key, unit.text);
  if (wordless.length > 0) {
    notes.push(`${wordless.length} fragment(s) contained no words and were kept verbatim.`);
  }

  const { known, unknown } = spec.memory
    ? spec.memory.partition(spec.targetLanguage, translatable)
    : { known: new Map<string, string>(), unknown: [...translatable] };

  for (const [key, value] of known) translations.set(key, value);
  if (known.size > 0) {
    notes.push(`${known.size}/${spec.units.length} strings reused from the translation memory.`);
  }

  let usage: TokenUsage = { ...EMPTY_USAGE };
  let costUsd = 0;
  // Only what a model actually produced is worth caching: an untranslatable
  // fragment answered locally would cost a persistent memory a line per run and
  // save nothing, since the same rule answers it again for free.
  const learned = new Map<string, string>();

  for (const batch of chunk(unknown, spec.maxPerCall)) {
    const outcome = await callBatch(spec, batch);
    usage = addUsage(usage, outcome.usage);
    costUsd += outcome.costUsd;
    notes.push(...outcome.notes);
    for (const [key, value] of outcome.translations) {
      translations.set(key, value);
      learned.set(key, value);
    }
  }

  spec.memory?.remember(spec.targetLanguage, learned);
  return { translations, usage, costUsd, notes };
}

/**
 * One batch, with a repair ladder on the same cheapest-axis-first principle the
 * context strategies use.
 *
 * Models answer 19 of 20 keys often enough that it must not cost a second full
 * batch: the first call therefore accepts a partial answer, and the keys that
 * are missing or malformed are re-asked on their own. Only the **last** round is
 * strict, so a gap that survives repair still becomes an ordinary validation
 * failure and inherits retry-then-fall-back-to-a-stronger-model — on a payload
 * of the few keys that actually need it rather than on the whole table.
 */
async function callBatch(
  spec: StringBatchSpec,
  batch: readonly LocalizationUnit[],
): Promise<{ translations: Map<string, string>; usage: TokenUsage; costUsd: number; notes: string[] }> {
  const translations = new Map<string, string>();
  const notes: string[] = [];
  let usage: TokenUsage = { ...EMPTY_USAGE };
  let costUsd = 0;

  const rounds = Math.max(0, spec.repairAttempts) + 1;
  let pending: readonly LocalizationUnit[] = batch;

  for (let round = 0; round < rounds && pending.length > 0; round += 1) {
    const strict = round === rounds - 1;
    if (round > 0) {
      notes.push(`Re-asked for ${pending.length} of ${batch.length} fragment(s) the previous answer left out.`);
    }

    const outcome = await callOnce(spec, pending, strict);
    usage = addUsage(usage, outcome.usage);
    costUsd += outcome.costUsd;
    for (const [key, value] of outcome.translations) translations.set(key, value);

    pending = pending.filter((unit) => !translations.has(unit.key));
  }

  if (pending.length > 0) {
    throw new PipelineError(`Batch left ${pending.length} fragment(s) untranslated after ${rounds} attempt(s)`, {
      details: { taskId: spec.task.taskId, keys: pending.slice(0, 5).map((unit) => unit.key) },
    });
  }
  return { translations, usage, costUsd, notes };
}

async function callOnce(
  spec: StringBatchSpec,
  batch: readonly LocalizationUnit[],
  strict: boolean,
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

        // A lenient round hands back whatever was usable and lets the caller
        // re-ask for the rest; a strict one demands the complete table.
        if (verdict.value.size === 0 || (strict && verdict.unanswered.length > 0)) {
          return { ok: false, reason: describeGap(verdict, batch.length) };
        }

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

interface TableVerdictOk {
  ok: true;
  value: Map<string, string>;
  /** Keys that were asked for and came back missing, empty or malformed. */
  unanswered: string[];
  /** Why a key that *was* answered had to be rejected — for the error message. */
  problems: string[];
}

/**
 * Reads the answer without deciding what to do about it.
 *
 * `ok: false` means the response is unusable as a whole — no JSON at all, or not
 * an object — which no amount of re-asking for individual keys can repair. A
 * response that is structurally fine but incomplete comes back `ok: true` with
 * the gap listed, because that *is* repairable and doing so is much cheaper than
 * re-sending everything.
 */
function parseTable(
  text: string,
  batch: readonly LocalizationUnit[],
  verify: StringBatchSpec['verify'],
): TableVerdictOk | { ok: false; reason: string } {
  const block = extractJsonBlock(text);
  if (!block) return { ok: false, reason: 'response contained no JSON object' };

  const json = safeJsonParse<JsonObject>(block);
  if (!json.ok) return { ok: false, reason: `response was not valid JSON: ${json.error}` };
  if (!json.value || typeof json.value !== 'object' || Array.isArray(json.value)) {
    return { ok: false, reason: 'response was not a JSON object' };
  }

  const table = new Map<string, string>();
  const unanswered: string[] = [];
  const problems: string[] = [];

  for (const unit of batch) {
    const value = json.value[unit.key];
    if (typeof value !== 'string' || value.trim() === '') {
      unanswered.push(unit.key);
      continue;
    }
    // A dropped mask token means a lost URL: treat it exactly like a missing
    // answer so the repair round asks for that fragment again.
    const problem = verify?.(unit, value);
    if (problem) {
      unanswered.push(unit.key);
      problems.push(`${unit.key}: ${problem}`);
    } else {
      table.set(unit.key, value);
    }
  }

  return { ok: true, value: table, unanswered, problems };
}

function describeGap(verdict: TableVerdictOk, asked: number): string {
  const detail = verdict.problems.length > 0 ? ` (${verdict.problems.slice(0, 3).join('; ')})` : '';
  return (
    `missing or malformed translation for ${verdict.unanswered.length}/${asked} key(s): ` +
    verdict.unanswered.slice(0, 5).join(', ') +
    detail
  );
}

/** Anything with a letter in it has words to translate; nothing else does. */
function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

function partition<T>(items: readonly T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (predicate(item) ? yes : no).push(item);
  return [yes, no];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}
