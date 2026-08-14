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
import type { CatalogHints } from '../extraction/normalize.js';
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
 * **No LLM calls, still.** The classification the format needs — `type`,
 * `gender`, `country`, a Latin `title` — is not derivable from a dossier, but it
 * *was* derivable from the article, which `extract` had open anyway. So it is
 * collected there and left on the `catalogHints` channel, and this pipeline only
 * chooses between sources. That keeps the aggregation deterministic and free,
 * and adds no second pass over the corpus.
 *
 * Precedence for every classification field: **the existing index wins**, then
 * the extraction hint, then a configured default. An index row is the one thing
 * here a human may have edited by hand, so nothing derived is allowed to
 * overwrite it.
 *
 * `img` is preserved but never invented: media is a curation decision, and a
 * wrong portrait is worse than the gender-based default the format specifies.
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
          generateAliases: config.generateAliases,
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
      const hints = await this.readHints(item, context);
      const previous = allocator.previous(item.slug);
      const row: CatalogRow = {
        id: allocator.idFor(item.slug),
        title: previous?.title ?? latinTitleOf(item.slug, dossiers, hints.title),
        lang: editions.join(','),
        type: previous?.type ?? hints.type ?? config.defaultType,
        md: `/${item.slug}${context.config.input.slugSuffix}`,
        ...(dossiers.size > 0 ? { json: `/${item.slug}.bio.json` } : {}),
        ...pick('gender', previous?.gender ?? hints.gender),
        ...pick('country', previous?.country ?? hints.country),
        ...(previous?.img ? { img: previous.img } : {}),
      };
      rows.push(row);

      if (!previous && (hints.gender || hints.country || hints.type)) {
        notes.push(`${item.slug}: classified from the extraction hint (${describe(hints)}).`);
      }
      if (config.localizedNames) this.collectNames(row, dossiers, names, config.generateAliases);
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

  /**
   * The classification `extract` noticed while it had the article open.
   *
   * Read from the source-language edition: nationality and craft are properties
   * of the person, so any edition would do, and the source one is the edition
   * guaranteed to exist. A missing file is normal — extraction may be off, or
   * the article may simply not have said.
   */
  private async readHints(item: WorkItem, context: ExecutionContext): Promise<CatalogHints> {
    const file = this.pathOf(context.writer, context.config.tasks.catalog.hintsChannel, item, item.language);
    if (!(await pathExists(file))) return {};
    return (await readJsonFile<CatalogHints>(file).catch(() => ({}))) ?? {};
  }

  private collectNames(
    row: CatalogRow,
    dossiers: ReadonlyMap<string, DossierNames>,
    names: Map<string, Map<string, string[]>>,
    aliases: boolean,
  ): void {
    for (const [lang, entries] of displayNamesOf(row, dossiers, { aliases })) {
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

/** Omits the key entirely when there is no value — the format has no empty strings. */
function pick(key: string, value: string | undefined): Record<string, string> {
  return value ? { [key]: value } : {};
}

function describe(hints: CatalogHints): string {
  return Object.entries(hints)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}
