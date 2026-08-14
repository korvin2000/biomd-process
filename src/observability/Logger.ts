import pc from 'picocolors';

import type { LoggingConfig } from '../config/schema.js';
import { LineAppender } from '../shared/fs.js';
import type { JsonObject } from '../shared/json.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
  /** Returns a logger that stamps `fields` onto every record. */
  child(fields: JsonObject): Logger;
}

export type LogWriter = (level: LogLevel, line: string) => void;

/**
 * Small structured logger.
 *
 * Console output goes to **stderr** so the progress bar can own stdout, and the
 * writer is replaceable so the CLI can print log lines above a live bar instead
 * of through it. File output is JSONL, matching the run journal, so both can be
 * read by the same tooling.
 */
export class AppLogger implements Logger {
  private static fileSink: LineAppender | undefined;
  private static writer: LogWriter = (level, line) => {
    process.stderr.write(`${line}\n`);
    void level;
  };

  private constructor(
    private readonly threshold: number,
    private readonly console: LoggingConfig['console'],
    private readonly fields: JsonObject,
  ) {}

  static create(config: LoggingConfig, fileResolver: (path: string) => string): AppLogger {
    if (config.file) AppLogger.fileSink = new LineAppender(fileResolver(config.file));
    return new AppLogger(ORDER[config.level], config.console, {});
  }

  /** Lets the CLI route log lines around a live progress bar. */
  static setWriter(writer: LogWriter): void {
    AppLogger.writer = writer;
  }

  static async close(): Promise<void> {
    await AppLogger.fileSink?.close();
    AppLogger.fileSink = undefined;
  }

  child(fields: JsonObject): Logger {
    return new AppLogger(this.threshold, this.console, { ...this.fields, ...fields });
  }

  debug(message: string, fields?: JsonObject): void {
    this.log('debug', message, fields);
  }
  info(message: string, fields?: JsonObject): void {
    this.log('info', message, fields);
  }
  warn(message: string, fields?: JsonObject): void {
    this.log('warn', message, fields);
  }
  error(message: string, fields?: JsonObject): void {
    this.log('error', message, fields);
  }

  private log(level: LogLevel, message: string, fields?: JsonObject): void {
    if (ORDER[level] < this.threshold) return;

    const record = { ts: new Date().toISOString(), level, message, ...this.fields, ...fields };
    void AppLogger.fileSink?.append(JSON.stringify(record)).catch(() => undefined);

    if (this.console === 'off') return;
    AppLogger.writer(level, this.console === 'json' ? JSON.stringify(record) : formatPretty(level, message, record));
  }
}

const BADGE: Record<LogLevel, string> = {
  debug: pc.dim('debug'),
  info: pc.blue('info '),
  warn: pc.yellow('warn '),
  error: pc.red('error'),
};

function formatPretty(level: LogLevel, message: string, record: Record<string, unknown>): string {
  const { ts, level: _level, message: _message, ...rest } = record;
  const time = pc.dim(String(ts).slice(11, 19));
  const extra = Object.keys(rest).length > 0 ? pc.dim(` ${formatFields(rest)}`) : '';
  return `${time} ${BADGE[level]} ${message}${extra}`;
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

/** Discards everything — used by tests and by `--quiet`. */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};
