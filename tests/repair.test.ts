import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import type { CompletionResponse } from '../src/llm/types.js';
import { FakeClient, Workspace, echoTable, requestedTable, respond, translated, type FakeCall } from './helpers/workspace.js';

/**
 * The failure this file is about: a model answers all but one key of a
 * `{hash: text}` batch. Re-sending the whole batch is what the run journal
 * showed happening — two identical, separately billed translation calls for one
 * dropped fragment.
 */
const ARTICLE = `# Андрес Сеговия

Сеговия родился в Линаресе.

==Для тестового каталога== эта запись демонстрирует таблицу.

1893–1987

[Справка](https://example.org/segovia)
`;

const TRANSLATE_ONLY = {
  translate: { enabled: true, targetLanguages: ['en'] },
};

let workspace: Workspace;

beforeEach(async () => {
  workspace = await Workspace.create();
  await workspace.writeDefaultPrompts();
  await workspace.writeFile('corpus/ru/andres-segovia.bio.md', ARTICLE);
});

afterEach(async () => {
  await workspace.destroy();
});

/** Answers every key but the last one, once — then behaves. */
function dropsOneKeyOnce(): { client: FakeClient; batches: FakeCall[] } {
  const batches: FakeCall[] = [];

  const client = new FakeClient((call): CompletionResponse => {
    if (call.request.responseFormat?.type !== 'json_object') return respond('');
    batches.push(call);

    if (batches.length > 1) return respond(echoTable(call.request));

    const table = requestedTable(call);
    // Translated, like any other answer: an untranslated value is now a
    // *rejected* value, and this fixture is about a key that never came back at
    // all rather than one that came back wrong.
    const answered = Object.entries(table)
      .slice(0, -1)
      .map(([key, text]) => [key, translated(text)]);
    return respond(JSON.stringify(Object.fromEntries(answered)));
  });

  return { client, batches };
}

describe('partial batch answers', () => {
  it('re-asks only for the fragments that were left out', async () => {
    const { client, batches } = dropsOneKeyOnce();
    const app = workspace.app({ tasks: TRANSLATE_ONLY }, client);

    const outcome = await runJob(app);
    expect(outcome.summary.status).toBe('completed');

    // Two calls, as before the fix — but the second one is not the first again.
    expect(batches).toHaveLength(2);
    const first = Object.keys(requestedTable(batches[0]!));
    const repair = Object.keys(requestedTable(batches[1]!));

    expect(repair).toEqual([first.at(-1)]);
    expect(repair.length).toBeLessThan(first.length);
  });

  it('produces the complete document, not one with a hole in it', async () => {
    const { client } = dropsOneKeyOnce();
    const app = workspace.app({ tasks: TRANSLATE_ONLY }, client);

    await runJob(app);

    const document = await readFile(workspace.path('out/en/andres-segovia.bio.md'), 'utf8');
    expect(document.trim()).toBe(translated(ARTICLE).trim());
  });

  it('counts the repair as an ordinary call, not a retry', async () => {
    const { client } = dropsOneKeyOnce();
    const app = workspace.app({ tasks: TRANSLATE_ONLY }, client);

    await runJob(app);

    // The point of the change: no retry, because nothing failed — the first
    // answer was usable, it was merely incomplete.
    expect(app.metrics.snapshot().retries).toBe(0);
    expect(app.metrics.snapshot().llmRequests).toBe(2);
  });

  it('falls back to all-or-nothing retries when repairAttempts is 0', async () => {
    const { client, batches } = dropsOneKeyOnce();
    const app = workspace.app(
      { tasks: { translate: { ...TRANSLATE_ONLY.translate, repairAttempts: 0 } } },
      client,
    );

    await runJob(app);

    // The old behaviour, on purpose: the whole table goes again.
    expect(Object.keys(requestedTable(batches[1]!))).toEqual(Object.keys(requestedTable(batches[0]!)));
    expect(app.metrics.snapshot().retries).toBe(1);
  });

  it('fails the task when even the repair leaves a gap', async () => {
    const client = new FakeClient((call) => {
      if (call.request.responseFormat?.type !== 'json_object') return respond('');
      const answered = Object.entries(requestedTable(call)).slice(0, -1);
      return respond(JSON.stringify(Object.fromEntries(answered)));
    });

    const app = workspace.app({ tasks: TRANSLATE_ONLY }, client);
    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('failed');
    expect(outcome.summary.failures[0]?.message).toMatch(/missing or malformed/i);
  });

  it('never sends a fragment that has no words in it', async () => {
    const { client, batches } = dropsOneKeyOnce();
    const app = workspace.app({ tasks: TRANSLATE_ONLY }, client);

    await runJob(app);

    const sent = Object.values(requestedTable(batches[0]!));
    expect(sent).not.toContain('1893–1987');
    expect(sent.some((text) => text.includes('Сеговия родился'))).toBe(true);
  });
});

