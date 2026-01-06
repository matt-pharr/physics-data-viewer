import React, { useEffect, useMemo, useState } from 'react';
import { treeService, type TreeNodeData } from '../../services/tree';
import { TreeNodeRow } from './TreeNodeRow';
import { ContextMenu } from './ContextMenu';

interface TreeProps {
  kernelId: string | null;
  refreshToken?: number;
  onAction?: (action: string, node: TreeNodeData) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNodeData;
}

export const Tree: React.FC<TreeProps> = ({ kernelId, refreshToken = 0, onAction }) => {
  const [nodes, setNodes] = useState<TreeNodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const loadRoot = async (force?: boolean) => {
    setLoading(true);
    setError(undefined);
    if (!kernelId) {
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
      setNodes(rootNodes);
    } catch (err) {
      console.error('[Tree] Failed to load root nodes', err);
      setError('Failed to load tree');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRoot(true);
  }, [kernelId, refreshToken]);

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
    if (!kernelId) return;
    if (node.isExpanded) {
      setNodes((prev) => updateNode(prev, node.path, (n) => ({ ...n, isExpanded: false })));
      return;
    }

    setNodes((prev) => updateNode(prev, node.path, (n) => ({ ...n, isLoading: true })));
    try {
      const children = await treeService.getChildren(node, kernelId);
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

  const handleRightClick = (node: TreeNodeData, event: React.MouseEvent) => {
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      node,
    });
  };

  const handleContextAction = (action: string, node: TreeNodeData) => {
    setContextMenu(null);
    if (action === 'refresh') {
      void loadRoot(true);
      return;
    }
    onAction?.(action, node);
  };

  const flatNodes = useMemo(() => flattenTree(nodes), [nodes]);

  return (
    <div className="tree-container">
      <div className="tree-header">
        <span className="tree-col key">Key</span>
        <span className="tree-col type">Type</span>
        <span className="tree-col preview">Preview</span>
      </div>

      <div className="tree-content">
        {loading && <div className="tree-loading">Loading...</div>}
        {error && <div className="tree-error">{error}</div>}
        {!loading && !error && flatNodes.length === 0 && <div className="tree-empty">No data</div>}

        {!loading &&
          !error &&
          flatNodes.map((node) => (
            <TreeNodeRow
              key={node.id}
              node={node}
              onExpand={handleExpand}
              onDoubleClick={handleDoubleClick}
              onRightClick={handleRightClick}
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
