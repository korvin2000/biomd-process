import { basename } from 'node:path';

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
import { CatalogIndex, mergeNameIndex, type CatalogOptions, type RowUpdate } from '../../domain/catalog.js';
import type { CatalogHints, EntryRow } from '../../domain/types.js';
import type { Artifact, ArtifactWriter } from '../../io/types.js';
import { EMPTY_USAGE } from '../../llm/types.js';
import { pathExists, readJsonFile } from '../../shared/fs.js';
import type { JsonValue } from '../../shared/json.js';
import { displayNamesOf, latinTitleOf, type DossierNames } from './names.js';

const PIPELINE_ID = 'catalog';

/**
 * Builds `index.json` and the `index-<lang>.json` name files — by **updating**
 * them, never by replacing them.
 *
 * A corpus-scope pipeline: the catalogue is an aggregate and cannot be computed
 * one document at a time. It runs in the final dependency wave, after every
 * article and dossier has landed, and reports what is actually on disk rather
 * than what was planned — a language whose translation failed does not appear
 * among that entry's editions, because a declared edition with no file is a
 * broken entry rather than a fallback.
 *
 * **Still LLM-free.** The classification the format needs (`type`, `gender`,
 * `country`, a Latin `title`) is not derivable from a dossier but *was*
 * derivable from the article, which `extract` had open anyway — so it arrives on
 * the `catalogHints` channel and this pipeline only chooses between sources.
 *
 * Precedence for every field: **the existing index wins**, then the extraction
 * hint, then a configured default. An index row is the one thing here a human
 * may have edited by hand, and its `id` is a join key that must never move.
 */
export class CatalogPipeline implements CorpusPipeline {
  readonly id = PIPELINE_ID;
  readonly scope = 'corpus' as const;
  readonly usesLlm = false;
  readonly description = 'Aggregate the corpus into index.json and the per-language name files.';

  async planCorpus(items: readonly WorkItem[], context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.catalog;

    return [
      {
        label: `catalogue index (${items.length} entries)`,
        contract: {
          languages: this.editionLanguages(context.config).sort(),
          localizedNames: config.localizedNames,
          generateAliases: config.generateAliases,
          merge: config.merge,
          catalogue: context.config.catalogue,
          portraits: context.config.tasks.portrait.enabled,
        },
        promptVersion: 'none',
        usesLlm: false,
        expectedOutputs: [{ channel: config.indexChannel, pathVars: {} }],
        // Everything the index describes must exist before it is indexed.
        dependsOn: [
          { pipeline: 'extract', scope: 'all' },
          { pipeline: 'websearch', scope: 'all' },
          { pipeline: 'translate', scope: 'all' },
          { pipeline: 'localize', scope: 'all' },
          { pipeline: 'portrait', scope: 'all' },
        ],
      },
    ];
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.catalog;
    const options = this.catalogOptions(context.config);
    const index = await this.loadIndex(config, options, context);
    const notes = [...index.loadNotes];

    const derived = new Map<string, Map<string, string[]>>();
    const checked = [...new Set([...this.editionLanguages(context.config)])];

    for (const item of task.items) {
      const editions = await this.editionsOf(item, context, notes);
      if (editions.languages.length === 0) {
        notes.push(`${item.slug}: no complete edition on disk; the index is left as it was.`);
        continue;
      }

      const dossiers = await this.readDossiers(item, editions.languages, context);
      const hints = await this.readHints(item, context);

      const update: RowUpdate = {
        slug: item.slug,
        md: `/${basename(item.relativePath)}`,
        verifiedLanguages: editions.languages,
        checkedLanguages: checked,
        title: hints.title ?? latinTitleOf(item.slug, dossiers),
        ...(editions.dossierPath ? { json: editions.dossierPath } : {}),
        ...(hints.type ? { type: hints.type } : {}),
        ...(hints.gender ? { gender: hints.gender } : {}),
        ...(hints.country ? { country: hints.country } : {}),
        ...(hints.img ? { img: hints.img } : {}),
      };

      const result = index.upsert(update);
      notes.push(...result.notes);
      if (result.created) {
        notes.push(`${item.slug}: new row, id ${result.row.id}${describe(hints)}.`);
      }

      if (config.localizedNames) this.collectNames(result.row, dossiers, derived, config.generateAliases);
    }

    const artifacts: Artifact[] = [
      {
        channel: config.indexChannel,
        format: 'json',
        body: index.toArray() as unknown as JsonValue,
        pathVars: {},
        // This *is* the existing file plus this run's updates. Skipping it under
        // `output.onExisting: skip` would protect nothing and discard the merge.
        overwrite: config.merge,
      },
    ];

    if (config.localizedNames) {
      artifacts.push(...(await this.nameArtifacts(config, index, derived, context, notes)));
    }

    return { artifacts, usage: { ...EMPTY_USAGE }, costUsd: 0, notes };
  }

