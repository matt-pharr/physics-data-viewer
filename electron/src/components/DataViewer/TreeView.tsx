import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
const DEFAULT_VIEWPORT_HEIGHT = 360;

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
  viewportHeight,
  overscan = 10,
  onNodeDoubleClick,
  onContextMenu,
}) => {
  const resolvedHeight = viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const root = useMemo(() => buildTree(data ?? {}), [data]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([pathKey(root.path)]));
  const [scrollTop, setScrollTop] = useState(0);
  const [colWidths, setColWidths] = useState<[number, number, number]>([220, 140, 320]);
  const dragState = useRef<{ index: number; startX: number; start: [number, number, number] } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const flattened = useMemo(() => {
    const nodes: TreeNodeData[] = [];
    flatten(root, expanded, nodes);
    return nodes;
  }, [expanded, root]);

  const rowsPerViewport = Math.max(1, Math.ceil(resolvedHeight / rowHeight));
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

  const gridTemplateColumns = `${colWidths[0]}px ${colWidths[1]}px ${colWidths[2]}px`;

  const handleResizeStart = useCallback((index: number, event: React.MouseEvent) => {
    event.preventDefault();
    dragState.current = { index, startX: event.clientX, start: [...colWidths] as [number, number, number] };
  }, [colWidths]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!dragState.current) return;
      const { index, startX, start } = dragState.current;
      const delta = event.clientX - startX;
      const next = [...start] as [number, number, number];
      const min = 80;
      const total = start[index] + start[index + 1];
      next[index] = Math.min(total - min, Math.max(min, start[index] + delta));
      next[index + 1] = total - next[index];
      setColWidths(next);
    };
    const handleUp = () => {
      dragState.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  return (
    <div
      className="tree-view"
      ref={containerRef}
      style={{ height: resolvedHeight, overflow: 'auto', position: 'relative', display: 'flex', flexDirection: 'column' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      data-testid="tree-view"
    >
      <div className="tree-header" style={{ display: 'grid', gridTemplateColumns, alignItems: 'center', position: 'relative' }}>
        <div className="tree-header-cell">Key</div>
        <div className="tree-header-cell">Type</div>
        <div className="tree-header-cell">Value</div>
        <div
          className="tree-header-resizer"
          style={{ left: colWidths[0] }}
          onMouseDown={(e) => handleResizeStart(0, e)}
        />
        <div
          className="tree-header-resizer"
          style={{ left: colWidths[0] + colWidths[1] }}
          onMouseDown={(e) => handleResizeStart(1, e)}
        />
      </div>
      <div style={{ paddingTop, paddingBottom }}>
        {visible.map((node) => {
          const isExpanded = expanded.has(pathKey(node.path));
          return (
            <div
              key={pathKey(node.path)}
              className="tree-row"
              style={{
                display: 'grid',
                gridTemplateColumns,
                alignItems: 'center',
                height: rowHeight,
              }}
              onDoubleClick={() => onNodeDoubleClick?.(node)}
              onContextMenu={(e) => handleContextMenu(e, node)}
              data-testid="tree-node"
            >
              <div className="tree-cell tree-cell-key" style={{ paddingLeft: node.depth * 14, display: 'flex', alignItems: 'center', gap: 6 }}>
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
              </div>
              <div className="tree-cell tree-cell-type">
                <span className="tree-type">({node.formatted.typeName})</span>
              </div>
              <div className="tree-cell tree-cell-value" title={node.formatted.preview}>
                <span className="tree-preview">{node.formatted.preview}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
