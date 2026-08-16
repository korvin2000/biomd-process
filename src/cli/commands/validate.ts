import { Command } from 'commander';
import pc from 'picocolors';
import { resolve } from 'node:path';

import { loadConfig } from '../../config/loader.js';
import { validateCatalogue, type Finding } from '../../domain/validate.js';
import { readCatalogue } from '../../io/CatalogueReader.js';
import { heading } from '../ui/report.js';
import { renderTable, symbols, truncate } from '../ui/format.js';

/**
 * `biomd validate` — the pre-publication pass.
 *
 * Almost every way this format breaks is silent at runtime: a renumbered id
 * detaches localized names with no error, a duplicate slug makes an entry
 * unreachable while its files sit on disk, a declared edition with no file looks
 * available until a reader clicks it. None of that is visible in a diff, and
 * none of it is caught by producing the files correctly *this* time — it is
 * caught by checking the whole catalogue afterwards.
 *
 * Spends nothing: no model, no network.
 */
export function createValidateCommand(): Command {
  return new Command('validate')
    .description('Check a published catalogue against the format invariants (INV-1 … INV-28)')
    .argument('[dir]', 'catalogue root; defaults to output.baseDir from the config')
    .option('-c, --config <file>', 'path to the config file')
    .option('--strict', 'treat warnings as failures')
    .option('--json', 'emit the findings as JSON')
    .option('--no-files', 'skip the checks that need the filesystem (INV-8, INV-23)')
    .action(async (dir: string | undefined, options: Options) => {
      const loaded = await loadConfig({ file: options.config });
      const root = dir ? resolve(process.cwd(), dir) : loaded.paths.resolve(loaded.config.output.baseDir);
      const languages = loaded.config.catalogue.supportedLanguages;

      const snapshot = await readCatalogue(root, { supportedLanguages: languages });
      const findings = validateCatalogue(snapshot, {
        supportedLanguages: languages,
        checkFiles: options.files !== false,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify({ root, findings }, null, 2)}\n`);
      } else {
        report(root, snapshot.names.size, snapshot.dossiers.size, findings);
      }

      const errors = findings.filter((finding) => finding.severity === 'error').length;
      const warnings = findings.length - errors;
      if (errors > 0 || (options.strict && warnings > 0)) process.exitCode = 1;
    });
}

interface Options {
  config?: string;
  strict?: boolean;
  json?: boolean;
  /** Commander sets this to `false` for `--no-files`. */
  files?: boolean;
}

function report(root: string, nameFiles: number, dossiers: number, findings: readonly Finding[]): void {
  heading('Validate');
  process.stdout.write(`${root}\n`);
  process.stdout.write(pc.dim(`index.json · ${nameFiles} name index file(s) · ${dossiers} dossier(s)\n`));

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');

  if (findings.length === 0) {
    process.stdout.write(`\n${pc.green(symbols.ok)} every invariant holds\n`);
    return;
  }

  // Grouped by invariant rather than by file: a broken rule is almost always
  // broken the same way in many places, and the rule is the thing to fix.
  const byInvariant = new Map<string, Finding[]>();
  for (const finding of findings) {
    byInvariant.set(finding.invariant, [...(byInvariant.get(finding.invariant) ?? []), finding]);
  }

  const rows = [...byInvariant.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([invariant, items]) => ({
      severity:
        items[0]?.severity === 'error' ? pc.red(`${symbols.fail} error`) : pc.yellow(`${symbols.skip} warning`),
      invariant,
      count: String(items.length),
      example: truncate(`${items[0]?.file ?? ''}: ${items[0]?.message ?? ''}`, 96),
    }));

  process.stdout.write(`\n${renderTable(rows, [
    { header: '', value: (row) => row.severity },
    { header: 'INVARIANT', value: (row) => row.invariant },
    { header: 'N', value: (row) => row.count, align: 'right' },
    { header: 'FIRST OCCURRENCE', value: (row) => row.example },
  ])}\n`);

  process.stdout.write(
    `\n${errors.length} error(s), ${warnings.length} warning(s). ` +
      `${pc.dim('Use --json for the full list.')}\n`,
  );
}
