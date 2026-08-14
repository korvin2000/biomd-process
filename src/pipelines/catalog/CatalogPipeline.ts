import type { AppConfig, CatalogTaskConfig } from '../../config/schema.js';
import type {
  CorpusPipeline,
  ExecutionContext,
  PlanContext,
  PlannedTask,
  TaskResult,
  TaskSeed,
  WorkItem,
} from '../../core/types.js';
import type { Artifact, ArtifactWriter } from '../../io/types.js';
import { EMPTY_USAGE } from '../../llm/types.js';
import { pathExists, readJsonFile } from '../../shared/fs.js';
import type { JsonValue } from '../../shared/json.js';
import { IdAllocator, type CatalogRow } from './IdAllocator.js';
import { displayNamesOf, latinTitleOf, type DossierNames } from './names.js';

const PIPELINE_ID = 'catalog';

/**
 * Builds `index.json` and the `index-<lang>.json` name files.
 *
 * A corpus-scope pipeline: the catalogue is an aggregate and cannot be computed
 * one document at a time. It runs in the final dependency wave, after every
 * article and dossier has landed, and reports **what is actually on disk** rather
 * than what was planned — a language whose translation failed simply does not
 * appear among that entry's editions.
 *
 * No LLM calls. Everything here is derivable from the outputs and the config.
 *
 * TODO(domain): the classification fields are the open part of this format.
 *  - `type` (`guitarist`, `composer`, `luthier`, `hidden`, …) is guessed as
 *    `tasks.catalog.defaultType` for new rows; existing rows keep theirs.
 *  - `gender` and `country` are preserved when already present and omitted
 *    otherwise — neither is reliably derivable from a dossier.
 *  - `title` falls back to de-slugging when no Latin edition exists; a real
 *    romanization pass (LLM-assisted) belongs here.
 *  - `img` is preserved but never invented.
 *  - Search aliases beyond the display name are not generated yet; see
 *    `Catalog-Index.md` §10, which is explicit that aliases are what makes
 *    CJK search work.
 */
export class CatalogPipeline implements CorpusPipeline {
  readonly id = PIPELINE_ID;
  readonly scope = 'corpus' as const;
  readonly usesLlm = false;
  readonly description = 'Aggregate the corpus into index.json and the per-language name files.';

  async planCorpus(items: readonly WorkItem[], context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.catalog;
    const channels = [{ channel: config.indexChannel, pathVars: {} }];

    return [
      {
        label: `catalogue index (${items.length} entries)`,
        contract: {
          languages: this.editionLanguages(context.config).sort(),
          localizedNames: config.localizedNames,
          defaultType: config.defaultType,
        },
        // Promptless: the version only has to be stable.
        promptVersion: 'none',
        expectedOutputs: channels,
        // Everything the index describes must exist before it is indexed.
        dependsOn: [
          { pipeline: 'extract', scope: 'all' },
          { pipeline: 'translate', scope: 'all' },
          { pipeline: 'localize', scope: 'all' },
        ],
      },
    ];
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.catalog;
    const allocator = await this.loadAllocator(config, context);
    const notes: string[] = [];

    const rows: CatalogRow[] = [];
    const names = new Map<string, Map<string, string[]>>();

    for (const item of task.items) {
      const editions = await this.editionsOf(item, context);
      if (editions.length === 0) {
        notes.push(`${item.slug}: no edition found on disk; omitted from the index.`);
        continue;
      }

      const dossiers = await this.readDossiers(item, editions, context);
      const previous = allocator.previous(item.slug);
      const row: CatalogRow = {
        id: allocator.idFor(item.slug),
        title: previous?.title ?? latinTitleOf(item.slug, dossiers),
        lang: editions.join(','),
        type: previous?.type ?? config.defaultType,
        md: `/${item.slug}${context.config.input.slugSuffix}`,
        ...(dossiers.size > 0 ? { json: `/${item.slug}.bio.json` } : {}),
        ...(previous?.gender ? { gender: previous.gender } : {}),
        ...(previous?.country ? { country: previous.country } : {}),
        ...(previous?.img ? { img: previous.img } : {}),
      };
      rows.push(row);

      if (config.localizedNames) this.collectNames(row, dossiers, names);
    }

    const artifacts: Artifact[] = [
      { channel: config.indexChannel, format: 'json', body: rows as unknown as JsonValue, pathVars: {} },
    ];

    if (config.localizedNames) {
      for (const [lang, entries] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
        artifacts.push({
          channel: config.localizedIndexChannel,
          format: 'json',
          body: Object.fromEntries([...entries].sort(byNumericId)) as unknown as JsonValue,
          pathVars: { lang },
        });
      }
    }

    return { artifacts, usage: { ...EMPTY_USAGE }, costUsd: 0, notes };
  }

  /**
   * Ids must be stable forever and never reused, so an existing index is the
   * authority. Re-deriving them from position would silently break every
   * `index-<lang>.json` key that referenced the old number.
   */
  private async loadAllocator(config: CatalogTaskConfig, context: ExecutionContext): Promise<IdAllocator> {
    if (!config.preserveIds) return new IdAllocator([]);

    const file = context.writer.resolvePath({
      channel: config.indexChannel,
      format: 'json',
      body: '',
      pathVars: {},
    });
    if (!(await pathExists(file))) return new IdAllocator([]);

    const existing = await readJsonFile<CatalogRow[]>(file).catch(() => []);
    return new IdAllocator(Array.isArray(existing) ? existing : [], context.config.input.slugSuffix);
  }

  /** Languages for which this entry actually has an article on disk. */
  private async editionsOf(item: WorkItem, context: ExecutionContext): Promise<string[]> {
    const found: string[] = [item.language];

    for (const lang of this.editionLanguages(context.config)) {
      if (lang === item.language) continue;
      const path = this.pathOf(context.writer, context.config.tasks.translate.outputChannel, item, lang);
      if (await pathExists(path)) found.push(lang);
    }
    return found;
  }

  private async readDossiers(
    item: WorkItem,
    editions: readonly string[],
    context: ExecutionContext,
  ): Promise<Map<string, DossierNames>> {
    const dossiers = new Map<string, DossierNames>();

    for (const lang of editions) {
      const path = this.pathOf(context.writer, context.config.tasks.extract.outputChannel, item, lang);
      if (!(await pathExists(path))) continue;
      const dossier = await readJsonFile<DossierNames>(path).catch(() => undefined);
      if (dossier) dossiers.set(lang, dossier);
    }
    return dossiers;
  }

  private collectNames(
    row: CatalogRow,
    dossiers: ReadonlyMap<string, DossierNames>,
    names: Map<string, Map<string, string[]>>,
  ): void {
    for (const [lang, entries] of displayNamesOf(row, dossiers)) {
      const bucket = names.get(lang) ?? new Map<string, string[]>();
      bucket.set(row.id, entries);
      names.set(lang, bucket);
    }
  }

  private editionLanguages(config: AppConfig): string[] {
    const translate = config.tasks.translate.targetLanguages;
    const localize = config.tasks.localize.targetLanguages;
    return [...new Set([...translate, ...localize])];
  }

  private pathOf(writer: ArtifactWriter, channel: string, item: WorkItem, lang: string): string {
    return writer.resolvePath({
      channel,
      format: 'text',
      body: '',
      pathVars: { slug: item.slug, lang, sourceLang: item.language, targetLang: lang },
    });
  }
}

function byNumericId([a]: [string, string[]], [b]: [string, string[]]): number {
  return (Number(a) || 0) - (Number(b) || 0);
}
