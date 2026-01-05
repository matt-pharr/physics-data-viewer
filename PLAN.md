# Physics Data Viewer – Build Plan (React + Vite + Electron + Jupyter kernels)

This plan guides implementation of Physics Data Viewer using AI agents and iterative steps with test checkpoints.  The focus is on:  a performant Electron UI, Jupyter-kernel-backed execution (Python/Julia), a file-system-based project structure with scripts and data, and native-plot behavior with a capture fallback.

---

## Overall Goals (What the App Is Supposed To Be/Do)

**In short:** A modernized, trimmed-down, generalized, minimalist version of OMFIT with an Electron frontend independent of the Python/Julia environment.  The burden of keeping a module compatible with a certain Python or Julia version lies solely with the module itself, not the app. 

**Core objectives:**

1. **Unified project workspace**:  Provide a desktop app (Electron) to explore, run, and manage scientific data workflows in a project-oriented way.

2. **Language-agnostic REPL control**: Talk to Python and Julia via Jupyter kernels; no runtimes bundled.  Users pick an environment/kernelspec on startup; switching kernels should not restart the UI.

3. **File-system-based project structure**: Projects are directories on disk with a clear structure: 
   ```
   my_project/
   ├── project.pdv              # Project metadata (tree structure, config)
   ├── tree/
   │   ├── data/               # Actual data files (HDF5, Zarr, etc.)
   │   ├── scripts/            # Python/Julia scripts (editable in any IDE)
   │   └── results/            # Output files, figures
   └── blobs/                  # Content-addressed object store (pickles, JLSO)
   ```

4. **Central Tree as source of truth**: A lazy, manifest-driven Tree that references files and objects.  It must: 
   - Mirror the file system structure (`tree/` directory)
   - Store arbitrary objects with trust-gated serialization (pickle/JLSO/JLD2)
   - Provide lazy metadata-only browsing; fetch children/content on demand
   - Attach default and custom actions; double-click runs the primary action
   - Support loader hints for chunked/streamed access to large datasets
   - Elements lazily loaded for compatibility with large-size data on disk

5. **Script system (clean IDE experience)**: Scripts are normal Python/Julia files with a standard `run(tree, **kwargs)` entry point. No magic globals, no IDE warnings. Scripts live in `tree/scripts/` and are editable in external IDEs (VS Code, Neovim, etc.). Example: 
   ```python
   # tree/scripts/analysis/fit_model.py
   def run(tree:  dict, data_path: str, model:  str = "linear") -> dict:
       """Entry point called by PDV"""
       data = tree[data_path]
       # ...  do analysis
       tree['results']['fit_params'] = params
       return {"status": "success", "params": params}
   ```
   Execute from command box: `tree['scripts']['analysis']['fit_model']. run(data_path='data.raw', model='quadratic')`

6. **Interactive execution UI**:
   - Monaco-based command boxes (cell analogues) with run-selection/full-cell, tabs for multiple scratchpads, inline error display, and duration
   - Console/log showing execution history (timestamps, durations, stdout/stderr/result summaries) with search/filter/clear

7. **Plot handling**:
   - Default to native windows (matplotlib QtAgg/GR/GLMakie) like a normal REPL
   - Provide a capture fallback (`pdv_show()`) to return PNG/SVG when native windows aren't available or when inline viewing is desired
   - Plot mode toggle (Native vs Capture) per session/execution

8. **Data loaders (lazy and efficient)**:
   - Chunked/streamed reads for large data (HDF5/Zarr/Parquet/Arrow/NPY); avoid blocking the renderer; offload to sidecar/worker where possible
   - Previews/metadata first; only load heavy payloads when needed
   - Loaders for:  HDF5 (groups/datasets), Zarr (arrays), Parquet/Arrow (schema/pages), NPY (memmap), images (PIL)

9. **Extensibility via manifests**:
   - Modules can register custom GUIs using declarative JSON manifests
   - Module developers work entirely in Python/Julia—no JavaScript required
   - Manifests define widgets (inputs, buttons, plots, tables) and actions (call Python methods)
   - UI panels/cards for modules driven by manifests

