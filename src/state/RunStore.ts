import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

import { LineAppender, ensureDir, pathExists, readJsonFile, writeFileAtomic } from '../shared/fs.js';
import type { JournalEvent, JournalRecord, RunManifest, RunStatus, RunTotals, TaskRecord } from './types.js';

const MANIFEST = 'run.json';
const JOURNAL = 'events.jsonl';
const CHECKPOINT = 'state.json';

interface Checkpoint {
  runId: string;
  updatedAt: string;
  /** Keyed by fingerprint — the identity resume compares against. */
  tasks: Record<string, TaskRecord>;
}

/**
 * Per-run directory holding the manifest, the append-only journal and the
 * checkpoint.
 *
 * The journal is the audit trail (what happened, in order); the checkpoint is
 * the resume index (what is already done). They are separate on purpose: the
 * journal must never be rewritten, and the checkpoint must be small enough to
 * rewrite atomically after every task.
 */
export class RunStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly journal: LineAppender;
  private sequence = 0;
  private flushing: Promise<void> | undefined;
  private dirty = false;

  private constructor(
    readonly runId: string,
    readonly dir: string,
    private manifest: RunManifest,
  ) {
    this.journal = new LineAppender(join(dir, JOURNAL));
  }

  static async create(stateDir: string, manifest: RunManifest): Promise<RunStore> {
    const dir = resolve(stateDir, manifest.runId);
    await ensureDir(dir);
    const store = new RunStore(manifest.runId, dir, manifest);
    await store.writeManifest();
    await store.append({ type: 'run.started', manifest });
    return store;
  }

  /** Most recent run id under `stateDir`, or undefined when there is none. */
  static async latestRunId(stateDir: string): Promise<string | undefined> {
    if (!(await pathExists(stateDir))) return undefined;
    const entries = await readdir(stateDir, { withFileTypes: true });
    const runs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    return runs.at(-1);
  }

  /** Completed-task index of a previous run, for `--resume`. */
  static async loadCheckpoint(stateDir: string, runId: string): Promise<Map<string, TaskRecord>> {
    const file = resolve(stateDir, runId, CHECKPOINT);
    if (!(await pathExists(file))) return new Map();

    const checkpoint = await readJsonFile<Checkpoint>(file);
    return new Map(Object.entries(checkpoint.tasks ?? {}));
  }

  static async loadManifest(stateDir: string, runId: string): Promise<RunManifest | undefined> {
    const file = resolve(stateDir, runId, MANIFEST);
    return (await pathExists(file)) ? readJsonFile<RunManifest>(file) : undefined;
  }

  /**
   * The journal, one record at a time.
   *
   * Streamed rather than parsed whole: `events.jsonl` is the largest file a run
   * produces — 290KB for fifty documents, so tens of megabytes for the real
   * corpus — and a reader that only wants the notes should not have to hold the
   * request log in memory to find them. A line that does not parse is skipped:
   * the last line of an interrupted run is routinely half-written, and refusing
   * to read the journal of the run that crashed would be exactly backwards.
   */
  static async *readEvents(stateDir: string, runId: string): AsyncGenerator<JournalRecord> {
    const file = resolve(stateDir, runId, JOURNAL);
    if (!(await pathExists(file))) return;

    const stream = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    try {
      for await (const line of stream) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as JournalRecord;
        } catch {
          // A truncated final line, or a record from a future version.
        }
      }
    } finally {
      stream.close();
    }
  }

  get manifestSnapshot(): RunManifest {
    return { ...this.manifest, totals: { ...this.manifest.totals } };
  }

  async append(event: JournalEvent): Promise<void> {
    this.sequence += 1;
    const record: JournalRecord = { ...event, ts: new Date().toISOString(), runId: this.runId, seq: this.sequence };
    await this.journal.append(JSON.stringify(record));
  }

  /** Records a task's terminal (or in-progress) state; flush is coalesced. */
  recordTask(record: TaskRecord): void {
    this.tasks.set(record.fingerprint, record);
    this.dirty = true;
  }

  taskCount(): number {
    return this.tasks.size;
  }

  /**
   * Writes the checkpoint. Concurrent callers share one in-flight write and a
   * single follow-up, so a hundred parallel tasks cause two writes, not a hundred.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) return;
    }
    if (!this.dirty) return;

    this.dirty = false;
    this.flushing = this.writeCheckpoint().finally(() => {
      this.flushing = undefined;
    });
    await this.flushing;
  }

  async finish(status: RunStatus, totals: RunTotals, durationMs: number): Promise<void> {
    this.manifest = { ...this.manifest, status, totals, finishedAt: new Date().toISOString() };
    await this.flush();
    await this.writeManifest();
    await this.append({ type: 'run.finished', status, totals, durationMs });
    await this.journal.close();
  }

  private async writeManifest(): Promise<void> {
    await writeFileAtomic(join(this.dir, MANIFEST), `${JSON.stringify(this.manifest, null, 2)}\n`);
  }

  private async writeCheckpoint(): Promise<void> {
    const checkpoint: Checkpoint = {
      runId: this.runId,
      updatedAt: new Date().toISOString(),
      tasks: Object.fromEntries(this.tasks),
    };
    await writeFileAtomic(join(this.dir, CHECKPOINT), `${JSON.stringify(checkpoint, null, 2)}\n`);
  }
}

/** Sortable, human-readable run id: `20260814-020304-a1b2`. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-${suffix}`;
}
