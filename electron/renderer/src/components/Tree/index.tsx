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
import { findNode, flattenTree, removeNodeImmut, updateNodeImmut } from './tree-utils';
import type { TreeChangeInfo } from '../../types';
import { TREE_PERSIST_DEBOUNCE_MS } from '../../app/constants';
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
const VirtualRow = React.memo(({ index, style, flatNodes, selectedPath, onExpand, onDoubleClick, onRightClick, onClick }: RowComponentProps<VirtualRowProps>) => {
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
  
  const getInitialExpandedPaths = (): Set<string> => {
    try {
      const stored = localStorage.getItem('pdv:expandedPaths');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  };
  
  const expandedPathsRef = useRef<Set<string>>(getInitialExpandedPaths());
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
      const restored = await restoreExpandedTree(rootNodes, expandedPathsRef.current, kernelId);

      // Wrap in a synthetic root node so there is always a right-clickable
      // container even when the tree is empty.
      const rootIsExpanded = expandedPathsRef.current.has('') || restored.length > 0;
      if (rootIsExpanded) expandedPathsRef.current.add('');
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
        isExpanded: rootIsExpanded,
        children: restored,
      };
      setNodes([syntheticRoot]);
    } catch (err) {
      console.error('[Tree] Failed to load root nodes', err);
      setError('Failed to load tree');
    } finally {
      setLoading(false);
    }
  };

  // Persist expanded paths to localStorage whenever they change
  // We trigger this by watching nodes, but use a ref callback to debounce
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      try {
        localStorage.setItem('pdv:expandedPaths', JSON.stringify(Array.from(expandedPathsRef.current)));
      } catch (error) {
        console.warn('Failed to persist expanded paths:', error);
      }
    }, TREE_PERSIST_DEBOUNCE_MS);
    
    return () => clearTimeout(timeoutId);
  }, [nodes]); // Save whenever nodes change (expand/collapse)

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
        if (change_type === 'removed') {
          treeService.invalidatePath(kernelId, parentPath);
        } else {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- nodesRef used instead of nodes to avoid re-triggering
  }, [pendingChanges, kernelId, disabled, onChangesConsumed]);

  const handleExpand = useCallback(async (node: TreeNodeData) => {
    if (!kernelId || disabled) return;
    if (node.isExpanded) {
      setNodes((prev) => updateNodeImmut(prev, node.path, (n) => ({ ...n, isExpanded: false })));
      expandedPathsRef.current.delete(node.path);
      return;
    }

    expandedPathsRef.current.add(node.path);
    setNodes((prev) => updateNodeImmut(prev, node.path, (n) => ({ ...n, isLoading: true })));
    try {
      const children = await treeService.getChildren(node, kernelId, {
        force: true,
      });
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
      console.error('[Tree] Failed to load children for', node.key, err);
      setError(`Failed to load children for ${node.key}`);
      setNodes((prev) => updateNodeImmut(prev, node.path, (n) => ({ ...n, isLoading: false })));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Scroll the virtualised list to keep the selected node visible.
  useEffect(() => {
    if (selectedPath && listRef.current) {
      const idx = flatNodes.findIndex((n) => n.path === selectedPath);
      if (idx >= 0) {
        listRef.current.scrollToRow({ index: idx, align: 'smart' });
      }
    }
  }, [selectedPath, flatNodes]);

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

async function restoreExpandedTree(
  rootNodes: TreeNodeData[],
  expanded: Set<string>,
  kernelId: string,
): Promise<TreeNodeData[]> {
  let current = rootNodes;
  const paths = Array.from(expanded).sort((a, b) => a.split('.').length - b.split('.').length);

  for (const path of paths) {
    const target = findNode(current, path);
    if (!target) continue;
    try {
      const children = await treeService.getChildren(target, kernelId, {
        force: true,
      });
      current = updateNodeImmut(current, path, (n) => ({ ...n, isExpanded: true, children }));
    } catch (error) {
      console.warn('[Tree] Failed to restore expanded path', path, error);
    }
  }

  return current;
}
