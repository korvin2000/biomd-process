import type { PortraitTaskConfig } from '../../config/schema.js';
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
import { harvestMedia } from '../../documents/markdown/media.js';
import { readTitle } from '../../documents/markdown/title.js';
import { sanitizeDossier } from '../../domain/dossier.js';
import type { CatalogHints, Dossier } from '../../domain/types.js';
import { normalizeAssetPath } from '../../domain/values.js';
import type { ImageIndexStore } from '../../images/ImageIndexStore.js';
import { buildQuery, type NameQuery } from '../../images/query.js';
import { selectPortrait, type Candidate, type Selection } from '../../images/select.js';
import { describeSubject, detectSubject, type SubjectShape } from '../../images/subject.js';
import type { Artifact } from '../../io/types.js';
import { EMPTY_USAGE } from '../../llm/types.js';
import type { NameRosterStore } from '../../roster/NameRosterStore.js';
import type { RosterEntry } from '../../roster/types.js';
import { pathExists, readJsonFile } from '../../shared/fs.js';
import type { JsonValue } from '../../shared/json.js';
import { findDossierToLocalize } from '../shared/dossierSource.js';
import { rosterEntryFor } from '../shared/roster.js';

const PIPELINE_ID = 'portrait';
/** Enough of the gallery to hold the entry's own picture; the rest is discography. */
const ARTICLE_IMAGES = 12;

/**
 * One person, or how many.
 *
 * Read from the article's title and the roster's name — never from the prose,
 * where "played in a duo with Meleshko" would file a soloist as a pair.
 */
function subjectOf(item: WorkItem, entry: RosterEntry | undefined): SubjectShape {
  const title = readTitle(item.content);
  return detectSubject({
    titles: title.lines,
    names: entry ? [entry.fullName, entry.displayName] : [],
    slug: item.slug,
  });
}

/**
 * Chooses the entry's portrait out of an existing image index — **without
 * calling a model**.
 *
 * The whole selection is in `src/images`; this pipeline is the wiring: it
 * assembles what is known about the person (the slug, the dossier's own name
 * fields, the Latin title `extract` derived) and writes the answer to a hint
 * channel that `catalog` reads.
 *
 * Two decisions are worth stating here rather than in the matcher:
 *
 *  1. **It writes a hint, not `index.json`.** `img` is a curated field: a human
 *     may have chosen a portrait by hand, and `CatalogIndex.upsert` never
 *     overwrites one that already exists. A hint offers a value; the index
 *     decides whether it is needed.
 *  2. **Below the confidence threshold it writes nothing at all.** Not a
 *     placeholder, not a guess. `external/03` §3.4.9 already specifies what an
 *     absent `img` means — the reader substitutes `photos/default-male.svg`,
 *     `-female` or `-mixed` by gender — and those synthetic defaults are
 *     deliberately kept out of the entry's gallery, which a value written here
 *     would not be. `onLowConfidence: default` exists for a deployment that
 *     wants the value spelled out anyway.
 */
export class PortraitPipeline implements DocumentPipeline {
  readonly id = PIPELINE_ID;
  readonly usesLlm = false;
  readonly description = 'Choose an entry portrait from the image index, by name and picture suitability.';

  constructor(
    private readonly images: ImageIndexStore,
    private readonly roster: NameRosterStore,
  ) {}

  async plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.portrait;
    const roster = await rosterEntryFor(item, context.config, this.roster);

