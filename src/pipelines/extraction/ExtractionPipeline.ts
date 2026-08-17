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
import { harvestMedia, type HarvestResult } from '../../documents/markdown/media.js';
import {
  emptyDossier,
  isEmptyDossier,
  mergeDossier,
  presentFields,
  sanitizeDossier,
  type DossierOptions,
} from '../../domain/dossier.js';
import type { CatalogHints, Dossier } from '../../domain/types.js';
import type { Artifact } from '../../io/types.js';
import { EMPTY_USAGE, type TokenUsage } from '../../llm/types.js';
import type { JsonValue } from '../../shared/json.js';
import { findSourceDossier, type ExistingDossier } from '../shared/dossierSource.js';
import { runWithEscalation, type Parsed } from '../shared/escalation.js';
import {
  answeredKeys,
  buildDossier,
  fieldsFor,
  mergeFlat,
  normalizeFlat,
  parseFlatAnswer,
  toCardKey,
  type FlatField,
  type FlatRecord,
} from './FlatFields.js';

const PIPELINE_ID = 'extract';
/** A flat answer of ~20 short values. Generous, and far below the old nested one. */
const EXPECTED_OUTPUT_TOKENS = 600;

/** What this task will actually do, decided during planning. */
type Plan = 'create' | 'reuse' | 'complete' | 'rebuild';

/**
 * Metadata extraction: a flat question to a model, a dossier assembled here.
 *
 * Three decisions define this pipeline, and only the first involves a model at
 * all:
 *
 *  1. **What to ask.** A flat `key: value` card, never the dossier's schema —
 *    see {@link ./FlatFields.js}. The nesting, the `dates` sub-object, the
 *    comma-list encoding and the version 2 rule about identity fields are all
 *    knowledge this process has and a model does not need to be sold.
 *  2. **What not to ask.** The gallery is parsed out of the article's own
 *    `::: image` containers and tablature tables; nothing about media crosses
 *    the wire in either direction.
 *  3. **Whether to ask at all.** An entry that already has a dossier is not
 *    re-extracted. `reuse` (the default) re-emits it, normalized and migrated to
 *    version 2, for **zero tokens**; `complete` asks only for the fields it is
 *    missing; `rebuild` ignores it.
 */
export class ExtractionPipeline implements DocumentPipeline {
  readonly id = PIPELINE_ID;
  readonly description = 'Extract structured metadata from a document into a dossier JSON.';

  async plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.extract;
    const existing = await findSourceDossier(item, context.config);
    const plan = planFor(config, existing);

    return [
      {
        label: `${item.slug} → metadata (${item.language})${plan === 'reuse' ? ' [reused]' : ''}`,
        contract: this.contractOf(config, plan, existing?.hash, context.config.catalogue.datePrecision),
        promptVersion: plan === 'reuse' ? 'none' : await context.prompts.versionOf(PIPELINE_ID),
        // A reused dossier costs nothing, and a cost preview that says otherwise
        // is a cost preview nobody trusts.
        usesLlm: plan !== 'reuse',
        expectedOutputs: [{ channel: config.outputChannel, pathVars: this.pathVars(item) }],
      },
    ];
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.extract;
    const item = soleItem(task);
    const options = this.dossierOptions(context);

    const existing = await findSourceDossier(item, context.config);
    const plan = planFor(config, existing);
    const notes: string[] = [];

    // An existing file is read through the same sanitizer as a fresh answer, so
    // a version 1 document is migrated in passing: its `title`/`type`/`gender`/
    // `country`/`img` become catalogue hints instead of being deleted.
    const base = existing && plan !== 'rebuild' ? sanitizeDossier(existing.value, options) : undefined;
    if (base) {
      notes.push(`Reusing the dossier at ${describePath(existing)}.`);
      notes.push(...base.notes);
    }

    if (plan === 'reuse' && base) {
      return this.emit(config, item, base.dossier, base.hints, { ...EMPTY_USAGE }, 0, notes);
    }

    const harvest = this.harvest(config, item, notes);
    const fields = this.cardFor(config, plan, base?.dossier);