10. **Project persistence**: 
    - Save/load projects from `project.pdv` (JSON manifest)
    - File system structure persists scripts and data files naturally
    - Blob store for arbitrary objects (pickles, JLSO)
    - Auto-save (every 30s) with crash recovery
    - Namespace is ephemeral (NOT saved in project)

11. **Packaging and portability**:
    - Ship only the Electron app (no Python/Julia bundled)
    - First-run environment selector (kernelspecs/custom commands); optional remote kernel support
    - Distribute as Electron app with installers for macOS/Windows/Linux

12. **Safety and trust**:
    - Trust gate for unsafe deserialization (pickle/JLSO/BSON). Only load from trusted sources

---

## Tech Stack (Locked)

- **Frontend**: Electron (with preload), React, Vite, TypeScript, Monaco editor
- **Kernel bridge**: `@jupyterlab/services` (Jupyter protocol) in Electron main
- **Plot behavior**: Native windows by default; capture fallback via helper (`pdv_show`) for PNG/SVG
- **Data**:  Lazy loaders for HDF5/Zarr/Parquet/Arrow/NPY/Image; pickle/JLSO for unknowns (trust-gated)
- **Packaging**: `electron-builder`

---

## Project Structure (File System)

### On Disk

```
my_project/
├── project.pdv              # Project manifest (JSON)
├── tree/
│   ├── data/
│   │   ├── raw_data. h5      # Actual data files
│   │   └── processed. zarr/
│   ├── scripts/
│   │   ├── preprocessing/
│   │   │   ├── normalize.py
│   │   │   └── filter.jl
│   │   └── analysis/
│   │       └── fit_model.py
│   └── results/
│       ├── figures/
│       │   └── plot1.png
│       └── outputs/
│           └── fitted_params.npy
└── blobs/                   # Content-addressed object store
    ├── a3f2e1.... pickle     # Arbitrary Python objects
    └── b4c8d9....jlso       # Arbitrary Julia objects
```

### Project Manifest (`project.pdv`)

```json
{
  "version": "1.0",
  "name": "My Physics Project",
  "created":  "2024-01-15T10:30:00Z",
  "tree": {
    "data": {
      "raw_data. h5": {
        "type": "file",
        "relativePath": "tree/data/raw_data.h5"
      }
    },
    "scripts":  {
      "analysis": {
        "fit_model. py": {
          "type":  "file",
          "relativePath": "tree/scripts/analysis/fit_model.py"
        }
      }
    },
    "results": {
      "fit_params":  {
        "type": "blob",
        "hash": "b4c8d92a.. .",
        "metadata": {"dtype": "ndarray"}
      }
    }
  },
  "config": {
    "pythonPath": "/usr/bin/python3",
    "juliaPath": "/usr/local/bin/julia"
  }
}
```

**What's saved:**
- ✅ Tree structure (references to files + blobs)
- ✅ File contents (scripts, data files in `tree/`)
- ✅ Pickled/JLSO objects (in `blobs/`)
- ✅ Project config (kernel paths, editor config)

**What's NOT saved:**
- ❌ Kernel namespace (variables)
- ❌ Execution history
- ❌ UI state (open tabs, scroll position)

---

## GUI Specification (Detailed)

### Overall Layout (Desktop-First)

```
+-----------------------------------------------------------------------+
| Header:  App title | Connection status | Kernel/env selector           |
+------------------+----------------------------------------------------+
|                  |                                                    |
|   Tree Pane      |   Console / Log (right-top)                        |
|   (left)         |   - Read-only execution history                    |
|                  |   - Timestamps, durations, stdout/stderr/results   |
|   Tabs:           |   - Images from captured plots                     |
|   [Namespace]    |   - Search/filter/clear                            |
|   [Tree]         |                                                    |
|   [Modules]      +----------------------------------------------------+
|                  |                                                    |
|   Virtualized    |   Command Box / Cells (right-bottom)               |
|   lazy tree      |   - Monaco editor (required)                       |
|   Key|Type|Value |   - Tabs for multiple scratchpads                  |
|                  |   - Execute / Clear buttons                        |
|                  |   - Inline error bar, exec duration                |
|                  |   - Plot mode toggle (Native vs Capture)           |
+------------------+----------------------------------------------------+
| Status Bar:  kernel status | env name | cwd | plot mode | last exec    |
+-----------------------------------------------------------------------+
```

