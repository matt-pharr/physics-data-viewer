/**
 * TreeNodeRow — presentational row for one tree node.
 *
 * Handles row click/double-click/context interactions and expand toggling while
 * delegating all data mutations to parent callbacks.
 */

import React from 'react';
import type { TreeNodeData } from '../../types';

const TYPE_ICONS: Record<string, string> = {
  root: '🌳',
  folder: '📁',
  file: '📄',
  script: '📜',
  markdown: '📝',
  ndarray: '🔢',
  dataframe: '📊',
  series: '📈',
  dict: '🗂️',
  list: '🧾',
  tuple: '🧾',
  set: '🧾',
  string: '🔤',
  number: '#️⃣',
  boolean: '✔️',
  none: '∅',
  image: '🖼️',
  json: '{ }',
  python: '🐍',
  julia: '🔴',
  unknown: '❓',
};

interface TreeNodeRowProps {
  node: TreeNodeData & { depth: number; selected?: boolean };
  onExpand: (node: TreeNodeData) => void;
  onDoubleClick: (node: TreeNodeData) => void;
  onRightClick: (node: TreeNodeData, event: React.MouseEvent) => void;
  onClick: (node: TreeNodeData) => void;
  style?: React.CSSProperties;
}

/** Render one row in the tree table view. */
export const TreeNodeRow: React.FC<TreeNodeRowProps> = ({
  node,
  onExpand,
  onDoubleClick,
  onRightClick,
  onClick,
  style,
}) => {
  const icon = TYPE_ICONS[node.type] || TYPE_ICONS.unknown;
  const toggleLabel = node.hasChildren
    ? node.isExpanded
      ? `Collapse ${node.key}`
      : `Expand ${node.key}`
    : `${node.key} has no children`;
  const indent = `calc(${node.depth || 0} * var(--tree-indent-size))`;

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.hasChildren) {
      onExpand(node);
    }
  };

  return (
    <div
      className={`tree-row ${node.selected ? 'selected' : ''}`}
      style={style}
      onDoubleClick={() => onDoubleClick(node)}
      onClick={() => onClick(node)}
      onContextMenu={(e) => {
        e.preventDefault();
        onRightClick(node, e);
      }}
    >
      <div className="tree-col key" style={{ paddingLeft: indent }}>
        <button
          className={`tree-toggle ${node.hasChildren ? '' : 'hidden'}`}
          onClick={handleExpandClick}
          disabled={!node.hasChildren}
          aria-label={toggleLabel}
        >
          {node.isLoading ? (
            <span className="spinner" role="status" aria-label="Loading children">
              <span aria-hidden="true">⏳</span>
            </span>
          ) : node.isExpanded ? (
            <span aria-hidden="true">▼</span>
          ) : (
            <span aria-hidden="true">▶</span>
          )}
        </button>

        <span className="tree-icon">{icon}</span>
        <span className="tree-key-text">{node.key}</span>
      </div>

      <div className="tree-col type">
        <span className="tree-type-badge">{node.type}</span>
        {node.language && <span className="tree-type-badge subtle">{node.language}</span>}
      </div>

      <div className="tree-col preview">{node.preview || '—'}</div>
    </div>
  );
};
