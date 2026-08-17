import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createApp, type App } from '../../src/app/container.js';
import { ProjectPaths } from '../../src/config/paths.js';
import { appConfigSchema, type AppConfigInput } from '../../src/config/schema.js';
import type { LoadedConfig } from '../../src/config/loader.js';
import { hashStructure } from '../../src/shared/hash.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LlmClient,
  ModelTarget,
} from '../../src/llm/types.js';

/** Isolated on-disk project for a test: corpus, prompts, output and state. */
export class Workspace {
  private constructor(readonly root: string) {}

  static async create(): Promise<Workspace> {
    return new Workspace(await mkdtemp(join(tmpdir(), 'biomd-test-')));
  }

  async writeFile(relativePath: string, content: string): Promise<string> {
    const file = resolve(this.root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return file;
  }

  /** The template pairs every built-in pipeline expects. */
  async writeDefaultPrompts(): Promise<void> {
    await this.writeFile(
      'prompts/extraction/system.md',
      'Extract these facts:\n<% var card = it.fields || []; card.forEach(function (f) { %>- <%= f.key %>: <%= f.hint %>\n<% }); %>',
    );
    await this.writeFile('prompts/extraction/user.md', 'Language: <%= it.language %>. Return JSON only.');
    await this.writeFile('prompts/translation/system.md', 'Translate, preserving Markdown structure exactly.');
    await this.writeFile(
      'prompts/translation/user.md',
      'From <%= it.sourceLanguage %> to <%= it.targetLanguage %>.',
    );
    await this.writeFile('prompts/translation/segments-system.md', 'Translate fragments. Return the same keys.');
    await this.writeFile(
      'prompts/translation/segments-user.md',
      '<%= it.count %> fragments, <%= it.sourceLanguage %> to <%= it.targetLanguage %>.',
    );
    await this.writeFile('prompts/localization/system.md', 'Localize field values. Return the same keys.');
    await this.writeFile(
      'prompts/localization/user.md',
      '<%= it.count %> values, <%= it.sourceLanguage %> to <%= it.targetLanguage %>.',
    );
    await this.writeFile(
      'prompts/websearch/system.md',
      'Search for these facts:\n<% var card = it.fields || []; card.forEach(function (f) { %>- <%= f.key %>: <%= f.hint %>\n<% }); %>' +
        '<% if (it.checkLiveness) { %>Also answer status: alive | dead | unknown.<% } %>',
    );
    await this.writeFile('prompts/websearch/user.md', 'Language: <%= it.language %>. Return JSON only.');
  }

  path(...segments: string[]): string {
    return resolve(this.root, ...segments);
  }

  loaded(overrides: Partial<AppConfigInput> = {}): LoadedConfig {
    const config = appConfigSchema.parse({
      project: { name: 'test', rootDir: '.' },
      input: { baseDir: 'corpus', include: ['*/**.bio.md'], sourceLanguage: 'auto' },
      output: { baseDir: 'out' },
      llm: {
        endpoints: [{ id: 'fake', baseUrl: 'http://localhost:9/v1', apiKey: 'x' }],
        models: [
          {
            id: 'primary',
            endpoint: 'fake',
            model: 'primary-model',
            contextWindow: 32_000,
            maxOutputTokens: 4096,
            pricing: { inputPer1M: 1, outputPer1M: 2 },
          },
          {
            id: 'secondary',
            endpoint: 'fake',
            model: 'secondary-model',
            contextWindow: 32_000,
            maxOutputTokens: 4096,
            pricing: { inputPer1M: 5, outputPer1M: 10 },
          },
        ],
        routing: { strategy: 'cost-optimized', pools: { default: ['primary', 'secondary'] } },
      },
      reliability: { retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' } },
      context: { strategy: 'full' },
      prompts: { dir: 'prompts' },
      run: { concurrency: 2, stateDir: '.biomd/runs', resume: 'off' },
      logging: { level: 'error', console: 'off', file: null },
      ...overrides,
    } as AppConfigInput);

    return {
      config,
      file: this.path('biomd.config.yaml'),
      paths: new ProjectPaths(this.root),
      hash: hashStructure(config, 16),
      warnings: [],
    };
  }

  app(overrides: Partial<AppConfigInput> = {}, client?: LlmClient): App {
    const app = createApp(this.loaded(overrides));
    if (client) app.clients.setDefaultBuilder(() => client);
    return app;
  }

  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export interface FakeCall {
  target: string;
  request: CompletionRequest;
}

/**
 * Deterministic stand-in for a provider.
 *
 * Three shapes. Extraction and a string batch both ask for `json_object` now —
 * the extraction contract is a flat table of facts, not a schema — so they are
 * told apart by what the request actually carries: a `json` fenced block is a
 * `{key: text}` batch, a `markdown` one is an article.
 *
 *  - a `json` block  → a string batch, answered by echoing every key (an
 *    identity translation, the one answer guaranteed to keep the structure and
 *    every mask token intact);
 *  - `json_object` without one → extraction, answered with the supplied facts;
 *  - otherwise → whole-document translation, answered with the document itself.
 */
export class FakeClient implements LlmClient {
  readonly endpointId = 'fake';
  readonly calls: FakeCall[] = [];

  constructor(
    private readonly behaviour: (call: FakeCall, index: number) => CompletionResponse | Error = () => new Error('unset'),
  ) {}

  static happyPath(facts: unknown = DEFAULT_FACTS): FakeClient {
    return new FakeClient((call) => {
      if (isStringBatch(call.request)) return respond(echoTable(call.request));
      if (call.request.responseFormat?.type === 'json_object') return respond(JSON.stringify(facts));
      return respond(lastFencedBlock(call.request));
    });
  }

  /** Answers a string batch with `transform` applied to every value. */
  static batch(transform: (text: string, key: string) => string): FakeClient {
    return new FakeClient((call) => respond(echoTable(call.request, transform)));
  }

  async complete(target: ModelTarget, request: CompletionRequest): Promise<CompletionResponse> {
    const call: FakeCall = { target: target.modelId, request };
    const index = this.calls.length;
    this.calls.push(call);

    const outcome = this.behaviour(call, index);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

export function respond(text: string, overrides: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    text,
    finishReason: 'stop',
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      cachedPromptTokens: 0,
      reasoningTokens: 0,
      totalTokens: 150,
    },
    reportedModel: 'fake',
    latencyMs: 1,
    ...overrides,
  };
}

/** The flat facts the extraction card asks for, as a model would answer them. */
export const DEFAULT_FACTS = {
  forename: 'Пако',
  surname: 'де Лусия',
  born: '21.12.1947',
  jobs: 'Гитарист,Композитор',
  url: 'https://fundacionpacodelucia.com/legado/',
  type: 'guitarist',
  gender: 'm',
  country: 'es',
  latin: 'Paco de Lucia',
};

/** A `{key: text}` table is fenced as `json`; an article is fenced as `markdown`. */
export function isStringBatch(request: CompletionRequest): boolean {
  return (request.messages.at(-1)?.content ?? '').includes('```json');
}

/** The document block the MessageBuilder appended last. */
function lastFencedBlock(request: CompletionRequest, info = 'markdown'): string {
  const user = request.messages.at(-1)?.content ?? '';
  const matches = [...user.matchAll(new RegExp('```' + info + '\\n([\\s\\S]*?)\\n```', 'g'))];
  return matches.at(-1)?.[1] ?? user;
}

/** Echoes a `{key: text}` batch back, optionally transforming each value. */
export function echoTable(request: CompletionRequest, transform?: (text: string, key: string) => string): string {
  const table = JSON.parse(lastFencedBlock(request, 'json')) as Record<string, string>;
  const answer = Object.fromEntries(
    Object.entries(table).map(([key, text]) => [key, transform ? transform(text, key) : text]),
  );
  return JSON.stringify(answer);
}

/** The strings a batch call was asked to translate. */
export function requestedTable(call: FakeCall): Record<string, string> {
  return JSON.parse(lastFencedBlock(call.request, 'json')) as Record<string, string>;
}
