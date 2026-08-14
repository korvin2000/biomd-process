import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { IoError } from './errors.js';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error: unknown) {
    throw new IoError(`Cannot read file: ${file}`, { details: { file }, cause: error });
  }
}

export async function readJsonFile<T>(file: string): Promise<T> {
  const raw = await readTextFile(file);
  try {
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    throw new IoError(`Cannot parse JSON file: ${file}`, { details: { file }, cause: error });
  }
}

/**
 * Write-then-rename. A crash mid-write leaves the previous version intact
 * instead of a truncated file — required for the checkpoint and for artifacts.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const target = resolve(file);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await ensureDir(dirname(target));
    await writeFile(temp, content, 'utf8');
    await rename(temp, target);
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new IoError(`Cannot write file: ${target}`, { details: { file: target }, cause: error });
  }
}

/** Append-only line sink used by the JSONL journal. */
export class LineAppender {
  private stream: WriteStream | undefined;

  constructor(private readonly file: string) {}

  async append(line: string): Promise<void> {
    const stream = await this.open();
    await new Promise<void>((resolveWrite, rejectWrite) => {
      stream.write(`${line}\n`, (error) => (error ? rejectWrite(error) : resolveWrite()));
    });
  }

  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolveClose) => stream.end(resolveClose));
  }

  private async open(): Promise<WriteStream> {
    if (!this.stream) {
      await ensureDir(dirname(this.file));
      this.stream = createWriteStream(this.file, { flags: 'a', encoding: 'utf8' });
    }
    return this.stream;
  }
}
