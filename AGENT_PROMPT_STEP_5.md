# Agent Task: Step 5 - Tree POC (Lazy Metadata)

## Context

You are continuing work on "Physics Data Viewer", an Electron + React + Vite + TypeScript app.   Step 4 implemented the Console and Monaco-based CommandBox.  The app now has functional code execution with visual feedback. 

**Your task is to build a functional Tree component that displays hierarchical data with lazy loading, expand/collapse, and default actions.  This replaces the placeholder tree from Step 1.**

**Reference files you should read first:**
- `PLAN.md` — GUI specification for Tree layout (columns, interactions)
- `IMPLEMENTATION_STEPS.md` — Step 5 requirements
- `electron/main/ipc. ts` — TreeNode type definition
- `electron/main/index.ts` — Stub tree data (already returns mock nodes)

**Current state:**
- IPC `tree. list(path)` returns stub hierarchical data
- App has placeholder tree area with tabs (Namespace | Tree | Modules)
- Tree header with columns (Key | Type | Preview) exists

**After this step:**
- Tree displays nodes from `tree.list('')` on mount
- Expanding a node fetches and displays children via `tree.list(nodePath)`
- Collapsing a node hides children
- Double-click logs node to console (placeholder action)
- Right-click shows context menu with stub actions
- Loading spinner appears while fetching children
- Type badges/icons for different node types
- Virtualized rendering for performance (optional but recommended)

---

## Your Task

### Overview

Build the Tree component and a supporting service layer: 

1. **Tree Service** — Client-side wrapper for tree IPC calls with caching
2. **Tree Component** — Renders hierarchical nodes with expand/collapse and interactions
3. **TreeNode Component** — Renders individual row with icon, columns, and interaction handlers
4. **Integration** — Wire tree into App's left pane

---

### 1. Tree Service

**Location:** `electron/renderer/src/services/tree.ts`

**Purpose:** Wrap IPC calls, cache nodes, manage loading states. 

**Interface:**

```typescript
interface TreeNodeData extends TreeNode {
  children?: TreeNodeData[];
  isExpanded?: boolean;
  isLoading?: boolean;
}

class TreeService {
  private cache:  Map<string, TreeNodeData[]> = new Map();
  
  async getRootNodes(): Promise<TreeNodeData[]>;
  async getChildren(node: TreeNodeData): Promise<TreeNodeData[]>;
  clearCache(): void;
}

export const treeService = new TreeService();
```

**Implementation notes:**

- `getRootNodes()` calls `window.pdv.tree.list('')` and caches result
- `getChildren(node)` calls `window.pdv.tree.list(node.path)` and caches by path
- Cache prevents redundant fetches when collapsing/expanding same node
- Return nodes with `isExpanded: false`, `isLoading: false`, `children: undefined` initially

**Pseudocode:**

```typescript
class TreeService {
  private cache = new Map<string, TreeNodeData[]>();
  
  async getRootNodes(): Promise<TreeNodeData[]> {
    const cached = this.cache.get('');
    if (cached) return cached;
    
    const nodes = await window.pdv.tree.list('');
    const enriched = nodes.map(n => ({ ...n, isExpanded: false, isLoading: false }));
    this.cache.set('', enriched);
    return enriched;
  }
  
  async getChildren(node: TreeNodeData): Promise<TreeNodeData[]> {
    if (! node.hasChildren) return [];
    
    const cached = this.cache.get(node.path);
    if (cached) return cached;
    
    const nodes = await window.pdv.tree.list(node.path);
    const enriched = nodes.map(n => ({ ...n, isExpanded: false, isLoading: false }));
    this.cache.set(node.path, enriched);
    return enriched;
  }
  
  clearCache() {
    this.cache.clear();
  }
}
```

---

### 2. Tree Component

**Location:** `electron/renderer/src/components/Tree/index.tsx`

**Props:**

```typescript
interface TreeProps {
  // No props needed; component manages its own state
}
```

**State:**

```typescript
const [nodes, setNodes] = useState<TreeNodeData[]>([]);
const [loading, setLoading] = useState(true);
const [error, setError] = useState<string | undefined>();
const [contextMenu, setContextMenu] = useState<{
  x: number;
  y: number;
  node: TreeNodeData;
} | null>(null);
```

