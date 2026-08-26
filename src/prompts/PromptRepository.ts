import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { PromptsConfig } from '../config/schema.js';
import type { ProjectPaths } from '../config/paths.js';
import { ConfigError } from '../shared/errors.js';
import { pathExists, readTextFile } from '../shared/fs.js';
import { shortHash, stableStringify } from '../shared/hash.js';
import { EtaTemplateEngine } from './TemplateEngine.js';
import type { PromptVariables, RenderedPrompt, TemplateEngine } from './types.js';

interface TemplateSource {
  systemFile: string;
  userFile: string;
  system: string;
  user: string;
  version: string;
}

interface TaskTemplates {
  shared: TemplateSource;
  /** Model id → the templates that model gets instead. Usually empty. */
  byModel: Map<string, TemplateSource>;
  /** Hash of *everything* a change to which should re-plan the corpus. */
  version: string;
}

/**
 * Loads the `system`/`user` template pair for each task type from disk, once.
 *
 * Prompts live in files rather than in code so they can be edited, reviewed and
 * diffed by whoever tunes the output — and so that a change to one is a visible
 * change to the task fingerprint rather than an invisible drift.
 *
 * ## Per-model templates
 *
 * A subdirectory named after a model id shadows the file it sits beside:
 *
 * ```
 * prompts/translation/segments-system.md            ← everyone
 * prompts/translation/minimax-m3/segments-system.md ← minimax-m3 instead
 * ```
 *
 * The id is the one in `llm.models[].id`, not the provider's slug. Shadowing is
 * per file, so the override above changes the system prompt and leaves
 * `segments-user.md` shared.
 *
 * This exists because a prompt is tuned against a model, not against a task. A
 * rule added to make one model stop leaving names in the source alphabet is
 * three more lines every other model pays for on every call and may read
 * differently — and the shared prompt here is a hundred lines of rules that were
 * each measured before they were written down. Forking it wholesale to correct
 * one model's habit is how those rules drift apart, so an override is handed the
 * rendered shared text as `sharedSystem` / `sharedUser` and the intended shape
 * of one is:
 *
 * ```eta
 * <%= it.sharedSystem %>
 *
 * ## Names in headings and captions
 * …the correction this model needs…
 * ```
 *
 * A full replacement is still possible — just do not mention the variable — and
 * is the escape hatch rather than the pattern.
 *
 * **Every override hashes into the task's version**, so adding or editing one
 * re-plans the corpus for *all* models, not only for the model it names. Which
 * model answers is a routing decision taken per call, long after a fingerprint
 * is computed, so a fingerprint can never mean "this model's prompt"; the choice
 * is between over-invalidating and silently serving stale output, and this is
 * the safe half. A task with no override keeps exactly the version it had before
 * overrides existed, so the feature costs nothing until it is used.
 */
export class PromptRepository {
  private readonly cache = new Map<string, TaskTemplates>();

  constructor(
    private readonly config: PromptsConfig,
    private readonly paths: ProjectPaths,
    private readonly engine: TemplateEngine = new EtaTemplateEngine(),
  ) {}

  /** Task ids that have templates configured. */
  taskIds(): string[] {
    return Object.keys(this.config.templates).sort();
  }

  /**
   * Hash of every template file this task can use, and of the global variables.
   *
   * Feeds the task fingerprint and the translation-memory namespace, which is
   * why it covers the per-model overrides as well as the shared pair.
   */
  async versionOf(taskId: string): Promise<string> {
    return (await this.load(taskId)).version;
  }

  /** Model ids this task has an override for, sorted. Usually empty. */
  async variantsOf(taskId: string): Promise<string[]> {
    return [...(await this.load(taskId)).byModel.keys()].sort();
  }

