import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { ConfigError } from '../shared/errors.js';
import { pathExists, readTextFile } from '../shared/fs.js';
import { hashStructure } from '../shared/hash.js';
import { interpolateEnv } from './env.js';
import { deepMerge, pruneUndefined, type DeepPartial } from './merge.js';
import { ProjectPaths } from './paths.js';
import { appConfigSchema, type AppConfig, type AppConfigInput } from './schema.js';

const CANDIDATE_FILES = [
  'biomd.config.yaml',
  'biomd.config.yml',
  'config/biomd.config.yaml',
  'config/biomd.config.yml',
];

export interface LoadConfigOptions {
  /** Explicit config file; otherwise the well-known names are probed under `cwd`. */
  file?: string;
  cwd?: string;
  /** CLI overrides, applied on top of the file. */
  overrides?: DeepPartial<AppConfigInput>;
  env?: NodeJS.ProcessEnv;
  /** Load a `.env` next to the config file before interpolating. Default: true. */
  dotenv?: boolean;
}

export interface LoadedConfig {
  config: AppConfig;
  /** Absolute path of the config file that was used. */
  file: string;
  paths: ProjectPaths;
  /** Stable hash of the effective config; part of the run manifest. */
  hash: string;
  warnings: string[];
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const file = await locateConfigFile(cwd, options.file);

  if (options.dotenv !== false) {
    loadDotenv({ path: resolve(dirname(file), '.env'), quiet: true });
    loadDotenv({ path: resolve(cwd, '.env'), quiet: true });
  }

  const raw = parseYamlFile(await readTextFile(file), file);
  const interpolated = interpolateEnv(raw, options.env ?? process.env);
  const merged = deepMerge(interpolated.value as AppConfigInput, pruneUndefined(options.overrides));
  const config = validate(merged, file);

  const paths = new ProjectPaths(resolve(dirname(file), config.project.rootDir));
  const warnings = interpolated.missing.map(
    (name) => `Environment variable \${${name}} is not set; it resolved to an empty string.`,
  );

  return { config, file, paths, hash: hashStructure(config, 16), warnings };
}

async function locateConfigFile(cwd: string, explicit?: string): Promise<string> {
  if (explicit) {
    const file = resolve(cwd, explicit);
    if (await pathExists(file)) return file;
    throw new ConfigError(`Config file not found: ${file}`, { details: { file } });
  }

  for (const candidate of CANDIDATE_FILES) {
    const file = resolve(cwd, candidate);
    if (await pathExists(file)) return file;
  }

  throw new ConfigError(
    `No config file found in ${cwd}. Looked for: ${CANDIDATE_FILES.join(', ')}. ` +
      'Run `biomd config init` to create one.',
    { details: { cwd, candidates: CANDIDATE_FILES } },
  );
}

function parseYamlFile(text: string, file: string): unknown {
  try {
    return parseYaml(text) ?? {};
  } catch (error: unknown) {
    throw new ConfigError(`Invalid YAML in ${file}`, { details: { file }, cause: error });
  }
}

function validate(input: unknown, file: string): AppConfig {
  const result = appConfigSchema.safeParse(input);
  if (result.success) return result.data;

  throw new ConfigError(`Invalid configuration in ${file}:\n${formatIssues(result.error)}`, {
    details: { file, issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
  });
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  • ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
}

/** Endpoint secrets must never reach the journal or the console. */
export function redactConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      endpoints: config.llm.endpoints.map((endpoint) => ({
        ...endpoint,
        apiKey: endpoint.apiKey ? '***' : '',
        headers: Object.fromEntries(
          Object.entries(endpoint.headers).map(([key, value]) => [
            key,
            /authorization|api[-_]?key|token|secret/i.test(key) ? '***' : value,
          ]),
        ),
      })),
    },
  };
}
