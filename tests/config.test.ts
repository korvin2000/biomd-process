import { describe, expect, it } from 'vitest';

import { interpolateEnv } from '../src/config/env.js';
import { deepMerge, pruneUndefined } from '../src/config/merge.js';
import { appConfigSchema } from '../src/config/schema.js';
import { createRunCommand } from '../src/cli/commands/run.js';
import { ModelRegistry } from '../src/llm/ModelRegistry.js';
import { minimalConfig } from './helpers/config.js';

describe('env interpolation', () => {
  it('substitutes variables and reports the missing ones', () => {
    const result = interpolateEnv({ key: '${PRESENT}', other: '${ABSENT}' }, { PRESENT: 'value' });
    expect(result.value).toEqual({ key: 'value', other: '' });
    expect(result.missing).toEqual(['ABSENT']);
  });

  it('uses the :- fallback without reporting the variable as missing', () => {
    const result = interpolateEnv({ url: '${HOST:-http://localhost:4000/v1}' }, {});
    expect(result.value).toEqual({ url: 'http://localhost:4000/v1' });
    expect(result.missing).toEqual([]);
  });

  it('leaves non-string values untouched', () => {
    const result = interpolateEnv({ n: 5, flag: true, list: ['${A}'] }, { A: 'x' });
    expect(result.value).toEqual({ n: 5, flag: true, list: ['x'] });
  });
});

describe('override merging', () => {
  it('merges objects recursively but replaces arrays wholesale', () => {
    const merged = deepMerge(
      { run: { concurrency: 4, dryRun: false }, langs: ['ru', 'en'] },
      { run: { concurrency: 8 }, langs: ['de'] },
    );
    expect(merged).toEqual({ run: { concurrency: 8, dryRun: false }, langs: ['de'] });
  });

  it('drops undefined leaves so unset CLI flags never override the file', () => {
    expect(pruneUndefined({ a: undefined, b: { c: undefined }, d: 1 })).toEqual({ d: 1 });
  });
});

