import type { WebSearchTaskConfig } from '../../config/schema.js';
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
import { mergeDossier, orderDossier, sanitizeDossier, type DossierOptions } from '../../domain/dossier.js';
import { normalizeUrl, sharpensDate } from '../../domain/values.js';
import type { CatalogHints, Dossier } from '../../domain/types.js';
import type { Artifact } from '../../io/types.js';
import { MessageBuilder } from '../../prompts/MessageBuilder.js';
import { EMPTY_USAGE } from '../../llm/types.js';
import { PipelineError } from '../../shared/errors.js';
import { pathExists, readJsonFile } from '../../shared/fs.js';
import type { JsonValue } from '../../shared/json.js';
import { findDossierToLocalize } from '../shared/dossierSource.js';
import { parseWebAnswer, type WebAnswer, type WebValue } from './answer.js';
import { readTitle } from '../../documents/markdown/title.js';
import { languageName, resolveEnsemble } from '../../domain/vocabulary.js';
import { findGaps, type FieldQuestion, type GapAnalysis, type WebField } from './gaps.js';

/** A sourced date that disagrees with the record, recorded for a human to settle. */
export interface DateConflict {
  field: 'born' | 'died' | string;
  /** What the dossier holds now. */
  recorded: string;
  /** What the search returned. */
  found: string;
  source?: string;
  confidence: number;
}

const PIPELINE_ID = 'websearch';
/** A handful of short values, each with a URL beside it. */
const EXPECTED_OUTPUT_TOKENS = 700;

/**
 * Fills the gaps an article cannot fill, using a model that can search.
 *
 * The premise: `extract` escalating its context ladder over a fact the document
 * does not contain is pure waste — a chunked pass over the whole biography to
 * discover, again, that it never states a birthplace. This task takes over at
 * exactly that point, and it is *conditional* in three ways that keep it cheap:
 *
 *  1. **The questions come from the dossier.** An entry that already answers
 *     everything costs nothing at all: no gaps, no call, no artifact.
 *  2. **The article is not sent.** What crosses the wire is an identity card —
 *     name, known dates, instruments — and optionally the lead paragraph for
 *     telling namesakes apart. A biography of 40 000 characters costs about two
 *     hundred tokens here.
 *  3. **Only the missing keys are asked for.** The answer is a handful of short
 *     values, and everything else in the dossier is untouchable by construction:
 *     the merge fills gaps and never overwrites (`mergeDossier`).
 *
 * The liveness rule is the one question that is not about an absent fact but
 * about a *stale* one. A biography written while its subject was alive says
 * nothing about their death and never will; past `livenessAgeYears` the absence
 * of a death date stops being evidence. The answer contract is a status, not a
 * date, so "no evidence of death" can never become one.
 */
export class WebSearchPipeline implements DocumentPipeline {
  readonly id = PIPELINE_ID;
  readonly description = 'Fill missing biographical facts from the web, and re-check an undated death.';

  async plan(item: WorkItem, context: PlanContext): Promise<TaskSeed[]> {
    const config = context.config.tasks.websearch;

    return [
      {
        label: `${item.slug} → web search`,
        contract: {
          fields: [...config.fields].sort(),
          requireSource: config.requireSource,
          minConfidence: config.minConfidence,
          livenessAgeYears: config.livenessAgeYears,
          upgradePrecision: config.upgradePrecision,
          onDateConflict: config.onDateConflict,
          includeContext: config.includeContext,
          recordSources: config.recordSources,
          promptVariables: config.promptVariables,
          datePrecision: context.config.catalogue.datePrecision,
          collective: resolveEnsemble(readTitle(item.content).lines.join(' | ')).group,
        },
        promptVersion: await context.prompts.versionOf(PIPELINE_ID),
        expectedOutputs: [{ channel: config.outputChannel, pathVars: this.pathVars(item) }],
        // The declared output is the dossier `extract` writes, which therefore
        // exists before this task ever starts. Reading that as "already done"
        // meant the task ran exactly once per corpus and never again.
        mergesOutput: true,
        // The dossier this completes is the one `extract` just wrote.
        dependsOn: context.config.tasks.extract.enabled ? [{ pipeline: 'extract' }] : [],
      },
    ];
  }

