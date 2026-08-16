import fastGlob from 'fast-glob';
import { basename } from 'node:path';

import type { CatalogueSnapshot, LoadedFile } from '../domain/validate.js';
import { readTextFile } from '../shared/fs.js';

/**
 * Reads a published catalogue off disk into the shape the validator wants.
 *
 * Both the parsed value and the raw bytes are kept, because two of the
 * invariants are about things `JSON.parse` destroys: a duplicate object key
 * (the parser silently keeps the last one) and a literal `null` distinguishable
 * from an absent key only before parsing.
 *
 * A file that fails to parse is not an error here — it is recorded with
 * `value: undefined`, and the validator reports it in the same list as every
 * other defect. Failing the read would mean one bad file hides the rest.
 */

export interface ReadOptions {
  /** Content languages whose directories hold editions. */
  supportedLanguages: readonly string[];
  /** Directories to ignore entirely — internal channels, VCS metadata. */
  ignore?: readonly string[];
}

const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**'];

export async function readCatalogue(root: string, options: ReadOptions): Promise<CatalogueSnapshot> {
  const paths = await fastGlob(['**/*'], {
    cwd: root,
    onlyFiles: true,
    dot: false,
    unique: true,
    ignore: [...DEFAULT_IGNORE, ...(options.ignore ?? [])],
  });

  const files = new Set(paths);
  const names = new Map<string, LoadedFile>();
  const dossiers = new Map<string, LoadedFile>();

  const index = files.has('index.json') ? await load(root, 'index.json') : { value: undefined };

  for (const path of paths) {
    const name = basename(path);

    const localized = /^index-([a-z]{2})\.json$/.exec(name);
    if (localized?.[1] && !path.includes('/')) {
      names.set(localized[1], await load(root, path));
      continue;
    }

    const [lang, ...rest] = path.split('/');
    if (!lang || rest.length === 0) continue;
    if (!options.supportedLanguages.includes(lang)) continue;
    if (!name.toLowerCase().endsWith('.json')) continue;

    dossiers.set(path, await load(root, path));
  }

  return { index, names, dossiers, files };
}

async function load(root: string, relativePath: string): Promise<LoadedFile> {
  const raw = await readTextFile(`${root}/${relativePath}`).catch(() => undefined);
  if (raw === undefined) return { value: undefined };

  try {
    return { value: JSON.parse(stripBom(raw)) as unknown, raw };
  } catch {
    return { value: undefined, raw };
  }
}

/** A byte-order mark is tolerated on read and should not be written. */
function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
