import { dirname, join } from 'node:path';

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
import { EMPTY_USAGE, type TokenUsage } from '../../llm/types.js';
import { PipelineError } from '../../shared/errors.js';
import { pathExists, readJsonFile, readTextFile } from '../../shared/fs.js';
import { shortHash } from '../../shared/hash.js';
import type { JsonValue } from '../../shared/json.js';
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

    // The dossier this task localizes is either already on disk or about to be
    // written by `extract`. Fold whichever is knowable into the fingerprint so a
    // hand-edited dossier, or a changed extraction prompt, redoes the editions.
    const sourcePath = await this.resolveSource(item, context.config, context.writer).catch(() => undefined);
    const sourceHash = sourcePath ? shortHash(await this.hashOf(sourcePath), 12) : 'pending';
    const extractVersion = extractEnabled ? await context.prompts.versionOf('extract') : 'off';

    return this.targetLanguages(item, context.config).map((targetLang) => ({
      variant: targetLang,
      label: `${item.slug} → metadata (${targetLang})`,
      contract: {
        targetLang,
        localizableFields: [...config.localizableFields].sort(),
        listFields: [...config.listFields].sort(),
        sourceHash,
        extractVersion,
      },
      promptVersion,
      expectedOutputs: [{ channel: config.outputChannel, pathVars: this.pathVars(item, targetLang) }],
      // Wait for this document's extraction, when there is one, so the dossier
      // we localize is the one this run produced.
      dependsOn: extractEnabled ? [{ pipeline: 'extract' }] : [],
    }));
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.localize;
    const item = soleItem(task);
    const targetLang = task.variant;
    if (!targetLang) {
      throw new PipelineError('Localization task is missing its target language', { details: { taskId: task.taskId } });
    }

    const source = await this.loadSource(item, context);
    const options: LocalizationOptions = { localizable: config.localizableFields, listFields: config.listFields };
    const units = collectUnits(source, options);

    if (units.length === 0) {
      return this.result(config, item, targetLang, source, { ...EMPTY_USAGE }, 0, [
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
    const notes = [...batch.notes];
    const unresolved = missingKeys(units, batch.translations);
    if (unresolved.length > 0) {
      notes.push(`${unresolved.length} string(s) kept their source text: no translation was returned.`);
    }

    return this.result(config, item, targetLang, localized, batch.usage, batch.costUsd, notes);
  }

  /**
   * The dossier to localize: the extraction output for the source language, or —
   * when extraction is off — the dossier sitting beside the article, which is how
   * an existing corpus is laid out.
   */
  private async loadSource(item: WorkItem, context: ExecutionContext): Promise<JsonValue> {
    const file = await this.resolveSource(item, context.config, context.writer);
    return readJsonFile<JsonValue>(file);
  }

  private async resolveSource(
    item: WorkItem,
    config: ExecutionContext['config'],
    writer: ExecutionContext['writer'],
  ): Promise<string> {
    const produced = writer.resolvePath({
      channel: config.tasks.localize.outputChannel,
      format: 'json',
      body: '',
      pathVars: this.pathVars(item, item.language),
    });
    if (await pathExists(produced)) return produced;

    const sibling = join(dirname(item.absolutePath), `${item.slug}${config.input.slugSuffix.replace(/\.md$/, '.json')}`);
    if (await pathExists(sibling)) return sibling;

    throw new PipelineError(
      `No source dossier for "${item.id}". Looked for ${produced} and ${sibling}. ` +
        'Enable tasks.extract, or place a dossier next to the article.',
      { details: { item: item.id, produced, sibling } },
    );
  }

  private async hashOf(file: string): Promise<string> {
    return readTextFile(file).catch(() => '');
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

