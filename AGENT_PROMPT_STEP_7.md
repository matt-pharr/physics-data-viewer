# Agent Task:   Step 7 - Namespace View

## Context

You are continuing work on "Physics Data Viewer", an Electron + React + Vite + TypeScript app.    Step 6 implemented plot capture with native/capture modes.  The app now executes real code, displays results, and shows plots inline or in external windows. 

**Your task is to implement the Namespace tab, which displays kernel variables (like an IDE's variable inspector). Users should see what variables exist in their kernel's memory, with type, shape, size, and preview information.**

**Reference files you should read first:**
- `PLAN.md` — Namespace view architecture
- `electron/main/init/python-init.py` — Python init cell (has `pdv_info()` helper)
- `electron/renderer/src/components/Tree/index.tsx` — Tree component (reuse for namespace)
- `electron/renderer/src/app/index.tsx` — App with left pane tabs

**Current state:**
- "Namespace" tab exists but shows placeholder text
- Kernel executes code and variables persist
- Tree component functional with expand/collapse
- No way to query kernel variables

**After this step:**
- Namespace tab queries kernel for variables after each execution
- Displays variables in tree-like structure (name, type, shape, preview)
- Refresh button to manually re-query
- Auto-refresh option (poll every N seconds)
- Double-click variable to inspect or copy to command box
- Filter to hide private variables, modules, functions

---

## Your Task

### Part 1: Enhance Python Init Cell with Namespace Query

**Location:** `electron/main/init/python-init.py`

**Add namespace querying function:**

```python
# =============================================================================
# Namespace Management
# =============================================================================

def pdv_namespace(include_private=False, include_modules=False, include_callables=False):
    """
    Get the current namespace as a dict suitable for the Namespace view.
    Filters out unwanted variables based on parameters.
    
    Args:
        include_private:  If False, exclude variables starting with '_'
        include_modules: If False, exclude module objects
        include_callables: If False, exclude functions and classes
    
    Returns:
        dict: Variable name -> metadata dict
        
    Example:
        >>> import numpy as np
        >>> x = np.array([1, 2, 3])
        >>> pdv_namespace()
        {
          'x': {
            'type': 'ndarray',
            'shape': [3],
            'dtype': 'int64',
            'size': 24,
            'preview': 'array([1, 2, 3])'
          },
          'np': {
            'type': 'module',
            'module': 'numpy'
          }
        }
    """
    import sys
    import inspect
    
    # Get IPython namespace if available, otherwise use globals()
    try:
        # Try IPython kernel
        ipython = get_ipython()
        namespace = ipython.user_ns
    except NameError:
        # Fallback to regular Python namespace
        namespace = globals()
    
    result = {}
    
    for name, obj in namespace.items():
        # Skip private variables (unless requested)
        if not include_private and name.startswith('_'):
            continue
        
        # Skip modules (unless requested)
        if not include_modules and inspect.ismodule(obj):
            continue
        
        # Skip callables (unless requested)
        if not include_callables and callable(obj) and not hasattr(obj, 'shape'):
            continue
        
        # Skip PDV internals
        if name.startswith('pdv_') or name.startswith('_pdv_'):
            continue
        
        # Get metadata using pdv_info
        try:
            info = pdv_info(obj)
            result[name] = info
        except Exception as e:
            # Fallback for objects that can't be inspected
            result[name] = {
                'type': type(obj).__name__,
                'preview': str(obj)[: 100],
                'error': f'Could not inspect:  {str(e)}'
            }
    
    return result

# Update pdv_info to handle more types
def pdv_info(obj):
    """
    Get detailed information about an object for display in the Tree/Namespace. 
    
    Returns:
        dict: Object metadata including type, shape, dtype, preview, etc.
    """
    info = {
        'type': type(obj).__name__,
        'module': type(obj).__module__,
    }
    
    # NumPy arrays
    if hasattr(obj, 'shape') and hasattr(obj, 'dtype'):
        info['shape'] = list(obj.shape)
        info['dtype'] = str(obj.dtype)
        info['size'] = int(obj.nbytes) if hasattr(obj, 'nbytes') else None
        info['preview'] = f"{obj.dtype} {tuple(obj.shape)}"
        
        # Add min/max/mean for numeric arrays
        try:
            if obj.size > 0 and obj.dtype.kind in ['i', 'u', 'f', 'c']:
                info['min'] = float(obj.min())
                info['max'] = float(obj. max())
                info['mean'] = float(obj.mean())
        except:
            pass
    
    # Pandas DataFrames
    elif hasattr(obj, 'columns') and hasattr(obj, 'index'):
        info['shape'] = list(obj.shape)
        info['columns'] = list(obj.columns)[: 20]  # First 20 columns
        info['preview'] = f"DataFrame ({len(obj)} rows, {len(obj.columns)} cols)"
        info['size'] = int(obj.memory_usage(deep=True).sum()) if hasattr(obj, 'memory_usage') else None
    
    # Pandas Series
    elif hasattr(obj, 'index') and hasattr(obj, 'dtype') and not hasattr(obj, 'columns'):
        info['shape'] = [len(obj)]
        info['dtype'] = str(obj.dtype)
        info['preview'] = f"Series ({len(obj)}) [{obj.dtype}]"
        info['size'] = int(obj.memory_usage(deep=True)) if hasattr(obj, 'memory_usage') else None
    
    # Lists, tuples, sets
    elif isinstance(obj, (list, tuple, set)):
        info['length'] = len(obj)
        info['preview'] = f"{type(obj).__name__} ({len(obj)} items)"
        
        # Show first few elements
        if len(obj) > 0:
            try:
                items = list(obj)[:3] if isinstance(obj, set) else obj[:3]
                items_str = ', '.join(repr(item)[:20] for item in items)
                if len(obj) > 3:
                    items_str += ', ...'
                info['preview'] += f":  [{items_str}]"
            except:
                pass
    
    # Dicts
    elif isinstance(obj, dict):
        info['length'] = len(obj)
        info['keys'] = list(obj.keys())[:10]  # First 10 keys
        info['preview'] = f"dict ({len(obj)} items)"
    
    # Strings
    elif isinstance(obj, str):
        info['length'] = len(obj)
        preview = obj[:50]
        if len(obj) > 50:
            preview += '...'
        info['preview'] = repr(preview)
    
    # Numbers
    elif isinstance(obj, (int, float, complex)):
        info['preview'] = repr(obj)
    
    # Booleans
    elif isinstance(obj, bool):
        info['preview'] = repr(obj)
    
    # None
    elif obj is None: 
        info['preview'] = 'None'
    
    # Matplotlib figures
    elif type(obj).__name__ == 'Figure':
        info['preview'] = f"Figure ({obj.get_figwidth()}x{obj.get_figheight()} in)"
        info['num_axes'] = len(obj.get_axes())
    
    # Generic objects
    else:
        info['preview'] = repr(obj)[: 100]
    
    return info
```

---

### Part 2: Enhance Julia Init Cell with Namespace Query

**Location:** `electron/main/init/julia-init.jl`

**Add namespace querying function:**

```julia
# =============================================================================
# Namespace Management
# =============================================================================

"""
    pdv_namespace(; include_private:: Bool=false, include_modules::Bool=false)

Get the current namespace as a Dict suitable for the Namespace view. 

# Arguments
- `include_private`: If false, exclude names starting with '_'
- `include_modules`: If false, exclude Module objects

# Returns
- `Dict{String, Any}`: Variable name => metadata dict
"""
function pdv_namespace(; include_private::Bool=false, include_modules::Bool=false)
    result = Dict{String, Any}()
    
    # Get names from Main module
    for name in names(Main, all=false, imported=false)
        name_str = string(name)
        
        # Skip private names (unless requested)
        if !include_private && startswith(name_str, "_")
            continue
        end
        
        # Skip PDV internals
        if startswith(name_str, "pdv_") || startswith(name_str, "_pdv_")
            continue
        end
        
        try
            obj = getfield(Main, name)
            
            # Skip modules (unless requested)
            if !include_modules && obj isa Module
                continue
            end
            
            # Skip functions (unless they're data-like)
            if obj isa Function
                continue
            end
            
            # Get metadata
            info = pdv_info(obj)
            result[name_str] = info
            
        catch e
            # Skip names that can't be accessed
            continue
        end
    end
    
    return result
end

# Update pdv_info to handle more types
function pdv_info(obj)
    info = Dict{String, Any}(
        "type" => string(typeof(obj)),
        "module" => string(parentmodule(typeof(obj)))
    )
    
    # Arrays
    if obj isa AbstractArray
        info["shape"] = collect(size(obj))
        info["dtype"] = string(eltype(obj))
        info["size"] = sizeof(obj)
        info["preview"] = "$(eltype(obj)) $(size(obj))"
        
        # Add min/max/mean for numeric arrays
        try
            if length(obj) > 0 && eltype(obj) <: Number
                info["min"] = Float64(minimum(obj))
                info["max"] = Float64(maximum(obj))
                info["mean"] = Float64(sum(obj) / length(obj))
            end
        catch
        end
    
    # DataFrames (if available)
    elseif hasproperty(obj, : colindex) && hasproperty(obj, :nrow)
        info["shape"] = [obj.nrow, length(obj. colindex)]
        info["columns"] = string.(names(obj)[1:min(20, end)])
        info["preview"] = "DataFrame ($(obj.nrow) rows, $(length(obj.colindex)) cols)"
        # Size estimation
        info["size"] = sum(sizeof(col) for col in eachcol(obj))
    
    # Dicts
    elseif obj isa AbstractDict
        info["length"] = length(obj)
        info["keys"] = string.(collect(keys(obj))[1:min(10, length(obj))])
        info["preview"] = "Dict ($(length(obj)) items)"
    
    # Tuples
    elseif obj isa Tuple
        info["length"] = length(obj)
        info["preview"] = "Tuple ($(length(obj)) items)"
    
    # Strings
    elseif obj isa AbstractString
        info["length"] = length(obj)
        preview = length(obj) > 50 ? obj[1:50] * "..." : obj
        info["preview"] = repr(preview)
    
    # Numbers
    elseif obj isa Number
        info["preview"] = string(obj)
    
    # Booleans
    elseif obj isa Bool
        info["preview"] = string(obj)
    
    # Nothing
    elseif obj === nothing
        info["preview"] = "nothing"
    
    # Generic objects
    else
        info["preview"] = repr(obj)[1:min(100, end)]
    end
    
    return info
end
```

---

### Part 3: Add Namespace Query IPC

**Location:** `electron/main/ipc. ts`

**Add to IPC channels:**

```typescript
export const IPC = {
  // ... existing channels ...
  namespace: {
    query: 'namespace: query',
  },
} as const;
```

**Add namespace query types:**

```typescript
export interface NamespaceQueryOptions {
  includePrivate?: boolean;
  includeModules?: boolean;
  includeCallables?: boolean;
}

export interface NamespaceVariable {
  name: string;
  type: string;
  module?:  string;
  shape?: number[];
  dtype?: string;
  size?: number;
  preview?: string;
  min?: number;
  max?: number;
  mean?: number;
  length?: number;
  columns?: string[];
  keys?: string[];
  error?: string;
}
```

---

### Part 4: Add Namespace Query Handler

**Location:** `electron/main/index.ts`

**Add IPC handler:**

```typescript
ipcMain.handle(IPC. namespace.query, async (_event, kernelId:  string, options?:  NamespaceQueryOptions) => {
  console.log('[IPC] namespace: query', kernelId, options);
  
  if (!kernelId) {
    return { error: 'No kernel ID provided' };
  }
  
  try {
    const kernelManager = getKernelManager();
    const kernel = kernelManager.getKernel(kernelId);
    
    if (!kernel) {
      return { error: `Kernel not found: ${kernelId}` };
    }
    
    // Build query code based on language
    const language = kernel.language;
    let code = '';
    
    if (language === 'python') {
      const includePrivate = options?.includePrivate ?  'True' : 'False';
      const includeModules = options?. includeModules ? 'True' : 'False';
      const includeCallables = options?. includeCallables ? 'True' : 'False';
      
      code = `pdv_namespace(include_private=${includePrivate}, include_modules=${includeModules}, include_callables=${includeCallables})`;
    } else if (language === 'julia') {
      const includePrivate = options?.includePrivate ? 'true' : 'false';
      const includeModules = options?. includeModules ? 'true' : 'false';
      
      code = `pdv_namespace(include_private=${includePrivate}, include_modules=${includeModules})`;
    } else {
      return { error:  `Unsupported language: ${language}` };
    }
    
    // Execute namespace query
    const result = await kernelManager.execute(kernelId, { code });
    
    if (result.error) {
      return { error: result.error };
    }
    
    // Parse result (should be a dict/Dict)
    try {
      // Result should be in result.result as a dict representation
      // For Python, it might be a string repr, so we need to parse it
      // For simplicity, we can use JSON serialization in the query
      
      // Better approach: use JSON serialization in kernel
      const jsonCode = language === 'python' 
        ? `import json; json.dumps(pdv_namespace(include_private=${options?.includePrivate ?  'True' : 'False'}, include_modules=${options?. includeModules ? 'True' : 'False'}, include_callables=${options?.includeCallables ? 'True' : 'False'}))`
        : `using JSON; JSON.json(pdv_namespace(include_private=${options?.includePrivate ?  'true' : 'false'}, include_modules=${options?.includeModules ? 'true' : 'false'}))`;
      
      const jsonResult = await kernelManager.execute(kernelId, { code: jsonCode });
      
      if (jsonResult.error) {
        return { error: jsonResult.error };
      }
      
      // Parse JSON result
      const namespaceData = JSON.parse(jsonResult.result as string);
      
      // Convert to NamespaceVariable array
      const variables: NamespaceVariable[] = Object.entries(namespaceData).map(([name, info]:  [string, any]) => ({
        name,
        ... info,
      }));
      
      return { variables };
      
    } catch (parseError) {
      return { error: `Failed to parse namespace:  ${parseError}` };
    }
    
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});
```

---

### Part 5: Add Namespace Query to Preload

**Location:** `electron/preload. ts`

**Add to API:**

```typescript
namespace: {
  query: (kernelId: string, options?:  NamespaceQueryOptions): Promise<{ variables?:  NamespaceVariable[]; error?: string }> =>
    ipcRenderer.invoke(IPC.namespace.query, kernelId, options),
},
```

---

### Part 6: Create Namespace View Component

**Location:** `electron/renderer/src/components/NamespaceView/index.tsx` (NEW)

**Create namespace view component:**

```typescript
import React, { useState, useEffect } from 'react';

interface NamespaceVariable {
  name: string;
  type: string;
  module?: string;
  shape?: number[];
  dtype?: string;
  size?: number;
  preview?: string;
  min?: number;
  max?: number;
  mean?: number;
  length?: number;
  columns?: string[];
  keys?: string[];
  error?: string;
}

interface NamespaceViewProps {
  kernelId: string | null;
  autoRefresh?: boolean;
  refreshInterval?: number;  // milliseconds
}

export const NamespaceView: React.FC<NamespaceViewProps> = ({
  kernelId,
  autoRefresh = false,
  refreshInterval = 2000,
}) => {
  const [variables, setVariables] = useState<NamespaceVariable[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [filters, setFilters] = useState({
    includePrivate: false,
    includeModules:  false,
    includeCallables: false,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'type' | 'size'>('name');

  const fetchNamespace = async () => {
    if (!kernelId) {
      setVariables([]);
      return;
    }

    setLoading(true);
    setError(undefined);

    try {
      const result = await window.pdv.namespace.query(kernelId, filters);
      
      if (result.error) {
        setError(result.error);
        setVariables([]);
      } else {
        setVariables(result.variables || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVariables([]);
    } finally {
      setLoading(false);
    }
  };

  // Fetch on mount and when kernel/filters change
  useEffect(() => {
    fetchNamespace();
  }, [kernelId, filters]);

  // Auto-refresh
  useEffect(() => {
    if (! autoRefresh || !kernelId) return;

    const interval = setInterval(() => {
      fetchNamespace();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, kernelId, filters]);

  // Filter and sort variables
  const filteredVariables = variables
    .filter(v => v.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'type') return a.type.localeCompare(b.type);
      if (sortBy === 'size') return (b.size || 0) - (a.size || 0);
      return 0;
    });

  const handleDoubleClick = (variable: NamespaceVariable) => {
    // Copy variable name to clipboard or insert into command box
    navigator.clipboard.writeText(variable.name);
    console.log('[Namespace] Copied to clipboard:', variable.name);
  };

  const handleRefresh = () => {
    fetchNamespace();
  };

  const toggleFilter = (filter: keyof typeof filters) => {
    setFilters(prev => ({ ...prev, [filter]: !prev[filter] }));
  };

  const formatSize = (bytes: number | undefined): string => {
    if (! bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="namespace-view">
      {/* Header with controls */}
      <div className="namespace-header">
        <input
          type="text"
          className="namespace-search"
          placeholder="Search variables..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e. target.value)}
        />
        
        <div className="namespace-controls">
          <button
            className="btn btn-icon"
            onClick={handleRefresh}
            disabled={loading || ! kernelId}
            title="Refresh"
          >
            🔄
          </button>
          
          <label className="namespace-filter">
            <input
              type="checkbox"
              checked={filters.includePrivate}
              onChange={() => toggleFilter('includePrivate')}
            />
            <span>Private</span>
          </label>
          
          <label className="namespace-filter">
            <input
              type="checkbox"
              checked={filters.includeModules}
              onChange={() => toggleFilter('includeModules')}
            />
            <span>Modules</span>
          </label>
          
          <label className="namespace-filter">
            <input
              type="checkbox"
              checked={filters.includeCallables}
              onChange={() => toggleFilter('includeCallables')}
            />
            <span>Functions</span>
          </label>
        </div>
      </div>

      {/* Variable table */}
      <div className="namespace-table-container">
        <table className="namespace-table">
          <thead>
            <tr>
              <th onClick={() => setSortBy('name')} style={{ cursor: 'pointer' }}>
                Name {sortBy === 'name' && '▼'}
              </th>
              <th onClick={() => setSortBy('type')} style={{ cursor: 'pointer' }}>
                Type {sortBy === 'type' && '▼'}
              </th>
              <th>Shape/Length</th>
              <th onClick={() => setSortBy('size')} style={{ cursor: 'pointer' }}>
                Size {sortBy === 'size' && '▼'}
              </th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="namespace-loading">Loading...</td>
              </tr>
            )}
            
            {error && (
              <tr>
                <td colSpan={5} className="namespace-error">{error}</td>
              </tr>
            )}
            
            {! loading && !error && filteredVariables.length === 0 && (
              <tr>
                <td colSpan={5} className="namespace-empty">
                  {kernelId ? 'No variables in namespace' : 'No kernel active'}
                </td>
              </tr>
            )}
            
            {!loading && !error && filteredVariables.map((variable) => (
              <tr
                key={variable.name}
                className="namespace-row"
                onDoubleClick={() => handleDoubleClick(variable)}
                title="Double-click to copy name"
              >
                <td className="namespace-name">{variable.name}</td>
                <td className="namespace-type">{variable.type}</td>
                <td className="namespace-shape">
                  {variable.shape ?  `(${variable.shape.join(', ')})` : 
                   variable.length !== undefined ? `${variable.length}` : '—'}
                </td>
                <td className="namespace-size">{formatSize(variable.size)}</td>
                <td className="namespace-preview">{variable.preview || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer with stats */}
      <div className="namespace-footer">
        <span>{filteredVariables.length} variable{filteredVariables.length !== 1 ? 's' :  ''}</span>
        {autoRefresh && <span className="namespace-auto-refresh">● Auto-refresh</span>}
      </div>
    </div>
  );
};
```

---

### Part 7: Integrate Namespace View into App

**Location:** `electron/renderer/src/app/index.tsx`

**Update left pane tabs:**

```typescript
// Add state for auto-refresh
const [autoRefreshNamespace, setAutoRefreshNamespace] = useState(false);

// In the left pane render: 
<aside className="left-pane">
  <div className="pane-tabs">
    <button
      className={`tab ${activeTab === 'namespace' ? 'active' : ''}`}
      onClick={() => setActiveTab('namespace')}
    >
      Namespace
    </button>
    <button
      className={`tab ${activeTab === 'tree' ? 'active' : ''}`}
      onClick={() => setActiveTab('tree')}
    >
      Tree
    </button>
    <button
      className={`tab ${activeTab === 'modules' ? 'active' : ''}`}
      onClick={() => setActiveTab('modules')}
    >
      Modules
    </button>
  </div>

  {activeTab === 'namespace' && (
    <NamespaceView
      kernelId={currentKernelId}
      autoRefresh={autoRefreshNamespace}
      refreshInterval={2000}
    />
  )}
  
  {activeTab === 'tree' && <Tree />}
  
  {activeTab === 'modules' && (
    <div className="tree-empty">Modules view (coming soon)</div>
  )}
</aside>
```

**Trigger namespace refresh after execution (optional):**

```typescript
const handleExecute = async (code: string) => {
  // ...  existing execution logic ...
  
  // After execution completes, refresh namespace if tab is active
  if (activeTab === 'namespace') {
    // NamespaceView will auto-refresh via useEffect on kernel state change
    // Or manually trigger:  namespaceViewRef.current?.refresh()
  }
};
```

---

### Part 8: Add Styling

**Location:** `electron/renderer/src/styles/index.css`

**Add namespace styles:**

```css
/* ===== NAMESPACE VIEW ===== */

.namespace-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.namespace-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background-color: var(--bg-secondary);
  flex-shrink: 0;
}

.namespace-search {
  width: 100%;
  padding:  6px 10px;
  background-color: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: var(--font-sans);
}

.namespace-search:focus {
  outline: none;
  border-color: var(--accent);
}

.namespace-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.btn-icon {
  padding: 4px 8px;
  background-color: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
}

.btn-icon:hover: not(:disabled) {
  background-color: var(--bg-hover);
}

.btn-icon:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.namespace-filter {
  display: flex;
  align-items: center;
  gap:  4px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}

.namespace-filter input[type="checkbox"] {
  cursor: pointer;
}

.namespace-filter span {
  user-select: none;
}

.namespace-table-container {
  flex: 1;
  overflow-y: auto;
  background-color: var(--bg-primary);
}

.namespace-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 12px;
}

.namespace-table thead {
  position: sticky;
  top: 0;
  background-color: var(--bg-tertiary);
  z-index: 1;
}

.namespace-table th {
  padding: 8px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
  user-select: none;
}

.namespace-table th:hover {
  color: var(--accent);
}

.namespace-table tbody tr {
  border-bottom: 1px solid var(--bg-secondary);
}

.namespace-table tbody tr:hover {
  background-color: var(--bg-hover);
}

.namespace-row {
  cursor: pointer;
}

.namespace-table td {
  padding: 6px 12px;
  color: var(--text-primary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.namespace-name {
  font-weight: 500;
  color: var(--accent);
}

.namespace-type {
  color: var(--text-secondary);
}

.namespace-shape {
  color: var(--text-secondary);
  font-size: 11px;
}

.namespace-size {
  color: var(--text-secondary);
  text-align: right;
}

.namespace-preview {
  color: var(--text-primary);
  font-size: 11px;
}

.namespace-loading,
.namespace-error,
.namespace-empty {
  padding: 24px;
  text-align:  center;
  color: var(--text-secondary);
  font-style: italic;
}

.namespace-error {
  color: var(--error);
}

.namespace-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-top: 1px solid var(--border-color);
  background-color: var(--bg-secondary);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.namespace-auto-refresh {
  color: var(--success);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
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

2. **App launches:**
   ```bash
   npm run dev
   ```

3. **Namespace tab exists:**
   - Click "Namespace" tab in left pane
   - Shows empty state if no variables

4. **Variables appear after execution:**
   ```python
   import numpy as np
   x = np.array([1, 2, 3, 4, 5])
   y = [1, 2, 3]
   name = "test"
   ```
   - Switch to Namespace tab
   - Shows 4 variables: `np`, `x`, `y`, `name`
   - (If modules filter is off, `np` is hidden)

5. **Variable metadata displayed:**
   - `x`: type `ndarray`, shape `(5,)`, dtype `int64`, preview shows shape
   - `y`: type `list`, length `3`, preview shows `[1, 2, 3]`
   - `name`: type `str`, length `4`, preview shows `"test"`

6. **Filters work:**
   - Uncheck "Private" → variables starting with `_` disappear
   - Check "Modules" → `np` appears
   - Check "Functions" → function definitions appear

7. **Search works:**
   - Type "x" in search box → only variables with "x" in name shown
   - Clear search → all variables reappear

8. **Sorting works:**
   - Click "Name" header → sorts alphabetically
   - Click "Type" header → sorts by type
   - Click "Size" header → sorts by size (largest first)

9. **Refresh works:**
   - Execute:  `z = 42`
   - Click refresh button (🔄)
   - `z` appears in namespace

10. **Double-click copies name:**
    - Double-click variable row
    - Name copied to clipboard
    - Can paste into command box

11. **Auto-refresh (if implemented):**
    - Enable auto-refresh option
    - Execute new code
    - Namespace updates automatically after 2 seconds

12. **Julia variables work:**
    - Switch kernel to Julia
    - Execute:  `x = [1, 2, 3]`
    - Namespace shows `x` with type `Vector{Int64}`

13. **Error handling:**
    - No kernel active → shows "No kernel active"
    - Kernel dies → shows error message
    - Query fails → shows error, doesn't crash

14. **Performance:**
    - Large namespace (100+ variables) loads in < 1s
    - Sorting/filtering is instant
    - No UI freezing during query

---

## Files to Create/Modify (Checklist)

- [ ] `electron/main/init/python-init.py` — Add `pdv_namespace()` and enhance `pdv_info()`
- [ ] `electron/main/init/julia-init.jl` — Add `pdv_namespace()` and enhance `pdv_info()`
- [ ] `electron/main/ipc. ts` — Add namespace query channel and types
- [ ] `electron/main/index.ts` — Add namespace query IPC handler
- [ ] `electron/preload. ts` — Add namespace query to API
- [ ] `electron/renderer/src/components/NamespaceView/index.tsx` — NEW:  Namespace view component
- [ ] `electron/renderer/src/app/index.tsx` — Integrate NamespaceView into tabs
- [ ] `electron/renderer/src/styles/index.css` — Add namespace styles

---

## Notes

- **Performance:** Namespace queries can be slow for kernels with many large objects.   Consider pagination or lazy loading for 1000+ variables. 

- **JSON serialization:** Python's `json.dumps()` can fail on non-serializable objects (e.g., functions, complex objects). The handler catches these and returns error strings.

- **IPython vs Python:** The code detects IPython and uses `user_ns` if available, otherwise uses `globals()`.  IPython is standard for Jupyter kernels.

- **Julia type system:** Julia's type names can be verbose (e.g., `Array{Float64, 2}`). Consider shortening for display.

- **Memory usage:** Large arrays appear in namespace but aren't loaded into frontend—only metadata is transferred.

- **Auto-refresh:** Polling every 2 seconds can be expensive. Consider only refreshing after execution completes (hook into execution IPC).

- **Context menu:** Future enhancement—right-click variable to plot, inspect, delete, etc.

- **Copy to command box:** Future enhancement—drag variable name into command box instead of clipboard.

---

## Testing Tips

**Manual test workflow:**

1. Start app, execute some Python code creating variables
2. Switch to Namespace tab
3. Verify variables appear with correct metadata
4. Try filters (private, modules, functions)
5. Search for specific variable
6. Sort by name/type/size
7. Execute more code, click refresh
8. Double-click to copy name
9. Test with Julia kernel
10. Test with large namespace (100+ variables)

**Edge cases:**

- No variables in namespace → empty state
- Only private variables → empty state (unless filter enabled)
- Very large array (GB) → metadata loads instantly, array not transferred
- Object that can't be inspected → shows error in preview, doesn't break table
- Kernel restart → namespace clears

**Performance tests:**

- 1000 variables → query time < 2s
- Sorting 1000 variables → instant
- Filtering 1000 variables → instant
- Auto-refresh with 100 variables → no UI lag

---

## Future Enhancements (Not Required for This Step)

- Context menu actions (plot, inspect, delete)
- Variable details panel (expand to show full info)
- Drag variable name to command box
- Export namespace to file
- Compare namespaces (before/after execution)
- Variable history (track changes over time)
- Type-specific icons (array icon, dataframe icon, etc.)
- Inline mini-plots for arrays