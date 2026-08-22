import type { AppConfig, ExtractTaskConfig } from '../../config/schema.js';
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
import { readTitle } from '../../documents/markdown/title.js';
import {
  emptyDossier,
  isEmptyDossier,
  mergeDossier,
  presentFields,
  sanitizeDossier,
  type DossierOptions,
} from '../../domain/dossier.js';
import type { CatalogHints, Dossier } from '../../domain/types.js';
import { mergeCsvLists, normalizeCsvList, text } from '../../domain/values.js';
import { languageName, resolveEnsemble, type EnsembleResolution } from '../../domain/vocabulary.js';
import type { Artifact } from '../../io/types.js';
import { EMPTY_USAGE, type TokenUsage } from '../../llm/types.js';
import type { NameRosterStore } from '../../roster/NameRosterStore.js';
import type { RosterEntry } from '../../roster/types.js';
import type { JsonValue } from '../../shared/json.js';
import { findSourceDossier, type ExistingDossier } from '../shared/dossierSource.js';
import { rosterEntryFor } from '../shared/roster.js';
import { runWithEscalation, type Parsed } from '../shared/escalation.js';
import {
  answeredKeys,
  buildDossier,
  fieldsFor,
  mergeFlat,
  normalizeFlat,
  parseFlatAnswer,
  PERSON_ONLY_FIELDS,
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

  constructor(private readonly roster: NameRosterStore) {}

  async plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.extract;
    const existing = await findSourceDossier(item, context.config);
    const plan = planFor(config, existing);
    // The roster is an input to the answer, so it belongs in the fingerprint:
    // editing a name in it must re-extract that entry and no other.
    const roster = await rosterEntryFor(item, context.config, this.roster);

    return [
      {
        label: `${item.slug} → metadata (${item.language})${plan === 'reuse' ? ' [reused]' : ''}`,
        contract: {
          ...(this.contractOf(config, plan, existing?.hash, context.config.catalogue.datePrecision) as object),
          roster: roster ? { name: roster.displayName, aliases: roster.aliases.length } : 'none',
        },
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
    const local = await this.localFacts(item, context);

    // An existing file is read through the same sanitizer as a fresh answer, so
    // a version 1 document is migrated in passing: its `title`/`type`/`gender`/
    // `country`/`img` become catalogue hints instead of being deleted.
    const base = existing && plan !== 'rebuild' ? sanitizeDossier(existing.value, options) : undefined;
    if (base) {
      notes.push(`Reusing the dossier at ${describePath(existing)}.`);
      notes.push(...base.notes);
    }

    if (plan === 'reuse' && base) {
      return this.emit(config, item, base.dossier, base.hints, { ...EMPTY_USAGE }, 0, notes, local, context.config);
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
        local,
        context.config,
      );
    }

    // A field the roster answers is a field a partial extraction may leave out:
    // the answer is already on this side, so rejecting the response over it
    // would buy a retry that changes nothing.
    const satisfied = base ? this.satisfiedKeys(base.dossier) : new Set<string>();
    for (const key of Object.keys(local.metadata)) satisfied.add(key);
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
        languageName: languageName(item.language),
        fields: fields.map((field) => ({ key: field.key, hint: field.hint })),
        requiredFields: config.requiredFields.map(toCardKey).filter((key) => fields.some((f) => f.key === key)),
        partial: attempt.partial || segment.total > 1,
        partLabel: segment.label,
      }),
      section: (segment) => ({ title: 'Article', body: segment.text, volatile: true, fence: 'markdown' }),
      parse: (text) => this.parse(text, fields, options),
      merge: (parts) => mergeFlat(parts, fields),
      accept: (record) => this.accept(record, config, satisfied, local),
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
      return this.emit(
        config,
        item,
        built.dossier,
        built.hints,
        outcome.usage,
        outcome.costUsd,
        notes,
        local,
        context.config,
      );
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
      local,
      context.config,
    );
  }

  /**
   * What this run knows about the entry **without** reading a model's answer:
   * the roster's name components, and whether the title names a collective.
   *
   * Both are corroboration, never authority. The roster fills a gap the article
   * left and is reported when it contradicts one it did not; the collective test
   * decides one machine token (`gender`) that the format defines by fiat —
   * `mixed` *means* "a collective entry" (`external/02`), so a title that says
   * `квартет` settles it more reliably than a model reading between the lines.
   */
  private async localFacts(item: WorkItem, context: ExecutionContext | PlanContext): Promise<LocalFacts> {
    const entry = await rosterEntryFor(item, context.config, this.roster);
    const title = readTitle(item.content);
    // Titles, the roster name and the slug — never the prose, where "played in
    // a duo with Meleshko" would file a soloist as a pair.
    const named = [...title.lines, entry?.fullName ?? '', item.slug.replace(/[_-]+/g, ' ')];
    const ensemble = resolveEnsemble(named.filter(Boolean).join(' | '));

    const metadata: Record<string, string> = {};
    if (entry && context.config.roster.fillMetadata) {
      if (entry.personName) {
        if (entry.surname) metadata['surname'] = entry.surname;
        if (entry.forename) metadata['forename'] = entry.forename;
      } else if (entry.ensemble.group && entry.fullName) {
        // A collective has no family name; its own title is the name the
        // catalogue displays, and `surname` is where a dossier keeps it.
        metadata['surname'] = entry.fullName;
      }
    }
    return { entry, metadata, ensemble, title: title.title };
  }

  /**
   * The roster's contribution, applied the way every other second source is:
   * gaps only.
   *
   * A disagreement is not resolved here. The article is what the entry is about
   * and the roster is a list maintained by hand elsewhere; when they differ the
   * article wins, and the run log says so if it was asked to.
   */
  private applyRoster(dossier: Dossier, local: LocalFacts, appConfig: AppConfig, notes: string[]): Dossier {
    if (Object.keys(local.metadata).length === 0) return dossier;

    const options: DossierOptions = {
      supportedLanguages: appConfig.catalogue.supportedLanguages,
      allowUnknownTypes: appConfig.catalogue.allowUnknownTypes,
      datePrecision: appConfig.catalogue.datePrecision,
    };

    // A mononym is the case this guards: the article gives `forename: Армик`
    // and no family name, the roster's only column is `surname: Армик`, and
    // filling the gap publishes "Армик Армик" as the display name. One name
    // twice is not two names.
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(local.metadata)) {
      const other = key === 'surname' ? 'forename' : 'surname';
      // Exact, not the loose `agree` the conflict report uses: `Виктор` is
      // *contained* in `Викторов` and they are two different name parts.
      if (sameName(text(dossier.metadata?.[other]) ?? '', value)) {
        notes.push(`The roster's ${key} "${value}" repeats the ${other} already on record; left as it was.`);
        continue;
      }
      metadata[key] = value;
    }
    if (Object.keys(metadata).length === 0) return dossier;

    if (appConfig.roster.reportConflicts) {
      for (const [key, value] of Object.entries(metadata)) {
        const current = dossier.metadata?.[key];
        if (typeof current !== 'string' || !current) continue;
        if (agree(current, value)) continue;
        notes.push(`The roster spells ${key} "${value}"; the article gave "${current}". Kept the article's.`);
      }
    }

    const merged = mergeDossier(dossier, { metadata }, options);
    if (merged.filled.length > 0) {
      notes.push(`The name roster supplied ${merged.filled.join(', ')}; the article did not state as much.`);
    }
    return merged.dossier;
  }

  /** The gallery, read out of the article rather than asked for. */
  private harvest(config: ExtractTaskConfig, item: WorkItem, notes: string[]): HarvestResult {
    if (!config.harvest.photos && !config.harvest.music) {
      return { photos: [], music: [], imageTargets: [], notes: [] };
    }

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
    local: LocalFacts,
  ): { ok: true } | { ok: false; reason: string } {
    const answered = answeredKeys(record);
    // A collective has no given name to be missing. Requiring one rejects the
    // answer, retries it, escalates it to a paid model and finally fails the
    // document — over a field an ensemble cannot have.
    const required = local.ensemble.group
      ? config.requiredFields.filter((field) => !PERSON_ONLY_FIELDS.includes(toCardKey(field)))
      : config.requiredFields;

    const missing = required
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
    local: LocalFacts,
    appConfig: AppConfig,
  ): TaskResult {
    const complete = this.applyRoster(this.forCollective(dossier, local, notes), local, appConfig, notes);
    const classified = this.classify(hints, local, notes);

    const artifacts: Artifact[] = [
      {
        channel: config.outputChannel,
        format: 'json',
        body: complete as unknown as JsonValue,
        pathVars: this.pathVars(item),
      },
    ];

    if (config.emitCatalogHints && Object.keys(classified).length > 0) {
      artifacts.push({
        channel: config.hintsChannel,
        format: 'json',
        body: { slug: item.slug, language: item.language, ...classified } as JsonValue,
        pathVars: this.pathVars(item),
      });
    }

    if (isEmptyDossier(complete)) notes.push('The dossier is structurally valid but carries no facts.');
    return { artifacts, usage, costUsd, notes };
  }

  /**
   * A collective has no given name, so whatever is in `forename` is one of
   * three other things.
   *
   * The field matters because it is not decoration: `displayNamesOf` renders
   * `forename + surname`, so `"Хеленус де Рижке, Ольга Франсен, Эстер
   * Стинберген"` in `forename` publishes that as the beginning of the trio's
   * display name in every language index, and
   * `"Классический ансамбль гитаристов"` publishes the ensemble's name twice.
   *
   * What actually turns up there, in order of how the value is treated:
   *
   *  1. **the collective's name**, when the model had nowhere else to put it —
   *     promoted to `surname`, which is where the format keeps it;
   *  2. **the collective's name again**, beside a `surname` that already says
   *     it — dropped;
   *  3. **the members** — moved to `relatives`, which `external/05` defines as
   *     "related persons" and the reader renders as exactly that comma-joined
   *     line. A real fact in the wrong member is worth moving, not discarding.
   */
  private forCollective(dossier: Dossier, local: LocalFacts, notes: string[]): Dossier {
    if (!local.ensemble.group) return dossier;

    const forename = text(dossier.metadata?.forename);
    if (!forename) return dossier;

    const metadata = { ...dossier.metadata };
    delete metadata['forename'];
    const surname = text(metadata['surname']);
    const subject = local.title || 'this entry';

    // A comma is what separates the two: an ensemble's name is one name, and
    // its members are a list. `Классический ансамбль гитаристов` is the first,
    // `Козлов, Ковба, Мухатдинов` is the second.
    if (!surname && !forename.includes(',')) {
      metadata['surname'] = forename;
      notes.push(`"${subject}" is a collective, so "${forename}" is its name rather than a given name.`);
      return { ...dossier, metadata };
    }
    if (surname && agree(surname, forename)) {
      notes.push(`"${subject}" is a collective: dropped forename "${forename}", which repeats its name.`);
      return { ...dossier, metadata };
    }

    const existing = text(metadata['relatives']);
    metadata['relatives'] = existing ? mergeCsvLists(existing, forename) : normalizeCsvList(forename);
    notes.push(
      `"${subject}" is a collective, so it has no given name: moved "${forename}" from forename to ` +
        'relatives, where the format puts related persons.',
    );
    return { ...dossier, metadata };
  }

  /**
   * The one classification this pipeline decides rather than reads.
   *
   * `gender: mixed` is defined by `external/02` as "a collective entry", so a
   * title that says `квартет` answers it outright — and a model asked to
   * choose between `m`, `f` and `mixed` for an ensemble of four men will answer
   * `m` often enough to matter. Everything else the model noticed passes
   * through untouched.
   */
  private classify(hints: CatalogHints, local: LocalFacts, notes: string[]): CatalogHints {
    if (!local.ensemble.group || hints.gender === 'mixed') return hints;

    notes.push(
      `"${local.title || local.entry?.fullName || 'this entry'}" names a collective ` +
        `("${local.ensemble.word}"), so gender is mixed${hints.gender ? ` rather than ${hints.gender}` : ''}.`,
    );
    return { ...hints, gender: 'mixed' };
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

/** Everything known about the entry before a model is asked anything. */
interface LocalFacts {
  entry?: RosterEntry;
  /** `metadata` members the roster can supply, already normalized. */
  metadata: Record<string, string>;
  ensemble: EnsembleResolution;
  /** The article's own title, for the diagnostic note. */
  title: string;
}

/** The same name written twice, ignoring case, diacritics and punctuation. */
function sameName(left: string, right: string): boolean {
  return Boolean(left) && Boolean(right) && foldName(left) === foldName(right);
}

/** Two spellings of the same name, one possibly abbreviated — for the conflict report. */
function agree(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = foldName(left);
  const b = foldName(right);
  return a === b || a.includes(b) || b.includes(a);
}

function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** `reuse` only applies when there is something to reuse. */
function planFor(config: ExtractTaskConfig, existing: ExistingDossier | undefined): Plan {
  if (!existing) return 'create';
  return config.onExistingDossier;
}

function describePath(existing: ExistingDossier | undefined): string {
  return existing ? `${existing.path} (${existing.origin})` : 'nowhere';
}
