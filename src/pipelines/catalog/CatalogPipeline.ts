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
import type { NameRosterStore } from '../../roster/NameRosterStore.js';
import type { RosterEntry } from '../../roster/types.js';
import { pathExists, readJsonFile } from '../../shared/fs.js';
import type { JsonValue } from '../../shared/json.js';
import { rosterEntryFor } from '../shared/roster.js';
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

  constructor(private readonly roster: NameRosterStore) {}

  async planCorpus(items: readonly WorkItem[], context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.catalog;

    return [
      {
        label: `catalogue index (${items.length} entries)`,
        contract: {
          languages: this.editionLanguages(context.config).sort(),
          localizedNames: config.localizedNames,
          generateAliases: config.generateAliases,
          aliasPolicy: config.aliasPolicy,
          displayNameOrder: config.displayNameOrder,
          refresh: [...config.refresh].sort(),
          roster: context.config.roster.aliases ? context.config.roster.file : '',
          merge: config.merge,
          catalogue: context.config.catalogue,
          portraits: context.config.tasks.portrait.enabled,
        },
        promptVersion: 'none',
        usesLlm: false,
        expectedOutputs: [{ channel: config.indexChannel, pathVars: {} }],
        // index.json is read, edited and written back. Its existence is the
        // normal state of a catalogue, not a sign that this run has nothing to
        // add: skipping on it meant a new article could never reach the index.
        mergesOutput: true,
        /**
         * Everything the index describes must have *finished* before it is
         * indexed — but only finished, not succeeded.
         *
         * These are ordering barriers (`optional`), because this pipeline reads
         * the disk rather than the plan: a language whose translation failed is
         * simply absent from that entry's editions, which is the same answer it
         * gives for a language nobody asked for. Treating them as prerequisites
         * meant one document failing one translation retired the index for the
         * entire corpus — every other entry losing its row to a neighbour's bad
         * luck, which is the opposite of what an aggregate is for.
         */
        dependsOn: [
          { pipeline: 'extract', scope: 'all', optional: true },
          { pipeline: 'websearch', scope: 'all', optional: true },
          { pipeline: 'translate', scope: 'all', optional: true },
          { pipeline: 'localize', scope: 'all', optional: true },
          { pipeline: 'portrait', scope: 'all', optional: true },
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

      if (config.localizedNames) {
        await this.collectNames(result.row, item, dossiers, derived, context);
      }
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

  private async collectNames(
    row: EntryRow,
    item: WorkItem,
    dossiers: ReadonlyMap<string, DossierNames>,
    derived: Map<string, Map<string, string[]>>,
    context: ExecutionContext,
  ): Promise<void> {
    const config = context.config.tasks.catalog;
    const roster = await rosterEntryFor(item, context.config, this.roster);
    const names = displayNamesOf(row, dossiers, {
      aliases: config.generateAliases,
      policy: config.aliasPolicy,
      order: config.displayNameOrder,
      rosterLanguage: context.config.roster.language,
      extra: this.rosterAliases(context, roster),
      ...(this.rosterDisplayName(context, roster) ?? {}),
    });

    for (const [lang, entries] of names) {
      const bucket = derived.get(lang) ?? new Map<string, string[]>();
      bucket.set(row.id, entries);
      derived.set(lang, bucket);
    }
  }

  /**
   * The roster's own names for this entry, for the one language it is written in.
   *
   * These are the best aliases in the system and the only ones nothing else can
   * derive: `Баццотти Марко` beside `Баззотти`, `Инсаров` for a man the
   * catalogue files under `Черножуков`, `Буэк` for `Бюк`. They are hand-authored
   * variants, not translations, so they are offered to their own language and to
   * no other.
   */
  private rosterAliases(
    context: ExecutionContext,
    entry: RosterEntry | undefined,
  ): ReadonlyMap<string, readonly string[]> | undefined {
    const settings = context.config.roster;
    if (!settings.aliases || !context.config.tasks.catalog.generateAliases || !entry) return undefined;

    const names = [entry.fullName, ...entry.aliases].filter(Boolean);
    return names.length > 0 ? new Map([[settings.language, names]]) : undefined;
  }

  /**
   * The roster's heading, offered as the entry's **display name** rather than
   * as one more alias.
   *
   * `index-<lang>.json[0]` is what the reader prints under the thumbnail, and
   * a derived `Forename Surname` is a guess at what a person already wrote
   * down: `Абитон Жерар` is the catalogue's own heading for that entry, and for
   * a collective — where a dossier's name columns hold whatever the extractor
   * could make of a title — it is frequently the only real name in the system.
   *
   * Two records are refused. One whose columns do not read as a name at all
   * (`authors.bio.md`, a page title chopped into three) would publish
   * `Музыкальные пристрастия – музыка гитариста` as somebody's name; a
   * collective is *not* refused, because its `fullName` is precisely its title.
   * And it is offered to the roster's own language only — these are variant
   * spellings, not translations.
   */
  private rosterDisplayName(
    context: ExecutionContext,
    entry: RosterEntry | undefined,
  ): { preferred: ReadonlyMap<string, string> } | undefined {
    const settings = context.config.roster;
    if (!entry || context.config.tasks.catalog.displayNameOrder !== 'roster') return undefined;
    if (!entry.personName && !entry.ensemble.group) return undefined;

    const name = entry.fullName.trim();
    return name ? { preferred: new Map([[settings.language, name]]) } : undefined;
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
      // `merge: false` means "rebuild rather than update", and it has to mean
      // the same thing here as it does for `index.json`. Otherwise a derived
      // display name can never be *corrected*: `mergeNameIndex` treats every
      // existing `[0]` as hand-authored — which is right, and which also makes
      // a fix to this producer invisible until the file is deleted by hand.
      const existing =
        config.merge && (await pathExists(path))
          ? await readJsonFile<unknown>(path).catch(() => undefined)
          : undefined;

      const merged = mergeNameIndex(existing, entries, {
        titles,
        knownIds,
        refreshDisplayNames: config.refresh.includes('displayNames'),
      });
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
      refresh: config.tasks.catalog.refresh,
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
