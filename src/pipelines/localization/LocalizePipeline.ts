import type { AppConfig, LocalizeTaskConfig } from '../../config/schema.js';
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
import { sanitizeDossier, type DossierOptions } from '../../domain/dossier.js';
import type { Dossier } from '../../domain/types.js';
import { EMPTY_USAGE, type TokenUsage } from '../../llm/types.js';
import { PipelineError } from '../../shared/errors.js';
import { readJsonFile } from '../../shared/fs.js';
import type { JsonValue } from '../../shared/json.js';
import {
  findDossierToLocalize,
  findSourceDossier,
  outputDossierPath,
  sourceDossierPath,
} from '../shared/dossierSource.js';
import { translateUnits } from '../shared/stringBatch.js';
import { applyUnits, collectUnits, missingKeys, type LocalizationOptions } from './StringTable.js';
import { TranslationMemory } from './TranslationMemory.js';

const PIPELINE_ID = 'localize';

/**
 * Produces the per-language *edition* of a dossier.
 *
 * `MetaData.md` is explicit that `pages/<lang>/<slug>.bio.json` is an edition,
 * not a translation of a canonical original: its prose is authored in the
 * directory's language, while `dates`, `ranking` and `url` are identical
 * everywhere. This pipeline enforces both halves mechanically.
 *
 * The model never sees the JSON. {@link collectUnits} lifts out just the
 * translatable strings, content-hashed and deduplicated; the model answers a
 * flat `{hash: translation}` table; the document is rebuilt locally. So the
 * structure, the invariant fields, every URL and every unknown field are copied
 * from the source and cannot be damaged — and the tokens spent are the prose
 * alone, once per distinct string in the whole run.
 */
export class LocalizePipeline implements DocumentPipeline {
  readonly id = PIPELINE_ID;
  readonly description = 'Localize the dossier JSON into each target language, keeping invariant fields identical.';

  /** One memory for the whole run: every task of this pipeline shares it. */
  private memory: TranslationMemory | undefined;

  async plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.localize;
    const promptVersion = await context.prompts.versionOf(PIPELINE_ID);
    const extractEnabled = context.config.tasks.extract.enabled;

    // A hand-edited dossier beside the article must redo the editions, so its
    // hash goes into the fingerprint. This run's *own* extraction output must
    // not: folding in a file this run writes would change the fingerprint after
    // every run and make resume permanently useless. What the article said is
    // already covered — the planner folds the work item's content hash in.
    const authored = await findSourceDossier(item, context.config);
    const sourceHash = authored?.hash ?? 'none';
    const extractVersion = extractEnabled ? await context.prompts.versionOf('extract') : 'off';
    // The dossier this localizes is whatever the last pipeline in the chain
    // left; a web search that adds a birthplace changes what there is to
    // translate, so it belongs in the fingerprint exactly like extraction does.
    const websearchEnabled = context.config.tasks.websearch.enabled;
    const websearchVersion = websearchEnabled ? await context.prompts.versionOf('websearch') : 'off';

    return this.targetLanguages(item, context.config).map((targetLang) => ({
      variant: targetLang,
      label: `${item.slug} → metadata (${targetLang})`,
      contract: {
        targetLang,
        localizableFields: [...config.localizableFields].sort(),
        listFields: [...config.listFields].sort(),
        sourceHash,
        extractVersion,
        websearchVersion,
      },
      promptVersion,
      expectedOutputs: [{ channel: config.outputChannel, pathVars: this.pathVars(item, targetLang) }],
      // Wait for this document's extraction and its web completion, when there
      // are any, so the dossier we localize is the finished one.
      dependsOn: [
        ...(extractEnabled ? [{ pipeline: 'extract' }] : []),
        ...(websearchEnabled ? [{ pipeline: 'websearch' }] : []),
      ],
    }));
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.localize;
    const item = soleItem(task);
    const targetLang = task.variant;
    if (!targetLang) {
      throw new PipelineError('Localization task is missing its target language', { details: { taskId: task.taskId } });
    }

    const loaded = await this.loadSource(item, context);
    const source = loaded.dossier as unknown as JsonValue;
    const options: LocalizationOptions = { localizable: config.localizableFields, listFields: config.listFields };
    const units = collectUnits(source, options);