/**
 * The `williams2` failure, one level down from routing: the model was willing
 * and the payload was fine, the answer simply had nowhere left to go. Halving
 * the table is the cheapest repair — half a batch needs half the output — and it
 * keeps the work on the model already chosen instead of escalating to a wider,
 * paid one.
 */
describe('a batch whose answer does not fit', () => {
  /** Refuses any table with more than `limit` keys, the way an output cap does. */
  function cutsOffAbove(limit: number): { client: FakeClient; batches: FakeCall[] } {
    const batches: FakeCall[] = [];

    const client = new FakeClient((call): CompletionResponse => {
      if (call.request.responseFormat?.type !== 'json_object') return respond('');
      batches.push(call);

      const asked = Object.keys(requestedTable(call)).length;
      if (asked > limit) return respond('{"partial": "cut off mid-', { finishReason: 'length' });
      return respond(echoTable(call.request));
    });

    return { client, batches };
  }

  it('splits it instead of failing the document', async () => {
    const { client, batches } = cutsOffAbove(1);
    const app = workspace.app({ tasks: TRANSLATE_ONLY }, client);

    const outcome = await runJob(app);

    expect(outcome.summary.status).toBe('completed');
    expect(batches.some((call) => Object.keys(requestedTable(call)).length > 1)).toBe(true);
    // Every batch that was actually answered had come down to the size that fits.
    const answered = batches.filter((call) => Object.keys(requestedTable(call)).length <= 1);
    expect(answered.length).toBeGreaterThan(1);
  });

  it('produces the complete document, not one missing the fragments that were cut', async () => {
    const { client } = cutsOffAbove(1);
    await runJob(workspace.app({ tasks: TRANSLATE_ONLY }, client));

    const document = await readFile(workspace.path('out/en/andres-segovia.bio.md'), 'utf8');
    expect(document.trim()).toBe(translated(ARTICLE).trim());
  });

  it('does not retry the identical payload before narrowing it', async () => {
    // A cut-off answer is deterministic, so a retry buys the same cut twice.
    const { client } = cutsOffAbove(1);
    const app = workspace.app({ tasks: TRANSLATE_ONLY }, client);

    await runJob(app);

    expect(app.metrics.snapshot().retries).toBe(0);
  });

  it('gives up on a single fragment that still does not fit, rather than looping', async () => {
    const { client } = cutsOffAbove(0);
    const outcome = await runJob(workspace.app({ tasks: TRANSLATE_ONLY }, client));

    expect(outcome.summary.status).toBe('failed');
    expect(outcome.summary.failures[0]?.message).toMatch(/cut off by the output token limit/i);
  });
});

describe('translation memory', () => {
  const TWO_DOCS = { translate: { enabled: true, targetLanguages: ['en'] } };

  it('reuses a persisted translation on the next run instead of paying again', async () => {
    await workspace.writeFile('corpus/ru/other.bio.md', ARTICLE);

    const first = workspace.app(
      { tasks: { translate: { ...TWO_DOCS.translate, useTranslationMemory: 'persistent' } }, run: { resume: 'off' } },
      FakeClient.batch((text) => `EN:${translated(text)}`),
    );
    await runJob(first);
    const paidFor = first.metrics.snapshot().llmRequests;
    expect(paidFor).toBeGreaterThan(0);

    // A fresh app, a fresh run directory — only the memory file survives.
    const second = workspace.app(
      { tasks: { translate: { ...TWO_DOCS.translate, useTranslationMemory: 'persistent' } }, run: { resume: 'off' } },
      FakeClient.batch((text) => `EN:${translated(text)}`),
    );
    await runJob(second);

    expect(second.metrics.snapshot().llmRequests).toBe(0);
    const document = await readFile(workspace.path('out/en/andres-segovia.bio.md'), 'utf8');
    expect(document).toContain('EN:');
  });

  it('does not carry a run-scoped memory into the next run', async () => {
    const first = workspace.app({ tasks: TWO_DOCS, run: { resume: 'off' } }, FakeClient.batch(translated));
    await runJob(first);

    const second = workspace.app({ tasks: TWO_DOCS, run: { resume: 'off' } }, FakeClient.batch(translated));
    await runJob(second);

    expect(second.metrics.snapshot().llmRequests).toBeGreaterThan(0);
  });
});
