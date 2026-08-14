import { describe, expect, it } from 'vitest';

import { interpolateEnv } from '../src/config/env.js';
import { deepMerge, pruneUndefined } from '../src/config/merge.js';
import { appConfigSchema } from '../src/config/schema.js';
import { createRunCommand } from '../src/cli/commands/run.js';
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

  it('rejects unknown top-level keys instead of ignoring a typo', () => {
    const input = { ...minimalConfig(), tsaks: {} };
    expect(appConfigSchema.safeParse(input).success).toBe(false);
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
});
