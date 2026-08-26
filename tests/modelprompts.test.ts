import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import { FakeClient, Workspace, echoTable, isStringBatch, respond } from './helpers/workspace.js';

const ARTICLE = `# Андрес Сеговия

Сеговия родился в Линаресе.
`;

const SHARED = 'Translate fragments. Return the same keys.';

let workspace: Workspace;

beforeEach(async () => {
  workspace = await Workspace.create();
  await workspace.writeDefaultPrompts();
  await workspace.writeFile('corpus/ru/andres-segovia.bio.md', ARTICLE);
});

afterEach(async () => {
  await workspace.destroy();
});

/** A pool of exactly one, so which model answered is not a routing question. */
function only(modelId: string) {
  return {
    tasks: { translate: { enabled: true, targetLanguages: ['en'] } },
    llm: {
      endpoints: [{ id: 'fake', baseUrl: 'http://localhost:9/v1', apiKey: 'x' }],
      models: [
        { id: 'primary', endpoint: 'fake', model: 'primary-model', contextWindow: 32_000, maxOutputTokens: 4096 },
        { id: 'secondary', endpoint: 'fake', model: 'secondary-model', contextWindow: 32_000, maxOutputTokens: 4096 },
      ],
      routing: { strategy: 'sequential', pools: { default: [modelId] } },
    },
  };
}

function recorder(): { client: FakeClient; systemOf: (modelId: string) => string | undefined } {
  const client = new FakeClient((call) =>
    isStringBatch(call.request) ? respond(echoTable(call.request)) : respond(''),
  );
  return {
    client,
    systemOf: (modelId) =>
      client.calls.find((call) => call.target === modelId)?.request.messages[0]?.content,
  };
}

describe('a prompt tuned for one model', () => {
  /**
   * The whole point, and the reason the mechanism is a directory rather than a
   * config key: the correction one model needs is sent to that model and to
   * nobody else. A rule written to stop `minimax-m3` leaving names in Cyrillic
   * is three lines every other model pays for on every call, and may read
   * differently to each of them.
   */
  it('reaches the model it names and no other', async () => {
    await workspace.writeFile('prompts/translation/secondary/segments-system.md', 'SECONDARY ONLY.');

    const chosen = recorder();
    await runJob(workspace.app(only('secondary'), chosen.client));
    expect(chosen.systemOf('secondary')).toBe('SECONDARY ONLY.');

    const other = recorder();
    await runJob(workspace.app(only('primary'), other.client));
    expect(other.systemOf('primary')).toBe(SHARED);
  });

  /**
   * The shared prompt here is a hundred lines of rules that were each measured
   * before they were written down. Copying all of them to change one is how two
   * versions of the same rule end up in the tree disagreeing, so an override is
   * handed the rendered shared text and the expected shape of one is an
   * addendum.
   */
  it('can extend the shared prompt instead of forking it', async () => {
    await workspace.writeFile(
      'prompts/translation/secondary/segments-system.md',
      '<%= it.sharedSystem %>\n\n## Also\nTransliterate every name in a heading.',
    );

    const chosen = recorder();
    await runJob(workspace.app(only('secondary'), chosen.client));

    const system = chosen.systemOf('secondary') ?? '';
    expect(system).toContain(SHARED);
    expect(system).toContain('Transliterate every name in a heading.');
  });

  /** Shadowing is per file: overriding the system prompt leaves the user prompt shared. */
  it('shadows one file and leaves the other alone', async () => {
    await workspace.writeFile('prompts/translation/secondary/segments-system.md', 'SECONDARY ONLY.');

    const chosen = recorder();
    await runJob(workspace.app(only('secondary'), chosen.client));

    const call = chosen.client.calls.find((c) => isStringBatch(c.request));
    expect(call?.request.messages[0]?.content).toBe('SECONDARY ONLY.');
    // The shared `segments-user.md` renders the fragment count and the languages.
    expect(call?.request.messages[1]?.content).toContain('ru to en');
  });

  /**
   * Two different system prefixes sharing one cache key is a wrong hit: the
   * provider is being told these requests begin with the same tokens, and for
   * one of them that is false.
   */
  it('gives a variant its own prompt-cache key', async () => {
    await workspace.writeFile('prompts/translation/secondary/segments-system.md', 'SECONDARY ONLY.');

    const chosen = recorder();
    await runJob(workspace.app(only('secondary'), chosen.client));
    const overridden = chosen.client.calls.find((c) => isStringBatch(c.request))?.request.promptCache?.key;

    const other = recorder();
    await runJob(workspace.app(only('primary'), other.client));
    const shared = other.client.calls.find((c) => isStringBatch(c.request))?.request.promptCache?.key;

    expect(overridden).toBeTruthy();
    expect(overridden).not.toBe(shared);
  });

  /** `variants` is an instruction to the gateway, not a field any provider knows. */
  it('never puts the other models’ prompts on the wire', async () => {
    await workspace.writeFile('prompts/translation/secondary/segments-system.md', 'SECONDARY ONLY.');

    const chosen = recorder();
    await runJob(workspace.app(only('secondary'), chosen.client));

    for (const call of chosen.client.calls) expect(call.request.variants).toBeUndefined();
  });
});

describe('the version an override belongs to', () => {
  /**
   * A fingerprint is computed at plan time and the model is chosen per call, so
   * a fingerprint can never mean "this model's prompt". Over-invalidating is the
   * safe half of that trade: the alternative is editing an override and being
   * served the output of the prompt it replaced.
   */
  it('re-plans the corpus when an override is added', async () => {
    const before = await workspace.app().prompts.versionOf('translateSegments');

    await workspace.writeFile('prompts/translation/secondary/segments-system.md', 'SECONDARY ONLY.');
    const after = await workspace.app().prompts.versionOf('translateSegments');

    expect(after).not.toBe(before);
  });

  /** Overrides are a feature that costs nothing until somebody uses it. */
  it('leaves the version exactly as it was when nothing overrides', async () => {
    const first = await workspace.app().prompts.versionOf('translateSegments');

    await workspace.writeFile('prompts/extraction/secondary/system.md', 'A different task entirely.');
    const second = await workspace.app().prompts.versionOf('translateSegments');

    expect(second).toBe(first);
  });

  /**
   * `prompts/translation/experiments/` holds superseded versions under their own
   * names. Looking up `<dir>/<name>/<the same file name>` passes over it without
   * needing to know what a model id looks like.
   */
  it('passes over a directory that shadows nothing', async () => {
    const before = await workspace.app().prompts.versionOf('translateSegments');

    await workspace.writeFile('prompts/translation/experiments/segments-system.old.md', 'An earlier draft.');
    const after = await workspace.app().prompts.versionOf('translateSegments');

    expect(after).toBe(before);
    await expect(workspace.app().prompts.variantsOf('translateSegments')).resolves.toEqual([]);
  });
});
