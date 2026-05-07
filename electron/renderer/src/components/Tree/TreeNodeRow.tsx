/**
 * TreeNodeRow — presentational row for one tree node.
 *
 * Handles row click/double-click/context interactions and expand toggling while
 * delegating all data mutations to parent callbacks.
 */

import React from 'react';
import type { TreeNodeData } from '../../types';

// Keys must match the canonical NodeKindValue union from pdv-protocol.ts
// (`mapping`, `sequence`, `text`, `scalar`, `binary`, etc.). The 'root' key
// is the synthetic Tree-panel root row. Anything else falls back to 'unknown'.
const TYPE_ICONS: Record<string, string> = {
  root: '🌳',
  folder: '📁',
  file: '📄',
  script: '📜',
  markdown: '📝',
  ndarray: '🔢',
  dataframe: '📊',
  series: '📈',
  mapping: '🗂️',
  sequence: '🧾',
  text: '🔤',
  scalar: '#️⃣',
  binary: '🧬',
  namelist: '📋',
  module: '📦',
  gui: '🖼️',
  lib: '📚',
  unknown: '❓',
};

/** Types that are containers (have or can have children). Drives the
 *  branch-vs-leaf visual distinction in tree.css (heavier name weight,
 *  elevated row background). Add new container types here if/when added. */
const BRANCH_TYPES = new Set<string>(['root', 'folder', 'mapping', 'sequence', 'module', 'lib']);

/** User-facing label rendered in the Type chip. Shows the Python class
 *  name for built-in data (`np.ndarray`, `pd.DataFrame`, `str`, …) since
 *  that matches how users construct those values, and a friendly noun
 *  for PDV concepts (`script`, `note`, …) since the implementing class
 *  name (`PDVScript`) is jargon the user doesn't need in this column.
 *  Unknown nodes fall back to the descriptor's `python_type` field. */
const DISPLAY_LABELS: Record<string, string> = {
  root: 'root',
  folder: 'folder',
  mapping: 'dict',
  sequence: 'list',
  ndarray: 'np.ndarray',
  dataframe: 'pd.DataFrame',
  series: 'pd.Series',
  scalar: 'scalar',
  text: 'str',
  binary: 'bytes',
  script: 'script',
  markdown: 'note',
  namelist: 'namelist',
  file: 'file',
  gui: 'gui',
  module: 'module',
  lib: 'lib',
};

/** Kinds whose wire `type` is intentionally generic — the chip should
 *  show the exact Python class from `python_type` instead so users see
 *  e.g. `int` vs `float`, `list` vs `tuple`, or the actual class name
 *  for unclassified values. The `DISPLAY_LABELS` entries for these
 *  kinds remain as a safety-net fallback when `python_type` is absent. */
const USE_PYTHON_TYPE = new Set<string>(['unknown', 'scalar', 'sequence']);

/** Display overrides for Python type names that read awkwardly when shown
 *  literally. `type(None).__name__` is `NoneType`, but every Python user
 *  thinks of it as `None`. */
const PYTHON_TYPE_OVERRIDES: Record<string, string> = {
  NoneType: 'None',
};

/** Strip the `builtins.` module prefix from a fully qualified
 *  Python type so e.g. `builtins.int` reads as `int`. */
function stripBuiltinsPrefix(qualified: string): string {
  return qualified.startsWith('builtins.') ? qualified.slice('builtins.'.length) : qualified;
}

/** Compute the chip label, preferring `pythonType` for kinds in
 *  {@link USE_PYTHON_TYPE} and falling back to the generic label. */
function resolveTypeLabel(type: string, pythonType?: string): string {
  if (USE_PYTHON_TYPE.has(type) && pythonType) {
    const stripped = stripBuiltinsPrefix(pythonType);
    return PYTHON_TYPE_OVERRIDES[stripped] ?? stripped;
  }
  return DISPLAY_LABELS[type] ?? type;
}

interface TreeNodeRowProps {
  node: TreeNodeData & { depth: number };
  /** Position in the virtualized flat list. Used for absolute-row striping. */
  index?: number;
  selected?: boolean;
  onExpand: (node: TreeNodeData) => void;
  onDoubleClick: (node: TreeNodeData) => void;
  onRightClick: (node: TreeNodeData, event: React.MouseEvent) => void;
  onClick: (node: TreeNodeData) => void;
  style?: React.CSSProperties;
  ariaAttributes?: Record<string, unknown>;
}

/** Render one row in the tree table view. */
const TreeNodeRowInner: React.FC<TreeNodeRowProps> = ({
  node,
  index,
  selected,
  onExpand,
  onDoubleClick,
  onRightClick,
  onClick,
  style,
  ariaAttributes,
}) => {
  const icon = TYPE_ICONS[node.type] || TYPE_ICONS.unknown;
  const toggleLabel = node.hasChildren
    ? node.isExpanded
      ? `Collapse ${node.key}`
      : `Expand ${node.key}`
    : `${node.key} has no children`;
  const indent = `calc(${node.depth || 0} * var(--tree-indent-size))`;
  const isBranch = BRANCH_TYPES.has(node.type);
  const parityClass = typeof index === 'number' && index % 2 === 1 ? 'odd' : 'even';

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.hasChildren) {
      onExpand(node);
    }
  };

  return (
    <div
      className={`tree-row ${parityClass} ${isBranch ? 'branch' : 'leaf'}${selected ? ' selected' : ''}`}
      style={style}
      {...ariaAttributes}
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
        <span className="tree-type-badge">{resolveTypeLabel(node.type, node.pythonType)}</span>
        {node.language && <span className="tree-type-badge subtle">{node.language}</span>}
      </div>

      <div className="tree-col preview">{node.preview || '—'}</div>
    </div>
  );
};

export const TreeNodeRow = React.memo(TreeNodeRowInner);