  async execute(task: PlannedTask, context: ExecutionContext): Promise<TaskResult> {
    const config = context.config.tasks.websearch;
    const item = soleItem(task);
    const notes: string[] = [];

    const loaded = await findDossierToLocalize(item, context.config, context.writer);
    if (!loaded) {
      return { artifacts: [], usage: { ...EMPTY_USAGE }, costUsd: 0, notes: ['No dossier to complete; skipped.'] };
    }

    const options = this.dossierOptions(context);
    const dossier = sanitizeDossier(loaded.value, options).dossier;
    const hints = await this.readHints(item, context);

    // A trio has no birthday. Read from the title, never from the prose.
    const collective = resolveEnsemble(readTitle(item.content).lines.join(' | ')).group;
    const gaps = findGaps(dossier, {
      fields: config.fields as WebField[],
      datePrecision: options.datePrecision ?? 'day',
      upgradePrecision: config.upgradePrecision,
      livenessAgeYears: config.livenessAgeYears,
      collective,
      ...(hints.country ? { known: { country: hints.country } } : {}),
    });

    if (collective) {
      notes.push('The title names a collective, so the personal questions (born, died, places) were not asked.');
    }
    if (gaps.questions.length === 0) {
      return {
        artifacts: [],
        usage: { ...EMPTY_USAGE },
        costUsd: 0,
        notes: ['Nothing is missing that a search could supply; no request made.'],
      };
    }
    if (gaps.checkLiveness) {
      notes.push(`No date of death and an age of about ${gaps.age}; asking whether this person is still alive.`);
    }

    const answer = await this.ask(task, context, item, dossier, gaps, hints, collective);
    notes.push(...answer.notes);

    return this.apply(config, item, dossier, answer.value, gaps, options, notes, answer.usage, answer.costUsd);
  }

  /**
   * One call. No escalation ladder: the input is a short identity card, not a
   * document, so there is no cheaper slice of it to try first. Retry, fallback
   * and validation still come from the gateway.
   */
  private async ask(
    task: PlannedTask,
    context: ExecutionContext,
    item: WorkItem,
    dossier: Dossier,
    gaps: GapAnalysis,
    hints: CatalogHints,
    collective: boolean,
  ): Promise<{ value: WebAnswer; usage: typeof EMPTY_USAGE; costUsd: number; notes: string[] }> {
    const config = context.config.tasks.websearch;
    const asked = gaps.questions.map((question) => question.field);

    const prompt = await context.prompts.render(PIPELINE_ID, {
      ...config.promptVariables,
      language: item.language,
      languageName: languageName(item.language),
      fields: gaps.questions.map((question) => ({
        key: question.field,
        hint: question.hint,
        ...(question.refine ? { refine: true, current: question.current } : {}),
      })),
      checkLiveness: gaps.checkLiveness,
      age: gaps.age,
      collective,
      requireSource: config.requireSource,
    });

    // The person, as facts rather than prose. Volatile, so it lands after every
    // stable instruction and the prompt-cache prefix survives the corpus.
    const messages = MessageBuilder.build(prompt, [
      {
        title: collective ? 'Ensemble' : 'Person',
        body: this.identityCard(item, dossier, config),
        volatile: true,
        fence: 'yaml',
      },
    ]);

    let parsed: WebAnswer | undefined;
    const result = await context.llm.complete(
      {
        messages,
        responseFormat: { type: 'json_object' },
        correlationId: task.taskId,
        webSearch: { required: true, searchContextSize: 'medium' },
        promptCache: { key: `${PIPELINE_ID}:${prompt.version}`, mode: 'explicit' },
      },
      {
        pipeline: task.pipeline,
        pool: config.pool,
        variant: task.variant,
        requiredCapabilities: config.requireWebSearchCapability ? ['web_search'] : [],
        estimatedInputTokens: context.estimator.estimateMessages(messages),
        expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
        signal: context.signal,
        validate: (response) => {
          if (!response.webSearch?.performed) {
            parsed = undefined;
            return {
              ok: false,
              retryable: false,
              reason: 'provider returned no completed web_search_call or citation evidence',
            };
          }
          const verifiedSources = new Set(
            response.webSearch.sources
              .map((source) => normalizeUrl(source.url))
              .filter((source): source is string => source !== undefined),
          );
          parsed = parseWebAnswer(response.text, {
            asked,
            datePrecision: context.config.catalogue.datePrecision,
            requireSource: config.requireSource,
            minConfidence: config.minConfidence,
            current: currentValues(gaps.questions),
            // The dossier being completed is this item's own edition, so a
            // prose value belongs in its language.
            language: item.language,
            verifiedSources,
            requireVerifiedSource: config.requireSource,
            ...(hints.country ? { country: hints.country } : {}),
          });
          if (!parsed) return { ok: false, reason: 'the answer was not a JSON object' };

          // An answer that found nothing is a *valid* answer: the web does not
          // owe us a birthplace. Retrying it would buy the same silence twice.
          return { ok: true };
        },
      },
    );

    if (!parsed) {
      throw new PipelineError('Web search response passed validation but produced no answer', {
        details: { taskId: task.taskId },
      });
    }
    return {
      value: parsed,
      usage: result.totalUsage,
      costUsd: result.totalCostUsd,
      notes: parsed.rejected.map((reason) => `Refused a web answer — ${reason}.`),
    };
  }

