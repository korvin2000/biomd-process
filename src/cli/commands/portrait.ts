import { Command } from 'commander';
import pc from 'picocolors';

import { createApp } from '../../app/container.js';
import { loadConfig } from '../../config/loader.js';
import { sanitizeDossier } from '../../domain/dossier.js';
import { buildQuery } from '../../images/query.js';
import { selectPortrait } from '../../images/select.js';
import { describeSubject, detectSubject, SOLO_SUBJECT, type SubjectShape } from '../../images/subject.js';
import { rosterEntryFor } from '../../pipelines/shared/roster.js';
import { assetPath } from '../../pipelines/portrait/PortraitPipeline.js';
import { pathExists, readJsonFile } from '../../shared/fs.js';
import { renderTable, truncate } from '../ui/format.js';
import { heading } from '../ui/report.js';

/**
 * `biomd portrait <slug or name>` — ask the matcher a question and see its
 * whole reasoning.
 *
 * The thresholds in `tasks.portrait` are the kind of setting nobody can choose
 * correctly in the abstract; they are chosen by looking at what the archive
 * actually returns for a dozen real people. This command is that loop, and it
 * spends nothing: no model, no network.
 */
export function createPortraitCommand(): Command {
  return new Command('portrait')
    .description('Search the image index for an entry portrait and explain the ranking')
    .argument('<who...>', 'a slug (`andres-segovia`), or a name in any script')
    .option('-c, --config <file>', 'path to the config file')
    .option('--top <n>', 'how many candidates to show', '10')
    .option('--min-identity <n>', 'override tasks.portrait.minIdentity')
    .option('--all', 'show candidates the visual filters rejected, too')
    .option('--faces <n>', 'expect a collective of n people (0 = a collective of unknown size)')
    .option('--solo', 'force one-person scoring, whatever the name says')
    .option('--image <path...>', 'treat these index paths as images the article embeds')
    .option('--json', 'emit the full selection as JSON')
    .action(async (who: string[], options: Options) => {
      const loaded = await loadConfig({ file: options.config });
      const app = createApp(loaded, { dryRun: true });
      const config = loaded.config.tasks.portrait;

      const subject = who.join(' ').trim();
      const slug = toSlug(subject);
      const index = await app.images.load(config.indexFile);
      const roster = await rosterEntryFor({ slug }, loaded.config, app.roster);

      const shape = subjectShape(subject, slug, roster?.fullName, options);
      const query = buildQuery({
        slug,
        ...(await readDossier(app, slug, loaded.config.catalogue.supportedLanguages)),
        ...(isLatin(subject) ? { latinTitle: subject } : { extraNames: [subject] }),
        ...(roster ? { extraNames: [subject, roster.fullName, roster.displayName, ...roster.aliases] } : {}),
        ...(options.image?.length ? { articleImages: options.image } : {}),
      });

      const selection = selectPortrait(index, query, {
        minIdentity: options.minIdentity ? Number(options.minIdentity) : config.minIdentity,
        maxTier: options.all ? 4 : config.maxTier,
        minPixels: config.minPixels,
        excludeReleaseCovers: config.excludeReleaseCovers,
        keep: Number.parseInt(options.top ?? '10', 10) || 10,
        subject: shape,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify({ slug, query, selection }, null, 2)}\n`);
        return;
      }

      heading(`Portrait · ${subject}`);
      process.stdout.write(
        `${pc.dim('index')}    ${index.source} (${index.records.length} images)\n` +
          `${pc.dim('surname')}  ${query.surnames.join(', ') || pc.dim('—')}\n` +
          `${pc.dim('forename')} ${query.forenames.join(', ') || pc.dim('—')}\n\n`,
      );

      if (selection.chosen) {
        const chosen = selection.chosen;
        process.stdout.write(
          `${pc.green('chosen')}   ${chosen.record.relPath}\n` +
            `${pc.dim('img')}      ${assetPath(config.assetPrefix, chosen.record.relPath) ?? pc.dim('—')}\n` +
            `${pc.dim('because')}  ${chosen.identity.reasons.join('; ')}\n\n`,
        );
      } else {
        process.stdout.write(`${pc.yellow('no portrait')} — ${selection.declined ?? 'no candidate'}\n\n`);
      }

      if (selection.candidates.length === 0) {
        process.stdout.write(pc.dim('Nothing in the index matches this name.\n'));
        return;
      }

      process.stdout.write(
        `${renderTable(selection.candidates, [
          { header: 'ID', value: (candidate) => candidate.identity.score.toFixed(2), align: 'right' },
          { header: 'TIER', value: (candidate) => String(candidate.suitability.tier), align: 'right' },
          { header: 'AVATAR', value: (candidate) => candidate.suitability.score.toFixed(2), align: 'right' },
          { header: 'CLASS', value: (candidate) => candidate.record.ai.class },
          { header: 'FACES', value: (candidate) => String(candidate.record.ai.faceCount), align: 'right' },
          { header: 'COVER', value: (candidate) => candidate.record.ai.faceCoverage.toFixed(2), align: 'right' },
          { header: 'SIZE', value: (candidate) => `${candidate.record.width}×${candidate.record.height}` },
          { header: 'PATH', value: (candidate) => truncate(candidate.record.relPath, 46) },
          {
            header: 'NOTE',
            value: (candidate) =>
              candidate.suitability.excluded
                ? pc.red(candidate.suitability.excluded)
                : pc.dim(truncate(candidate.identity.reasons.slice(1).join('; ') || candidate.identity.kind, 40)),
          },
        ])}\n`,
      );
    });
}

interface Options {
  config?: string;
  top?: string;
  minIdentity?: string;
  all?: boolean;
  json?: boolean;
  faces?: string;
  solo?: boolean;
  image?: string[];
}

/**
 * What the matcher should expect to see in the frame.
 *
 * The flags come first because this command exists to answer "why did it pick
 * that one" — being able to force the expectation is how a wrong answer gets
 * diagnosed rather than argued with.
 */
function subjectShape(subject: string, slug: string, rosterName: string | undefined, options: Options): SubjectShape {
  if (options.solo) return SOLO_SUBJECT;

  if (options.faces !== undefined) {
    const size = Number.parseInt(options.faces, 10);
    return Number.isFinite(size) && size > 0
      ? { kind: 'group', size, evidence: `--faces ${size}` }
      : { kind: 'group', evidence: '--faces 0' };
  }
  return detectSubject({ titles: [subject], names: rosterName ? [rosterName] : [], slug });
}

/** A dossier already on disk sharpens the query; its absence is normal. */
async function readDossier(
  app: ReturnType<typeof createApp>,
  slug: string,
  supportedLanguages: readonly string[],
): Promise<{ dossier?: ReturnType<typeof sanitizeDossier>['dossier'] }> {
  for (const lang of supportedLanguages) {
    const file = app.writer.resolvePath({
      channel: app.config.tasks.extract.outputChannel,
      format: 'json',
      body: '',
      pathVars: { slug, lang, sourceLang: lang, targetLang: lang },
    });
    if (!(await pathExists(file))) continue;

    const value = await readJsonFile<unknown>(file).catch(() => undefined);
    if (value === undefined) continue;
    return { dossier: sanitizeDossier(value, { supportedLanguages }).dossier };
  }
  return {};
}

/** `"Андрес Сеговия"` → `andres-segoviya`; a slug is left as it is. */
function toSlug(subject: string): string {
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(subject)) return subject;
  return subject.trim().toLowerCase().replace(/\s+/g, '-');
}

function isLatin(value: string): boolean {
  return !/\p{Script=Cyrillic}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Hangul}/u.test(value);
}
