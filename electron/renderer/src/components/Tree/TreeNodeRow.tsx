/**
 * TreeNodeRow — presentational row for one tree node.
 *
 * Handles row click/double-click/context interactions and expand toggling while
 * delegating all data mutations to parent callbacks.
 */

import React from 'react';
import type { TreeNodeData } from '../../types';
import { TYPE_ICONS, UnknownIcon } from './icons';

/** Types that are containers (have or can have children). Drives the
 *  branch-vs-leaf visual distinction in tree.css (heavier name weight,
 *  elevated row background). Add new container types here if/when added. */
const BRANCH_TYPES = new Set<string>([
  'root',
  'folder',
  'mapping',
  'sequence',
  'module',
  'lib',
  'dataset',
  'dataset_file',
  'hdf5_file',
  'hdf5_group',
]);

/** User-facing label rendered in the Type chip. Shows the Python class
 *  name for built-in data (`np.ndarray`, `pd.DataFrame`, `str`, …) since
 *  that matches how users construct those values, and a friendly noun
 *  for PDV concepts (`script`, `note`, …) since the implementing class
 *  name (`PDVScript`) is jargon the user doesn't need in this column.
 *  Unknown nodes fall back to the descriptor's `python_type` field. */
const DISPLAY_LABELS: Record<string, string> = {
  root: 'root',
  // PDV "folders" are PDVTree subnodes — they don't correspond to
  // filesystem folders. Surfacing them as `tree` in the chip prevents
  // users from assuming they reflect on-disk structure.
  folder: 'tree',
  mapping: 'dict',
  sequence: 'list',
  ndarray: 'np.ndarray',
  dataframe: 'pd.DataFrame',
  series: 'pd.Series',
  dataset: 'xr.Dataset',
  dataarray: 'xr.DataArray',
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
  // Lazy file-backed data nodes and their virtual children: format nouns
  // ("what is this data"), matching the chip convention above.
  dataset_file: 'netcdf',
  hdf5_file: 'hdf5',
  hdf5_group: 'group',
  hdf5_dataset: 'h5.Dataset',
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

/** Julia sessions reuse the same wire kind strings, but the Python class
 *  names in {@link DISPLAY_LABELS} (`np.ndarray`, `pd.DataFrame`, …) would
 *  be wrong for them. When the descriptor's type string identifies a Julia
 *  type (see {@link isJuliaTypeString}) these labels win instead. */
const JULIA_DISPLAY_LABELS: Record<string, string> = {
  ndarray: 'Array',
  dataframe: 'DataFrame',
  mapping: 'Dict',
  text: 'String',
  binary: 'bytes',
};

/** Heuristic: module-qualified Julia type strings start with a Julia root
 *  module (`Core.Int64`, `Base.Dict{…}`, `Main.NPendulum.…`,
 *  `DataFrames.DataFrame`) or carry `{…}` type parameters — shapes a
 *  fully-qualified Python type string never takes. */
function isJuliaTypeString(qualified: string): boolean {
  return /^(Core|Base|Main|DataFrames)\./.test(qualified) || qualified.includes('{');
}

/** Strip the module prefix from a fully qualified type so e.g.
 *  `builtins.int` reads as `int` and `Core.Int64` reads as `Int64`. */
function stripModulePrefix(qualified: string): string {
  if (qualified.startsWith('builtins.')) return qualified.slice('builtins.'.length);
  const juliaRoot = /^(Core|Base)\./.exec(qualified);
  if (juliaRoot) return qualified.slice(juliaRoot[0].length);
  return qualified;
}

/** Compute the chip label, preferring `pythonType` for kinds in
 *  {@link USE_PYTHON_TYPE} and falling back to the generic label
 *  (Julia-flavored when the type string identifies a Julia value). */
function resolveTypeLabel(type: string, pythonType?: string): string {
  if (USE_PYTHON_TYPE.has(type) && pythonType) {
    const stripped = stripModulePrefix(pythonType);
    return PYTHON_TYPE_OVERRIDES[stripped] ?? stripped;
  }
  // Julia NamedTuples ride the mapping kind (expandable like a Dict) but
  // are their own thing — say so instead of "Dict".
  if (type === 'mapping' && pythonType === 'Core.NamedTuple') {
    return 'NamedTuple';
  }
  if (pythonType && isJuliaTypeString(pythonType) && JULIA_DISPLAY_LABELS[type]) {
    return JULIA_DISPLAY_LABELS[type];
  }
  return DISPLAY_LABELS[type] ?? type;
}

interface TreeNodeRowProps {
  node: TreeNodeData & { depth: number };
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
  selected,
  onExpand,
  onDoubleClick,
  onRightClick,
  onClick,
  style,
  ariaAttributes,
}) => {
  const Icon = TYPE_ICONS[node.type] ?? UnknownIcon;
  const toggleLabel = node.hasChildren
    ? node.isExpanded
      ? `Collapse ${node.key}`
      : `Expand ${node.key}`
    : `${node.key} has no children`;
  const indent = `calc(${node.depth || 0} * var(--tree-indent-size))`;
  const isBranch = BRANCH_TYPES.has(node.type);

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.hasChildren) {
      onExpand(node);
    }
  };

  return (
    <div
      className={`tree-row ${isBranch ? 'branch' : 'leaf'}${selected ? ' selected' : ''}${node.isCoord ? ' coord' : ''}`}
      style={style}
      {...ariaAttributes}
      onDoubleClick={() => onDoubleClick(node)}
      // Use mousedown rather than click for selection so the highlight
      // appears on press, not release. Click fires on mouseup, which
      // gives a ~100ms perceived lag equal to how long the button is
      // held down. Guard on `button === 0` so right-clicks don't
      // double-fire (onContextMenu handles those).
      onMouseDown={(e) => {
        if (e.button === 0) onClick(node);
      }}
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

        <Icon className="tree-icon" />
        <span className="tree-key-text">{node.key}</span>
      </div>

      <div className="tree-col type">
        <span className="tree-type-badge">{resolveTypeLabel(node.type, node.pythonType)}</span>
        {node.language && <span className="tree-type-badge subtle">{node.language}</span>}
        {node.isCoord && <span className="tree-type-badge subtle">coord</span>}
      </div>

      <div className="tree-col preview">{node.preview || '—'}</div>
    </div>
  );
};

export const TreeNodeRow = React.memo(TreeNodeRowInner);