  /**
   * The person as a short fact table.
   *
   * Everything here is for **disambiguation**: a name alone finds three people,
   * and an instrument plus a birth year finds one. The lead paragraph is
   * optional and capped, because it is the only part that grows with the
   * article.
   */
  private identityCard(item: WorkItem, dossier: Dossier, config: WebSearchTaskConfig): string {
    const meta = dossier.metadata ?? {};
    const dates = meta.dates ?? {};
    const lines: string[] = [];

    const put = (key: string, value: unknown): void => {
      if (typeof value === 'string' && value.trim()) lines.push(`${key}: ${value.trim()}`);
    };

    put('name', [meta.forename, meta.surname].filter(Boolean).join(' ') || item.slug.replace(/-/g, ' '));
    put('birthname', meta.birthname);
    put('born', dates.born);
    put('died', dates.died);
    put('birthplace', meta.birthplace);
    put('instruments', meta.instruments);
    put('jobs', meta.jobs);
    put('bands', meta.bands);
    put('activeFrom', dates.activeFrom);

    if (config.includeContext === 'lead') {
      const lead = leadParagraph(item.content, config.contextChars);
      if (lead) lines.push(`about: ${lead}`);
    }
    return lines.join('\n');
  }

  /** Merges what survived into the dossier, and routes `country` to the index. */
  private apply(
    config: WebSearchTaskConfig,
    item: WorkItem,
    dossier: Dossier,
    answer: WebAnswer,
    gaps: GapAnalysis,
    options: DossierOptions,
    notes: string[],
    usage: typeof EMPTY_USAGE,
    costUsd: number,
  ): TaskResult {
    const live = this.filterLiveness(answer, gaps, notes);
    const settled = this.settleConflicts(config, dossier, live, notes);
    const accepted = settled.values;

    if (accepted.length === 0 && settled.conflicts.length === 0) {
      notes.push(
        'The search returned nothing usable; the dossier is unchanged. ' +
          `${gaps.questions.length} question(s) were asked and every answer was missing or refused.`,
      );
      return { artifacts: [], usage, costUsd, notes };
    }

    const incoming: Dossier = { metadata: {}, media: { photos: [], music: [] }, documents: [] };
    const hints: CatalogHints = {};
    const dates: Record<string, string> = {};
    const sources: WebValue[] = [];

    for (const value of accepted) {
      if (value.source) sources.push(value);

      switch (value.field) {
        case 'born':
        case 'died':
          dates[value.field] = value.value;
          break;
        case 'country':
          hints.country = value.value;
          break;
        default:
          (incoming.metadata as Record<string, unknown>)[value.field] = value.value;
      }
    }
    if (Object.keys(dates).length > 0) incoming.metadata.dates = dates;

    // `url` is the entry's single best source; a search result only fills it
    // when the article named nothing, which `mergeDossier` already enforces.
    if (config.recordSources === 'url' && !incoming.metadata.url) {
      const best = sources[0]?.source;
      if (best) incoming.metadata.url = best;
    }

    const merged = mergeDossier(settled.dossier, incoming, options);
    notes.push(...merged.notes);
    for (const value of accepted) {
      notes.push(
        `${value.field} = "${value.value}" from the web` +
          (value.source ? ` (${value.source})` : '') +
          (value.confidence < 1 ? `, confidence ${value.confidence.toFixed(2)}` : '') +
          '.',
      );
    }
    if (merged.filled.length === 0 && settled.conflicts.length === 0) {
      notes.push('Everything found was already on record; nothing changed.');
    }

    const artifacts: Artifact[] = [];
    if (accepted.length > 0) {
      artifacts.push({
        channel: config.outputChannel,
        format: 'json',
        body: orderDossier(merged.dossier) as unknown as JsonValue,
        pathVars: this.pathVars(item),
        // This *is* the dossier plus what the search added. Refusing to replace
        // the file `extract` wrote a moment ago would discard the whole task.
        overwrite: true,
      });
    }

    // The hint file carries two different things and is written for either: a
    // `country`, which belongs to `index.json`, and an unresolved date conflict,
    // which belongs to whoever has to settle it. A conflict recorded nowhere is
    // the failure this task was accused of, so it gets a file of its own.
    if (hints.country || settled.conflicts.length > 0) {
      artifacts.push({
        channel: config.hintsChannel,
        format: 'json',
        body: {
          slug: item.slug,
          language: item.language,
          ...hints,
          ...(settled.conflicts.length > 0 ? { conflicts: settled.conflicts } : {}),
        } as unknown as JsonValue,
        pathVars: this.pathVars(item),
        overwrite: true,
      });
    }

    return { artifacts, usage, costUsd, notes };
  }

