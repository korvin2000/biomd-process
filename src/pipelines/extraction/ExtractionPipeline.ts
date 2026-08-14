import type { ExtractTaskConfig } from '../../config/schema.js';
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
import type { Artifact } from '../../io/types.js';
import type { JsonValue } from '../../shared/json.js';
import { extractJsonBlock, safeJsonParse } from '../../shared/json.js';
import { runWithEscalation, type Parsed } from '../shared/escalation.js';
import { hasField, mergeMetadata } from './merge.js';
import {
  METADATA_SCHEMA_NAME,
  emptyMetadata,
  metadataJsonSchema,
  metadataSchema,
  type MetadataDocument,
} from './MetadataContract.js';
import { liftCatalogHints, normalizeValues, type NormalizeOptions } from './normalize.js';

const PIPELINE_ID = 'extract';
/** Metadata dossiers are small; a generous ceiling still fits any of them. */
const EXPECTED_OUTPUT_TOKENS = 1200;

/**
 * Heuristic metadata extraction.
 *
 * One task per document, one artifact on the configured channel. Everything
 * expensive — routing, retry, fallback, context escalation — is delegated, so
 * this class only owns the three decisions that are genuinely its own: what the
 * prompt variables are, what a parseable response looks like, and when a result
 * is good enough.
 */
export class ExtractionPipeline implements DocumentPipeline {
  readonly id = PIPELINE_ID;
  readonly description = 'Extract structured metadata from a document into JSON.';

  async plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]> {
    const task = context.config.tasks.extract;
    return [
      {
        label: `${item.slug} → metadata (${item.language})`,
        contract: this.contractOf(task),
        promptVersion: await context.prompts.versionOf(PIPELINE_ID),
        expectedOutputs: [{ channel: task.outputChannel, pathVars: this.pathVars(item) }],
      },
    ];
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.extract;
    const document = soleItem(task);

    const outcome = await runWithEscalation<MetadataDocument>({
      task,
      context,
      promptId: PIPELINE_ID,
      pool: config.pool,
      contextStrategyId: config.contextStrategy ?? context.config.context.strategy,
      responseFormat: this.responseFormat(),
      expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
      variables: (attempt, segment) => ({
        ...config.promptVariables,
        language: document.language,
        requiredFields: config.requiredFields,
        catalogHints: config.emitCatalogHints,
        schemaText: JSON.stringify(metadataJsonSchema, null, 2),
        partial: attempt.partial || segment.total > 1,
        partLabel: segment.label,
      }),
      section: (segment) => ({ title: 'Article', body: segment.text, volatile: true, fence: 'markdown' }),
      parse: (text) => this.parse(text, this.normalizeOptions(config)),
      merge: (parts) => mergeMetadata(parts, config.listFields),
      accept: (value) => this.accept(value, config),
    });

    // The index-owned fields are lifted once, on the merged document: they are a
    // property of the entry, not of whichever chunk happened to mention them.
    const lifted = liftCatalogHints(outcome.value);
    const artifacts: Artifact[] = [
      {
        channel: config.outputChannel,
        format: 'json',
        body: lifted.document as unknown as Record<string, never>,
        pathVars: this.pathVars(document),
      },
    ];

    if (config.emitCatalogHints && Object.keys(lifted.hints).length > 0) {
      artifacts.push({
        channel: config.hintsChannel,
        format: 'json',
        body: { slug: document.slug, language: document.language, ...lifted.hints } as JsonValue,
        pathVars: this.pathVars(document),
      });
    }

    return {
      artifacts,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      contextAttempt: outcome.attempt.id,
      notes: [...outcome.notes, ...lifted.notes],
    };
  }

  /**
   * Models wrap JSON in prose more often than they should; recovering the block
   * locally is free, while a re-ask costs a whole round trip.
   */
  private parse(text: string, options: NormalizeOptions): Parsed<MetadataDocument> {
    const block = extractJsonBlock(text);
    if (!block) return { ok: false, reason: 'response contained no JSON object' };

    const json = safeJsonParse(block);
    if (!json.ok) return { ok: false, reason: `response was not valid JSON: ${json.error}` };

    const parsed = metadataSchema.safeParse(json.value);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return { ok: false, reason: `schema violation at ${first?.path.join('.') || '(root)'}: ${first?.message}` };
    }

    // Shape is the schema's job; the format guide's rules are the normalizer's.
    // An ISO date is rewritten here for free — only what cannot be read at all
    // is handed back as a rejection, and only when the config asks for that.
    const normalized = normalizeValues(parsed.data, options);
    if (normalized.rejection) return { ok: false, reason: normalized.rejection };

    return { ok: true, value: normalized.document, notes: normalized.notes };
  }

  private normalizeOptions(config: ExtractTaskConfig): NormalizeOptions {
    return { listFields: config.listFields, onInvalidDate: config.onInvalidDate };
  }

  /**
   * A partial extraction is not a failure — the format guide says every field is
   * optional. Only the explicitly required fields gate acceptance, which is what
   * makes "try the cheap head slice first" safe.
   */
  private accept(value: MetadataDocument, config: ExtractTaskConfig): { ok: true } | { ok: false; reason: string } {
    const missing = config.requiredFields.filter((field) => !hasField(value, field));
    if (missing.length > 0) return { ok: false, reason: `missing required field(s): ${missing.join(', ')}` };

    if (Object.keys(value.metadata).length === 0 && value.documents.length === 0) {
      return { ok: false, reason: 'extraction produced an empty dossier' };
    }
    return { ok: true };
  }

  private responseFormat() {
    return {
      type: 'json_schema' as const,
      name: METADATA_SCHEMA_NAME,
      schema: metadataJsonSchema,
      // Strict mode rejects the `passthrough` keys we deliberately allow.
      strict: false,
    };
  }

  /** Metadata is a per-language edition, so it is written beside its source. */
  private pathVars(item: WorkItem): Record<string, string> {
    return { slug: item.slug, lang: item.language, sourceLang: item.language, targetLang: item.language };
  }

  /** Only the parts of the config that change what a correct output looks like. */
  private contractOf(config: ExtractTaskConfig): unknown {
    return {
      schema: METADATA_SCHEMA_NAME,
      requiredFields: [...config.requiredFields].sort(),
      // Normalization decides what a conforming dossier looks like, so changing
      // it has to invalidate the ones already written under the old rules.
      listFields: [...config.listFields].sort(),
      onInvalidDate: config.onInvalidDate,
      promptVariables: config.promptVariables,
    };
  }
}

export { emptyMetadata };
