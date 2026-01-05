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

interface TreeNodeRowProps {
  node: TreeNodeData & { depth: number };
  depth: number;
  onExpand: (node: TreeNodeData) => void;
  onDoubleClick: (node: TreeNodeData) => void;
  onRightClick: (node: TreeNodeData, event: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

export const TreeNodeRow: React.FC<TreeNodeRowProps> = ({
  node,
  depth,
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
      <div className="tree-col key" style={{ paddingLeft: depth * 20 }}>
        <button
          className="tree-toggle"
          onClick={handleExpandClick}
          disabled={!node.hasChildren}
          style={{ visibility: node.hasChildren ? 'visible' : 'hidden' }}
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