  /**
   * What to do about an answer that disagrees with the record.
   *
   * `upgradePrecision` asks for the sharper form of a date the article stated
   * loosely, and an article that says "born about 1950" is sometimes simply
   * wrong about the year — so the sharper answer arrives *contradicting* the
   * blunter one rather than refining it, and the old rule dropped it without
   * saying so. Three things can happen now, and all three are audible:
   *
   *  - **`prefer-precise`** — a strictly more precise sourced date wins. The
   *    recorded value is removed so `mergeDossier` fills the gap in its normal
   *    gap-filling way; nothing here reaches into the merge's rules.
   *  - **`report`** — the record stands and the candidate is written to the
   *    hint file with its source, for a human to settle.
   *  - **`ignore`** — dropped, with a note. Never silence.
   *
   * A conflict of *equal* precision is never an upgrade: two full dates that
   * disagree are two claims about a person, and picking one by provenance alone
   * would publish a coin toss.
   */
  private settleConflicts(
    config: WebSearchTaskConfig,
    dossier: Dossier,
    values: readonly WebValue[],
    notes: string[],
  ): { dossier: Dossier; values: WebValue[]; conflicts: DateConflict[] } {
    if (!values.some((value) => value.conflictsWith)) return { dossier, values: [...values], conflicts: [] };

    const next = structuredClone(dossier);
    const kept: WebValue[] = [];
    const conflicts: DateConflict[] = [];

    for (const value of values) {
      const current = value.conflictsWith;
      if (!current) {
        kept.push(value);
        continue;
      }

      const sharper = sharpensDate(current, value.value);
      const describe =
        `${value.field}: the web says "${value.value}"` +
        (value.source ? ` (${value.source})` : '') +
        ` and the record says "${current}"`;

      if (config.onDateConflict === 'prefer-precise' && sharper) {
        // Clearing the recorded value is what turns an overwrite into the
        // ordinary gap fill `mergeDossier` already performs and reports.
        const dates = next.metadata?.dates as Record<string, string> | undefined;
        if (dates) delete dates[value.field];
        kept.push(value);
        notes.push(`${describe}; the sourced date is more precise, so it replaces the recorded one.`);
        continue;
      }

      if (config.onDateConflict === 'ignore') {
        notes.push(`${describe}; onDateConflict is "ignore", so the web answer was dropped.`);
        continue;
      }

      conflicts.push({
        field: value.field,
        recorded: current,
        found: value.value,
        confidence: value.confidence,
        ...(value.source ? { source: value.source } : {}),
      });
      notes.push(
        `${describe}; ` +
          (sharper
            ? 'recorded as a conflict for review rather than published.'
            : 'both are equally precise, so neither can be called a correction — recorded as a conflict for review.'),
      );
    }

    return { dossier: next, values: kept, conflicts };
  }

