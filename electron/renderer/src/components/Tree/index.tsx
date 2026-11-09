/**
 * Tree panel — browsable view of `pdv_tree` descriptors.
 *
 * Server state (children listings) lives in React Query — one query per
 * expanded path (`['tree', kernelId, path]`), invalidated by push events via
 * `queries/invalidation.ts`. This component owns only UI state: which paths
 * are expanded, the selection (persisted per project in localStorage), and
 * the context menu. A low-frequency safety-net poll revalidates visible
 * listings through the same cache to catch plain-dict mutations that emit no
 * push; it stays quiet while pushes are flowing.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import type { TreeNodeData } from '../../services/tree';
import { TreeNodeRow } from './TreeNodeRow';
import { ContextMenu } from './ContextMenu';
import { flattenFromCache, collapseSubtree, type TreeRow } from './tree-utils';
import {
  useTreeChildrenQueries,
  pollTreeOnce,
  TREE_POLL_INTERVAL_MS,
  TREE_PUSH_SUPPRESS_MS,
} from '../../queries/tree';
import { invalidateTree, msSinceTreePush, parentTreePath } from '../../queries/invalidation';
import type { Shortcuts } from '../../shortcuts';
import { matchesShortcut } from '../../shortcuts';

const ROW_HEIGHT = 32;

/** How long a pending fetch must run before its row shows a spinner. */
const LOADING_SPINNER_DELAY_MS = 1000;

/** Props passed to VirtualRow via react-window's rowProps. */
interface VirtualRowProps {
  flatNodes: TreeRow[];
  selectedPath: string | null;
  onExpand: (node: TreeNodeData) => void;
  onDoubleClick: (node: TreeNodeData) => void;
  onRightClick: (node: TreeNodeData, event: React.MouseEvent) => void;
  onClick: (node: TreeNodeData) => void;
}

/** Module-level row renderer for react-window v2.
 *
 * Wrapped in `React.memo` for runtime memoization, but exposed as a plain
 * function type because `react-window`'s `rowComponent` prop is typed as
 * `(props) => ReactElement | null`, not a `MemoExoticComponent`.
 */
const VirtualRowImpl = ({ index, style, ariaAttributes, flatNodes, selectedPath, onExpand, onDoubleClick, onRightClick, onClick }: RowComponentProps<VirtualRowProps>): React.ReactElement => {
  const node = flatNodes[index];
  return (
    <TreeNodeRow
      node={node}
      selected={node.path === selectedPath}
      onExpand={onExpand}
      onDoubleClick={onDoubleClick}
      onRightClick={onRightClick}
      onClick={onClick}
      style={style}
      ariaAttributes={ariaAttributes}
    />
  );
};
const VirtualRow = React.memo(VirtualRowImpl) as unknown as typeof VirtualRowImpl;

interface TreeProps {
  kernelId: string | null;
  disabled?: boolean;
  /**
   * True while a kernel start is actually in flight. Distinguishes the
   * placeholder's "Starting kernel…" (something is happening) from
   * "No active session" (nothing is; the id alone cannot tell, because it
   * stays null until the start resolves).
   */
  startingKernel?: boolean;
  onAction?: (action: string, node: TreeNodeData) => void;
  shortcuts: Shortcuts;
  /**
   * Stable identity of the open project (e.g. its directory path), used to
   * scope selection persistence so selection doesn't leak across projects.
   * Null/undefined for a not-yet-saved project.
   */
  projectKey?: string | null;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNodeData;
}

