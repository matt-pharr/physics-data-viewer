/**
 * Tree panel — browsable view of `pdv_tree` descriptors.
 *
 * Fetches root/child nodes via `treeService`, preserves expansion/selection
 * state in localStorage, and exposes context-menu actions back to `App`.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { treeService, type TreeNodeData } from '../../services/tree';
import { TreeNodeRow } from './TreeNodeRow';
import { ContextMenu } from './ContextMenu';
import { findNode, flattenTree, updateNodeImmut } from './tree-utils';
import { TREE_PERSIST_DEBOUNCE_MS } from '../../app/constants';
import type { Shortcuts } from '../../shortcuts';
import { matchesShortcut } from '../../shortcuts';

interface TreeProps {
  kernelId: string | null;
  disabled?: boolean;
  refreshToken?: number;
  onAction?: (action: string, node: TreeNodeData) => void;
  shortcuts: Shortcuts;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNodeData;
}

/** Tree browser component for node navigation and node actions. */
export const Tree: React.FC<TreeProps> = ({ kernelId, disabled = false, refreshToken = 0, onAction, shortcuts }) => {
  const [nodes, setNodes] = useState<TreeNodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(() => {
    try {
      return localStorage.getItem('pdv:selectedPath') || null;
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
        lazy: false,
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
      if (selectedPath) {
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
  }, [kernelId, refreshToken, disabled]);

  const handleExpand = async (node: TreeNodeData) => {
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
        eagerLoadLazy: true,
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
      void loadRoot(true);
    } catch (err) {
      console.error('[Tree] Failed to load children for', node.key, err);
      setError(`Failed to load children for ${node.key}`);
      setNodes((prev) => updateNodeImmut(prev, node.path, (n) => ({ ...n, isLoading: false })));
    }
  };

  const handleDoubleClick = (node: TreeNodeData) => {
    if (disabled) return;
    if (node.type === 'markdown') {
      onAction?.('open_note', node);
    } else if (node.type === 'script') {
      onAction?.('run', node);
    }
  };

  const handleSelect = (node: TreeNodeData) => {
    if (disabled) return;
    setSelectedPath(node.path);
  };

  const handleRightClick = (node: TreeNodeData, event: React.MouseEvent) => {
    if (disabled) return;
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      node,
    });
  };

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

  const selectedNode = selectedPath ? flatNodes.find((n) => n.path === selectedPath) : undefined;

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

    if (selectedNode.type === 'script' && matchesShortcut(nativeEvent, shortcuts.treeEditScript)) {
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

        {!disabled &&
          !loading &&
          !error &&
          flatNodes.map((node) => (
              <TreeNodeRow
                key={node.id}
                node={{ ...node, selected: node.path === selectedPath }}
                onExpand={handleExpand}
                onDoubleClick={handleDoubleClick}
                onRightClick={handleRightClick}
                onClick={handleSelect}
              />
            ))}
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
        eagerLoadLazy: true,
      });
      current = updateNodeImmut(current, path, (n) => ({ ...n, isExpanded: true, children }));
    } catch (error) {
      console.warn('[Tree] Failed to restore expanded path', path, error);
    }
  }

  return current;
}
