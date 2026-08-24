import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJob } from '../src/app/runJob.js';
import type { AttemptRecord } from '../src/llm/LlmGateway.js';
import { EMPTY_USAGE } from '../src/llm/types.js';
import { ProgressLog, type ProgressLogTask } from '../src/observability/ProgressLog.js';
import { pathExists } from '../src/shared/fs.js';
import { FakeClient, Workspace } from './helpers/workspace.js';

/**
 * The one surface of this tool meant to be read *while* a run is going, rather
 * than replayed afterwards.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'biomd-progress-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function attempt(overrides: Partial<AttemptRecord> & { correlationId: string }): AttemptRecord {
  return {
    target: 'local:local-small',
    modelId: 'local-small',
    modelName: 'gemma4-31b-local',
    endpointId: 'local',
    attempt: 1,
    outcome: 'success',
    latencyMs: 100,
    usage: { ...EMPTY_USAGE },
    costUsd: 0,
    ...overrides,
  };
}

function task(overrides: Partial<ProgressLogTask> = {}): ProgressLogTask {
  return {
    taskId: 't1',
    pipeline: 'extract',
    label: 'abiton → metadata (ru)',
    outputs: ['ru/abiton.bio.json'],
    durationMs: 35_000,
    status: 'completed',
    ...overrides,
  };
}

async function read(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean);
}

describe('progress log lines', () => {
  it('writes one line per finished task, naming the file and the model', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });

    log.noteAttempt(attempt({ correlationId: 't1' }));
    log.taskFinished(task());
    await log.close();

    const lines = await read(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] \[extract\] {3}'.ru.abiton\.bio\.json' : local-small:gemma4-31b-local \(35\.0s\)$/,
    );
  });

  it('renders the path with native separators, leading one included', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(task({ outputs: ['en/abiton.bio.md'] }));
    await log.close();

    expect((await read(file))[0]).toContain(`'${sep}en${sep}abiton.bio.md'`);
  });

  it('formats a duration over a minute the way the run summary does', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(task({ durationMs: 62_000 }));
    await log.close();

    expect((await read(file))[0]).toContain('(1m 2s)');
  });

  /**
   * A pool is a fallback chain, so the model that answered is routinely not the
   * one that was asked first. Naming the one that failed would credit it with
   * work it did not do.
   */
  it('names the model that succeeded, not the one that was tried first', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });

    log.noteAttempt(attempt({ correlationId: 't1', outcome: 'error', modelId: 'dead', modelName: 'dead-model' }));
    log.noteAttempt(attempt({ correlationId: 't1', modelId: 'or-cheap', modelName: 'deepseek/deepseek-v4' }));
    log.taskFinished(task());
    await log.close();

    expect((await read(file))[0]).toContain('or-cheap:deepseek/deepseek-v4');
    expect((await read(file))[0]).not.toContain('dead');
  });

  it('marks a task that called no model at all', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(task({ pipeline: 'catalog', outputs: ['index.json'] }));
    await log.close();

    expect((await read(file))[0]).toContain(`'${sep}index.json' : —`);
  });

  it('keeps one task’s model out of another’s line', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });

    log.noteAttempt(attempt({ correlationId: 't1' }));
    log.taskFinished(task({ taskId: 't1' }));
    log.taskFinished(task({ taskId: 't2', outputs: ['de/abiton.bio.md'] }));
    await log.close();

    const lines = await read(file);
    expect(lines[0]).toContain('local-small:gemma4-31b-local');
    expect(lines[1]).toContain("' : —");
  });

  it('says so when a task failed, and says why', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(
      task({ status: 'failed', outputs: [], label: 'abiton → de', detail: 'All 3 model target(s) failed' }),
    );
    await log.close();

    const line = (await read(file))[0] ?? '';
    expect(line).toContain("'abiton → de'");
    expect(line).toContain('FAILED — All 3 model target(s) failed');
  });

  it('flattens and truncates a failure message so a line stays a line', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(task({ status: 'failed', outputs: [], detail: `x${'y'.repeat(400)}\nsecond line` }));
    await log.close();

    const line = (await read(file))[0] ?? '';
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(260);
    expect(line).toContain('…');
  });
});

/**
 * Why a file was produced by the model it was produced by. A pool is a fallback
 * chain, so "who did it" is only half the story whenever something went wrong.
 */