  /**
   * The death gate.
   *
   * A date **or a place** of death is only written when the answer *states* the
   * person has died. `alive` and `unknown` both mean neither, and they mean it
   * for different reasons worth recording separately.
   *
   * `deathplace` belongs here as much as `died` does: it is the same claim in
   * another field, and a model that would not assert a date of death for a
   * living guitarist will happily name the town.
   */
  private filterLiveness(answer: WebAnswer, gaps: GapAnalysis, notes: string[]): WebValue[] {
    if (!gaps.checkLiveness) return answer.values;
    const isDeath = (value: WebValue): boolean => value.field === 'died' || value.field === 'deathplace';

    if (answer.status === 'alive') {
      notes.push('The search reports this person is still living; no date or place of death recorded.');
      return answer.values.filter((value) => !isDeath(value));
    }
    if (answer.status !== 'dead') {
      const claimed = answer.values.filter(isDeath);
      if (claimed.length > 0) {
        notes.push(
          `Ignored ${claimed.map((value) => `${value.field} ("${value.value}")`).join(' and ')} — the answer ` +
            'never said this person has died, and silence about a living person must not become a death.',
        );
      }
      return answer.values.filter((value) => !isDeath(value));
    }
    return answer.values;
  }

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

  private dossierOptions(context: ExecutionContext): DossierOptions {
    return {
      supportedLanguages: context.config.catalogue.supportedLanguages,
      allowUnknownTypes: context.config.catalogue.allowUnknownTypes,
      datePrecision: context.config.catalogue.datePrecision,
    };
  }

  private pathVars(item: WorkItem): Record<string, string> {
    return { slug: item.slug, lang: item.language, sourceLang: item.language, targetLang: item.language };
  }
}

/**
 * What is already on record for the fields being asked about.
 *
 * Only the refinements carry a `current` value — those are the only questions
 * whose answer has something to contradict.
 */
function currentValues(questions: readonly FieldQuestion[]): Partial<Record<WebField, string>> {
  const current: Partial<Record<WebField, string>> = {};
  for (const question of questions) {
    if (question.current) current[question.field] = question.current;
  }
  return current;
}

/**
 * The article's opening prose, with the Markdown scaffolding removed.
 *
 * Headings, `:::` containers, tables and images are dropped rather than
 * summarized: what is wanted is one sentence that distinguishes this person
 * from a namesake, and everything else is tokens.
 */
export function leadParagraph(content: string, maxChars: number): string | undefined {
  if (maxChars <= 0) return undefined;

  const cleaned = content
    .replace(/^---[\s\S]*?\n---\s*/, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:#|:::|\||>|\d+[.)]\s|[-*+]\s|```|!\[|\w+:\s)/.test(line))
    .join('\n');

  const paragraph = cleaned
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part.length > 40);
  if (!paragraph) return undefined;

  return paragraph.length > maxChars ? `${paragraph.slice(0, maxChars).trimEnd()}…` : paragraph;
}