### Left Pane (Tree Area)

- Fixed width ~320–380px, scrollable, sticky header
- Tabs above tree:  `Namespace | Tree | Modules` (Tree is default)
- **Tree tab**: File system + data + scripts + results
- **Namespace tab**: Kernel variables (queries `dir()` / `names(Main)`)
- **Modules tab**: Registered module panels

### Tree Details

- Virtualized, lazy-loaded tree with expand/collapse
- Columns: Key, Type, Preview (value snippet); header is sticky
- Node types: folder, file, script, dataset, group, ndarray, dataframe, image, blob, etc.
- Icons/badges for types; loading spinners on expand
- Context menu actions: 
  - Scripts: Run, Edit (external), Reload
  - Data files: Load to namespace, Preview
  - Datasets: Plot, Inspect
  - All: Copy path, Delete

### Right-Top (Console / Log)

- Read-only log of executions with timestamps, duration, stdout/stderr/result summaries
- Images displayed inline (from capture mode)
- Filters/search; Clear; (optional) Export
- Optional Monaco read-only for code snippets in log entries

### Right-Bottom (Command Box / Cells)

- **Monaco editor required** for code input
- Tabs for multiple scratchpads (add/remove)
- Run selection or full cell; Execute button; Clear button
- Inline error bar (red); show execution duration
- Sends execution to active kernel; capture flag toggle (native vs inline plots)
- Keyboard shortcuts: Ctrl/Cmd+Enter to run; Shift+Enter run+newline

### Status Bar (Bottom Full Width)

- Kernel status (idle/busy/error) with colored dot
- Environment name (python3, julia-1.9, etc.)
- Current working directory
- Plot mode toggle (Native | Capture)
- Last execution duration

### Styling

- Dark theme (VS Code-like). Borders at 1px #333; backgrounds around #1e1e1e–#252526; accent #4ec9b0
- Consistent monospace fonts for code areas and tree rows (Consolas/Monaco/JetBrains Mono)

---

## Script System (Detailed)

### Script Structure

Scripts are normal Python/Julia files with a standard entry point: 

**Python:**
```python
# tree/scripts/analysis/fit_model.py

def run(tree: dict, data_path: str, model: str = "linear", **kwargs) -> dict:
    """
    Entry point called by PDV. 
    
    Args:
        tree: Reference to PDV tree (dict-like)
        data_path: Path to data in tree
        model: Model type
        **kwargs: Additional parameters
    
    Returns:
        dict: Results summary
    """
    data = tree[data_path]
    # ... analysis
    tree['results']['fit_params'] = params
    return {"status": "success", "params":  params. tolist()}
```

**Julia:**
```julia
# tree/scripts/analysis/solve_pde.jl

function run(tree::Dict, initial_condition::String; tspan=(0.0, 1.0))
    """Entry point called by PDV"""
    u0 = tree[initial_condition]
    # ... solve PDE
    tree["results"]["solution"] = sol
    return Dict("status" => "success")
end
```

### Execution

From command box:
```python
script = tree['scripts']['analysis']['fit_model']
result = script.run(data_path='data.experimental', model='quadratic')
```

Or shorthand:
```python
tree. run_script('scripts. analysis.fit_model', 
                data_path='data.shot_42', 
                model='linear')
```

### External Editing

Right-click script in Tree → "Edit" → Opens in configured editor:
```
Config: editors.python = "code %s"  # VS Code
        editors.julia = "nvim %s"   # Neovim
```

App spawns:  `code /path/to/project/tree/scripts/analysis/fit_model.py`

File watcher detects changes → offers reload in UI.

### Benefits

