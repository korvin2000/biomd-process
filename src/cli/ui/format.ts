import pc from 'picocolors';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
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