describe('incidents', () => {
  const incident = { pipeline: 'translate', correlationId: 't1', kind: 'timeout', message: 'request timed out' };

  it('records a retry with the reason and the wait', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });

    log.taskStarted({ taskId: 't1', label: 'abiton → de' });
    log.noteRetry({ ...incident, target: 'local:local-small', attempt: 1, maxAttempts: 3, delayMs: 1500 });
    await log.close();

    const line = (await read(file))[0] ?? '';
    expect(line).toContain('[translate] !');
    expect(line).toContain("'abiton → de'");
    expect(line).toContain('retry 1/3 on local:local-small — timeout: request timed out');
    expect(line).toContain('next attempt in 1.5s');
  });

  it('records a fallback, naming both targets and why the first gave way', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });

    log.taskStarted({ taskId: 't1', label: 'abiton → de' });
    log.noteFallback({
      ...incident,
      kind: 'output_truncated',
      message: 'Response was cut off by the output token limit',
      from: 'local:local-small',
      to: 'omniroute:or-luna',
    });
    await log.close();

    const line = (await read(file))[0] ?? '';
    expect(line).toContain('fallback local:local-small → omniroute:or-luna');
    expect(line).toContain('output_truncated: Response was cut off');
  });

  /** A target that never works is a config bug, not a call that went wrong. */
  it('records a target written off for the whole run', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });

    log.noteTargetDown({
      pipeline: 'websearch',
      target: 'omniroute:or-search',
      kind: 'model_unavailable',
      message: '404 No active credentials for provider: omniroute',
    });
    await log.close();

    const line = (await read(file))[0] ?? '';
    expect(line).toContain('[websearch] ! TARGET DOWN omniroute:or-search');
    expect(line).toContain('model_unavailable: 404 No active credentials');
  });

  it('still records an incident whose task it cannot name', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.noteRetry({ ...incident, correlationId: undefined, target: 'x:y', attempt: 1, maxAttempts: 3, delayMs: 0 });
    await log.close();

    expect((await read(file))[0]).toContain('retry 1/3 on x:y');
  });

  it('keeps an incident on one line however long the provider was', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.noteFallback({ ...incident, message: `a${'b'.repeat(500)}
more`, from: 'x:y', to: 'p:q' });
    await log.close();

    const lines = await read(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThan(240);
  });

  it('stops naming a task once it has finished', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });

    log.taskStarted({ taskId: 't1', label: 'abiton → de' });
    log.taskFinished(task({ taskId: 't1' }));
    log.noteRetry({ ...incident, target: 'x:y', attempt: 1, maxAttempts: 3, delayMs: 0 });
    await log.close();

    expect((await read(file))[1]).not.toContain('abiton → de');
  });
});

/**
 * `extract` writes a dossier *and* an internal `.hints/` hand-off; `portrait`
 * writes nothing but a hint. One rule has to serve both.
 */
describe('which file a line is about', () => {
  it('prefers the published output over an internal hand-off', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(task({ outputs: ['ru/abiton.bio.json', '.hints/abiton.json'] }));
    await log.close();

    const lines = await read(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('abiton.bio.json');
  });

  it('falls back to the hand-off when that is the whole product', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(task({ pipeline: 'portrait', outputs: ['.hints/abiton.portrait.json'] }));
    await log.close();

    expect((await read(file))[0]).toContain('abiton.portrait.json');
  });

  it('names the task itself when nothing was written', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(task({ pipeline: 'websearch', outputs: [], label: 'abiton → web search' }));
    await log.close();

    expect((await read(file))[0]).toContain("'abiton → web search'");
  });

  it('gives an aggregation a line per index it wrote', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });
    log.taskFinished(task({ pipeline: 'catalog', outputs: ['index.json', 'index-en.json', 'index-de.json'] }));
    await log.close();

    expect(await read(file)).toHaveLength(3);
  });
});

describe('write throttling', () => {
  /** The file is written asynchronously; wait for it rather than guess. */
  async function waitForLines(file: string, count: number, timeoutMs = 3000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const lines = await read(file);
      if (lines.length >= count || Date.now() > deadline) return lines;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const INTERVAL = 250;

  it('batches tasks that finish inside the interval into one write', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: INTERVAL });

    // The header goes out immediately: a monitor should see the run start.
    log.runStarted({ runId: 'r1', tasks: 3, skipped: 0 });
    expect(await waitForLines(file, 1)).toHaveLength(1);

    log.taskFinished(task({ taskId: 't1' }));
    log.taskFinished(task({ taskId: 't2' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await read(file)).toHaveLength(1); // still only the header

    // …and then both lines arrive in a single write.
    expect(await waitForLines(file, 3)).toHaveLength(3);
    await log.close();
  });

  /**
   * The interval is a ceiling as well as a floor. A line that arrives just
   * after a write must not wait for the *next* task — on a slow document that
   * is minutes of a log claiming nothing is happening.
   */
  it('writes a waiting line when the interval elapses, with no further tasks', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: INTERVAL });

    log.runStarted({ runId: 'r1', tasks: 1, skipped: 0 });
    await waitForLines(file, 1);
    log.taskFinished(task());

    expect(await waitForLines(file, 2)).toHaveLength(2);
    await log.close();
  });

  it('flushes whatever is pending on close, however recent', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 60_000 });

    log.runStarted({ runId: 'r1', tasks: 1, skipped: 0 });
    log.taskFinished(task());
    await log.close();

    expect(await read(file)).toHaveLength(2);
  });
});

