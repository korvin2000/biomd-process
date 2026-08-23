/**
 * What is missing from a dossier, and what it is worth asking the web about.
 *
 * The whole point of this task is that it is *conditional*: an entry whose
 * article states everything costs nothing, because the questions are computed
 * from the dossier rather than asked unconditionally. Two kinds of gap exist:
 *
 *  - **an absent field.** The article never said where the person was born, and
 *    no amount of re-reading it will change that. `extract` escalating its
 *    context strategy over a fact the document does not contain is the exact
 *    waste this task removes.
 *  - **a fact that has gone stale.** A biography written while its subject was
 *    alive says nothing about their death, and never will. Age is the only
 *    signal available for that, and it is a good one.
 */

import type { Dossier } from '../../domain/types.js';
import { datePrecisionOf, text, yearOf, type DatePrecision } from '../../domain/values.js';

/** A dossier field this task knows how to ask about. */
export type WebField = 'born' | 'died' | 'birthplace' | 'deathplace' | 'country' | 'url';

export const WEB_FIELDS: readonly WebField[] = ['born', 'died', 'birthplace', 'deathplace', 'country', 'url'];

export interface FieldQuestion {
  field: WebField;
  /** One short line for the prompt. Billed on every call — keep it terse. */
  hint: string;
  /** True when the field has a value already and we are only sharpening it. */
  refine?: boolean;
  /** The value being sharpened, so the model knows what it must stay consistent with. */
  current?: string;
}

export interface GapOptions {
  /** Fields the deployment allows this task to ask about. */
  fields: readonly WebField[];
  /**
   * Whether the entry is one person or a collective.
   *
   * A quartet has no date of birth, no birthplace and no date of death, and
   * asking a search model for them produces an answer rather than a refusal —
   * the founding year dressed up as a birthday, or a member's home town as the
   * ensemble's. So those questions are simply not asked. What a collective
   * *does* have is a country and a website, which are the two that remain.
   */
  collective?: boolean;
  /** Publish precision, so a year-only date is only a gap when days are wanted. */
  datePrecision: DatePrecision;
  /** Ask for a sharper date when one is already known to the year or month. */
  upgradePrecision: boolean;
  /**
   * Age at which an undated death becomes a question rather than an absence.
   *
   * Nothing about it is a claim that the person has died — it is the age past
   * which "the article does not mention a death" stops being evidence that
   * there was none, because the article may simply predate it.
   */
  livenessAgeYears: number;
  /** Today, injectable so the age arithmetic is testable. */
  now?: Date;
  /**
   * Values that are known but do not live in the dossier.
   *
   * `country` is the whole reason this exists: it belongs to `index.json`
   * (`INV-7` forbids it inside a dossier), so without this the task would ask
   * for it on every entry that already has one.
   */
  known?: Partial<Record<WebField, string>>;
}

export interface GapAnalysis {
  questions: FieldQuestion[];
  /**
   * True when the person is old enough that their death may have gone
   * unrecorded here. Turns the answer contract from "what is the date" into
   * "is this person alive, and if not, when did they die".
   */
  checkLiveness: boolean;
  /** Age in whole years, when a birth year is known. */
  age?: number;
}

const HINTS: Record<WebField, string> = {
  born: 'date of birth, DD.MM.YYYY',
  died: 'date of death, DD.MM.YYYY',
  birthplace: 'place of birth, as "City, Country"',
  deathplace: 'place of death, as "City, Country"',
  country: 'principal nationality as an ISO 3166-1 alpha-2 code, lowercase — not the birthplace',
  url: 'one authoritative biography page for this person',
};

/** Fields that describe one human being and make no sense for an ensemble. */
const PERSON_ONLY: ReadonlySet<WebField> = new Set<WebField>(['born', 'died', 'birthplace', 'deathplace']);

export function findGaps(dossier: Dossier, options: GapOptions): GapAnalysis {
  const allowed = new Set(
    options.collective ? options.fields.filter((field) => !PERSON_ONLY.has(field)) : options.fields,
  );
  const meta = dossier.metadata ?? {};
  const dates = (meta.dates ?? {}) as Record<string, string | undefined>;

  const valueOf = (field: WebField): string | undefined =>
    field === 'born' || field === 'died'
      ? text(dates[field])
      : (text(meta[field]) ?? text(options.known?.[field]));

  const questions: FieldQuestion[] = [];
  const age = ageOf(text(dates['born']), options.now ?? new Date());

  // A death that predates the article is the one fact a biography can be wrong
  // about by simply being old. Only asked when there is a birth year to reason
  // from, and never resolved by the model's silence — see `answer.ts`.
  const died = valueOf('died');
  const checkLiveness =
    allowed.has('died') && !died && age !== undefined && age >= options.livenessAgeYears;

  for (const field of WEB_FIELDS) {
    if (!allowed.has(field)) continue;

    const current = valueOf(field);
    if (!current) {
      // `died` is only asked about when the age says it is worth asking. For a
      // 40-year-old the absence is not a gap, it is the answer.
      if (field === 'died' && !checkLiveness) continue;
      // And a place of death is the same question wearing a different hat. It
      // used to be asked of everyone with an empty `deathplace`, which is every
      // living guitarist in the corpus — and "where did Roberto Aussel die?" is
      // a question a search model answers: `Сен-Эрблен, Франция`, confidence
      // 0.95, published into the dossier of a man who is alive. Nothing after
      // this point could have caught it, because the value is well-formed and
      // the field it fills is the field that was asked for.
      if (field === 'deathplace' && !died && !checkLiveness) continue;
      questions.push({ field, hint: HINTS[field] });
      continue;
    }

    // A date already known to the year is a fact, not a gap. It becomes a
    // question only when the deployment asked for the sharper form: the answer
    // has to agree with the year we already have, so the round trip is cheap
    // to verify and easy to reject.
    if (!options.upgradePrecision || (field !== 'born' && field !== 'died')) continue;
    const precision = datePrecisionOf(current);
    if (precision && precision !== 'day') questions.push({ field, hint: HINTS[field], refine: true, current });
  }

  return {
    questions,
    checkLiveness,
    ...(age === undefined ? {} : { age }),
  };
}

/** Whole years between a birth date of any precision and today. */
export function ageOf(born: string | undefined, now: Date): number | undefined {
  if (!born) return undefined;
  const year = yearOf(born);
  if (year === undefined) return undefined;

  // Only the year is used: a birthday later this year changes the age by one,
  // and no threshold worth setting is that sharp.
  return now.getFullYear() - year;
}
