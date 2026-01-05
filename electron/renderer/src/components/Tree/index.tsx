import React, { useEffect, useMemo, useState } from 'react';
import { treeService, type TreeNodeData } from '../../services/tree';
import { TreeNodeRow } from './TreeNodeRow';
import { ContextMenu } from './ContextMenu';

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNodeData;
}

export const Tree: React.FC = () => {
  const [nodes, setNodes] = useState<TreeNodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(undefined);
      try {
        const rootNodes = await treeService.getRootNodes();
        if (mounted) {
          setNodes(rootNodes);
        }
      } catch (err) {
        console.error('[Tree] Failed to load root nodes', err);
        if (mounted) {
          setError('Failed to load tree');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      mounted = false;
    };
  }, []);

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
    if (node.isExpanded) {
      setNodes((prev) => updateNode(prev, node.path, (n) => ({ ...n, isExpanded: false })));
      return;
    }

    setNodes((prev) => updateNode(prev, node.path, (n) => ({ ...n, isLoading: true })));
    try {
      const children = await treeService.getChildren(node);
      setNodes((prev) =>
        updateNode(prev, node.path, (n) => ({
          ...n,
          isExpanded: true,
          isLoading: false,
          children,
        })),
      );
    } catch (err) {
      console.error('[Tree] Failed to load children for', node.path, err);
      setError('Failed to load children');
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
    console.log('[Tree] Action:', action, node);
    setContextMenu(null);
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
              depth={node.depth}
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