    if (fields.length === 0) {
      const merged = base
        ? mergeDossier(base.dossier, { metadata: {}, media: harvest, documents: [] }, options)
        : undefined;
      notes.push('Nothing left to extract; the existing dossier already answers every field.');
      return this.emit(
        config,
        item,
        merged?.dossier ?? base?.dossier ?? emptyDossier(),
        base?.hints ?? {},
        { ...EMPTY_USAGE },
        0,
        [...notes, ...(merged?.notes ?? [])],
      );
    }

    const satisfied = base ? this.satisfiedKeys(base.dossier) : new Set<string>();
    const outcome = await runWithEscalation<FlatRecord>({
      task,
      context,
      promptId: PIPELINE_ID,
      pool: config.pool,
      contextStrategyId: config.contextStrategy ?? context.config.context.strategy,
      // A harvest cannot tell "the article does not say" apart from "we did not
      // send the part that says it", so the truncated rungs are not a cheap win
      // here — they are a silently incomplete dossier.
      coverage: config.readWholeDocument ? 'whole' : 'any',
      responseFormat: { type: 'json_object' },
      expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
      variables: (attempt, segment) => ({
        ...config.promptVariables,
        language: item.language,
        fields: fields.map((field) => ({ key: field.key, hint: field.hint })),
        requiredFields: config.requiredFields.map(toCardKey).filter((key) => fields.some((f) => f.key === key)),
        partial: attempt.partial || segment.total > 1,
        partLabel: segment.label,
      }),
      section: (segment) => ({ title: 'Article', body: segment.text, volatile: true, fence: 'markdown' }),
      parse: (text) => this.parse(text, fields, options),
      merge: (parts) => mergeFlat(parts, fields),
      accept: (record) => this.accept(record, config, satisfied),
    });

    const built = buildDossier(outcome.value, fields, { ...options, media: harvest });
    notes.push(...outcome.notes, ...built.notes);

    // An absent key means two different things depending on this, and only the
    // run log can tell them apart afterwards.
    if (outcome.attempt.partial) {
      notes.push(
        `Only part of the article was read (${outcome.attempt.description}), so an absent field may be a fact ` +
          'that was never sent rather than one the article omits.',
      );
    }

    if (!base) {
      return this.emit(config, item, built.dossier, built.hints, outcome.usage, outcome.costUsd, notes);
    }

    // Completion never overwrites: the file on disk is the authority, the fresh
    // reading fills its gaps.
    const merged = mergeDossier(base.dossier, built.dossier, options);
    notes.push(...merged.notes);
    if (merged.filled.length > 0) notes.push(`Completed ${merged.filled.length} field(s): ${merged.filled.join(', ')}.`);
    else notes.push('The extraction found nothing the existing dossier was missing.');