✅ No IDE warnings—scripts are normal Python/Julia files
✅ Explicit `run(tree, ...)` entry point—clean interface
✅ Scripts live in `tree/` and are editable externally
✅ Type hints supported—IDEs autocomplete `tree` methods
✅ Hot reload without kernel restart (importlib.reload / Revise. jl)

---

## Data Loaders (Detailed)

### Supported Formats

| Format | Extension | Metadata | Lazy Read | Use Case |
|--------|-----------|----------|-----------|----------|
| HDF5 | `.h5`, `.hdf5` | Groups, datasets, attrs | Chunked slicing | Large arrays, nested data |
| Zarr | `.zarr` (dir) | Array metadata | Chunked | Cloud-optimized arrays |
| Parquet | `.parquet` | Schema, row count | Paged | Tabular data |
| Arrow | `.arrow` | Schema | Paged | High-perf tables |
| NumPy | `.npy`, `.npz` | Shape, dtype | Memmap | Simple arrays |
| Images | `.png`, `.jpg` | Dimensions | PIL | Figures, photos |

### Loader Interface

```python
class Loader:
    def can_load(self, path: str, type: str) -> bool:
        """Check if this loader handles the file"""
        
    def get_metadata(self, path: str) -> dict:
        """Extract metadata without loading data"""
        
    def get_children(self, path: str) -> list[TreeNode]:
        """Get child nodes (for HDF5 groups, etc.)"""
        
    def load(self, path: str, slice: dict) -> Any:
        """Load data (with optional slicing)"""
```

### Example: HDF5 Loader

```python
class HDF5Loader(Loader):
    def get_metadata(self, path):
        with h5py.File(path, 'r') as f:
            return {
                'groups': list(f.keys()),
                'num_datasets': len([k for k in f.keys() if isinstance(f[k], h5py.Dataset)]),
            }
    
    def get_children(self, path, group_path=''):
        with h5py. File(path, 'r') as f:
            group = f[group_path] if group_path else f
            children = []
            for key in group. keys():
                item = group[key]
                if isinstance(item, h5py. Group):
                    children.append({
                        'key': key,
                        'type': 'group',
                        'hasChildren': True,
                    })
                elif isinstance(item, h5py. Dataset):
                    children.append({
                        'key': key,
                        'type': 'dataset',
                        'shape': list(item.shape),
                        'dtype': str(item.dtype),
                        'hasChildren': False,
                    })
            return children
    
    def load(self, path, dataset_path, slice=None):
        with h5py.File(path, 'r') as f:
            dataset = f[dataset_path]
            if slice:
                return dataset[slice]
            return dataset[:]
```

### Tree Integration

HDF5 file appears in Tree: 
```
📁 data
  📄 raw_data.h5
    📁 experiments
      📊 shot_001 (1000, 2048) float64
      📊 shot_002 (1000, 2048) float64
```

Double-click `shot_001` → loads into kernel: 
```python
data = tree['data']['raw_data.h5']['experiments']['shot_001'][:]
# Or lazy slice:
preview = tree['data']['raw_data.h5']['experiments']['shot_001'][:10, : 10]
```

---

## Module System (Detailed)

### Manifest Schema

Modules define GUIs using JSON manifests:

```json
{
  "type": "module_panel",
  "title": "Data Smoothing",
  "description": "Apply smoothing filters to 1D data",
  "widgets": [
    {
      "type":  "tree_selector",
      "id": "input_data",
      "label": "Input Data",
      "filter": {"types": ["ndarray"], "shape": [null]}
    },
    {
      "type": "number_input",
      "id": "window_size",
      "label":  "Window Size",
      "default": 5,
      "min": 1,
      "max": 100
    },
    {
      "type": "dropdown",
      "id": "method",
      "label": "Method",
      "options": [
        {"value": "moving_avg", "label": "Moving Average"},
        {"value": "savgol", "label": "Savitzky-Golay"}
      ],
      "default": "moving_avg"
    },
    {
      "type": "button",
      "label": "Run Smoothing",
      "action": {
        "type": "method",
        "target": "run_smoothing",
        "args": ["input_data", "window_size", "method"]
      }
    },
    {
      "type":  "plot_area",
      "id": "result_plot",
      "label":  "Result",
      "data_source": {"type": "variable", "variable": "self.result"}
    }
  ]
}
```

