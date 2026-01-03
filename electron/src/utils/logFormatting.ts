export interface LogEntry {
  id: number;
  code: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  timestamp: number;
  durationMs: number;
}

/**
 * Format a timestamp into a stable, readable string.
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

/**
 * Format duration in milliseconds into a compact human-readable string.
 */
export function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(2)}s`;
  }
  return `${durationMs.toFixed(0)}ms`;
}

/**
 * Convert a log entry into a plain-text block for exporting.
 */
export function entryToText(entry: LogEntry): string {
  const lines = [
    `[${formatTimestamp(entry.timestamp)} | ${formatDuration(entry.durationMs)}] >>> ${entry.code}`,
  ];

  if (entry.stdout) {
    lines.push(entry.stdout.trimEnd());
  }
  if (entry.stderr) {
    lines.push(`stderr: ${entry.stderr.trimEnd()}`);
  }
  if (entry.error) {
    lines.push(`error: ${entry.error}`);
  }

  return lines.join('\n');
}

/**
 * Build a full export string for multiple log entries.
 */
export function buildLogExport(entries: LogEntry[]): string {
  return entries.map(entryToText).join('\n\n');
}