    return [
      {
        label: `${item.slug} → portrait`,
        contract: {
          indexFile: config.indexFile,
          subject: subjectOf(item, roster),
          // Extra name spellings change which files are even considered.
          rosterNames: context.config.roster.nameHints ? (roster?.aliases.length ?? 0) : 0,
          assetPrefix: config.assetPrefix,
          minIdentity: config.minIdentity,
          maxTier: config.maxTier,
          minPixels: config.minPixels,
          excludeReleaseCovers: config.excludeReleaseCovers,
          onLowConfidence: config.onLowConfidence,
          defaultPortraits: config.defaultPortraits,
        },
        promptVersion: 'none',
        usesLlm: false,
        expectedOutputs: [{ channel: config.outputChannel, pathVars: this.pathVars(item) }],
        // The dossier supplies the name in its own script, which is what the
        // Cyrillic half of the index is matched against — and a birthplace the
        // web filled in is what keeps `segovia_linares.jpg` from reading as a
        // photograph of two people.
        //
        // The birthplace is a tie-breaker, not the query: a failed web search
        // costs some confidence on a namesake, so it waits for it and proceeds
        // either way.
        dependsOn: [
          ...(context.config.tasks.extract.enabled ? [{ pipeline: 'extract' }] : []),
          ...(context.config.tasks.websearch.enabled ? [{ pipeline: 'websearch', optional: true }] : []),
        ],
      },
    ];
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.portrait;
    const item = soleItem(task);
    const notes: string[] = [];

    const index = await this.images.load(config.indexFile);
    if (index.skipped > 0) notes.push(`${index.skipped} image record(s) in the index were unreadable and ignored.`);

    const hints = await this.readHints(item, context);
    const entry = await rosterEntryFor(item, context.config, this.roster);
    const subject = subjectOf(item, entry);

    // The article's own gallery, parsed rather than asked for. Its first image
    // is the closest thing to a curated answer this corpus has.
    const articleImages = harvestMedia(item.content, {
      photos: true,
      music: false,
      maxItems: ARTICLE_IMAGES,
    }).imageTargets;

    const query = buildQuery({
      slug: item.slug,
      ...(await this.readDossier(item, context)),
      ...(hints.title ? { latinTitle: hints.title } : {}),
      ...(articleImages.length > 0 ? { articleImages } : {}),
      ...(this.rosterNames(context, entry)),
    });

    const selection = selectPortrait(index, query, {
      minIdentity: config.minIdentity,
      maxTier: config.maxTier,
      minPixels: config.minPixels,
      excludeReleaseCovers: config.excludeReleaseCovers,
      keep: config.keepCandidates,
      subject,
    });