    if (units.length === 0) {
      return this.result(config, item, targetLang, source, { ...EMPTY_USAGE }, 0, [
        ...loaded.notes,
        'No translatable strings in the dossier; the edition is a verbatim copy.',
      ]);
    }

    // The escalation ladder does not apply here: the input is a small flat table,
    // not an article, so there is no cheaper slice of it to try first. Retry,
    // fallback and validation still come from the gateway.
    const batch = await translateUnits({
      task,
      context,
      promptId: PIPELINE_ID,
      pool: config.pool,
      targetLanguage: targetLang,
      units,
      maxPerCall: config.maxStringsPerCall,
      repairAttempts: config.repairAttempts,
      memory: await context.memories.acquire(
        `${PIPELINE_ID}-${await context.prompts.versionOf(PIPELINE_ID)}`,
        config.useTranslationMemory,
      ),
      variables: (part) => ({
        ...config.promptVariables,
        sourceLanguage: item.language,
        targetLanguage: targetLang,
        count: part.length,
      }),
    });

    const localized = applyUnits(source, options, batch.translations);
    const notes = [...loaded.notes, ...batch.notes];
    const unresolved = missingKeys(units, batch.translations);
    if (unresolved.length > 0) {
      notes.push(`${unresolved.length} string(s) kept their source text: no translation was returned.`);
    }

    // One pass through the sanitizer so the edition is punctuated, ordered and
    // shaped exactly like its source — the comparison `INV-17` is checked by.
    const clean = sanitizeDossier(localized, this.dossierOptions(context));
    return this.result(
      config,
      item,
      targetLang,
      clean.dossier as unknown as JsonValue,
      batch.usage,
      batch.costUsd,
      [...notes, ...clean.notes],
    );
  }

  /**
   * The dossier to localize: the extraction output for the source language, or —
   * when extraction is off — the dossier sitting beside the article, which is how
   * an existing corpus is laid out.
   *
   * Either way it goes through the sanitizer first. A hand-authored file may be a
   * version 1 document, and localizing one would copy its withdrawn identity
   * members into every edition instead of migrating them once.
   */
  private async loadSource(
    item: WorkItem,
    context: ExecutionContext,
  ): Promise<{ dossier: Dossier; notes: string[] }> {
    const existing = await findDossierToLocalize(item, context.config, context.writer);
    if (!existing) {
      const produced = outputDossierPath(item, context.config, context.writer);
      const sibling = sourceDossierPath(item, context.config);
      throw new PipelineError(
        `No source dossier for "${item.id}". Looked for ${produced} and ${sibling}. ` +
          'Enable tasks.extract, or place a dossier next to the article.',
        { details: { item: item.id, produced, sibling } },
      );
    }

    const sanitized = sanitizeDossier(existing.value, this.dossierOptions(context));
    return { dossier: sanitized.dossier, notes: sanitized.notes };
  }

  private dossierOptions(context: ExecutionContext): DossierOptions {
    return {
      supportedLanguages: context.config.catalogue.supportedLanguages,
      allowUnknownTypes: context.config.catalogue.allowUnknownTypes,
      datePrecision: context.config.catalogue.datePrecision,
    };
  }

  private result(
    config: LocalizeTaskConfig,
    item: WorkItem,
    targetLang: string,
    body: JsonValue,
    usage: TokenUsage,
    costUsd: number,
    notes: string[],
  ): TaskResult {
    return {
      artifacts: [
        { channel: config.outputChannel, format: 'json', body, pathVars: this.pathVars(item, targetLang) },
      ],
      usage,
      costUsd,
      notes,
    };
  }

  /** An empty `tasks.localize.targetLanguages` follows translation, so the two stay in step. */
  private targetLanguages(item: WorkItem, config: AppConfig): string[] {
    const localize = config.tasks.localize;
    const languages =
      localize.targetLanguages.length > 0 ? localize.targetLanguages : config.tasks.translate.targetLanguages;
    return languages.filter((lang) => !(localize.skipSourceLanguage && lang === item.language));
  }

  private pathVars(item: WorkItem, lang: string): Record<string, string> {
    return { slug: item.slug, lang, sourceLang: item.language, targetLang: lang };
  }
}

