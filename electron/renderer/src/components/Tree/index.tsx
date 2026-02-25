import React, { useEffect, useMemo, useRef, useState } from 'react';
import { treeService, type TreeNodeData } from '../../services/tree';
import { TreeNodeRow } from './TreeNodeRow';
import { ContextMenu } from './ContextMenu';

interface TreeProps {
  kernelId: string | null;
  disabled?: boolean;
  refreshToken?: number;
  onAction?: (action: string, node: TreeNodeData) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNodeData;
}

export const Tree: React.FC<TreeProps> = ({ kernelId, disabled = false, refreshToken = 0, onAction }) => {
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
      const rootNodes = await treeService.getRootNodes(kernelId);
      const restored = await restoreExpandedTree(rootNodes, expandedPathsRef.current, kernelId);
      setNodes(restored);
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
    }, 500); // Debounce saves to avoid excessive writes
    
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

  const updateNode = (list: TreeNodeData[], path: string, updater: (n: TreeNodeData) => TreeNodeData) =>
    list.map((node) => {
      if (node.path === path) {
        return updater(node);
      }
      if (node.children) {
        return { ...node, children: updateNode(node.children, path, updater) };
      }
      return node;
    });

  const handleExpand = async (node: TreeNodeData) => {
    if (!kernelId || disabled) return;
    if (node.isExpanded) {
      setNodes((prev) => updateNode(prev, node.path, (n) => ({ ...n, isExpanded: false })));
      expandedPathsRef.current.delete(node.path);
      return;
    }

    expandedPathsRef.current.add(node.path);
    setNodes((prev) => updateNode(prev, node.path, (n) => ({ ...n, isLoading: true })));
    try {
      const children = await treeService.getChildren(node, kernelId);
      expandedPathsRef.current.add(node.path);
      setNodes((prev) =>
        updateNode(prev, node.path, (n) => ({
          ...n,
          isExpanded: true,
          isLoading: false,
          children,
        })),
      );
    } catch (err) {
      console.error('[Tree] Failed to load children for', node.key, err);
      setError(`Failed to load children for ${node.key}`);
      setNodes((prev) => updateNode(prev, node.path, (n) => ({ ...n, isLoading: false })));
    }
  };

  const handleDoubleClick = (node: TreeNodeData) => {
    console.log('[Tree] Double-clicked:', node);
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
    if (!selectedNode || disabled) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      await navigator.clipboard.writeText(selectedNode.path);
      onAction?.('copy_path', selectedNode);
      return;
    }

    if (selectedNode.type === 'script' && (event.key === ' ' || event.key.toLowerCase() === 'e')) {
      event.preventDefault();
      onAction?.('edit', selectedNode);
      return;
    }

    if (event.key.toLowerCase() === 'p') {
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
        {!disabled && loading && <div className="tree-loading">Loading...</div>}
        {error && <div className="tree-error">{error}</div>}
        {!disabled && !loading && !error && flatNodes.length === 0 && <div className="tree-empty">No data</div>}

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
          onAction={handleContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};

function flattenTree(nodes: TreeNodeData[], depth = 0): Array<TreeNodeData & { depth: number }> {
  const result: Array<TreeNodeData & { depth: number }> = [];

  for (const node of nodes) {
    result.push({ ...node, depth });
    if (node.isExpanded && node.children) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }

  return result;
}

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
      const children = await treeService.getChildren(target, kernelId);
      current = updateNodeImmut(current, path, (n) => ({ ...n, isExpanded: true, children }));
    } catch (error) {
      console.warn('[Tree] Failed to restore expanded path', path, error);
    }
  }

  return current;
}

function findNode(nodes: TreeNodeData[], path: string): TreeNodeData | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function updateNodeImmut(
  list: TreeNodeData[],
  path: string,
  updater: (n: TreeNodeData) => TreeNodeData,
): TreeNodeData[] {
  return list.map((node) => {
    if (node.path === path) {
      return updater(node);
    }
    if (node.children) {
      return { ...node, children: updateNodeImmut(node.children, path, updater) };
    }
    return node;
  });
}