**Lifecycle:**

- `useEffect` on mount:  load root nodes via `treeService.getRootNodes()`
- Display loading state while fetching
- Display error state if fetch fails

**Key Functions:**

1. **handleExpand(node):**
   - If already expanded:  collapse (set `isExpanded: false`, optionally clear children)
   - If not expanded: 
     - Set `isLoading: true`
     - Fetch children via `treeService.getChildren(node)`
     - Set `isExpanded: true`, `children: [... fetched]`, `isLoading: false`
     - Update state immutably

2. **handleDoubleClick(node):**
   - Log node to console:  `console.log('[Tree] Double-clicked:', node);`
   - Later this will trigger default action (plot, view, etc.)

3. **handleRightClick(node, event):**
   - Prevent default context menu
   - Show custom context menu at cursor position
   - Store node reference

4. **handleContextAction(action, node):**
   - Log action:  `console.log('[Tree] Action:', action, node);`
   - Close context menu

**Rendering:**

- Header row (sticky): Key | Type | Preview
- Flat list of visible nodes (recursively flatten tree based on `isExpanded`)
- Each node rendered by `<TreeNodeRow />`
- Context menu overlay (positioned absolutely)

**Virtualization (optional but recommended):**

For large trees, use `react-window` or `@tanstack/react-virtual`:

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

// In component:
const parentRef = useRef<HTMLDivElement>(null);
const flatNodes = flattenTree(nodes);  // Recursive flatten based on isExpanded

const virtualizer = useVirtualizer({
  count: flatNodes. length,
  getScrollElement:  () => parentRef.current,
  estimateSize: () => 32,  // Row height in pixels
});

