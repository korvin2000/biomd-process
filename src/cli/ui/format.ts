import pc from 'picocolors';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * How much longer, from how long it has taken so far.
 *
 * A flat extrapolation of the mean task duration, deliberately: these tasks
 * differ by an order of magnitude (a free dossier reuse against a chunked
 * translation) but they are shuffled through the same queue at a fixed
 * concurrency, so the mean converges quickly and anything cleverer would be a
 * more confident version of the same guess.
 *
 * `undefined` until enough tasks have finished to mean anything — a number
 * extrapolated from two samples is worse than no number, because it is read as
 * a promise rather than as noise.
 */
export function estimateRemaining(elapsedMs: number, done: number, total: number): number | undefined {
  if (done < 3 || done >= total || elapsedMs <= 0) return undefined;
  return Math.round((elapsedMs / done) * (total - done));
}

/** `18:42` for a wall-clock instant this many milliseconds from now. */
export function formatEta(remainingMs: number, now: Date = new Date()): string {
  const at = new Date(now.getTime() + remainingMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface TableColumn<T> {
  header: string;
  value: (row: T) => string;
  align?: 'left' | 'right';
}

/** Minimal aligned table — enough for `biomd models` without a dependency. */
export function renderTable<T>(rows: readonly T[], columns: readonly TableColumn<T>[]): string {
  const cells = rows.map((row) => columns.map((column) => column.value(row)));
  const widths = columns.map((column, index) =>
    Math.max(visibleLength(column.header), ...cells.map((row) => visibleLength(row[index] ?? ''))),
  );

  const line = (values: string[], dim: boolean): string =>
    values
      .map((value, index) => pad(value, widths[index] ?? 0, columns[index]?.align ?? 'left'))
      .join('  ')
      .trimEnd()
      .replace(/^/, dim ? '' : '');

  const header = pc.bold(line(columns.map((column) => column.header), false));
  const divider = pc.dim(widths.map((width) => '─'.repeat(width)).join('  '));
  return [header, divider, ...cells.map((row) => line(row, true))].join('\n');
}

function pad(value: string, width: number, align: 'left' | 'right'): string {
  const padding = ' '.repeat(Math.max(0, width - visibleLength(value)));
  return align === 'right' ? padding + value : value + padding;
}

/** Ignores ANSI escapes so colored cells still line up. */
function visibleLength(value: string): number {
  // eslint-disable-next-line no-control-regex -- stripping SGR sequences is the point
  return value.replace(/\[[0-9;]*m/g, '').length;
}

export const symbols = {
  ok: pc.green('✔'),
  fail: pc.red('✖'),
  skip: pc.dim('•'),
  warn: pc.yellow('!'),
};
