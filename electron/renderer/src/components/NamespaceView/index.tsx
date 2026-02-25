import React, { useCallback, useEffect, useState } from 'react';
import type { NamespaceQueryOptions, NamespaceVariable } from '../../types';

interface NamespaceViewProps {
  kernelId: string | null;
  disabled?: boolean;
  autoRefresh?: boolean;
  refreshInterval?: number; // milliseconds
  refreshToken?: number;
  onToggleAutoRefresh?: (value: boolean) => void;
}

export const NamespaceView: React.FC<NamespaceViewProps> = ({
  kernelId,
  disabled = false,
  autoRefresh = false,
  refreshInterval = 2000,
  refreshToken = 0,
  onToggleAutoRefresh,
}) => {
  const [variables, setVariables] = useState<NamespaceVariable[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [filters, setFilters] = useState<NamespaceQueryOptions>({
    includePrivate: false,
    includeModules: false,
    includeCallables: false,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'type' | 'size'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSortClick = (col: 'name' | 'type' | 'size') => {
    if (col === sortBy) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir(col === 'size' ? 'desc' : 'asc');
    }
  };

  const fetchNamespace = useCallback(async () => {
    if (!kernelId || disabled) {
      setVariables([]);
      setError(undefined);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(undefined);

    try {
      const result = await window.pdv.namespace.query(kernelId, filters);
      setVariables(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVariables([]);
    } finally {
      setLoading(false);
    }
  }, [kernelId, filters, disabled]);

  // Fetch on mount and when kernel/filters/refresh token change
  useEffect(() => {
    void fetchNamespace();
  }, [fetchNamespace, refreshToken]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh || !kernelId || disabled) return;

    const interval = setInterval(() => {
      void fetchNamespace();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, kernelId, fetchNamespace, disabled]);

  // Filter and sort variables
  const filteredVariables = variables
    .filter((v) => v.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'type') cmp = a.type.localeCompare(b.type);
      else if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const handleDoubleClick = (variable: NamespaceVariable) => {
    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard.writeText(variable.name);
    }
    console.log('[Namespace] Copied to clipboard:', variable.name);
  };

  const handleRefresh = () => {
    void fetchNamespace();
  };

  const handleHeaderKeyDown = (sortKey: 'name' | 'type' | 'size') => (event: React.KeyboardEvent<HTMLTableCellElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSortClick(sortKey);
    }
  };

  const toggleFilter = (filter: keyof NamespaceQueryOptions) => {
    setFilters((prev) => ({ ...prev, [filter]: !prev[filter] }));
  };

  const formatSize = (bytes: number | undefined): string => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const shapeText = (variable: NamespaceVariable) => {
    if (variable.shape) {
      return `(${variable.shape.join(', ')})`;
    }
    if (typeof variable.length === 'number') {
      return `${variable.length}`;
    }
    return '—';
  };

  return (
    <div className="namespace-view">
      {/* Header with controls */}
      <div className="namespace-header">
        <input
          type="text"
          className="namespace-search"
          placeholder="Search variables..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          disabled={disabled}
        />

        <div className="namespace-controls">
            <button
              className="btn btn-icon"
              onClick={handleRefresh}
              disabled={loading || !kernelId || disabled}
              title="Refresh"
              aria-label="Refresh namespace"
              type="button"
          >
            🔄
          </button>

          <label className="namespace-filter">
            <input
              type="checkbox"
              checked={!!filters.includePrivate}
              onChange={() => toggleFilter('includePrivate')}
              disabled={disabled}
            />
            <span>Private</span>
          </label>

          <label className="namespace-filter">
            <input
              type="checkbox"
              checked={!!filters.includeModules}
              onChange={() => toggleFilter('includeModules')}
              disabled={disabled}
            />
            <span>Modules</span>
          </label>

          <label className="namespace-filter">
            <input
              type="checkbox"
              checked={!!filters.includeCallables}
              onChange={() => toggleFilter('includeCallables')}
              disabled={disabled}
            />
            <span>Functions</span>
          </label>

          {onToggleAutoRefresh && (
            <label className="namespace-filter">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={() => onToggleAutoRefresh(!autoRefresh)}
                disabled={disabled}
              />
              <span>Auto-refresh</span>
            </label>
          )}
        </div>
      </div>

      {/* Variable table */}
      <div className="namespace-table-container">
        <table className="namespace-table">
          <thead>
            <tr>
              <th
                scope="col"
                tabIndex={0}
                onClick={() => handleSortClick('name')}
                onKeyDown={handleHeaderKeyDown('name')}
                aria-sort={sortBy === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                style={{ cursor: 'pointer' }}
              >
                Name {sortBy === 'name' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              <th
                scope="col"
                tabIndex={0}
                onClick={() => handleSortClick('type')}
                onKeyDown={handleHeaderKeyDown('type')}
                aria-sort={sortBy === 'type' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                style={{ cursor: 'pointer' }}
              >
                Type {sortBy === 'type' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              <th scope="col">Shape/Length</th>
              <th
                scope="col"
                tabIndex={0}
                onClick={() => handleSortClick('size')}
                onKeyDown={handleHeaderKeyDown('size')}
                aria-sort={sortBy === 'size' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                style={{ cursor: 'pointer' }}
              >
                Size {sortBy === 'size' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              <th scope="col">Preview</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="namespace-loading">
                  Loading...
                </td>
              </tr>
            )}

            {error && (
              <tr>
                <td colSpan={5} className="namespace-error">
                  {error}
                </td>
              </tr>
            )}

            {!loading && !error && filteredVariables.length === 0 && (
              <tr>
                <td colSpan={5} className="namespace-empty">
                  {disabled ? 'Starting kernel...' : kernelId ? 'No variables in namespace' : 'No kernel active'}
                </td>
              </tr>
            )}

            {!loading &&
              !error &&
              filteredVariables.map((variable) => (
                <tr
                  key={variable.name}
                  className="namespace-row"
                  onDoubleClick={() => handleDoubleClick(variable)}
                  title="Double-click to copy name"
                >
                  <td className="namespace-name">{variable.name}</td>
                  <td className="namespace-type">{variable.type}</td>
                  <td className="namespace-shape">{shapeText(variable)}</td>
                  <td className="namespace-size">{formatSize(variable.size)}</td>
                  <td className="namespace-preview">{variable.preview || '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Footer with stats */}
      <div className="namespace-footer">
        <span>
          {filteredVariables.length} variable{filteredVariables.length !== 1 ? 's' : ''}
        </span>
        {autoRefresh && <span className="namespace-auto-refresh">● Auto-refresh</span>}
      </div>
    </div>
  );
};