return (
  <div ref={parentRef} style={{ height: '100%', overflow: 'auto' }}>
    <div style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(virtualRow => {
        const node = flatNodes[virtualRow.index];
        return (
          <TreeNodeRow
            key={node.id}
            node={node}
            depth={calculateDepth(node)}
            onExpand={handleExpand}
            onDoubleClick={handleDoubleClick}
            onRightClick={handleRightClick}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          />
        );
      })}
    </div>
  </div>
);
```

**Non-virtualized (simpler, acceptable for POC):**

```typescript
const flatNodes = flattenTree(nodes);

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
      {! loading && flatNodes.length === 0 && (
        <div className="tree-empty">No data</div>
      )}
      
      {flatNodes.map(node => (
        <TreeNodeRow
          key={node.id}
          node={node}
          depth={calculateDepth(node)}
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
```

**Helper:  flattenTree**

```typescript
function flattenTree(nodes: TreeNodeData[], depth = 0): Array<TreeNodeData & { depth: number }> {
  const result: Array<TreeNodeData & { depth:  number }> = [];
  
  for (const node of nodes) {
    result.push({ ...node, depth });
    
    if (node.isExpanded && node.children) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }
  
  return result;
}
```

---

### 3. TreeNodeRow Component

**Location:** `electron/renderer/src/components/Tree/TreeNodeRow.tsx`

**Props:**

```typescript
interface TreeNodeRowProps {
  node: TreeNodeData & { depth: number };
  onExpand:  (node: TreeNodeData) => void;
  onDoubleClick: (node: TreeNodeData) => void;
  onRightClick: (node: TreeNodeData, event: React.MouseEvent) => void;
  style?:  React.CSSProperties;  // For virtualized positioning
}
```

**Rendering:**

- Row with three columns (Key, Type, Preview)
- Indent Key column by `depth * 20px`
- Expand/collapse arrow icon (if `hasChildren`)
  - Right arrow (▶) if collapsed
  - Down arrow (▼) if expanded
  - Spinner if `isLoading`
- Type badge with icon based on node type
- Preview text (truncated with ellipsis)

**Type Icons:**

Map node types to icons (use emoji or icon library):

```typescript
const TYPE_ICONS:  Record<string, string> = {
  folder: '📁',
  file: '📄',
  ndarray: '🔢',
  dataframe: '📊',
  image: '🖼️',
  json: '{ }',
  python: '🐍',
  julia: '🔴',
  unknown: '❓',
  // ...  add more as needed
};
```

**Pseudocode:**

```typescript
export const TreeNodeRow: React.FC<TreeNodeRowProps> = ({
  node,
  onExpand,
  onDoubleClick,
  onRightClick,
  style,
}) => {
  const icon = TYPE_ICONS[node. type] || TYPE_ICONS.unknown;
  
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
      <div className="tree-col key" style={{ paddingLeft: node.depth * 20 }}>
        <button
          className="tree-toggle"
          onClick={handleExpandClick}
          disabled={! node.hasChildren}
          style={{ visibility: node.hasChildren ? 'visible' : 'hidden' }}
        >
          {node.isLoading ? (
            <span className="spinner">⏳</span>
          ) : node.isExpanded ? (
            '▼'
          ) : (
            '▶'
          )}
        </button>
        
        <span className="tree-icon">{icon}</span>
        <span className="tree-key-text">{node.key}</span>
      </div>
      
      <div className="tree-col type">
        <span className="tree-type-badge">{node.type}</span>
      </div>
      
      <div className="tree-col preview">
        {node.preview || '—'}
      </div>
    </div>
  );
};
```

**Styling notes:**

- `.tree-row` hover effect (slight bg change)
- `.tree-toggle` button:  transparent bg, pointer on hover, disabled state
- `.tree-icon` and `.tree-key-text` inline with gap
- `.tree-type-badge` small, rounded, bg with type color
- All columns use `text-overflow: ellipsis; overflow: hidden; white-space:  nowrap;`

---

### 4. ContextMenu Component

**Location:** `electron/renderer/src/components/Tree/ContextMenu.tsx`

**Props:**

```typescript
interface ContextMenuProps {
  x: number;
  y: number;
  node: TreeNodeData;
  onAction: (action: string, node: TreeNodeData) => void;
  onClose: () => void;
}
```

**Actions (stub for now):**

- "View" (for all types)
- "Plot" (for ndarray, dataframe)
- "Open" (for files)
- "Delete" (disabled for now)
- "Refresh"

**Rendering:**

- Absolutely positioned `div` at `(x, y)`
- List of action buttons
- Click outside or press Escape to close
- Use `useEffect` to add global click listener

**Pseudocode:**

```typescript
export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  node,
  onAction,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && ! menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    const handleEscape = (e: KeyboardEvent) => {
      if (e. key === 'Escape') {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);
  
  const actions = getActionsForNode(node);
  
  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ position: 'fixed', top: y, left: x }}
    >
      {actions.map(action => (
        <button
          key={action. id}
          className="context-menu-item"
          disabled={action.disabled}
          onClick={() => {
            onAction(action.id, node);
            onClose();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
};

function getActionsForNode(node: TreeNodeData) {
  const actions = [
    { id: 'view', label: 'View', disabled: false },
  ];
  
  if (node.type === 'ndarray' || node.type === 'dataframe') {
    actions.push({ id: 'plot', label: 'Plot', disabled: false });
  }
  
  if (node.type === 'file') {
    actions.push({ id: 'open', label: 'Open', disabled: false });
  }
  
  actions.push(
    { id: 'refresh', label: 'Refresh', disabled: false },
    { id: 'delete', label: 'Delete', disabled: true }  // Disabled for now
  );
  
  return actions;
}
```

**Styling:**

- `.context-menu` white bg (or dark theme bg-secondary), border, shadow, border-radius
- `.context-menu-item` full-width button, text-left, padding, hover effect
- `.context-menu-item: disabled` grayed out, no pointer

---

### 5. Integration into App

**Location:** `electron/renderer/src/app/index.tsx`

**Changes:**

1. **Import Tree component:**

```typescript
import { Tree } from '../components/Tree';
```

2. **Replace placeholder tree:**

In the left pane, replace the `.tree-container` placeholder with:

```typescript
<aside className="left-pane">
  <div className="pane-tabs">
    <button
      className={`tab ${activeTab === 'tree' ? 'active' : ''}`}
      onClick={() => setActiveTab('tree')}
    >
      Tree
    </button>
    <button
      className={`tab ${activeTab === 'namespace' ? 'active' : ''}`}
      onClick={() => setActiveTab('namespace')}
    >
      Namespace
    </button>
    <button
      className={`tab ${activeTab === 'modules' ? 'active' : ''}`}
      onClick={() => setActiveTab('modules')}
    >
      Modules
    </button>
  </div>

  {activeTab === 'tree' && <Tree />}
  {activeTab === 'namespace' && (
    <div className="tree-empty">Namespace view (coming soon)</div>
  )}
  {activeTab === 'modules' && (
    <div className="tree-empty">Modules view (coming soon)</div>
  )}
</aside>
```

**Note:** Namespace and Modules tabs still show placeholders; they will be implemented later.

---

### 6. CSS Updates

**Location:** `electron/renderer/src/styles/index.css`

**Add/refine:**

**Tree Container:**

```css
.tree-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.tree-content {
  flex: 1;
  overflow-y: auto;
}

. tree-loading,
.tree-error,
.tree-empty {
  padding: 24px;
  text-align:  center;
  color: var(--text-secondary);
}

.tree-error {
  color: var(--error);
}
```

**Tree Row:**

```css
.tree-row {
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-primary);
  cursor: default;
  border-bottom: 1px solid var(--bg-primary);
}

.tree-row:hover {
  background-color: var(--bg-hover);
}

.tree-col {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding:  4px 8px;
}

.tree-col.key {
  flex: 2;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tree-col.type {
  flex: 1;
}

.tree-col.preview {
  flex: 2;
  color: var(--text-secondary);
}

.tree-toggle {
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
}

.tree-toggle:hover:not(:disabled) {
  color: var(--accent);
}

.tree-toggle:disabled {
  cursor: default;
  opacity: 0;
}

.tree-icon {
  font-size: 14px;
  line-height: 1;
}

.tree-key-text {
  font-weight: 500;
  color:  var(--accent);
}

.tree-type-badge {
  display: inline-block;
  padding: 2px 6px;
  background-color: var(--bg-tertiary);
  border-radius: 3px;
  font-size:  11px;
  color: var(--text-secondary);
}

.spinner {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

**Context Menu:**

```css
.context-menu {
  min-width: 180px;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  padding: 4px 0;
  z-index: 1000;
}

.context-menu-item {
  width: 100%;
  padding: 8px 12px;
  border:  none;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  font-size: 13px;
  cursor: pointer;
  display: block;
}

.context-menu-item:hover: not(:disabled) {
  background-color: var(--bg-hover);
  color: var(--accent);
}

.context-menu-item:disabled {
  color: var(--text-hint);
  cursor: not-allowed;
}
```

---

## Exit Criteria

After completing this step, verify:  

1. **Build succeeds:**
   ```bash
   cd electron
   npm run build
   ```

2. **App launches with tree:**
   ```bash
   npm run dev
   ```
   - Tree tab is selected by default
   - Shows three root nodes:  `data`, `scripts`, `results`

3. **Expand/collapse works:**
   - Click arrow next to `data` — expands to show `array1` and `df1`
   - Click arrow again — collapses
   - Spinner appears briefly during first expand
   - Subsequent expand/collapse is instant (cached)

4. **Hierarchy works:**
   - Expand `data` — shows 2 children indented
   - Expand `scripts` — shows 2 children (analysis. py, plot.jl)
   - Expand `results` — shows 2 children (figure1.png, config.json)
   - Children are indented visually (20px per level)

5. **Node data displays correctly:**
   - Each node shows icon (emoji or text)
   - Type column shows node type (ndarray, dataframe, file, etc.)
   - Preview column shows summary (shape, size, etc.)

6. **Double-click:**
   - Double-click any node
   - DevTools console shows: `[Tree] Double-clicked:  {id, key, type, ... }`

7. **Context menu:**
   - Right-click any node
   - Context menu appears at cursor
   - Shows appropriate actions: 
     - All nodes: View, Refresh, Delete (disabled)
     - ndarray/dataframe: also Plot
     - files: also Open
   - Click action — console logs:  `[Tree] Action: view {node}`
   - Click outside — menu closes
   - Press Escape — menu closes

8. **Tab switching:**
   - Click Namespace tab — shows placeholder
   - Click Modules tab — shows placeholder
   - Click Tree tab — tree reappears with state preserved

9. **Empty/error states:**
   - Loading spinner appears on mount (brief)
   - If fetch fails (simulate by breaking IPC), error message displays

10. **Visual polish:**
    - Hover over row — background changes
    - Arrow icons clear and clickable
    - Type badges styled consistently
    - Text truncates with ellipsis in Preview column

---

## Testing Tips

**Manual test sequence:**

1. Launch app, verify root nodes load
2. Expand `data` → verify 2 children appear
3. Collapse `data` → verify children hide
4. Expand `data` again → verify instant (cached)
5. Expand `scripts` → verify python/julia files
6. Double-click `array1` → verify console log
7. Right-click `array1` → verify context menu with "Plot"
8. Right-click `analysis.py` → verify context menu with "Open"
9. Click "View" → verify console log and menu closes
10. Switch to Namespace tab → verify placeholder
11. Switch back to Tree → verify tree state preserved

**Edge cases:**

- Node with no children: arrow not visible
- Deeply nested structure: indentation increases (test with mock data if needed)
- Very long key/preview:  text truncates with ellipsis
- Rapid expand/collapse: no double-fetch or state corruption

**IPC verification:**

Check terminal for IPC logs:
```
[IPC] tree: list 
[IPC] tree:list data
[IPC] tree:list scripts
[IPC] tree: list results
```

**Performance:**

- With 100+ nodes (flat), scrolling should be smooth
- If sluggish, implement virtualization with `react-window` or `@tanstack/react-virtual`

---

## Files to Create/Modify (Checklist)

- [ ] `electron/renderer/src/services/tree.ts` — NEW:  Tree service with caching
- [ ] `electron/renderer/src/components/Tree/index.tsx` — NEW: Tree component
- [ ] `electron/renderer/src/components/Tree/TreeNodeRow.tsx` — NEW: Row component
- [ ] `electron/renderer/src/components/Tree/ContextMenu.tsx` — NEW: Context menu
- [ ] `electron/renderer/src/app/index.tsx` — Updated to integrate Tree
- [ ] `electron/renderer/src/styles/index.css` — Added tree styles
- [ ] `electron/renderer/src/types/index.ts` — Add TreeNodeData type (optional, or inline)

---

## Notes

- **Virtualization:** For this POC with stub data (< 20 nodes), virtualization is optional.  If you choose to implement it, use `@tanstack/react-virtual` (lightweight) or `react-window`.
  
- **Icons:** Emoji icons are quick for POC. For production, consider a proper icon library (react-icons, lucide-react) with consistent sizing.

- **Actions:** All actions currently just log to console. Step 9 will implement the action registry and real handlers.

- **Namespace tab:** Will be implemented later to show kernel variables using a similar tree structure.

- **Modules tab:** Will be implemented later to show loaded modules/manifests. 

- **Refresh action:** Currently a no-op. Later it should clear cache for that node and refetch.

- **Delete action:** Disabled for now; requires confirmation dialog and tree state mutation.

- **Performance:** The stub data is small.  With real data (thousands of nodes), you'll need: 
  - Virtualization (render only visible rows)
  - Debounced search/filter
  - Pagination or "load more" for large directories

- **Drag & drop:** Not required for POC, but could be added later for reordering or moving nodes.

- **Keyboard navigation:** Consider adding arrow key navigation in a future step (up/down to select, right to expand, left to collapse).

- **Multi-select:** Not required for POC, but useful for batch operations later (Ctrl/Cmd+click).

- **Sorting:** Consider adding column header click to sort by Key/Type later.

---

## Optional Enhancements (if time permits)

1. **Search/Filter:**
   - Add a search input above tree
   - Filter visible nodes by key/type/preview
   - Highlight matches

2. **Column Resizing:**
   - Draggable resizers in header
   - Persist widths to localStorage

3. **Type Colors:**
   - Color-code type badges:  blue for data, green for files, orange for images, etc. 

4. **Breadcrumb:**
   - Show current path above tree when drilling into nested structure

5. **Refresh Button:**
   - Header button to clear all cache and reload root

6. **Loading States:**
   - Skeleton loaders instead of spinner for smoother UX

7. **Tooltips:**
   - Show full path/preview on hover (truncated text)

These can be deferred to later steps or polish phases. 