describe('config schema', () => {
  it('applies defaults for everything that is omitted', () => {
    const config = appConfigSchema.parse(minimalConfig());
    expect(config.run.concurrency).toBe(4);
    expect(config.reliability.retry.maxAttempts).toBe(3);
    expect(config.context.strategy).toBe('truncation-first');
    expect(config.llm.models[0]?.contextWindow).toBe(128_000);
    expect(config.tasks.websearch.upgradePrecision).toBe(false);
    expect(config.tasks.websearch.onDateConflict).toBe('report');
    expect(config.tasks.websearch.recordSources).toBe('none');
  });

  it('rejects a model pointing at an undeclared endpoint', () => {
    const input = minimalConfig();
    input.llm.models[0]!.endpoint = 'nope';
    const result = appConfigSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Unknown endpoint');
  });

  it('rejects a routing pool naming an undeclared model', () => {
    const input = minimalConfig();
    input.llm.routing = { pools: { default: ['ghost'] } };
    const result = appConfigSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Unknown model');
  });

  it('rejects translation without target languages', () => {
    const input = minimalConfig();
    input.tasks = { translate: { enabled: true, targetLanguages: [] } };
    const result = appConfigSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.includes('targetLanguages'))).toBe(true);
  });

  it('rejects an enabled task whose output channel has no path template', () => {
    const input = minimalConfig();
    input.tasks = { extract: { enabled: true, outputChannel: 'nowhere' } };
    const result = appConfigSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('no path template');
  });

  it('accepts a pool as a bare model list and as an expanded object alike', () => {
    const input = minimalConfig();
    input.llm.routing = {
      pools: {
        default: ['small'],
        translate: { models: ['small'], strategy: 'least-busy', maxConcurrent: { local: 1 }, prefer: { zh: ['small'] } },
      },
    } as never;

    const config = appConfigSchema.parse(input);
    expect(config.llm.routing.pools['default']?.models).toEqual(['small']);
    expect(config.llm.routing.pools['default']?.strategy).toBeUndefined();
    expect(config.llm.routing.pools['translate']?.strategy).toBe('least-busy');
    expect(config.llm.routing.pools['translate']?.maxConcurrent).toEqual({ local: 1 });
  });

  it('rejects a preference naming a model the pool does not contain', () => {
    const input = minimalConfig();
    input.llm.routing = { pools: { default: { models: ['small'], prefer: { zh: ['ghost'] } } } } as never;
    const result = appConfigSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('is not in pool');
  });

  it('rejects a lane naming an undeclared endpoint', () => {
    const input = minimalConfig();
    input.llm.routing = { pools: { default: { models: ['small'], maxConcurrent: { ghost: 1 } } } } as never;
    const result = appConfigSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Unknown endpoint');
  });

  /**
   * A lane divides an endpoint's concurrency; it never raises it. Lanes adding
   * up to more than the endpoint allows would have every pool believing it had
   * a free slot and all of them queueing on the same one.
   */
  it('rejects lanes that add up to more than the endpoint allows', () => {
    const input = minimalConfig();
    input.llm.endpoints[0]!.maxConcurrent = 2;
    input.llm.routing = {
      pools: {
        default: { models: ['small'], maxConcurrent: { local: 1 } },
        translate: { models: ['small'], maxConcurrent: { local: 2 } },
      },
    } as never;
    const result = appConfigSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('add up to 3');
  });

  it('leaves lanes alone when the endpoint itself is uncapped', () => {
    const input = minimalConfig();
    input.llm.routing = {
      pools: { default: { models: ['small'], maxConcurrent: { local: 9 } } },
    } as never;
    expect(appConfigSchema.safeParse(input).success).toBe(true);
  });

  it('rejects unknown top-level keys instead of ignoring a typo', () => {
    const input = { ...minimalConfig(), tsaks: {} };
    expect(appConfigSchema.safeParse(input).success).toBe(false);
  });

  it('rejects unknown nested keys instead of silently stripping a typo', () => {
    const input = minimalConfig();
    (input.llm.models[0] as unknown as Record<string, unknown>)['capabilites'] = ['web_search'];
    const result = appConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
  });

  it('rejects duplicate endpoint and model ids', () => {
    const input = minimalConfig();
    input.llm.endpoints.push({ id: 'local', baseUrl: 'http://localhost:5000/v1' });
    input.llm.models.push({ id: 'small', endpoint: 'local', model: 'other-model' });
    const result = appConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('Duplicate endpoint id');
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('Duplicate model id');
  });

  it('checks web-search capability inside the task pool, not elsewhere in the config', () => {
    const input = minimalConfig();
    input.tasks = { websearch: { enabled: true, pool: 'websearch', requireWebSearchCapability: true } };
    input.llm.models.push({
      id: 'searcher',
      endpoint: 'local',
      model: 'search-model',
      apiFormat: 'responses',
      webSearchMode: 'responses_tool',
      capabilities: ['web_search'],
    } as never);
    input.llm.routing = { pools: { default: ['searcher'], websearch: ['small'] } };
    const result = appConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('pool "websearch"');
  });

  it('rejects a web_search declaration without an activation mode', () => {
    const input = minimalConfig();
    input.llm.models[0] = {
      ...input.llm.models[0]!,
      apiFormat: 'responses',
      capabilities: ['web_search'],
    } as never;
    const result = appConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('does not say how search is enabled');
  });

  it('rejects search modes whose activation mechanism is not configured', () => {
    const input = minimalConfig();
    input.llm.models[0] = {
      ...input.llm.models[0]!,
      capabilities: ['web_search'],
      webSearchMode: 'online',
    } as never;
    let result = appConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('no :online suffix');

    const pluginInput = minimalConfig();
    pluginInput.llm.models[0] = {
      ...pluginInput.llm.models[0]!,
      capabilities: ['web_search'],
      webSearchMode: 'plugin',
      params: { extra: { plugins: [{ id: 'not-web' }] } },
    } as never;
    result = appConfigSchema.safeParse(pluginInput);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toContain('has no web plugin');
  });

  it('merges llm default params underneath model-specific params', () => {
    const input = minimalConfig();
    input.llm.defaults = { params: { temperature: 0.7, topP: 0.8 } };
    (input.llm.models[0] as never as { params: { temperature: number } }).params = { temperature: 0.1 };
    const config = appConfigSchema.parse(input);
    expect(new ModelRegistry(config).get('small')?.params).toMatchObject({ temperature: 0.1, topP: 0.8 });
  });
});

describe('run command argument handling', () => {
  /**
   * `run` is the default command and it spends money, so anything commander
   * cannot place lands here. `biomd -c f config check` used to be read as `run`
   * with two ignorable extras and processed the whole corpus instead of
   * validating the config.
   */
  it('refuses stray positional arguments rather than processing the corpus', async () => {
    const command = createRunCommand().exitOverride();
    await expect(command.parseAsync(['-c', 'x.yaml', 'config', 'check'], { from: 'user' })).rejects.toThrow(
      /too many arguments/i,
    );
  });

  /**
   * `--only` used to disable `extract` and `translate` and silently leave
   * `localize` and `catalog` enabled — so `--only extract` went on paying for
   * localization, which is the opposite of what the flag is for.
   */
  it('refuses a pipeline name it does not know, instead of disabling everything', async () => {
    const command = createRunCommand().exitOverride();
    await expect(command.parseAsync(['--only', 'extrct', '--dry-run'], { from: 'user' })).rejects.toThrow(
      /Unknown pipeline\(s\) in --only: extrct/,
    );
  });
});
