import React, { useCallback, useMemo, useState } from 'react';
import { FormattedValue, formatValue } from '../../utils/dataFormatting';
import { VirtualScroller } from './VirtualScroller';

export interface TreeNodeData {
  key: string;
  value: any;
  path: string[];
  depth: number;
  formatted: FormattedValue;
  hasChildren: boolean;
  children?: TreeNodeData[];
}

export interface TreeViewProps {
  data: any;
  rowHeight?: number;
  viewportHeight?: number;
  overscan?: number;
  onNodeDoubleClick?: (node: TreeNodeData) => void;
  onContextMenu?: (node: TreeNodeData, position: { x: number; y: number }) => void;
}

const DEFAULT_ROW_HEIGHT = 28;
const DEFAULT_VIEWPORT_HEIGHT = 320;

function isContainer(value: any): boolean {
  return value !== null && typeof value === 'object';
}

function pathKey(path: string[]): string {
  return path.join('.') || 'root';
}

function buildTree(value: any, path: string[] = ['root'], depth: number = 0): TreeNodeData {
  const children: TreeNodeData[] | undefined = isContainer(value)
    ? Array.from(Object.entries(value)).map(([childKey, childValue]) =>
        buildTree(childValue, [...path, String(childKey)], depth + 1),
      )
    : undefined;

  return {
    key: path[path.length - 1] ?? 'root',
    value,
    path,
    depth,
    formatted: formatValue(value),
    hasChildren: Array.isArray(children) && children.length > 0,
    children,
  };
}

function flatten(node: TreeNodeData, expanded: Set<string>, acc: TreeNodeData[]): void {
  acc.push(node);
  if (!node.hasChildren) {
    return;
  }
  if (!expanded.has(pathKey(node.path))) {
    return;
  }
  node.children?.forEach((child) => flatten(child, expanded, acc));
}

export const TreeView: React.FC<TreeViewProps> = ({
  data,
  rowHeight = DEFAULT_ROW_HEIGHT,
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
  overscan = 10,
  onNodeDoubleClick,
  onContextMenu,
}) => {
  const root = useMemo(() => buildTree(data ?? {}), [data]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([pathKey(root.path)]));
  const [scrollTop, setScrollTop] = useState(0);

  const flattened = useMemo(() => {
    const nodes: TreeNodeData[] = [];
    flatten(root, expanded, nodes);
    return nodes;
  }, [expanded, root]);

  const rowsPerViewport = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const scroller = useMemo(() => new VirtualScroller(rowsPerViewport, overscan), [rowsPerViewport, overscan]);
  const startIndex = Math.floor(scrollTop / rowHeight);
  const [start, end] = useMemo(
    () => scroller.visibleRange(flattened.length, startIndex),
    [flattened.length, scroller, startIndex],
  );
  const visible = flattened.slice(start, end);

  const paddingTop = start * rowHeight;
  const paddingBottom = Math.max(0, (flattened.length - end) * rowHeight);

  const togglePath = useCallback(
    (path: string[]) => {
      const key = pathKey(path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
    [],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, node: TreeNodeData) => {
      event.preventDefault();
      onContextMenu?.(node, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu],
  );

  return (
    <div
      className="tree-view"
      style={{ height: viewportHeight, overflow: 'auto', position: 'relative' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      data-testid="tree-view"
    >
      <div style={{ paddingTop, paddingBottom }}>
        {visible.map((node) => {
          const isExpanded = expanded.has(pathKey(node.path));
          return (
            <div
              key={pathKey(node.path)}
              className="tree-row"
              style={{ display: 'flex', alignItems: 'center', height: rowHeight, paddingLeft: node.depth * 14 }}
              onDoubleClick={() => onNodeDoubleClick?.(node)}
              onContextMenu={(e) => handleContextMenu(e, node)}
              data-testid="tree-node"
            >
              {node.hasChildren ? (
                <button
                  type="button"
                  className="tree-toggle"
                  onClick={() => togglePath(node.path)}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? '▾' : '▸'}
                </button>
              ) : (
                <span className="tree-spacer" style={{ width: 16 }} />
              )}
              <span className="tree-key">{node.key}</span>
              <span className="tree-separator">:</span>
              <span className="tree-preview" title={node.formatted.preview}>
                {node.formatted.preview}
              </span>
              <span className="tree-type">({node.formatted.typeName})</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
