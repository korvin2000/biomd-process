import type { TranslateTaskConfig } from '../../config/schema.js';
import {
  soleItem,
  type DocumentPipeline,
  type ExecutionContext,
  type PlanContext,
  type PlannedTask,
  type TaskResult,
  type TaskSeed,
  type WorkItem,
} from '../../core/types.js';
import { applyTextSpans, extractTextSpans, missingMasks, type TextSpan } from '../../documents/markdown/textSpans.js';
import type { DocumentSegment } from '../../documents/types.js';
import { EMPTY_USAGE, type TokenUsage } from '../../llm/types.js';
import { PipelineError } from '../../shared/errors.js';
import { keyOf, type LocalizationUnit } from '../localization/StringTable.js';
import { TranslationMemory } from '../localization/TranslationMemory.js';
import { runWithEscalation, type Parsed } from '../shared/escalation.js';
import { translateUnits } from '../shared/stringBatch.js';
import { StructureGuard } from './StructureGuard.js';

const PIPELINE_ID = 'translate';
const SEGMENTS_PROMPT_ID = 'translateSegments';
/** Translations run longer than their source in most target languages. */
const OUTPUT_TOKEN_RATIO = 1.4;
/**
 * Whole-document mode must reproduce the *entire* article, so the lossy ladders
 * (`truncation-first`, `staged`) are never appropriate. `chunked` degrades to a
 * single full call whenever the document fits, so this costs nothing normally.
 */
const DEFAULT_CONTEXT_STRATEGY = 'chunked';

/**
 * Structure-preserving translation, in one of two modes.
 *
 * **`segments` (default)** — only the prose is sent. Heading hashes, list
 * bullets, `:::` containers and their attributes, fenced code and every URL stay
 * on this side and are spliced back after; identical spans are translated once
 * per run. The document's structure is preserved *by construction* rather than
 * by asking a model nicely, and the tokens billed are the words alone.
 *
 * **`document`** — the whole Markdown goes to the model. More surrounding
 * context for the translator, at the cost of tokens and of trusting the model
 * with the markup. The structure guard is the only defence, so it matters here.
 *
 * Either way one task is planned per (document × target language), so a failed
 * German run does not redo the English one.
 */
export class TranslationPipeline implements DocumentPipeline {
  readonly id = PIPELINE_ID;
  readonly description = 'Translate a document into the configured languages, preserving Markdown structure.';

  /** One memory for the whole run, shared by every task of this pipeline. */
  private memory: TranslationMemory | undefined;

  async plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.translate;
    const promptVersion = await context.prompts.versionOf(this.promptId(config));

    return this.targetLanguages(item, config).map((targetLang) => ({
      variant: targetLang,
      label: `${item.slug} → ${targetLang}`,
      contract: {
        targetLang,
        mode: config.mode,
        verifyStructure: config.verifyStructure,
        promptVariables: config.promptVariables,
      },
      promptVersion,
      expectedOutputs: [{ channel: config.outputChannel, pathVars: this.pathVars(item, targetLang) }],
    }));
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.translate;
    const document = soleItem(task);
    const targetLang = task.variant;
    if (!targetLang) {
      throw new PipelineError('Translation task is missing its target language', { details: { taskId: task.taskId } });
    }

    const outcome =
      config.mode === 'segments'
        ? await this.translateSpans(task, context, document, targetLang, config)
        : await this.translateDocument(task, context, document, targetLang, config);