### Python Module

```python
class SmoothingModule: 
    def __init__(self, tree, gui_state):
        self.tree = tree
        self.gui = gui_state
        self.result = None
    
    @staticmethod
    def get_gui_manifest():
        return { ...  }  # Manifest above
    
    def run_smoothing(self, input_path, window_size, method):
        data = self.tree[input_path]
        
        if method == "moving_avg": 
            from scipy.ndimage import uniform_filter1d
            smoothed = uniform_filter1d(data, size=window_size)
        elif method == "savgol": 
            from scipy.signal import savgol_filter
            smoothed = savgol_filter(data, window_size, 3)
        
        self. result = smoothed
        self.tree['results']['smoothed'] = smoothed
        
        return {"status": "success"}
```

### Registration

```python
# In kernel
import pdv
from my_module import SmoothingModule

gui = pdv.GUIState("smoothing")
module = SmoothingModule(tree, gui)
pdv.register_module("smoothing", module)
```

### Frontend Rendering

Frontend receives manifest → dynamically creates React components: 
- `tree_selector` → `<TreePicker>` component
- `number_input` → `<input type="number">`
- `button` → `<button>` wired to IPC call

Button click → IPC:  `window.pdv.modules.execute("smoothing", "run_smoothing", ["/data/signal", 5, "moving_avg"])`

Backend → Execute in kernel:  `smoothing.run_smoothing(tree['/data/signal'], 5, 'moving_avg')`

Result → Frontend updates plot area by polling `smoothing.result`

**No JavaScript required for module developer!**

---

## IPC Contracts (Reference)

```typescript
// Channel names
kernels: list / kernels:start / kernels:stop / kernels:execute / kernels:interrupt / kernels:restart / kernels:complete / kernels:inspect
tree:list / tree:get / tree:save / tree:run_script
files:read / files:write / files:edit
config:get / config:set
modules:register / modules:execute / modules:get_widget_value / modules:set_widget_value
project:save / project:load

// Key types
KernelExecuteRequest { code: string; capture?:  boolean; cwd?: string; }
KernelExecuteResult { stdout?:  string; stderr?: string; result?: unknown; images?: Array<{mime, data}>; error?: string; duration?: number; }
TreeNode { id: string; key: string; path: string; type: string; preview?: string; hasChildren: boolean; sizeBytes?: number; shape?: number[]; dtype?: string; loaderHint?: string; actions?: string[]; _file_path?: string; }
```

---

## Advice for Using AI Agents (GitHub Copilot)

1. **Constrain scope per step**:  Work step-by-step; feed Copilot the interface you want (types/signatures) before asking for implementation. 
2. **Use TODO blocks**: Write function skeleton and comments; let Copilot fill body.  Review for API correctness.
3. **Provide examples**: When writing loader registries or IPC shapes, paste a small example object so Copilot aligns with your schema.
4. **Keep IPC contracts in one file**: Reference it often so Copilot stays consistent across main/preload/renderer.
5. **Ask for tests alongside code**: Prompt Copilot to generate Vitest specs for every new module. 
6. **Guard main vs renderer**: Remind Copilot which context a file runs in (main/preload/renderer) to avoid using forbidden APIs in the renderer. 
7. **Small diffs**: Commit frequently with small, testable changes so Copilot has less surface to drift. 
8. **Explicit backends**: In init cells, be explicit about matplotlib backend fallback logic; Copilot can guess wrong—keep it deterministic. 
9. **Security notes**: Be explicit that pickle/JLSO loads are trust-gated; Copilot may omit safety—add checks manually. 
10. **Review generated types**: Ensure discriminated unions for actions/loaders; Copilot might over-widen types. 

---

## Next Actions

- Complete Step 5. 5 (Real Kernel Integration)
- Proceed with Step 6 (Plot Mode & Capture)
- Build out Steps 7-14 incrementally with testing at each step