    return this.emit(
      config,
      item,
      merged.dossier,
      { ...built.hints, ...base.hints },
      outcome.usage,
      outcome.costUsd,
      notes,
    );
  }

  /** The gallery, read out of the article rather than asked for. */
  private harvest(config: ExtractTaskConfig, item: WorkItem, notes: string[]): HarvestResult {
    if (!config.harvest.photos && !config.harvest.music) return { photos: [], music: [], notes: [] };

    const harvested = harvestMedia(item.content, config.harvest);
    notes.push(...harvested.notes);
    if (harvested.photos.length + harvested.music.length > 0) {
      notes.push(
        `Read ${harvested.photos.length} photo(s) and ${harvested.music.length} audio item(s) ` +
          'out of the article — no tokens spent on media.',
      );
    }
    return harvested;
  }

  /**
   * The field card for this task.
   *
   * In `complete` mode it is only the fields the existing dossier lacks, which
   * is where the second-run saving lives: an entry missing one date costs one
   * short question, not a re-extraction.
   */
  private cardFor(config: ExtractTaskConfig, plan: Plan, base: Dossier | undefined): FlatField[] {
    const full = fieldsFor({ include: config.fields, catalogHints: config.emitCatalogHints });
    if (plan !== 'complete' || !base) return full;

    const present = this.satisfiedKeys(base);
    return full.filter((field) => !present.has(field.key));
  }

  /** Card keys an existing dossier already answers. */
  private satisfiedKeys(dossier: Dossier): Set<string> {
    const keys = new Set<string>();
    for (const path of presentFields(dossier)) keys.add(toCardKey(path));
    return keys;
  }

  /**
   * Models wrap JSON in prose, answer with a nested object, or fall back to
   * plain lines. All three are read locally; a re-ask costs a whole round trip.
   */
  private parse(text: string, fields: readonly FlatField[], options: DossierOptions): Parsed<FlatRecord> {
    const parsed = parseFlatAnswer(text, fields);
    if (!parsed.ok) return { ok: false, reason: parsed.reason ?? 'unreadable answer' };

    const normalized = normalizeFlat(parsed.record, fields, { datePrecision: options.datePrecision });
    return { ok: true, value: normalized.record, notes: normalized.notes };
  }

  /**
   * A partial extraction is not a failure — every field of a dossier is
   * optional. Only the explicitly required ones gate acceptance, which is what
   * makes "try the cheap head slice first" safe.
   */
  private accept(
    record: FlatRecord,
    config: ExtractTaskConfig,
    satisfied: ReadonlySet<string>,
  ): { ok: true } | { ok: false; reason: string } {
    const answered = answeredKeys(record);
    const missing = config.requiredFields
      .map(toCardKey)
      .filter((key) => !answered.has(key) && !satisfied.has(key));

    if (missing.length > 0) return { ok: false, reason: `missing required field(s): ${missing.join(', ')}` };
    if (answered.size === 0 && satisfied.size === 0) {
      return { ok: false, reason: 'extraction produced no fields at all' };
    }
    return { ok: true };
  }

  private emit(
    config: ExtractTaskConfig,
    item: WorkItem,
    dossier: Dossier,
    hints: CatalogHints,
    usage: TokenUsage,
    costUsd: number,
    notes: string[],
  ): TaskResult {
    const artifacts: Artifact[] = [
      {
        channel: config.outputChannel,
        format: 'json',
        body: dossier as unknown as JsonValue,
        pathVars: this.pathVars(item),
      },
    ];

    if (config.emitCatalogHints && Object.keys(hints).length > 0) {
      artifacts.push({
        channel: config.hintsChannel,
        format: 'json',
        body: { slug: item.slug, language: item.language, ...hints } as JsonValue,
        pathVars: this.pathVars(item),
      });
    }

    if (isEmptyDossier(dossier)) notes.push('The dossier is structurally valid but carries no facts.');
    return { artifacts, usage, costUsd, notes };
  }

  private dossierOptions(context: ExecutionContext): DossierOptions {
    return {
      supportedLanguages: context.config.catalogue.supportedLanguages,
      allowUnknownTypes: context.config.catalogue.allowUnknownTypes,
      datePrecision: context.config.catalogue.datePrecision,
    };
  }

  /** A dossier is a per-language edition, so it is written beside its article. */
  private pathVars(item: WorkItem): Record<string, string> {
    return { slug: item.slug, lang: item.language, sourceLang: item.language, targetLang: item.language };
  }

  /** Only the parts of the config that change what a correct output looks like. */
  private contractOf(
    config: ExtractTaskConfig,
    plan: Plan,
    existingHash: string | undefined,
    datePrecision: string,
  ): unknown {
    return {
      plan,
      existingHash: existingHash ?? 'none',
      datePrecision,
      fields: fieldsFor({ include: config.fields, catalogHints: config.emitCatalogHints }).map((field) => field.key),
      requiredFields: [...config.requiredFields].sort(),
      readWholeDocument: config.readWholeDocument,
      harvest: config.harvest,
      promptVariables: config.promptVariables,
    };
  }
}

/** `reuse` only applies when there is something to reuse. */
function planFor(config: ExtractTaskConfig, existing: ExistingDossier | undefined): Plan {
  if (!existing) return 'create';
  return config.onExistingDossier;
}

function describePath(existing: ExistingDossier | undefined): string {
  return existing ? `${existing.path} (${existing.origin})` : 'nowhere';
}
