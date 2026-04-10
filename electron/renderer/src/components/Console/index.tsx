/**
 * Console panel for execution history and streamed output rendering.
 *
 * Displays code, stdout/stderr, rich display images, and execution metadata
 * emitted from kernel executions coordinated by `App`.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import type { LogEntry } from '../../types';
import { ansiToHtml } from './ansi';

/** Props for the execution console panel. */
interface ConsoleProps {
  logs: LogEntry[];
  onClear: () => void;
}

/** Execution console component. */
export const Console: React.FC<ConsoleProps> = ({ logs, onClear }) => {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <section className="console-pane">
      <header className="pane-header">
        <h2>Console</h2>
        <div className="pane-actions">
          <button className="btn btn-secondary" onClick={onClear}>
            Clear
          </button>
        </div>
      </header>

      <div className="console-content" ref={contentRef}>
        {logs.length === 0 ? (
          <div className="console-empty">
            <p>No output yet</p>
            <p className="hint">Execution results will appear here</p>
          </div>
        ) : (
          logs.map((log, index) => (
            <LogEntryView key={log.id} log={log} index={index + 1} />
          ))
        )}
      </div>
    </section>
  );
};

/** Render one console history item with optional streams/result/images. */
const LogEntryView: React.FC<{ log: LogEntry; index: number }> = ({ log, index }) => {
  const timestamp = useMemo(() => new Date(log.timestamp).toLocaleTimeString(), [log.timestamp]);
  const hasResult = log.result !== undefined;
  const hasImages = log.images && log.images.length > 0;
  const sourceText = formatSourceLabel(log.errorDetails?.source ?? log.origin);
  const locationText = formatLocationLabel(log.errorDetails?.location);
  const tracebackText = log.errorDetails?.traceback?.join('\n') ?? '';

  return (
    <div className="log-entry">
      <div className="log-entry-meta">
        <span className="log-count">[{index}]</span>
        <span className="log-time">{timestamp}</span>
        {typeof log.duration === 'number' && (
          <span className="log-duration">{Math.round(log.duration)}ms</span>
        )}
        {sourceText && <span className="log-source">{sourceText}</span>}
      </div>

      {log.code && <pre className="log-code">{log.code}</pre>}

      {log.stdout && (
        <pre
          className="log-stdout"
          dangerouslySetInnerHTML={{ __html: ansiToHtml(log.stdout) }}
        />
      )}
      {log.stderr && (
        <pre
          className="log-stderr"
          dangerouslySetInnerHTML={{ __html: ansiToHtml(log.stderr) }}
        />
      )}
      {hasResult && <pre className="log-result">{formatResult(log.result)}</pre>}
      {log.error && <pre className="log-error" dangerouslySetInnerHTML={{ __html: 'Error: ' + ansiToHtml(log.error) }} />}
      {log.error && locationText && <div className="log-error-context">{locationText}</div>}
      {tracebackText && (
        <pre
          className="log-traceback"
          dangerouslySetInnerHTML={{ __html: ansiToHtml(tracebackText) }}
        />
      )}
      {hasImages && (
        <div className="log-images">
          {log.images?.map((img, idx) => (
            <img
              key={`${log.id}-img-${idx}`}
              className="log-image"
              src={`data:${img.mime};base64,${img.data}`}
              alt={`Plot ${index}.${idx + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};

function formatResult(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatSourceLabel(source: LogEntry['origin']): string | undefined {
  if (!source) return undefined;
  if (source.kind === 'code-cell') {
    const numericTabId =
      typeof source.tabId === 'number'
        ? source.tabId
        : source.label
          ? Number.parseInt(source.label.replace(/\D+/g, ''), 10)
          : Number.NaN;
    return Number.isFinite(numericTabId) ? `Cell ${numericTabId}` : 'Cell';
  }
  if (source.kind === 'tree-script') {
    return source.label ? `Script: ${source.label}` : 'Script';
  }
  return source.label ? `Execution: ${source.label}` : 'Execution';
}

function formatLocationLabel(
  location: { file?: string; line?: number; column?: number } | undefined
): string | undefined {
  if (!location) return undefined;
  const parts: string[] = [];
  if (location.file) {
    parts.push(`File ${location.file}`);
  }
  if (typeof location.line === 'number') {
    parts.push(`line ${location.line}`);
  }
  if (typeof location.column === 'number') {
    parts.push(`column ${location.column}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}
