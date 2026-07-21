/**
 * NamespaceView — live tree-style browser of kernel namespace variables.
 *
 * Server state lives in React Query: one query for the top-level
 * `namespace.query` (keyed by kernel + filter set) and one per expanded
 * node's `namespace.inspect` (keyed by expression). Refresh is event-driven
 * — execution-finish and project-load invalidate the `namespace` domains via
 * `queries/invalidation.ts` — with an opt-in interval that simply invalidates
 * on a timer. Expanded queries refetch in parallel on invalidation, which
 * replaces the old hand-rolled fetch-sequence/in-flight guards.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { keys } from '../../queries/keys';
import { invalidateNamespace } from '../../queries/invalidation';
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

/** Show a pending state only after it has lasted this long (no flashing). */
function useDeferredFlag(pending: boolean, delayMs: number): boolean {
  const [deferred, setDeferred] = useState(false);
  useEffect(() => {
    if (!pending) {
      setDeferred(false);
      return;
    }
    const timer = setTimeout(() => setDeferred(true), delayMs);
    return () => clearTimeout(timer);
  }, [pending, delayMs]);
  return deferred;
}

/** Kernel namespace browser panel. */
export const NamespaceView: React.FC<NamespaceViewProps> = ({
  kernelId,
  disabled = false,
  autoRefresh = false,
  refreshInterval = 2000,
  onToggleAutoRefresh,
}) => {
  const [filters, setFilters] = useState<NamespaceQueryOptions>({
    includePrivate: false,
    includeModules: false,
    includeCallables: false,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'type' | 'size'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  // Nodes the user has expanded, keyed by expression. The node object is
  // retained because re-inspection needs its rootName/path.
  const [expandedNodes, setExpandedNodes] = useState<ReadonlyMap<string, NamespaceInspectorNode>>(
    () => new Map(),
  );

  const enabled = kernelId !== null && !disabled;
  const filtersHash = `${+!!filters.includePrivate}${+!!filters.includeModules}${+!!filters.includeCallables}`;
  const variablesQuery = useQuery({
    queryKey: keys.namespace(kernelId ?? '__no-kernel__', filtersHash),
    queryFn: () => window.pdv.namespace.query(kernelId!, filters),
    enabled,
  });
  const variables = useMemo(
    () => (enabled ? variablesQuery.data ?? [] : []),
    [enabled, variablesQuery.data],
  );
  const error = enabled && variablesQuery.error
    ? (variablesQuery.error instanceof Error ? variablesQuery.error.message : String(variablesQuery.error))
    : undefined;
  // Spinner only for the initial (no data yet) fetch, deferred 1 s to avoid
  // flashing; background refetches swap content in place.
  const loading = useDeferredFlag(enabled && variablesQuery.data === undefined && !error, 1000);

  // findRootName needs the freshest variables at inspect time, not the ones
  // captured when the queryFn closure was built.
  const variablesRef = useRef<NamespaceVariable[]>([]);
  variablesRef.current = variables;

  const expandedList = useMemo(() => Array.from(expandedNodes.values()), [expandedNodes]);
  const inspectResults = useQueries({
    queries: expandedList.map((node) => ({
      queryKey: keys.namespaceInspect(kernelId ?? '__no-kernel__', node.expression),
      queryFn: () =>
        window.pdv.namespace.inspect(kernelId!, {
          rootName: node.path.length === 0 ? node.name : findRootName(node, variablesRef.current),
          path: node.path,
        }),
      enabled,
    })),
  });

  // Derived per-expression inspection state (children, meta, errors, pending).
  const expandedExpressions = useMemo(() => new Set(expandedNodes.keys()), [expandedNodes]);
  const childrenByExpression: Record<string, NamespaceInspectorNode[]> = {};
  const inspectMetaByExpression: Record<string, NamespaceInspectResult> = {};
  const inspectErrors: Record<string, string> = {};
  const inspectLoading = new Set<string>();
  expandedList.forEach((node, i) => {
    const result = inspectResults[i];
    if (result.data) {
      childrenByExpression[node.expression] = result.data.children;
      inspectMetaByExpression[node.expression] = result.data;
    } else if (result.error) {
      inspectErrors[node.expression] =
        result.error instanceof Error ? result.error.message : String(result.error);
    } else {
      inspectLoading.add(node.expression);
    }
  });

  // Collapse expansions whose root variable no longer exists in the fresh
  // top-level listing (e.g. deleted between refreshes) so their queries
  // don't linger and re-error forever.
  const freshVariables = variablesQuery.data;
  useEffect(() => {
    if (!freshVariables) return;
    setExpandedNodes((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [expression, node] of prev) {
        const rootExists = node.path.length === 0
          ? freshVariables.some((v) => v.name === node.name)
          : freshVariables.some(
              (v) =>
                expression === v.expression ||
                expression.startsWith(`${v.expression}.`) ||
                expression.startsWith(`${v.expression}[`),
            );
        if (!rootExists) {
          next.delete(expression);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [freshVariables]);

  const handleSortClick = (col: 'name' | 'type' | 'size') => {
    if (col === sortBy) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir(col === 'size' ? 'desc' : 'asc');
    }
  };

  // Opt-in interval refresh: invalidate the namespace domains on a timer;
  // the top-level query and every expanded inspection refetch in parallel.
  // React Query dedupes ticks that land while a refetch is in flight.
  useEffect(() => {
    if (!autoRefresh || !kernelId || disabled) return;

    const interval = setInterval(() => {
      invalidateNamespace(kernelId);
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, kernelId, disabled]);

  const sortedVariables = useMemo(() => {
    return [...variables].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'type') cmp = a.type.localeCompare(b.type);
      else if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [variables, sortBy, sortDir]);

  // Expanding mounts the node's inspect query (cache-hit renders instantly,
  // stale data revalidates in the background); collapsing unmounts it.
  const toggleExpanded = useCallback((node: NamespaceInspectorNode) => {
    if (!node.hasChildren) return;
    setExpandedNodes((prev) => {
      const next = new Map(prev);
      if (next.has(node.expression)) {
        next.delete(node.expression);
      } else {
        next.set(node.expression, node);
      }
      return next;
    });
  }, []);

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
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const visibleRows = !trimmedQuery
    ? rows
    : rows.filter((row) => {
        if (row.kind !== 'node' || !row.node) {
          return false;
        }
        const haystack = `${row.node.name} ${row.node.expression} ${row.node.preview || ''}`.toLowerCase();
        return haystack.includes(trimmedQuery);
      });

  const handleDoubleClick = (node: NamespaceInspectorNode) => {
    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard.writeText(node.expression);
    }
  };

  const handleRefresh = () => {
    if (kernelId) invalidateNamespace(kernelId);
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
