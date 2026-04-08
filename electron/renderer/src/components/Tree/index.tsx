/**
 * Tree panel — browsable view of `pdv_tree` descriptors.
 *
 * Fetches root/child nodes via `treeService`, preserves expansion/selection
 * state in localStorage, and exposes context-menu actions back to `App`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import { treeService, type TreeNodeData } from '../../services/tree';
import { TreeNodeRow } from './TreeNodeRow';
import { ContextMenu } from './ContextMenu';
import { flattenTree, findNode, removeNodeImmut, updateNodeImmut } from './tree-utils';
import type { TreeChangeInfo } from '../../types';
import type { Shortcuts } from '../../shortcuts';
import { matchesShortcut } from '../../shortcuts';

const ROW_HEIGHT = 32;

/** Props passed to VirtualRow via react-window's rowProps. */
interface VirtualRowProps {
  flatNodes: Array<TreeNodeData & { depth: number }>;
  selectedPath: string | null;
  onExpand: (node: TreeNodeData) => void;
  onDoubleClick: (node: TreeNodeData) => void;
  onRightClick: (node: TreeNodeData, event: React.MouseEvent) => void;
  onClick: (node: TreeNodeData) => void;
}

/** Module-level row renderer for react-window v2. */
const VirtualRow = React.memo(({ index, style, ariaAttributes, flatNodes, selectedPath, onExpand, onDoubleClick, onRightClick, onClick }: RowComponentProps<VirtualRowProps>) => {
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
});

interface TreeProps {
  kernelId: string | null;
  disabled?: boolean;
  refreshToken?: number;
  pendingChanges?: TreeChangeInfo[];
  onChangesConsumed?: () => void;
  onAction?: (action: string, node: TreeNodeData) => void;
  shortcuts: Shortcuts;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNodeData;
}