    if (subject.kind === 'group') {
      notes.push(`Treated ${item.slug} as ${describeSubject(subject)} — ${subject.evidence}.`);
    }
    const body = this.report(config, item, query, selection, hints, notes, subject, articleImages);
    return {
      artifacts: [
        {
          channel: config.outputChannel,
          format: 'json',
          body: body as unknown as JsonValue,
          pathVars: this.pathVars(item),
          // The file is this run's answer in full; refusing to replace last
          // run's answer would leave a stale portrait pointing at nothing.
          overwrite: true,
        } satisfies Artifact,
      ],
      usage: { ...EMPTY_USAGE },
      costUsd: 0,
      notes,
    };
  }

  /** The hint document, which doubles as the diagnostic record of the choice. */
  private report(
    config: PortraitTaskConfig,
    item: WorkItem,
    query: NameQuery,
    selection: Selection,
    hints: CatalogHints,
    notes: string[],
    subject: SubjectShape,
    articleImages: readonly string[],
  ): Record<string, unknown> {
    const candidates = selection.candidates.map((candidate) => describe(candidate));
    const searched = {
      surnames: query.surnames,
      forenames: query.forenames,
      subject,
      ...(articleImages.length > 0 ? { articleImages: [...articleImages] } : {}),
    };

    if (selection.chosen) {
      const chosen = selection.chosen;
      const img = assetPath(config.assetPrefix, chosen.record.relPath);
      notes.push(
        `Portrait: ${chosen.record.relPath} (identity ${chosen.identity.score.toFixed(2)}, ` +
          `tier ${chosen.suitability.tier}) — ${chosen.identity.reasons.join('; ')}.`,
      );
      return {
        slug: item.slug,
        ...(img ? { img } : {}),
        source: chosen.record.relPath,
        identity: chosen.identity.score,
        tier: chosen.suitability.tier,
        reasons: chosen.identity.reasons,
        searched,
        candidates,
      };
    }

    const fallback = this.fallbackFor(config, hints);
    notes.push(
      `No portrait for ${item.slug}: ${selection.declined ?? 'no candidate'}` +
        (fallback ? ` — falling back to ${fallback}.` : ' — img omitted, the reader substitutes its default portrait.'),
    );
    return {
      slug: item.slug,
      ...(fallback ? { img: fallback, fallback: true } : {}),
      declined: selection.declined ?? 'no candidate',
      searched,
      candidates,
    };
  }

  /**
   * The gender-specific default asset, when the deployment asked for it in
   * writing rather than relying on the reader's own fallback chain.
   */
  private fallbackFor(config: PortraitTaskConfig, hints: CatalogHints): string | undefined {
    if (config.onLowConfidence !== 'default') return undefined;

    const gender = (hints.gender ?? 'mixed').toLowerCase();
    const table = config.defaultPortraits;
    return (gender === 'm' ? table.m : gender === 'f' ? table.f : table.mixed) || undefined;
  }

  /**
   * The roster's spellings of the name, when it has any.
   *
   * The one source that can name a collective the slug abbreviates
   * (`classicalag`) and the only place a pseudonym is written down.
   */
  private rosterNames(context: ExecutionContext, entry: RosterEntry | undefined): { extraNames?: string[] } {
    if (!entry || !context.config.roster.nameHints) return {};

    const names = [entry.displayName, entry.fullName, ...entry.aliases].filter(Boolean);
    return names.length > 0 ? { extraNames: [...new Set(names)] } : {};
  }

  /** The dossier as this run knows it: the extraction output, else the authored file. */
  private async readDossier(item: WorkItem, context: ExecutionContext): Promise<{ dossier?: Dossier }> {
    const existing = await findDossierToLocalize(item, context.config, context.writer);
    if (!existing) return {};

    const sanitized = sanitizeDossier(existing.value, {
      supportedLanguages: context.config.catalogue.supportedLanguages,
      allowUnknownTypes: context.config.catalogue.allowUnknownTypes,
      datePrecision: context.config.catalogue.datePrecision,
    });
    return { dossier: sanitized.dossier };
  }

  /** `extract`'s catalogue hints: the Latin title, and the gender for a fallback. */
  private async readHints(item: WorkItem, context: ExecutionContext): Promise<CatalogHints> {
    const file = context.writer.resolvePath({
      channel: context.config.tasks.extract.hintsChannel,
      format: 'json',
      body: '',
      pathVars: this.pathVars(item),
    });
    if (!(await pathExists(file))) return {};
    return (await readJsonFile<CatalogHints>(file).catch(() => ({}))) ?? {};
  }

  private pathVars(item: WorkItem): Record<string, string> {
    return { slug: item.slug, lang: item.language, sourceLang: item.language, targetLang: item.language };
  }
}

/** `pages/` + `photo/s/segovia_a.jpg` → `pages/photo/s/segovia_a.jpg` (VD-PATH-ASSET). */
export function assetPath(prefix: string, relPath: string): string | undefined {
  const joined = `${prefix.replace(/\/+$/, '')}/${relPath.replace(/^\/+/, '')}`.replace(/^\/+/, '');
  return normalizeAssetPath(joined);
}

function describe(candidate: Candidate): Record<string, unknown> {
  const { record, identity, suitability } = candidate;
  return {
    relPath: record.relPath,
    identity: identity.score,
    evidence: identity.kind,
    tier: suitability.tier,
    avatarScore: Math.round(suitability.score * 100) / 100,
    class: record.ai.class,
    faceCount: record.ai.faceCount,
    faceCoverage: record.ai.faceCoverage,
    orientation: record.orientation,
    reasons: [...identity.reasons, ...suitability.reasons],
    ...(suitability.excluded ? { excluded: suitability.excluded } : {}),
  };
}