    return {
      artifacts: [
        {
          channel: config.outputChannel,
          format: 'markdown',
          body: outcome.markdown,
          pathVars: this.pathVars(document, targetLang),
        },
      ],
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      contextAttempt: outcome.attempt,
      notes: outcome.notes,
    };
  }

  // --- segments mode -------------------------------------------------------

  private async translateSpans(
    task: PlannedTask,
    context: ExecutionContext,
    document: WorkItem,
    targetLang: string,
    config: TranslateTaskConfig,
  ): Promise<Outcome> {
    const spans = extractTextSpans(document.content);
    if (spans.length === 0) {
      return {
        markdown: document.content,
        usage: { ...EMPTY_USAGE },
        costUsd: 0,
        attempt: 'segments',
        notes: ['No translatable prose found; the document was copied verbatim.'],
      };
    }

    const units = dedupe(spans);
    const batch = await translateUnits({
      task,
      context,
      promptId: SEGMENTS_PROMPT_ID,
      pool: config.pool,
      targetLanguage: targetLang,
      units,
      maxPerCall: config.maxSegmentsPerCall,
      memory: this.memoryFor(config),
      variables: (part) => ({
        ...config.promptVariables,
        sourceLanguage: document.language,
        targetLanguage: targetLang,
        count: part.length,
      }),
      // A dropped mask token means a lost URL — catch it while a retry is cheap.
      verify: (unit, translation) => {
        const missing = missingMasks(unit.text, translation);
        return missing.length > 0 ? `placeholder(s) ${missing.join(', ')} were not preserved` : undefined;
      },
    });

    const byText = new Map(units.map((unit) => [unit.text, batch.translations.get(unit.key) ?? unit.text]));
    const markdown = applyTextSpans(document.content, spans, byText);

    const notes = [...batch.notes];
    // The guard is a safety net here rather than the defence: splicing cannot
    // change the skeleton, so a failure means the extractor missed something.
    const verdict = new StructureGuard(config.verifyStructure).verify(document.content, markdown);
    if (!verdict.ok) {
      throw new PipelineError(`Rebuilt translation diverged from the source: ${verdict.reason}`, {
        details: { taskId: task.taskId, document: document.relativePath, spans: spans.length },
      });
    }

    return { markdown, usage: batch.usage, costUsd: batch.costUsd, attempt: 'segments', notes };
  }

  // --- whole-document mode -------------------------------------------------

  private async translateDocument(
    task: PlannedTask,
    context: ExecutionContext,
    document: WorkItem,
    targetLang: string,
    config: TranslateTaskConfig,
  ): Promise<Outcome> {
    const guard = new StructureGuard(config.verifyStructure);

    const outcome = await runWithEscalation<string>({
      task,
      context,
      promptId: PIPELINE_ID,
      pool: config.pool,
      contextStrategyId: config.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY,
      expectedOutputTokens: Math.ceil(document.estimatedTokens * OUTPUT_TOKEN_RATIO),
      variables: (_attempt, segment) => ({
        ...config.promptVariables,
        sourceLanguage: document.language,
        targetLanguage: targetLang,
        partial: segment.total > 1,
        partLabel: segment.label,
      }),
      section: (segment) => ({ title: 'Document', body: segment.text, volatile: true, fence: 'markdown' }),
      parse: (text, segment) => this.parseDocument(text, segment, guard),
      merge: (parts) => parts.join('\n\n'),
      accept: (value, attempt) => {
        if (attempt.partial) {
          return { ok: false, reason: 'a truncated attempt cannot produce a complete translation' };
        }
        const verdict = guard.verify(document.content, value);
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason ?? 'structure mismatch' };
      },
    });

    return {
      markdown: outcome.value,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      attempt: outcome.attempt.id,
      notes: outcome.notes,
    };
  }

  /**
   * Per-segment check. Verifying each chunk against its own source catches a
   * broken chunk on the attempt that produced it, where a retry is still cheap.
   */
  private parseDocument(text: string, segment: DocumentSegment, guard: StructureGuard): Parsed<string> {
    const body = stripDocumentFence(text).trim();
    if (body.length === 0) return { ok: false, reason: 'model returned an empty translation' };

    const verdict = guard.verify(segment.text, body);
    if (!verdict.ok) return { ok: false, reason: verdict.reason ?? 'structure mismatch' };

    return { ok: true, value: body };
  }

  // --- shared --------------------------------------------------------------

  private memoryFor(config: TranslateTaskConfig): TranslationMemory | undefined {
    if (!config.useTranslationMemory) return undefined;
    this.memory ??= new TranslationMemory(true);
    return this.memory;
  }

  private promptId(config: TranslateTaskConfig): string {
    return config.mode === 'segments' ? SEGMENTS_PROMPT_ID : PIPELINE_ID;
  }

  private targetLanguages(item: WorkItem, config: TranslateTaskConfig): string[] {
    return config.targetLanguages.filter((lang) => !(config.skipSourceLanguage && lang === item.language));
  }

  private pathVars(item: WorkItem, targetLang: string): Record<string, string> {
    return { slug: item.slug, lang: targetLang, sourceLang: item.language, targetLang };
  }
}

interface Outcome {
  markdown: string;
  usage: TokenUsage;
  costUsd: number;
  attempt: string;
  notes: string[];
}

/** Distinct span texts, in document order — the unit of translation and of caching. */
function dedupe(spans: readonly TextSpan[]): LocalizationUnit[] {
  const units = new Map<string, LocalizationUnit>();

  for (const span of spans) {
    const key = keyOf(span.text);
    const existing = units.get(key);
    if (existing) existing.paths.push(String(span.start));
    else units.set(key, { key, text: span.text, paths: [String(span.start)] });
  }
  return [...units.values()];
}

/**
 * Some models fence the entire document despite being told not to. Unwrapping
 * one *outer* fence is safe; a document whose own content is a code block keeps
 * its inner fences because only a wrapper spanning the whole response is removed.
 */
function stripDocumentFence(text: string): string {
  const match = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
  return match?.[1] ?? text;
}
