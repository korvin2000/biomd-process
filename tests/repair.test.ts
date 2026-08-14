import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import type { CompletionResponse } from '../src/llm/types.js';
import { FakeClient, Workspace, echoTable, requestedTable, respond, type FakeCall } from './helpers/workspace.js';

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
    const answered = Object.entries(table).slice(0, -1);
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

    const translated = await readFile(workspace.path('out/en/andres-segovia.bio.md'), 'utf8');
    expect(translated.trim()).toBe(ARTICLE.trim());
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

describe('translation memory', () => {
  const TWO_DOCS = { translate: { enabled: true, targetLanguages: ['en'] } };

  it('reuses a persisted translation on the next run instead of paying again', async () => {
    await workspace.writeFile('corpus/ru/other.bio.md', ARTICLE);

    const first = workspace.app(
      { tasks: { translate: { ...TWO_DOCS.translate, useTranslationMemory: 'persistent' } }, run: { resume: 'off' } },
      FakeClient.batch((text) => `EN:${text}`),
    );
    await runJob(first);
    const paidFor = first.metrics.snapshot().llmRequests;
    expect(paidFor).toBeGreaterThan(0);

    // A fresh app, a fresh run directory — only the memory file survives.
    const second = workspace.app(
      { tasks: { translate: { ...TWO_DOCS.translate, useTranslationMemory: 'persistent' } }, run: { resume: 'off' } },
      FakeClient.batch((text) => `EN:${text}`),
    );
    await runJob(second);

    expect(second.metrics.snapshot().llmRequests).toBe(0);
    const translated = await readFile(workspace.path('out/en/andres-segovia.bio.md'), 'utf8');
    expect(translated).toContain('EN:');
  });

  it('does not carry a run-scoped memory into the next run', async () => {
    const first = workspace.app({ tasks: TWO_DOCS, run: { resume: 'off' } }, FakeClient.batch((text) => text));
    await runJob(first);

    const second = workspace.app({ tasks: TWO_DOCS, run: { resume: 'off' } }, FakeClient.batch((text) => text));
    await runJob(second);

    expect(second.metrics.snapshot().llmRequests).toBeGreaterThan(0);
  });
});