  /**
   * Loads the index this run will update.
   *
   * `merge: false` starts from nothing, which deletes every row this run does
   * not visit. It exists because someone will eventually want a clean rebuild;
   * it is not a default anyone should choose casually.
   */
  private async loadIndex(
    config: CatalogTaskConfig,
    options: CatalogOptions,
    context: ExecutionContext,
  ): Promise<CatalogIndex> {
    if (!config.merge) return CatalogIndex.load([], options);

    const file = this.indexPath(config, context.writer);
    if (!(await pathExists(file))) return CatalogIndex.load([], options);

    const existing = await readJsonFile<unknown>(file).catch(() => undefined);
    return CatalogIndex.load(existing, options);
  }

  /**
   * The languages for which this entry has a **complete** edition.
   *
   * Complete means the article *and*, when the entry is a biography, the
   * dossier: `INV-8` treats a declared edition with a missing file as a broken
   * entry, and a reader has no instruction to substitute another language.
   */
  private async editionsOf(
    item: WorkItem,
    context: ExecutionContext,
    notes: string[],
  ): Promise<{ languages: string[]; dossierPath?: string }> {
    const { config, writer } = context;
    const sourceDossier = this.pathOf(writer, config.tasks.extract.outputChannel, item, item.language);
    const isBiography = await pathExists(sourceDossier);
    const dossierPath = isBiography ? `/${basename(sourceDossier)}` : undefined;

    const languages = [item.language];
    const articleName = basename(item.relativePath);

    for (const lang of this.editionLanguages(config)) {
      if (lang === item.language) continue;

      const article = this.pathOf(writer, config.tasks.translate.outputChannel, item, lang);
      if (!(await pathExists(article))) continue;
      if (basename(article) !== articleName) {
        notes.push(
          `${item.slug}: the ${lang} article is named ${basename(article)} but the source is ${articleName}; ` +
            'one `md` value cannot describe both, so the edition is not declared.',
        );
        continue;
      }
      if (isBiography) {
        const dossier = this.pathOf(writer, config.tasks.localize.outputChannel, item, lang);
        if (!(await pathExists(dossier))) {
          notes.push(`${item.slug}: the ${lang} article exists but its dossier does not; edition not declared (INV-8).`);
          continue;
        }
      }
      languages.push(lang);
    }

    return dossierPath ? { languages, dossierPath } : { languages };
  }

  private async readDossiers(
    item: WorkItem,
    editions: readonly string[],
    context: ExecutionContext,
  ): Promise<Map<string, DossierNames>> {
    const dossiers = new Map<string, DossierNames>();

    for (const lang of editions) {
      const channel =
        lang === item.language
          ? context.config.tasks.extract.outputChannel
          : context.config.tasks.localize.outputChannel;
      const path = this.pathOf(context.writer, channel, item, lang);
      if (!(await pathExists(path))) continue;

      const dossier = await readJsonFile<DossierNames>(path).catch(() => undefined);
      if (dossier) dossiers.set(lang, dossier);
    }
    return dossiers;
  }