/** Tree browser component for node navigation and node actions. */
export const Tree: React.FC<TreeProps> = ({ kernelId, disabled = false, refreshToken = 0, pendingChanges, onChangesConsumed, onAction, shortcuts }) => {
  const [nodes, setNodes] = useState<TreeNodeData[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem('pdv:selectedPath');
      return stored !== null ? stored : null;
    } catch {
      return null;
    }
  });
  
  const expandedPathsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<ListImperativeAPI>(null);

  const loadRoot = async (force?: boolean) => {
    setLoading(nodes.length === 0);
    setError(undefined);
    if (!kernelId || disabled) {
      setNodes([]);
      setLoading(false);
      setError(undefined);
      return;
    }
    if (force) {
      treeService.clearCache(kernelId);
    }
    try {
      const rootNodes = await treeService.getRootNodes(kernelId, { force });

      // Preserve the set of previously expanded paths so the tree doesn't
      // collapse on every refresh. Paths that no longer exist in the new tree
      // are pruned after re-expansion.
      const previouslyExpanded = expandedPathsRef.current;
      const newExpanded = new Set(['']);

      // Re-expand previously open nodes by depth (parents before children)
      // so each level's children are available for the next level.
      const sortedPaths = Array.from(previouslyExpanded)
        .filter((p) => p !== '')
        .sort((a, b) => a.split('.').length - b.split('.').length);

      // Build a lookup from path → node for the freshly-fetched root children.
      const nodeMap = new Map<string, TreeNodeData>();
      for (const n of rootNodes) nodeMap.set(n.path, n);

      for (const expandPath of sortedPaths) {
        const target = nodeMap.get(expandPath);
        if (!target || !target.hasChildren) continue;
        try {
          const children = await treeService.getChildren(target, kernelId, { force });
          target.isExpanded = true;
          target.children = children;
          newExpanded.add(expandPath);
          for (const child of children) nodeMap.set(child.path, child);
        } catch {
          // Node may have been removed — skip silently.
        }
      }

      expandedPathsRef.current = newExpanded;

      // Wrap in a synthetic root node so there is always a right-clickable
      // container even when the tree is empty.
      const syntheticRoot: TreeNodeData = {
        id: '__root__',
        key: 'pdv_tree',
        path: '',
        parent_path: null,
        type: 'root',
        has_children: true,
        preview: '',
        hasChildren: true,
        parentPath: null,
        isExpanded: true,
        children: rootNodes,
      };
      setNodes([syntheticRoot]);
    } catch (err) {
      console.error('[Tree] Failed to load root nodes', err);
      setError('Failed to load tree');
    } finally {
      setLoading(false);
    }
  };

  // Persist selected path to localStorage
  useEffect(() => {
    try {
      if (selectedPath !== null) {
        localStorage.setItem('pdv:selectedPath', selectedPath);
      } else {
        localStorage.removeItem('pdv:selectedPath');
      }
    } catch (error) {
      console.warn('Failed to persist selected path:', error);
    }
  }, [selectedPath]);

  useEffect(() => {
    void loadRoot(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadRoot is stable for given kernelId; real triggers are kernelId/refreshToken/disabled
  }, [kernelId, refreshToken, disabled]);

  // Incremental tree update from push notifications — avoids full reload.
  // Processes a queue of changes so rapid successive updates are not lost.
  useEffect(() => {
    if (!pendingChanges || pendingChanges.length === 0 || !kernelId || disabled) return;
    // Consume the entire queue in one pass.
    const changes = pendingChanges;
    onChangesConsumed?.();

    // Collect all removals and parent paths to refresh across the batch.
    const removals: string[] = [];
    const parentsToRefresh = new Set<string>();

    for (const { changed_paths, change_type } of changes) {
      if (change_type === 'removed') {
        removals.push(...changed_paths);
      }
      for (const changedPath of changed_paths) {
        const dotIdx = changedPath.lastIndexOf('.');
        const parentPath = dotIdx > 0 ? changedPath.substring(0, dotIdx) : '';
        // Invalidate cache for removed paths and batch (which may contain removals).
        if (change_type === 'removed' || change_type === 'batch') {
          treeService.invalidatePath(kernelId, parentPath);
        }
        // For batch, added, or updated: re-fetch the parent.
        if (change_type !== 'removed') {
          parentsToRefresh.add(parentPath);
        }
      }
    }

    // Apply removals synchronously.
    if (removals.length > 0) {
      setNodes((prev) => {
        let updated = prev;
        for (const path of removals) {
          updated = removeNodeImmut(updated, path);
        }
        return updated;
      });
    }

    // Re-fetch parents of added/updated paths (only if expanded).
    if (parentsToRefresh.size > 0) {
      const refreshParents = async () => {
        for (const parentPath of parentsToRefresh) {
          if (parentPath !== '' && !expandedPathsRef.current.has(parentPath)) continue;

          // Read current nodes via ref to avoid stale closure.
          const parentNode = parentPath === '' ? null : findNode(nodesRef.current, parentPath);
          let children: TreeNodeData[];
          if (parentPath === '') {
            children = await treeService.getRootNodes(kernelId, { force: true });
          } else if (parentNode) {
            children = await treeService.getChildren(parentNode, kernelId, { force: true });
          } else {
            continue;
          }

          if (parentPath === '') {
            setNodes((prev) => updateNodeImmut(prev, '', (n) => ({ ...n, children })));
          } else {
            setNodes((prev) => updateNodeImmut(prev, parentPath, (n) => ({ ...n, children, isExpanded: true })));
          }
        }
      };
      void refreshParents();
    }
  }, [pendingChanges, kernelId, disabled, onChangesConsumed]);

  const handleExpand = useCallback(async (node: TreeNodeData) => {
    if (!kernelId || disabled) return;
    if (node.isExpanded) {
      // Collapse: discard children and clear all descendant expanded paths.
      setNodes((prev) => updateNodeImmut(prev, node.path, (n) => ({ ...n, isExpanded: false, children: undefined })));
      const prefix = node.path ? node.path + '.' : '';
      for (const p of Array.from(expandedPathsRef.current)) {
        if (p === node.path || (prefix && p.startsWith(prefix))) {
          expandedPathsRef.current.delete(p);
        }
      }
      return;
    }

    expandedPathsRef.current.add(node.path);
    // Show spinner only if the fetch takes longer than 1s to avoid flashing.
    const loadingTimer = setTimeout(() => {
      setNodes((prev) => updateNodeImmut(prev, node.path, (n) => ({ ...n, isLoading: true })));
    }, 1000);
    try {
      const children = await treeService.getChildren(node, kernelId, {
        force: true,
      });
      clearTimeout(loadingTimer);
      expandedPathsRef.current.add(node.path);
      setNodes((prev) =>
        updateNodeImmut(prev, node.path, (n) => ({
          ...n,
          isExpanded: true,
          isLoading: false,
          children,
        })),
      );
    } catch (err) {
      clearTimeout(loadingTimer);
      console.error('[Tree] Failed to load children for', node.key, err);
      setError(`Failed to load children for ${node.key}`);
      setNodes((prev) => updateNodeImmut(prev, node.path, (n) => ({ ...n, isLoading: false })));
    }
  }, [kernelId, disabled]);

  const handleDoubleClick = useCallback((node: TreeNodeData) => {
    if (disabled) return;
    if (node.type === 'module' || node.type === 'gui') {
      onAction?.('open_gui', node);
      return;
    }
    if (node.has_handler) {
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
      void loadRoot(true);
      return;
    }
    onAction?.(action, node);
  };

  const flatNodes = useMemo(() => flattenTree(nodes), [nodes]);

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
        {disabled && <div className="tree-loading">Starting kernel...</div>}
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

