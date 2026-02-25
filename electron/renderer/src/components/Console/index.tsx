import React, { useEffect, useMemo, useRef } from 'react';
import type { LogEntry } from '../../types';

export interface ConsoleProps {
  logs: LogEntry[];
  onClear: () => void;
  onExport?: () => void;
}

export const Console: React.FC<ConsoleProps> = ({ logs, onClear, onExport }) => {
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
          {onExport && (
            <button className="btn btn-secondary" onClick={onExport}>
              Export
            </button>
          )}
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

const LogEntryView: React.FC<{ log: LogEntry; index: number }> = ({ log, index }) => {
  const timestamp = useMemo(() => new Date(log.timestamp).toLocaleTimeString(), [log.timestamp]);
  const hasResult = log.result !== undefined;
  const hasImages = log.images && log.images.length > 0;

  return (
    <div className="log-entry">
      <div className="log-entry-meta">
        <span className="log-count">[{index}]</span>
        <span className="log-time">{timestamp}</span>
        {typeof log.duration === 'number' && (
          <span className="log-duration">{Math.round(log.duration)}ms</span>
        )}
      </div>

      <pre className="log-code">{log.code}</pre>

      {log.stdout && <pre className="log-stdout">{log.stdout}</pre>}
      {log.stderr && <pre className="log-stderr">{log.stderr}</pre>}
      {hasResult && <pre className="log-result">{formatResult(log.result)}</pre>}
      {log.error && <pre className="log-error">Error: {log.error}</pre>}
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