/** Read the persisted selection for one project's storage key, or null. */
function readStoredSelection(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/**
 * Cache-friendly map of parent path → children, rebuilt only when a query's
 * data identity actually changes (structural sharing keeps identities stable
 * across no-op refetches, so no-op polls rebuild nothing).
 */
function useChildrenByPath(
  paths: readonly string[],
  datas: readonly (TreeNodeData[] | undefined)[],
): ReadonlyMap<string, TreeNodeData[]> {
  const ref = useRef<{
    paths: readonly string[];
    datas: readonly (TreeNodeData[] | undefined)[];
    map: Map<string, TreeNodeData[]>;
  } | null>(null);
  const cached = ref.current;
  const unchanged =
    cached !== null &&
    cached.paths.length === paths.length &&
    cached.paths.every((p, i) => p === paths[i]) &&
    cached.datas.every((d, i) => d === datas[i]);
  if (!unchanged) {
    const map = new Map<string, TreeNodeData[]>();
    paths.forEach((p, i) => {
      const data = datas[i];
      if (data) map.set(p, data);
    });
    ref.current = { paths, datas, map };
  }
  return ref.current!.map;
}

/**
 * Paths whose fetch has been pending longer than `delayMs`, for spinner
 * display without flashing on fast fetches.
 */
function useDeferredLoadingPaths(pendingPaths: string[], delayMs: number): ReadonlySet<string> {
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
  // NUL never appears in tree paths, so the joined key is collision-free
  // even when node keys contain spaces.
  const key = pendingPaths.join('\u0000');
  useEffect(() => {
    // Drop entries that are no longer pending right away…
    setDeferred((prev) => {
      const next = new Set([...prev].filter((p) => pendingPaths.includes(p)));
      return next.size === prev.size ? prev : next;
    });
    if (pendingPaths.length === 0) return;
    // …and promote the still-pending set only after the delay.
    const timer = setTimeout(() => setDeferred(new Set(pendingPaths)), delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes pendingPaths
  }, [key, delayMs]);
  return deferred;
}

/** Tree browser component for node navigation and node actions. */
export const Tree: React.FC<TreeProps> = ({ kernelId, disabled = false, startingKernel = false, onAction, shortcuts, projectKey }) => {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Selection persistence is scoped per project so switching projects
  // doesn't inherit (or clobber) another project's selection.
  const selectionStorageKey = `pdv:selectedPath:${projectKey ?? '__unsaved__'}`;
  const [selectedPath, setSelectedPath] = useState<string | null>(() =>
    readStoredSelection(selectionStorageKey),
  );

  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;
  const listRef = useRef<ListImperativeAPI>(null);

  // One mounted query per visible level: root first, then expanded paths in
  // a stable order. Invalidation refetches them all in parallel.
  const paths = useMemo(
    () => ['', ...Array.from(expandedPaths).sort()],
    [expandedPaths],
  );
  const results = useTreeChildrenQueries(kernelId, paths, !disabled);

  const datas = results.map((r) => r.data);
  const childrenByPath = useChildrenByPath(paths, datas);

  const pendingPaths = paths.filter((_p, i) => results[i].data === undefined && !results[i].error);
  const loadingPaths = useDeferredLoadingPaths(pendingPaths, LOADING_SPINNER_DELAY_MS);

  const rootResult = results[0];
  const loading = !disabled && kernelId !== null && rootResult.data === undefined && !rootResult.error;
  const error = rootResult.error ? 'Failed to load tree' : undefined;

  // Reconcile expansion with reality: collapse paths that vanished from
  // their parent's (loaded) listing or whose own listing failed to load
  // (node removed mid-expansion). Cheap set surgery, no fetches.
  const erroredKey = paths.filter((p, i) => p !== '' && results[i].error).join('\u0000');
  useEffect(() => {
    if (expandedPaths.size === 0) return;
    let next: ReadonlySet<string> | null = null;
    const current = (): ReadonlySet<string> => next ?? expandedPaths;
    for (const p of expandedPaths) {
      const parent = parentTreePath(p);
      const parentListing = childrenByPath.get(parent);
      const parentVisible = parent === '' || expandedPaths.has(parent);
      if (parentVisible && parentListing && !parentListing.some((n) => n.path === p)) {
        next = collapseSubtree(current(), p);
      }
    }
    for (const p of erroredKey ? erroredKey.split('\u0000') : []) {
      if (current().has(p)) next = collapseSubtree(current(), p);
    }
    if (next) setExpandedPaths(next);
  }, [childrenByPath, expandedPaths, erroredKey]);

  // Persist selection per project; when the project (storage key) changes,
  // load that project's stored selection instead of persisting the old one.
  const lastSelectionKeyRef = useRef(selectionStorageKey);
  useEffect(() => {
    if (lastSelectionKeyRef.current !== selectionStorageKey) {
      lastSelectionKeyRef.current = selectionStorageKey;
      setSelectedPath(readStoredSelection(selectionStorageKey));
      return;
    }
    try {
      if (selectedPath !== null) {
        localStorage.setItem(selectionStorageKey, selectedPath);
      } else {
        localStorage.removeItem(selectionStorageKey);
      }
    } catch (error) {
      console.warn('Failed to persist selected path:', error);
    }
  }, [selectedPath, selectionStorageKey]);

  // Safety-net poll. Push notifications cover all PDVTree mutations, but
  // plain-dict mutations under the tree (e.g. `pdv_tree['data']['x'] = 1`
  // when `data` is a plain dict) emit nothing. Every tick revalidates the
  // root and every expanded listing through the shared cache — in parallel,
  // so a tick costs one round trip of wall-clock. Ticks are skipped while
  // pushes are flowing (the push pipeline is proven live) and fetches that
  // return unchanged data notify nothing (structural sharing + narrowed
  // notifyOnChangeProps), so idle ticks cause zero re-renders. The next
  // tick is scheduled only after the previous pass finishes.
  useEffect(() => {
    if (!kernelId || disabled) return;
    let cancelled = false;
    let timer: number | undefined;

    const pollOnce = async () => {
      if (msSinceTreePush() < TREE_PUSH_SUPPRESS_MS) return;
      await pollTreeOnce(kernelId, expandedPathsRef.current);
    };

    const scheduleNext = () => {
      timer = window.setTimeout(() => {
        void pollOnce().finally(() => {
          if (!cancelled) scheduleNext();
        });
      }, TREE_POLL_INTERVAL_MS);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [kernelId, disabled]);

  const handleExpand = useCallback((node: TreeNodeData) => {
    if (!kernelId || disabled || !node.hasChildren) return;
    setExpandedPaths((prev) => {
      if (prev.has(node.path)) {
        // Collapse: clear this path and all descendant expansions. Cached
        // listings are retained, so re-expanding renders instantly.
        return collapseSubtree(prev, node.path);
      }
      const next = new Set(prev);
      next.add(node.path);
      return next;
    });
  }, [kernelId, disabled]);

  const handleDoubleClick = useCallback((node: TreeNodeData) => {
    if (disabled) return;
    if (node.type === 'module' || node.type === 'gui') {
      onAction?.('open_gui', node);
      return;
    }
    if (node.hasHandler) {
      onAction?.('handle', node);
    } else if (node.type === 'markdown') {
      onAction?.('open_note', node);
    } else if (node.type === 'script') {
      onAction?.('run', node);
    }
  }, [disabled, onAction]);

  const handleSelect = useCallback((node: TreeNodeData) => {
    if (disabled) return;
    setSelectedPath(node.path);
  }, [disabled]);

  const handleRightClick = useCallback((node: TreeNodeData, event: React.MouseEvent) => {
    if (disabled) return;
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      node,
    });
  }, [disabled]);

  const handleContextAction = (action: string, node: TreeNodeData) => {
    if (disabled) return;
    setContextMenu(null);
    if (action === 'refresh') {
      if (kernelId) invalidateTree(kernelId);
      return;
    }
    onAction?.(action, node);
  };

  const flatNodes = useMemo(
    () => flattenFromCache(childrenByPath, expandedPaths, loadingPaths),
    [childrenByPath, expandedPaths, loadingPaths],
  );

  const rowProps = useMemo<VirtualRowProps>(() => ({
    flatNodes,
    selectedPath,
    onExpand: handleExpand,
    onDoubleClick: handleDoubleClick,
    onRightClick: handleRightClick,
    onClick: handleSelect,
  }), [flatNodes, selectedPath, handleExpand, handleDoubleClick, handleRightClick, handleSelect]);

  // Scroll the virtualised list to keep the selected node visible
  // when selection changes (but not on expand/collapse).
  const prevSelectedPath = useRef(selectedPath);
  useEffect(() => {
    if (selectedPath && selectedPath !== prevSelectedPath.current && listRef.current) {
      const idx = flatNodes.findIndex((n) => n.path === selectedPath);
      if (idx >= 0) {
        listRef.current.scrollToRow({ index: idx, align: 'smart' });
      }
    }
    prevSelectedPath.current = selectedPath;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only scroll on selection change, not on flatNodes change
  }, [selectedPath]);

  const selectedNode = selectedPath !== null ? flatNodes.find((n) => n.path === selectedPath) : undefined;

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Prevent Space from triggering browser button-click on focused tree rows
    if (event.key === ' ') {
      event.preventDefault();
      return;
    }

    // Arrow-key navigation through the visible flattened tree.
    // Up/Down: move selection by one row. Right: expand a collapsed
    // branch, or step into the first child of an expanded one.
    // Left: collapse an expanded branch, or step up to the parent.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (disabled || flatNodes.length === 0) return;
      event.preventDefault();
      if (!selectedNode) {
        setSelectedPath(flatNodes[0].path);
        return;
      }
      const currentIdx = flatNodes.findIndex((n) => n.path === selectedNode.path);
      if (currentIdx < 0) {
        setSelectedPath(flatNodes[0].path);
        return;
      }
      const nextIdx = event.key === 'ArrowDown'
        ? Math.min(flatNodes.length - 1, currentIdx + 1)
        : Math.max(0, currentIdx - 1);
      setSelectedPath(flatNodes[nextIdx].path);
      return;
    }
    if (event.key === 'ArrowRight' && selectedNode && !disabled) {
      event.preventDefault();
      if (selectedNode.hasChildren && !selectedNode.isExpanded) {
        handleExpand(selectedNode);
      } else if (selectedNode.isExpanded) {
        const children = childrenByPath.get(selectedNode.path);
        if (children && children.length > 0) {
          setSelectedPath(children[0].path);
        }
      }
      return;
    }
    if (event.key === 'ArrowLeft' && selectedNode && !disabled) {
      event.preventDefault();
      if (selectedNode.isExpanded && selectedNode.hasChildren) {
        handleExpand(selectedNode);
      } else if (selectedNode.parentPath !== null) {
        // Step up to parent. parentPath of '' means the synthetic root row.
        setSelectedPath(selectedNode.parentPath);
      }
      return;
    }

    if (!selectedNode || disabled) return;
    const nativeEvent = event.nativeEvent;

    if (matchesShortcut(nativeEvent, shortcuts.treeCopyPath)) {
      event.preventDefault();
      await navigator.clipboard.writeText(selectedNode.path);
      onAction?.('copy_path', selectedNode);
      return;
    }

    const editableTypes = ['script', 'namelist', 'lib'];
    if (editableTypes.includes(selectedNode.type) && matchesShortcut(nativeEvent, shortcuts.treeEditScript)) {
      event.preventDefault();
      onAction?.('edit', selectedNode);
      return;
    }

    if (matchesShortcut(nativeEvent, shortcuts.treePrint)) {
      event.preventDefault();
      onAction?.('print', selectedNode);
    }
  };

  return (
    <div className="tree-container" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="tree-header">
        <span className="tree-col key">Key</span>
        <span className="tree-col type">Type</span>
        <span className="tree-col preview">Preview</span>
      </div>

      <div className="tree-content">
        {/* "Starting kernel…" is only honest while a kernel is actually
            starting. With no kernel at all (fresh window, or a session
            swap that left none) the same text read as "PDV is doing
            something" when nothing was — a real user was misled by it. */}
        {disabled && (
          <div className="tree-loading">
            {startingKernel ? 'Starting kernel...' : 'No active session'}
          </div>
        )}
        {!disabled && loading && (
          <div className="tree-loading">
            <span className="spinner" role="status" aria-label="Loading">
              <span aria-hidden="true">⏳</span>
            </span>
            {' '}Loading...
          </div>
        )}
        {error && <div className="tree-error">{error}</div>}

        {!disabled && !loading && !error && flatNodes.length > 0 && (
          <List
            listRef={listRef}
            rowComponent={VirtualRow}
            rowCount={flatNodes.length}
            rowHeight={ROW_HEIGHT}
            rowProps={rowProps}
            overscanCount={5}
            style={{ flex: 1 }}
          />
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          shortcuts={shortcuts}
          onAction={handleContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
