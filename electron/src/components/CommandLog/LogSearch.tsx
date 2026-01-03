import React from 'react';

interface LogSearchProps {
  query: string;
  total: number;
  filteredCount: number;
  onChange: (value: string) => void;
  onReset: () => void;
}

export const LogSearch: React.FC<LogSearchProps> = ({
  query,
  total,
  filteredCount,
  onChange,
  onReset,
}) => {
  return (
    <div className="log-search">
      <input
        aria-label="Search log"
        className="log-search__input"
        type="text"
        placeholder="Search commands or output..."
        value={query}
        onChange={(e) => onChange(e.target.value)}
      />
      <button className="action-button" onClick={onReset} disabled={!query}>
        Clear Search
      </button>
      <span className="log-search__count">
        {filteredCount} / {total} entries
      </span>
    </div>
  );
};