  /**
   * The classification `extract` noticed while it had the article open, or
   * migrated out of an existing version 1 dossier, plus the portrait `portrait`
   * chose.
   *
   * Read from the source-language edition: nationality and craft are properties
   * of the person, so any edition would do, and the source one is the edition
   * guaranteed to exist. A missing file is normal.
   *
   * Precedence between the two hint files matters for one field. `extract`'s
   * `img` came out of a hand-authored version 1 dossier — a curated choice —
   * while `portrait`'s was derived by matching names against an image index. So
   * the authored one wins, and the whole chain reads: **existing index row →
   * authored hint → matched portrait → nothing** (and "nothing" is itself the
   * specified way to get the default portrait).
   */
  private async readHints(item: WorkItem, context: ExecutionContext): Promise<CatalogHints> {
    const config = context.config.tasks.catalog;
    const [article, web, portrait] = await Promise.all([
      this.readHintFile<CatalogHints>(config.hintsChannel, item, context),
      this.readHintFile<CatalogHints>(config.websearchChannel, item, context),
      this.readHintFile<{ img?: string }>(config.portraitChannel, item, context),
    ]);

    // Spread order *is* the precedence: what the article said outranks what a
    // search found, and a derived portrait fills only a gap.
    const hints: CatalogHints = { ...(web ?? {}), ...(article ?? {}) };
    if (!hints.img && portrait?.img) hints.img = portrait.img;
    return hints;
  }

  private async readHintFile<T>(channel: string, item: WorkItem, context: ExecutionContext): Promise<T | undefined> {
    const file = this.pathOf(context.writer, channel, item, item.language);
    if (!(await pathExists(file))) return undefined;
    return (await readJsonFile<T>(file).catch(() => undefined)) ?? undefined;
  }

  private collectNames(
    row: EntryRow,
    dossiers: ReadonlyMap<string, DossierNames>,
    derived: Map<string, Map<string, string[]>>,
    aliases: boolean,
  ): void {
    for (const [lang, entries] of displayNamesOf(row, dossiers, { aliases })) {
      const bucket = derived.get(lang) ?? new Map<string, string[]>();
      bucket.set(row.id, entries);
      derived.set(lang, bucket);
    }
  }

  /**
   * One artifact per language whose name index this run changes.
   *
   * A file that would come back byte-identical is not rewritten: these are
   * hand-editable documents, and an untouched file is the clearest possible
   * signal that nothing about it needed touching.
   */
  private async nameArtifacts(
    config: CatalogTaskConfig,
    index: CatalogIndex,
    derived: ReadonlyMap<string, Map<string, string[]>>,
    context: ExecutionContext,
    notes: string[],
  ): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    const titles = new Map([...index.toArray()].map((row) => [row.id, row.title]));
    const knownIds = index.ids();

    for (const [lang, entries] of [...derived].sort(([a], [b]) => a.localeCompare(b))) {
      const path = context.writer.resolvePath({
        channel: config.localizedIndexChannel,
        format: 'json',
        body: '',
        pathVars: { lang },
      });
      const existing = (await pathExists(path)) ? await readJsonFile<unknown>(path).catch(() => undefined) : undefined;

      const merged = mergeNameIndex(existing, entries, { titles, knownIds });
      notes.push(...merged.notes.map((note) => `index-${lang}.json: ${note}`));
      if (merged.unchanged && existing !== undefined) continue;

      artifacts.push({
        channel: config.localizedIndexChannel,
        format: 'json',
        body: merged.index as unknown as JsonValue,
        pathVars: { lang },
        overwrite: true,
      });
    }
    return artifacts;
  }

  private catalogOptions(config: AppConfig): CatalogOptions {
    return {
      supportedLanguages: config.catalogue.supportedLanguages,
      defaultType: config.catalogue.defaultType,
      defaultPageType: config.catalogue.defaultPageType,
      allowUnknownTypes: config.catalogue.allowUnknownTypes,
    };
  }

  private editionLanguages(config: AppConfig): string[] {
    const translate = config.tasks.translate.targetLanguages;
    const localize = config.tasks.localize.targetLanguages;
    return [...new Set([...translate, ...localize])];
  }

  private indexPath(config: CatalogTaskConfig, writer: ArtifactWriter): string {
    return writer.resolvePath({ channel: config.indexChannel, format: 'json', body: '', pathVars: {} });
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

function describe(hints: CatalogHints): string {
  const detail = Object.entries(hints)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  return detail ? ` (${detail})` : '';
}
