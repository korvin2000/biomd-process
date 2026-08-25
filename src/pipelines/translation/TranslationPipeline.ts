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
import {
  applyTextSpans,
  displacedMasks,
  extractTextSpans,
  missingMasks,
  structuralDrift,
  type TextSpan,
} from '../../documents/markdown/textSpans.js';
import { readTitle } from '../../documents/markdown/title.js';
import { languageName } from '../../domain/vocabulary.js';
import type { DocumentSegment } from '../../documents/types.js';
import { EMPTY_USAGE, type TokenUsage } from '../../llm/types.js';
import { PipelineError } from '../../shared/errors.js';
import { hashStructure } from '../../shared/hash.js';
import { keyOf, type LocalizationUnit } from '../localization/StringTable.js';
import { runWithEscalation, type Parsed } from '../shared/escalation.js';
import {
  halfTransliteratedNote,
  hasOwnScript,
  introducedMixedScriptWords,
  isTranslatable,
} from '../shared/script.js';
import { complexityOf } from '../../routing/strategies/adaptive/ComplexityScorer.js';
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

  async plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.translate;
    const promptVersion = await context.prompts.versionOf(this.promptId(config));

    const seeds: TaskSeed[] = this.targetLanguages(item, config).map((targetLang) => ({
      variant: targetLang,
      label: `${item.slug} → ${targetLang}`,
      contract: {
        targetLang,
        mode: config.mode,
        verifyStructure: config.verifyStructure,
        // Both change what a correct output looks like, so both belong in the
        // fingerprint: turning either on or off must re-translate the corpus.
        foreignFragments: config.foreignFragments,
        fencedBlocks: config.fencedBlocks,
        contextChars: config.contextChars,
        promptVariables: config.promptVariables,
      },
      promptVersion,
      expectedOutputs: [{ channel: config.outputChannel, pathVars: this.pathVars(item, targetLang) }],
    }));

    /**
     * The original edition, copied rather than translated.
     *
     * `INV-8` requires a file for **every** code in a row's `lang`, including the
     * first — the original. When the corpus and the catalogue root are different
     * directories, nothing else would ever put the source article in the output
     * tree, and the catalogue would declare an edition that 404s. Copying costs
     * nothing and it is what makes `out/` a catalogue rather than a pile of
     * derived files.
     */
    if (config.copySourceArticle) {
      seeds.push({
        variant: item.language,
        label: `${item.slug} → ${item.language} (source, copied)`,
        contract: { copy: true },
        promptVersion: 'none',
        usesLlm: false,
        expectedOutputs: [{ channel: config.outputChannel, pathVars: this.pathVars(item, item.language) }],
      });
    }
    return seeds;
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.translate;
    const document = soleItem(task);
    const targetLang = task.variant;
    if (!targetLang) {
      throw new PipelineError('Translation task is missing its target language', { details: { taskId: task.taskId } });
    }

    if (targetLang === document.language) {
      return {
        artifacts: [
          {
            channel: config.outputChannel,
            format: 'markdown',
            body: document.content,
            pathVars: this.pathVars(document, targetLang),
          },
        ],
        usage: { ...EMPTY_USAGE },
        costUsd: 0,
        notes: ['Copied the source article verbatim: this is the original edition, not a translation.'],
      };
    }

    const outcome =
      config.mode === 'segments'
        ? await this.translateSpans(task, context, document, targetLang, config)
        : await this.translateDocument(task, context, document, targetLang, config);

    // Both modes land here, so the check sits at the one point that has the
    // source and the finished edition side by side.
    const halfTransliterated = introducedMixedScriptWords(document.content, outcome.markdown);

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
      notes: halfTransliterated.length > 0
        ? [...outcome.notes, halfTransliteratedNote(halfTransliterated)]
        : outcome.notes,
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
    const spans = extractTextSpans(document.content, { fencedBlocks: config.fencedBlocks });
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
    // The same sentence can be a paragraph in one place and a list item in
    // another. The paragraph is the occurrence with something to lose, so it
    // is the one that decides what the answer is allowed to look like.
    const spanOf = new Map<string, TextSpan>();
    for (const span of spans) {
      const chosen = spanOf.get(keyOf(span.text));
      if (!chosen || (chosen.kind !== 'paragraph' && span.kind === 'paragraph')) spanOf.set(keyOf(span.text), span);
    }
    const keepForeign = config.foreignFragments === 'keep' && hasOwnScript(document.language);
    const articleContext = describeArticle(document, config.contextChars);

    const batch = await translateUnits({
      task,
      context,
      promptId: SEGMENTS_PROMPT_ID,
      pool: config.pool,
      targetLanguage: targetLang,
      units,
      maxPerCall: config.maxSegmentsPerCall,
      repairAttempts: config.repairAttempts,
      // Measured on the article, not on the fragments drawn from it — the
      // fragments carry none of the structure that makes an article hard to
      // reassemble. See {@link StringBatchSpec.complexity}.
      complexity: complexityOf(document.content),
      ...(articleContext ? { articleContext } : {}),
      // A fragment with no letter of the source script in it is a work title, a
      // name or a discography line — never a sentence of the article.
      ...(keepForeign ? { keepVerbatim: (unit) => !isTranslatable(unit.text, document.language) } : {}),
      // A retry is not served the previous attempt's answers: they are what
      // failed. Without this the cache makes task-level fallback a no-op here —
      // every fragment would be a hit, no model would be called, and the second
      // attempt would rebuild the identical broken document for free.
      ...(context.attempt > 1 ? {} : { memory: await context.memories.acquire(
        `${PIPELINE_ID}-${await context.prompts.versionOf(SEGMENTS_PROMPT_ID)}-${document.language}-${hashStructure(config.promptVariables, 10)}`,
        config.useTranslationMemory,
      ) }),
      variables: (part) => ({
        ...config.promptVariables,
        sourceLanguage: document.language,
        targetLanguage: targetLang,
        // The names as well as the codes: `pt` is unambiguous to a program and
        // merely probable to a model, and the word costs one token.
        sourceLanguageName: languageName(document.language),
        targetLanguageName: languageName(targetLang),
        count: part.length,
      }),
      // A dropped mask token means a lost URL, and a *displaced* one means a
      // lost link — catch both while a retry is still one fragment cheap.
      verify: (unit, translation) => {
        const missing = missingMasks(unit.text, translation);
        if (missing.length > 0) return `placeholder(s) ${missing.join(', ')} were not preserved`;
        const displaced = displacedMasks(unit.text, translation);
        if (displaced.length > 0) {
          return `placeholder(s) ${displaced.join(', ')} are no longer the target of a link — keep "](" and the token together`;
        }
        // The span this key came from, for the one check that needs to know
        // what kind of line the fragment was lifted out of.
        const span = spanOf.get(unit.key);
        return span ? structuralDrift(span, translation) : undefined;
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
      // A truncated rung can never produce a complete translation, so it is
      // dropped before it is called rather than paid for and then rejected
      // below. The rejection stays as the last line of defence.
      coverage: 'whole',
      expectedOutputTokens: Math.ceil(document.estimatedTokens * OUTPUT_TOKEN_RATIO),
      variables: (_attempt, segment) => ({
        ...config.promptVariables,
        sourceLanguage: document.language,
        targetLanguage: targetLang,
        sourceLanguageName: languageName(document.language),
        targetLanguageName: languageName(targetLang),
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

/**
 * The one or two lines that tell a translator what they are translating.
 *
 * The article's own title and the opening of its lead, nothing else: no dossier,
 * no dependency on `extract`, no second file to read. It rides in the volatile
 * part of the message, so the cached prefix is unaffected, and it costs about
 * eighty tokens per call against a batch of twenty fragments.
 *
 * Why it earns them: the fragments are lifted out of their document by design,
 * and a sentence like "Здесь ему открылась вся прелесть фламенко" arrives with
 * no way to know that *ему* is a guitarist, that the register is a reference
 * work's, or that `фламенко` is the genre rather than the dance.
 */
function describeArticle(document: WorkItem, limit: number): string | undefined {
  if (limit <= 0) return undefined;

  const { title, lead } = readTitle(document.content, { leadChars: limit });
  const lines = [
    ...(title ? [`Title: ${title}`] : []),
    ...(lead ? [`Opening: ${lead}`] : []),
  ];
  return lines.length > 0 ? lines.join('\n') : undefined;
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