  /**
   * The prompt as `modelId` will see it, or the shared one when that model has
   * no override — which is the common case and the default.
   */
  async render(taskId: string, variables: PromptVariables = {}, modelId?: string): Promise<RenderedPrompt> {
    const templates = await this.load(taskId);
    const merged = { ...this.config.variables, ...variables };
    const source = (modelId ? templates.byModel.get(modelId) : undefined) ?? templates.shared;

    // An override renders against the shared text so it can extend rather than
    // fork it. Rendering the shared pair first costs one template pass and is
    // what keeps a two-line correction two lines long.
    const scope =
      source === templates.shared
        ? merged
        : {
            ...merged,
            sharedSystem: this.engine.render(templates.shared.system, merged).trim(),
            sharedUser: this.engine.render(templates.shared.user, merged).trim(),
          };

    return {
      system: this.engine.render(source.system, scope).trim(),
      instructions: this.engine.render(source.user, scope).trim(),
      // The variant's own hash, never the task's: it keys the provider's prompt
      // cache, and two different system prefixes sharing one key is a wrong hit.
      version: source.version,
    };
  }

  /** Absolute paths, for `biomd prompts` and for error messages. */
  async filesOf(taskId: string, modelId?: string): Promise<{ system: string; user: string }> {
    const templates = await this.load(taskId);
    const source = (modelId ? templates.byModel.get(modelId) : undefined) ?? templates.shared;
    return { system: source.systemFile, user: source.userFile };
  }

  private async load(taskId: string): Promise<TaskTemplates> {
    const cached = this.cache.get(taskId);
    if (cached) return cached;

    const refs = this.config.templates[taskId];
    if (!refs) {
      throw new ConfigError(
        `No prompt templates configured for task "${taskId}". Add prompts.templates.${taskId}.{system,user}.`,
        { details: { taskId, configured: this.taskIds() } },
      );
    }

    const dir = this.paths.resolve(this.config.dir);
    const systemFile = resolve(dir, refs.system);
    const userFile = resolve(dir, refs.user);
    await this.assertExists(systemFile, taskId, 'system');
    await this.assertExists(userFile, taskId, 'user');

    const shared = await this.read(systemFile, userFile);
    const byModel = new Map<string, TemplateSource>();
    for (const [modelId, files] of await this.discoverOverrides(systemFile, userFile)) {
      byModel.set(modelId, await this.read(files.system ?? systemFile, files.user ?? userFile));
    }

    const templates: TaskTemplates = {
      shared,
      byModel,
      // Identical to the pre-override hash when nothing overrides, so shipping
      // this does not invalidate a corpus that never uses it.
      version: byModel.size === 0 ? shared.version : aggregateVersion(shared, byModel),
    };
    this.cache.set(taskId, templates);
    return templates;
  }

  private async read(systemFile: string, userFile: string): Promise<TemplateSource> {
    const [system, user] = await Promise.all([readTextFile(systemFile), readTextFile(userFile)]);
    return {
      systemFile,
      userFile,
      system,
      user,
      version: shortHash(`${system}\0${user}\0${stableStringify(this.config.variables)}`, 10),
    };
  }

  /**
   * Subdirectories beside a template that shadow it, keyed by their name.
   *
   * Looked up by file name rather than by listing model ids, so the repository
   * needs to know nothing about the model registry — and so a directory holding
   * something else entirely (`translation/experiments/`, whose files are named
   * `segments-system.old.md`) matches nothing and is passed over.
   */
  private async discoverOverrides(
    systemFile: string,
    userFile: string,
  ): Promise<Map<string, { system?: string; user?: string }>> {
    const found = new Map<string, { system?: string; user?: string }>();

    for (const [role, file] of [
      ['system', systemFile],
      ['user', userFile],
    ] as const) {
      const parent = dirname(file);
      const name = basename(file);
      for (const entry of await subdirectories(parent)) {
        const candidate = join(parent, entry, name);
        if (!(await pathExists(candidate))) continue;
        const slot = found.get(entry) ?? {};
        slot[role] = candidate;
        found.set(entry, slot);
      }
    }
    return found;
  }

  private async assertExists(file: string, taskId: string, role: string): Promise<void> {
    if (await pathExists(file)) return;
    throw new ConfigError(`Missing ${role} prompt for task "${taskId}": ${file}`, {
      details: { taskId, role, file },
    });
  }
}

function aggregateVersion(shared: TemplateSource, byModel: ReadonlyMap<string, TemplateSource>): string {
  const overrides = [...byModel]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, source]) => `${id}=${source.version}`);
  return shortHash([shared.version, ...overrides].join('\0'), 10);
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // The templates themselves were already proved to exist; an unreadable
    // parent means there is nowhere for an override to be, not an error.
    return [];
  }
}
