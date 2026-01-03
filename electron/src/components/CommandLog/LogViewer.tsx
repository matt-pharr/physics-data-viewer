import React, { useEffect, useRef } from 'react';
import { LogEntry, formatDuration, formatTimestamp } from '../../utils/logFormatting';

interface LogViewerProps {
  entries: LogEntry[];
  onClear: () => void;
  onExport: () => void;
}

export const LogViewer: React.FC<LogViewerProps> = ({ entries, onClear, onExport }) => {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const hasEntries = entries.length > 0;

  useEffect(() => {
    if (bottomRef.current && typeof bottomRef.current.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries]);

  return (
    <div className="log-panel">
      <div className="log-controls">
        <div className="log-meta">
          {hasEntries ? `Showing ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : 'No entries yet'}
        </div>
        <div className="log-actions">
          <button className="action-button" onClick={onExport} disabled={!hasEntries}>
            Export
          </button>
          <button className="action-button clear" onClick={onClear} disabled={!hasEntries}>
            Clear Log
          </button>
        </div>
      </div>

      <div className="log-list" data-testid="log-list">
        {!hasEntries ? (
          <div className="empty-state">Executed commands and output will appear here.</div>
        ) : (
          entries.map((entry) => (
            <div className="log-entry" key={entry.id} data-testid="log-entry">
              <div className="log-entry__meta">
                <span className="log-timestamp">{formatTimestamp(entry.timestamp)}</span>
                <span className="log-duration">{formatDuration(entry.durationMs)}</span>
              </div>
              <pre className="log-entry__code">
                <span className="log-prompt">{'>>> '}</span>
                {entry.code}
              </pre>
              {entry.stdout ? <pre className="log-entry__stdout">{entry.stdout}</pre> : null}
              {entry.stderr ? <pre className="log-entry__stderr">{entry.stderr}</pre> : null}
              {entry.error ? <pre className="log-entry__error">Error: {entry.error}</pre> : null}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};
