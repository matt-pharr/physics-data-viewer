import React from 'react';

export interface DisplayResult {
  methodName: string;
  resultType: string;
  content: unknown;
  error?: string | null;
  traceback?: string | null;
}

interface ResultWindowProps {
  results: DisplayResult[];
  onClear?: () => void;
}

export const ResultWindow: React.FC<ResultWindowProps> = ({ results, onClear }) => {
  return (
    <div className="result-window">
      <div className="result-window__header">
        <h3>Results</h3>
        <button type="button" onClick={onClear} className="action-button clear" data-testid="clear-results">
          Clear
        </button>
      </div>
      {results.length === 0 ? (
        <div className="empty-state">No results yet. Double-click a value to run its default action.</div>
      ) : (
        <div className="result-window__list" data-testid="result-list">
          {results.map((result, idx) => (
            <div key={`${result.methodName}-${idx}`} className={`result-card ${result.resultType}`}>
              <div className="result-title">
                <strong>{result.methodName}</strong> <span className="result-type">[{result.resultType}]</span>
              </div>
              {result.error ? (
                <div className="result-error">
                  <div>{result.error}</div>
                  {result.traceback && <pre>{result.traceback}</pre>}
                </div>
              ) : (
                <pre className="result-content">{stringifyContent(result.content)}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function stringifyContent(content: unknown): string {
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (typeof content === 'number' || typeof content === 'boolean') {
    return String(content);
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return String(content);
}
