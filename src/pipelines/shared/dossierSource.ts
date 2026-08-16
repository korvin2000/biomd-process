import { dirname, join } from 'node:path';

import type { AppConfig } from '../../config/schema.js';
import type { WorkItem } from '../../core/types.js';
import type { ArtifactWriter } from '../../io/types.js';
import { pathExists, readJsonFile, readTextFile } from '../../shared/fs.js';
import { shortHash } from '../../shared/hash.js';

/**
 * Where an entry's dossier already is, if it is anywhere.
 *
 * The rule the tool is built around: **an existing `<slug>.bio.json` is not
 * re-derived**. A dossier that ships beside its article is authored data — it
 * may have been curated, corrected, or written by hand for exactly the fields a
 * model gets wrong — and regenerating it would be both expensive and a
 * regression. Two locations count, in this order:
 *
 *  1. beside the article in the corpus (`ru/x.bio.md` → `ru/x.bio.json`), which
 *     is how an existing catalogue is laid out;
 *  2. the output path a previous run wrote, which is what makes a second run
 *     over a grown corpus incremental rather than a rebuild.
 */

export type DossierOrigin = 'source' | 'output';

export interface ExistingDossier {
  path: string;
  origin: DossierOrigin;
  /** Content hash, so editing the file invalidates the tasks derived from it. */
  hash: string;
  value: unknown;
}

/** The dossier filename that pairs with an article: `.bio.md` → `.bio.json`. */
export function dossierSuffixOf(config: AppConfig): string {
  const suffix = config.input.slugSuffix;
  return suffix.toLowerCase().endsWith('.md') ? `${suffix.slice(0, -3)}.json` : `${suffix}.json`;
}

/** The path the corpus would carry a dossier at, whether or not it exists. */
export function sourceDossierPath(item: WorkItem, config: AppConfig): string {
  return join(dirname(item.absolutePath), `${item.slug}${dossierSuffixOf(config)}`);
}

/** The path this tool writes the source-language dossier to. */
export function outputDossierPath(item: WorkItem, config: AppConfig, writer: ArtifactWriter): string {
  return writer.resolvePath({
    channel: config.tasks.extract.outputChannel,
    format: 'json',
    body: '',
    pathVars: {
      slug: item.slug,
      lang: item.language,
      sourceLang: item.language,
      targetLang: item.language,
    },
  });
}

/**
 * The **authored** dossier: the one shipped beside the article, and nothing else.
 *
 * This is what `tasks.extract.onExistingDossier` acts on, and the exclusion of
 * the output path is deliberate rather than an oversight. Extraction's own
 * product must not be an input to extraction's plan: a run would see the file it
 * wrote last time, decide the entry is "already extracted", change the task's
 * fingerprint, and re-plan on every run forever. Whether the output is already
 * up to date is a question `--resume` and `run.skipExistingOutputs` answer, and
 * they answer it without a feedback loop.
 */
export async function findSourceDossier(item: WorkItem, config: AppConfig): Promise<ExistingDossier | undefined> {
  return read(sourceDossierPath(item, config), 'source');
}

/**
 * The dossier to localize: this run's extraction output when there is one,
 * otherwise the authored file beside the article.
 *
 * Output first, because it is the sanitized, migrated and completed version of
 * whatever the source held.
 */
export async function findDossierToLocalize(
  item: WorkItem,
  config: AppConfig,
  writer: ArtifactWriter,
): Promise<ExistingDossier | undefined> {
  return (
    (await read(outputDossierPath(item, config, writer), 'output')) ??
    (await read(sourceDossierPath(item, config), 'source'))
  );
}

/**
 * Never throws: an unreadable or unparseable file is reported as "no dossier",
 * because the alternative — failing the whole entry — turns one corrupt file
 * into a missing catalogue row.
 */
async function read(path: string, origin: DossierOrigin): Promise<ExistingDossier | undefined> {
  if (!(await pathExists(path))) return undefined;

  const value = await readJsonFile<unknown>(path).catch(() => undefined);
  if (value === undefined) return undefined;

  const raw = await readTextFile(path).catch(() => '');
  return { path, origin, hash: shortHash(raw, 12), value };
}
