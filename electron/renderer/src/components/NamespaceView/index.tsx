/**
 * NamespaceView — live tree-style browser of kernel namespace variables.
 *
 * Queries `window.pdv.namespace.query` for top-level values and lazily expands
 * nested children through `window.pdv.namespace.inspect`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  NamespaceInspectResult,
  NamespaceInspectorNode,
  NamespaceQueryOptions,
  NamespaceVariable,
} from '../../types';

interface NamespaceViewProps {
  kernelId: string | null;
  disabled?: boolean;
  autoRefresh?: boolean;
  refreshInterval?: number;
  refreshToken?: number;
  onToggleAutoRefresh?: (value: boolean) => void;
}

interface VisibleNamespaceRow {
  depth: number;
  kind: 'node' | 'notice' | 'error';
  key: string;
  node?: NamespaceInspectorNode;
  message?: string;
}

const INDENT_PX = 16;

/** Kernel namespace browser panel. */
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
  const [expandedExpressions, setExpandedExpressions] = useState<Set<string>>(new Set());
  const [childrenByExpression, setChildrenByExpression] = useState<Record<string, NamespaceInspectorNode[]>>({});
  const [inspectMetaByExpression, setInspectMetaByExpression] = useState<Record<string, NamespaceInspectResult>>({});
  const [inspectLoading, setInspectLoading] = useState<Set<string>>(new Set());
  const [inspectErrors, setInspectErrors] = useState<Record<string, string>>({});

  const resetInspectionState = useCallback(() => {
    setExpandedExpressions(new Set());
    setChildrenByExpression({});
    setInspectMetaByExpression({});
    setInspectLoading(new Set());
    setInspectErrors({});
  }, []);

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
      resetInspectionState();
      return;
    }

    setError(undefined);
    // Show spinner only if the fetch takes longer than 1s to avoid flashing.
    const loadingTimer = setTimeout(() => setLoading(true), 1000);

    try {
      const result = await window.pdv.namespace.query(kernelId, filters);
      setVariables(result);
      resetInspectionState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVariables([]);
      resetInspectionState();
    } finally {
      clearTimeout(loadingTimer);
      setLoading(false);
    }
  }, [kernelId, filters, disabled, resetInspectionState]);

  useEffect(() => {
    void fetchNamespace();
  }, [fetchNamespace, refreshToken]);

  useEffect(() => {
    if (!autoRefresh || !kernelId || disabled) return;

    const interval = setInterval(() => {
      void fetchNamespace();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, kernelId, fetchNamespace, disabled]);

  const sortedVariables = useMemo(() => {
    return [...variables].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'type') cmp = a.type.localeCompare(b.type);
      else if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [variables, sortBy, sortDir]);

  const fetchChildren = useCallback(async (node: NamespaceInspectorNode) => {
    if (!kernelId) return;
    const key = node.expression;
    setInspectLoading((prev) => new Set(prev).add(key));
    setInspectErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      const result = await window.pdv.namespace.inspect(kernelId, {
        rootName: node.path.length === 0 ? node.name : findRootName(node, variables),
        path: node.path,
      });
      setChildrenByExpression((prev) => ({ ...prev, [key]: result.children }));
      setInspectMetaByExpression((prev) => ({ ...prev, [key]: result }));
    } catch (err) {
      setInspectErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setInspectLoading((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [kernelId, variables]);

  const toggleExpanded = useCallback((node: NamespaceInspectorNode) => {
    if (!node.hasChildren) return;
    const key = node.expression;
    setExpandedExpressions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    if (!childrenByExpression[key] && !inspectLoading.has(key)) {
      void fetchChildren(node);
    }
  }, [childrenByExpression, fetchChildren, inspectLoading]);

  const visibleRows = useMemo(() => {
    const rows: VisibleNamespaceRow[] = [];
    for (const variable of sortedVariables) {
      appendVisibleRows({
        rows,
        node: variable,
        depth: 0,
        expandedExpressions,
        childrenByExpression,
        inspectMetaByExpression,
        inspectErrors,
      });
    }

    if (!searchQuery.trim()) {
      return rows;
    }

    const query = searchQuery.toLowerCase();
    return rows.filter((row) => {
      if (row.kind !== 'node' || !row.node) {
        return false;
      }
      const haystack = `${row.node.name} ${row.node.expression} ${row.node.preview || ''}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [
    sortedVariables,
    expandedExpressions,
    childrenByExpression,
    inspectMetaByExpression,
    inspectErrors,
    searchQuery,
  ]);

  const handleDoubleClick = (node: NamespaceInspectorNode) => {
    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard.writeText(node.expression);
    }
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

  const shapeText = (variable: NamespaceInspectorNode) => {
    if (variable.shape) {
      return `(${variable.shape.join(', ')})`;
    }
    if (typeof variable.length === 'number') {
      return `${variable.length}`;
    }
    if (typeof variable.childCount === 'number' && variable.childCount > 0) {
      return `${variable.childCount}`;
    }
    return '—';
  };

  return (
    <div className="namespace-view">
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
                  <span className="spinner" role="status" aria-label="Loading">
                    <span aria-hidden="true">⏳</span>
                  </span>
                  {' '}Loading...
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

            {!loading && !error && visibleRows.length === 0 && (
              <tr>
                <td colSpan={5} className="namespace-empty">
                  {disabled ? 'Starting kernel...' : kernelId ? 'No variables in namespace' : 'No kernel active'}
                </td>
              </tr>
            )}

            {!loading &&
              !error &&
              visibleRows.map((row) => {
                if (row.kind === 'notice') {
                  return (
                    <tr key={row.key} className="namespace-row namespace-row-notice">
                      <td colSpan={5} className="namespace-message-row">{row.message}</td>
                    </tr>
                  );
                }
                if (row.kind === 'error') {
                  return (
                    <tr key={row.key} className="namespace-row namespace-row-error">
                      <td colSpan={5} className="namespace-message-row namespace-message-error">{row.message}</td>
                    </tr>
                  );
                }

                const node = row.node as NamespaceInspectorNode;
                const isExpanded = expandedExpressions.has(node.expression);
                const isInspecting = inspectLoading.has(node.expression);
                return (
                  <tr
                    key={row.key}
                    className="namespace-row"
                    onDoubleClick={() => handleDoubleClick(node)}
                    title="Double-click to copy expression"
                  >
                    <td className="namespace-name">
                      <div
                        className="namespace-name-cell"
                        style={{ paddingLeft: `${row.depth * INDENT_PX}px` }}
                      >
                        <button
                          type="button"
                          className={`namespace-toggle${node.hasChildren ? '' : ' hidden'}`}
                          onClick={() => toggleExpanded(node)}
                          aria-label={node.hasChildren ? `${isExpanded ? 'Collapse' : 'Expand'} ${node.expression}` : `${node.expression} has no children`}
                          disabled={!node.hasChildren}
                        >
                          {isInspecting ? '⏳' : (isExpanded ? '▼' : '▶')}
                        </button>
                        <span className="namespace-name-text">{node.name}</span>
                      </div>
                    </td>
                    <td className="namespace-type">
                      <span className="namespace-type-badge">{node.type}</span>
                      {node.kind !== node.type && <span className="namespace-type-badge subtle">{node.kind}</span>}
                    </td>
                    <td className="namespace-shape">{shapeText(node)}</td>
                    <td className="namespace-size">{formatSize(node.size)}</td>
                    <td className="namespace-preview">{node.preview || '—'}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <div className="namespace-footer">
        <span>
          {variables.length} variable{variables.length !== 1 ? 's' : ''}
        </span>
        {autoRefresh && <span className="namespace-auto-refresh">● Auto-refresh</span>}
      </div>
    </div>
  );
};

function appendVisibleRows({
  rows,
  node,
  depth,
  expandedExpressions,
  childrenByExpression,
  inspectMetaByExpression,
  inspectErrors,
}: {
  rows: VisibleNamespaceRow[];
  node: NamespaceInspectorNode;
  depth: number;
  expandedExpressions: Set<string>;
  childrenByExpression: Record<string, NamespaceInspectorNode[]>;
  inspectMetaByExpression: Record<string, NamespaceInspectResult>;
  inspectErrors: Record<string, string>;
}): void {
  rows.push({
    key: `${node.expression}:node`,
    kind: 'node',
    depth,
    node,
  });

  if (!expandedExpressions.has(node.expression)) {
    return;
  }

  const error = inspectErrors[node.expression];
  if (error) {
    rows.push({
      key: `${node.expression}:error`,
      kind: 'error',
      depth: depth + 1,
      message: error,
    });
    return;
  }

  const children = childrenByExpression[node.expression];
  if (children) {
    for (const child of children) {
      appendVisibleRows({
        rows,
        node: child,
        depth: depth + 1,
        expandedExpressions,
        childrenByExpression,
        inspectMetaByExpression,
        inspectErrors,
      });
    }
    const meta = inspectMetaByExpression[node.expression];
    if (meta?.truncated) {
      const shown = meta.children.length;
      const total = typeof meta.totalChildren === 'number' ? meta.totalChildren : shown;
      rows.push({
        key: `${node.expression}:notice`,
        kind: 'notice',
        depth: depth + 1,
        message: `${shown} of ${total} children shown`,
      });
    }
  }
}

function findRootName(node: NamespaceInspectorNode, variables: NamespaceVariable[]): string {
  if (node.path.length === 0) {
    return node.name;
  }
  const match = variables.find((variable) => node.expression === variable.expression || node.expression.startsWith(`${variable.expression}.`) || node.expression.startsWith(`${variable.expression}[`));
  return match?.name || node.expression.split(/[.[]/, 1)[0];
}