describe('the run frame', () => {
  it('heads each run and reports what it skipped', async () => {
    const file = join(dir, 'progress.log');
    const log = new ProgressLog({ file, intervalMs: 0 });

    log.runStarted({ runId: '20260823-205929-c392', tasks: 4, skipped: 27 });
    log.runFinished({ status: 'completed', durationMs: 297_000, completed: 4, failed: 0, costUsd: 0.00056 });
    await log.close();

    const lines = await read(file);
    expect(lines[0]).toContain('run 20260823-205929-c392 · 4 task(s), 27 already done');
    expect(lines.at(-1)).toContain('=== completed in 4m 57s · 4 ok · 0 failed · $0.00056 ===');
  });

  /** A second run must not erase the first: "who translated this last time" is a real question. */
  it('appends rather than replacing', async () => {
    const file = join(dir, 'progress.log');

    for (const runId of ['r1', 'r2']) {
      const log = new ProgressLog({ file, intervalMs: 0 });
      log.runStarted({ runId, tasks: 1, skipped: 0 });
      log.taskFinished(task());
      await log.close();
    }

    const lines = await read(file);
    expect(lines.filter((line) => line.startsWith('==='))).toHaveLength(2);
    expect(lines.filter((line) => line.includes('[extract]'))).toHaveLength(2);
  });

  it('writes nothing at all when the file is disabled', async () => {
    const log = new ProgressLog({ file: null, intervalMs: 0 });
    expect(log.enabled).toBe(false);

    log.runStarted({ runId: 'r1', tasks: 1, skipped: 0 });
    log.taskFinished(task());
    await log.close();

    expect(await pathExists(join(dir, 'progress.log'))).toBe(false);
  });
});

describe('a real run', () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await Workspace.create();
    await workspace.writeDefaultPrompts();
    await workspace.writeFile('corpus/ru/abiton.bio.md', '# Абитон\n\n::: lead\n\nГитарист.\n\n:::\n');
  });

  afterEach(async () => {
    await workspace.destroy();
  });

  it('accounts for every task with the model that did it', async () => {
    const app = workspace.app(
      {
        tasks: {
          extract: { enabled: true },
          translate: { enabled: true, targetLanguages: ['en'], copySourceArticle: false },
          catalog: { enabled: true },
        },
        logging: { level: 'error', console: 'off', file: null, progressFile: 'progress.log', progressIntervalMs: 0 },
      },
      FakeClient.happyPath(),
    );

    await runJob(app);
    const lines = await read(workspace.path('progress.log'));

    expect(lines[0]).toContain('· 3 task(s) ===');
    expect(lines.some((line) => /\[extract\] .+abiton\.bio\.json' : primary:primary-model \(/.test(line))).toBe(true);
    expect(lines.some((line) => /\[translate\] .+abiton\.bio\.md' : primary:primary-model \(/.test(line))).toBe(true);
    // The aggregation calls no model, and says so rather than borrowing one.
    expect(lines.some((line) => line.includes("[catalog]") && line.includes("' : —"))).toBe(true);
    expect(lines.at(-1)).toMatch(/^=== completed in .+ · 3 ok · 0 failed/);
  });

  /**
   * The whole point of recording an incident: the file below says `secondary`,
   * and the two lines above it say why.
   */
  it('explains a file that was produced by the fallback model', async () => {
    const happy = FakeClient.happyPath();
    const client = new FakeClient((call, index) => {
      if (call.target === 'primary') return new Error('boom: the primary is unwell');
      return happy['behaviour'](call, index);
    });

    const app = workspace.app(
      {
        tasks: { extract: { enabled: true }, catalog: { enabled: false } },
        logging: { level: 'error', console: 'off', file: null, progressFile: 'progress.log', progressIntervalMs: 0 },
      },
      client,
    );

    await runJob(app);
    const lines = await read(workspace.path('progress.log'));
    const incidents = lines.filter((line) => line.includes(' ! '));

    expect(incidents.some((line) => line.includes('TARGET DOWN fake:primary'))).toBe(true);
    expect(
      incidents.some(
        (line) => line.includes('fallback fake:primary → fake:secondary') && line.includes('the primary is unwell'),
      ),
    ).toBe(true);
    // The incident names the task it happened to, so it joins to the line below.
    expect(incidents.some((line) => line.includes("'abiton → metadata (ru)'"))).toBe(true);
    expect(lines.some((line) => line.includes("[extract]") && line.includes('secondary:secondary-model'))).toBe(true);
  });

  it('records a task that failed outright, with the reason', async () => {
    const app = workspace.app(
      {
        tasks: { extract: { enabled: true }, catalog: { enabled: false } },
        logging: { level: 'error', console: 'off', file: null, progressFile: 'progress.log', progressIntervalMs: 0 },
      },
      new FakeClient(() => new Error('every model is unwell')),
    );

    await runJob(app);
    const lines = await read(workspace.path('progress.log'));

    expect(lines.some((line) => line.includes('FAILED —') && line.includes('All 2 model target(s) failed'))).toBe(true);
    expect(lines.at(-1)).toContain('0 ok · 1 failed');
  });

  it('stays out of a dry run, which processed nothing', async () => {
    const app = workspace.app(
      {
        tasks: { extract: { enabled: true } },
        run: { concurrency: 1, stateDir: '.biomd/runs', resume: 'off', dryRun: true },
        logging: { level: 'error', console: 'off', file: null, progressFile: 'progress.log' },
      },
      FakeClient.happyPath(),
    );

    await runJob(app);
    expect(await pathExists(workspace.path('progress.log'))).toBe(false);
  });
});
