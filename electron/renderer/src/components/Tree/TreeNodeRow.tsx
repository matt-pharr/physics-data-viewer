import React from 'react';
import type { TreeNodeData } from '../../types';

const TYPE_ICONS: Record<string, string> = {
  folder: '📁',
  file: '📄',
  ndarray: '🔢',
  dataframe: '📊',
  image: '🖼️',
  json: '{ }',
  python: '🐍',
  julia: '🔴',
  unknown: '❓',
};

const TREE_INDENT_SIZE = 20;

interface TreeNodeRowProps {
  node: TreeNodeData & { depth: number };
  onExpand: (node: TreeNodeData) => void;
  onDoubleClick: (node: TreeNodeData) => void;
  onRightClick: (node: TreeNodeData, event: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

export const TreeNodeRow: React.FC<TreeNodeRowProps> = ({
  node,
  onExpand,
  onDoubleClick,
  onRightClick,
  style,
}) => {
  const icon = TYPE_ICONS[node.type] || TYPE_ICONS.unknown;

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.hasChildren) {
      onExpand(node);
    }
  };

  return (
    <div
      className="tree-row"
      style={style}
      onDoubleClick={() => onDoubleClick(node)}
      onContextMenu={(e) => {
        e.preventDefault();
        onRightClick(node, e);
      }}
    >
      <div className="tree-col key" style={{ paddingLeft: (node.depth || 0) * TREE_INDENT_SIZE }}>
        <button
          className={`tree-toggle ${node.hasChildren ? '' : 'hidden'}`}
          onClick={handleExpandClick}
          disabled={!node.hasChildren}
        >
          {node.isLoading ? <span className="spinner">⏳</span> : node.isExpanded ? '▼' : '▶'}
        </button>

        <span className="tree-icon">{icon}</span>
        <span className="tree-key-text">{node.key}</span>
      </div>

      <div className="tree-col type">
        <span className="tree-type-badge">{node.type}</span>
      </div>

      <div className="tree-col preview">{node.preview || '—'}</div>
    </div>
  );
};
