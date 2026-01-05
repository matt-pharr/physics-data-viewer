# Agent Task:   Step 8 - Script Execution & File Operations

## Context

You are continuing work on "Physics Data Viewer", an Electron + React + Vite + TypeScript app.    Step 7 implemented the Namespace view.   Users can now see kernel variables and their metadata.  

**Your task is to implement the script system:  scanning Python/Julia files from disk, displaying them in the Tree, enabling external editing, and executing scripts with a standard `run(tree, **kwargs)` entry point.   Scripts should be normal files editable in any IDE without warnings.**

**Reference files you should read first:**
- `PLAN.md` — Script system architecture (clean IDE experience)
- `electron/renderer/src/components/Tree/index.tsx` — Tree component
- `electron/main/kernel-manager.ts` — Kernel execution
- `electron/main/ipc.ts` — IPC types

**Current state:**
- Tree displays stub data
- No file system scanning
- No script execution mechanism
- No external editor integration

**After this step:**
- Tree scans `tree/scripts/` directory for `.py`/`.jl` files
- Scripts appear in Tree with metadata (docstring, last modified)
- Right-click script → "Edit" opens in external editor (configurable)
- Right-click script → "Run" executes with parameter dialog
- Scripts have standard `run(tree, **kwargs)` entry point
- `tree. run_script(path, **kwargs)` available in kernel
- Hot reload:  file changes detected, offer to re-run
- No IDE warnings when editing scripts

---

## Your Task

### Part 1: File System Scanner

**Location:** `electron/main/file-scanner.ts` (NEW)

**Purpose:** Scan project directory and build tree structure from file system. 

**Implementation:**

```typescript
/**
 * File System Scanner
 * 
 * Scans the project's tree/ directory and builds TreeNode structure. 
 * Detects file types and extracts metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TreeNode } from './ipc';

export interface ScanOptions {
  projectRoot: string;
  includeHidden?: boolean;
}

export class FileScanner {
  private projectRoot: string;
  private treeRoot: string;
  
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.treeRoot = path.join(projectRoot, 'tree');
  }
  
  /**
   * Scan entire tree directory
   */
  async scanAll(): Promise<TreeNode[]> {
    if (!fs.existsSync(this.treeRoot)) {
      // Create tree directory if it doesn't exist
      fs.mkdirSync(this. treeRoot, { recursive: true });
      
      // Create default subdirectories
      fs.mkdirSync(path.join(this.treeRoot, 'data'), { recursive: true });
      fs.mkdirSync(path.join(this.treeRoot, 'scripts'), { recursive: true });
      fs.mkdirSync(path. join(this.treeRoot, 'results'), { recursive: true });
    }
    
    return this.scanDirectory(this.treeRoot, '');
  }
  
  /**
   * Scan a specific directory
   */
  async scanDirectory(dirPath: string, relativePath: string): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];
    
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        // Skip hidden files (unless requested)
        if (entry.name.startsWith('.')) continue;
        
        const fullPath = path.join(dirPath, entry.name);
        const nodePath = relativePath ? `${relativePath}. ${entry.name}` : entry.name;
        const stats = fs.statSync(fullPath);
        
        if (entry.isDirectory()) {
          nodes.push({
            id: nodePath,
            key: entry.name,
            path: nodePath,
            type: 'folder',
            hasChildren: true,
            expandable: true,
            _file_path: fullPath,
          });
        } else if (entry.isFile()) {
          const node = await this.createFileNode(fullPath, entry.name, nodePath, stats);
          nodes.push(node);
        }
      }
    } catch (error) {
      console.error(`[FileScanner] Failed to scan ${dirPath}:`, error);
    }
    
    return nodes;
  }
  
  /**
   * Create TreeNode for a file
   */
  private async createFileNode(
    filePath: string,
    fileName:  string,
    nodePath: string,
    stats:  fs.Stats
  ): Promise<TreeNode> {
    const ext = path.extname(fileName);
    const node: TreeNode = {
      id: nodePath,
      key:  fileName,
      path: nodePath,
      type: this.detectFileType(ext),
      hasChildren: false,
      sizeBytes: stats.size,
      _file_path: filePath,
      _modified:  stats.mtime. toISOString(),
    };
    
    // Extract metadata based on file type
    if (ext === '.py' || ext === '.jl') {
      node.type = 'script';
      node.language = ext === '.py' ? 'python' : 'julia';
      node.actions = ['run', 'edit', 'reload', 'view_source'];
      
      // Extract docstring/description
      try {
        const content = fs. readFileSync(filePath, 'utf-8');
        const docstring = this.extractDocstring(content, ext);
        if (docstring) {
          node.preview = docstring;
        }
      } catch (error) {
        console.warn(`[FileScanner] Failed to read ${filePath}:`, error);
      }
    } else if (ext === '.h5' || ext === '.hdf5') {
      node.type = 'hdf5';
      node.loaderHint = 'hdf5';
      node.hasChildren = true;  // HDF5 files are expandable
      node.actions = ['load', 'inspect'];
    } else if (ext === '.zarr') {
      node.type = 'zarr';
      node.loaderHint = 'zarr';
      node.hasChildren = true;
      node.actions = ['load', 'inspect'];
    } else if (ext === '. parquet') {
      node.type = 'parquet';
      node.loaderHint = 'parquet';
      node. actions = ['load', 'preview'];
    } else if (ext === '.npy' || ext === '.npz') {
      node.type = 'npy';
      node.loaderHint = 'npy';
      node.actions = ['load'];
    } else if (['.png', '.jpg', '.jpeg', '. svg']. includes(ext)) {
      node.type = 'image';
      node.loaderHint = 'image';
      node. actions = ['view', 'open'];
    } else if (['.json', '.yaml', '.yml', '.toml'].includes(ext)) {
      node.type = 'config';
      node.actions = ['view', 'edit'];
    } else {
      node.type = 'file';
      node.actions = ['view', 'open'];
    }
    
    return node;
  }
  
  /**
   * Detect file type from extension
   */
  private detectFileType(ext: string): string {
    const typeMap:  Record<string, string> = {
      '.py': 'script',
      '.jl': 'script',
      '.h5': 'hdf5',
      '. hdf5': 'hdf5',
      '.zarr': 'zarr',
      '.parquet': 'parquet',
      '.arrow': 'arrow',
      '.npy': 'npy',
      '.npz': 'npy',
      '.png': 'image',
      '.jpg': 'image',
      '.jpeg': 'image',
      '.svg': 'image',
      '.json':  'config',
      '.yaml': 'config',
      '. yml': 'config',
      '. toml': 'config',
      '.txt': 'text',
      '.md': 'text',
    };
    
    return typeMap[ext] || 'file';
  }
  
  /**
   * Extract docstring from script file
   */
  private extractDocstring(content: string, ext:  string): string | undefined {
    if (ext === '.py') {
      // Python:  look for module docstring or run() docstring
      const moduleDocMatch = content.match(/^"""([\s\S]*?)"""/m) || 
                            content.match(/^'''([\s\S]*?)'''/m);
      if (moduleDocMatch) {
        return moduleDocMatch[1]. trim().split('\n')[0];  // First line only
      }
      
      // Try to find run() docstring
      const runDocMatch = content.match(/def run\([^)]*\):[^"']*"""([\s\S]*?)"""/);
      if (runDocMatch) {
        return runDocMatch[1].trim().split('\n')[0];
      }
    } else if (ext === '.jl') {
      // Julia: look for module docstring or run() docstring
      const moduleDocMatch = content.match(/^"""([\s\S]*?)"""/m);
      if (moduleDocMatch) {
        return moduleDocMatch[1].trim().split('\n')[0];
      }
      
      // Try to find run() docstring
      const runDocMatch = content. match(/"""[\s\S]*?"""\s*function run\(/);
      if (runDocMatch) {
        const docMatch = content.match(/"""([\s\S]*?)"""\s*function run\(/);
        if (docMatch) {
          return docMatch[1].trim().split('\n')[0];
        }
      }
    }
    
    return undefined;
  }
  
  /**
   * Get children of a directory node
   */
  async getChildren(nodePath: string): Promise<TreeNode[]> {
    const relativePathParts = nodePath.split('.');
    const dirPath = path.join(this. treeRoot, ... relativePathParts);
    
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return [];
    }
    
    return this.scanDirectory(dirPath, nodePath);
  }
}
```

---

### Part 2: Add Script Execution to IPC

**Location:** `electron/main/ipc.ts`

**Add script-related channels:**

```typescript
export const IPC = {
  // ... existing channels ...
  script: {
    run: 'script: run',
    edit: 'script:edit',
    reload:  'script:reload',
    get_params: 'script:get_params',
  },
  files: {
    // ... existing
    watch: 'files:watch',
    unwatch: 'files:unwatch',
  },
} as const;
```

**Add script types:**

```typescript
export interface ScriptRunRequest {
  scriptPath: string;  // Tree path (e.g., "scripts. analysis. fit_model")
  params?: Record<string, unknown>;
}

export interface ScriptRunResult {
  success: boolean;
  result?: unknown;
  error?: string;
  duration?: number;
}

export interface ScriptParameter {
  name: string;
  type: string;
  default?: unknown;
  required?: boolean;
  description?: string;
}
```

---

### Part 3: Implement Script Execution Handler

**Location:** `electron/main/index.ts`

**Add script handlers:**

```typescript
import { FileScanner } from './file-scanner';

// Initialize file scanner (project root from config or default)
let fileScanner: FileScanner | null = null;

function getFileScanner(): FileScanner {
  if (! fileScanner) {
    const config = loadConfig();
    const projectRoot = config.projectRoot || process.cwd();
    fileScanner = new FileScanner(projectRoot);
  }
  return fileScanner;
}

// Update tree: list to use file scanner
ipcMain.handle(IPC.tree.list, async (_event, treePath): Promise<TreeNode[]> => {
  console.log('[IPC] tree:list', treePath);
  
  const scanner = getFileScanner();
  
  if (!treePath || treePath === '' || treePath === 'root') {
    // Return root nodes
    return scanner.scanAll();
  }
  
  // Return children of a directory
  return scanner.getChildren(treePath);
});

// Script:  Run
ipcMain.handle(IPC.script.run, async (_event, kernelId:  string, request: ScriptRunRequest) => {
  console.log('[IPC] script:run', kernelId, request);
  
  try {
    const kernelManager = getKernelManager();
    const kernel = kernelManager.getKernel(kernelId);
    
    if (!kernel) {
      return { success: false, error: `Kernel not found: ${kernelId}` };
    }
    
    // Get script file path from tree
    const scanner = getFileScanner();
    const nodes = await scanner.scanAll();
    const scriptNode = findNodeByPath(nodes, request.scriptPath);
    
    if (!scriptNode || !scriptNode._file_path) {
      return { success: false, error: `Script not found: ${request.scriptPath}` };
    }
    
    // Build execution code
    const language = kernel.language;
    let code = '';
    
    if (language === 'python') {
      // Python: use tree.run_script()
      const paramsJson = JSON.stringify(request.params || {});
      code = `tree.run_script('${request.scriptPath}', **${paramsJson. replace(/"/g, "'")})`;
    } else if (language === 'julia') {
      // Julia: use tree.run_script()
      const paramsStr = request.params 
        ? Object.entries(request.params)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ')
        : '';
      code = `tree.run_script("${request.scriptPath}"${paramsStr ?  ', ' + paramsStr : ''})`;
    } else {
      return { success: false, error: `Unsupported language: ${language}` };
    }
    
    // Execute
    const startTime = Date.now();
    const result = await kernelManager.execute(kernelId, { code });
    
    if (result.error) {
      return {
        success: false,
        error: result.error,
        duration: Date.now() - startTime,
      };
    }
    
    return {
      success: true,
      result: result.result,
      duration: Date.now() - startTime,
    };
    
  } catch (error) {
    return {
      success: false,
      error:  error instanceof Error ? error.message :  String(error),
    };
  }
});

// Helper:  find node by path
function findNodeByPath(nodes: TreeNode[], targetPath: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === targetPath) {
      return node;
    }
    if (node.hasChildren && targetPath.startsWith(node.path + '.')) {
      // Recursively search children (would need to load them)
      // For now, return undefined (caller should handle)
    }
  }
  return undefined;
}

// Script: Edit (open in external editor)
ipcMain.handle(IPC.script. edit, async (_event, scriptPath: string) => {
  console.log('[IPC] script:edit', scriptPath);
  
  try {
    const scanner = getFileScanner();
    const nodes = await scanner.scanAll();
    const scriptNode = findNodeByPath(nodes, scriptPath);
    
    if (!scriptNode || !scriptNode._file_path) {
      return { success: false, error: `Script not found: ${scriptPath}` };
    }
    
    const filePath = scriptNode._file_path;
    const config = loadConfig();
    const language = scriptNode.language || 'python';
    
    // Get editor command from config
    const editorCmd = config.editors? .[language] || config.editors?. default || 'open %s';
    const cmd = editorCmd.replace('%s', `"${filePath}"`);
    
    // Spawn editor
    const { spawn } = require('child_process');
    spawn(cmd, {
      shell: true,
      detached: true,
      stdio:  'ignore',
    }).unref();
    
    return { success: true };
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error. message : String(error),
    };
  }
});

// Script: Get Parameters (extract from function signature)
ipcMain.handle(IPC.script.get_params, async (_event, scriptPath: string) => {
  console.log('[IPC] script:get_params', scriptPath);
  
  try {
    const scanner = getFileScanner();
    const nodes = await scanner.scanAll();
    const scriptNode = findNodeByPath(nodes, scriptPath);
    
    if (!scriptNode || !scriptNode._file_path) {
      return { success: false, error: `Script not found: ${scriptPath}` };
    }
    
    const content = fs.readFileSync(scriptNode._file_path, 'utf-8');
    const language = scriptNode.language;
    
    const params: ScriptParameter[] = [];
    
    if (language === 'python') {
      // Parse Python function signature
      const match = content.match(/def run\(([^)]+)\)/);
      if (match) {
        const argsStr = match[1];
        const args = argsStr. split(',').map(a => a.trim());
        
        for (const arg of args) {
          if (arg === 'tree' || arg === 'self') continue;  // Skip tree and self
          
          // Parse arg:  name, type hint, default
          const [nameType, ...defaultParts] = arg.split('=');
          const [name, typeHint] = nameType.split(': ').map(s => s.trim());
          const defaultValue = defaultParts.length > 0 ? defaultParts. join('=').trim() : undefined;
          
          params.push({
            name,
            type: typeHint || 'unknown',
            default:  defaultValue,
            required: ! defaultValue,
          });
        }
      }
    } else if (language === 'julia') {
      // Parse Julia function signature
      const match = content.match(/function run\(([^)]+)\)/);
      if (match) {
        const argsStr = match[1];
        const args = argsStr.split(',').map(a => a.trim());
        
        for (const arg of args) {
          if (arg === 'tree') continue;
          
          // Parse arg: name:: Type=default
          const [nameType, defaultValue] = arg.split('=').map(s => s.trim());
          const [name, typeHint] = nameType.split('::').map(s => s.trim());
          
          params. push({
            name,
            type: typeHint || 'Any',
            default: defaultValue,
            required: !defaultValue,
          });
        }
      }
    }
    
    return { success: true, params };
    
  } catch (error) {
    return {
      success: false,
      error:  error instanceof Error ? error.message :  String(error),
    };
  }
});
```

---

### Part 4: Add Script Methods to Python Init Cell

**Location:** `electron/main/init/python-init.py`

**Add PDVTree class with run_script:**

```python
# =============================================================================
# PDV Tree Object (Enhanced Dict)
# =============================================================================

class PDVTree(dict):
    """
    Enhanced dict that acts as the tree object in kernel namespace. 
    Provides methods for running scripts, loading data, etc.
    """
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._project_root = None
        self._tree_root = None
    
    def _set_project_root(self, root):
        """Internal:  set project root path"""
        import os
        self._project_root = root
        self._tree_root = os.path.join(root, 'tree')
    
    def run_script(self, script_path, **kwargs):
        """
        Execute a script file with parameters.
        
        Args:
            script_path: Path in tree (e.g., 'scripts.analysis.fit_model')
            **kwargs: Parameters to pass to script's run() function
        
        Returns:
            Result from script's run() function
        
        Example:
            >>> result = tree.run_script('scripts.analysis.fit_model',
            ...                          data_path='data.raw',
            ...                          model='linear')
        """
        import os
        import importlib.util
        
        # Convert tree path to file path
        path_parts = script_path.split('.')
        file_path = os. path.join(self._tree_root, *path_parts) + '.py'
        
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Script not found: {file_path}")
        
        # Load script as module
        spec = importlib. util.spec_from_file_location("_pdv_script", file_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Failed to load script: {file_path}")
        
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        
        # Check for run() function
        if not hasattr(module, 'run'):
            raise AttributeError(f"Script {script_path} does not have a run() function")
        
        # Call run() with tree and kwargs
        return module.run(self, **kwargs)
    
    def __getitem__(self, key):
        """Override to support path navigation (e.g., tree['data. array1'])"""
        if isinstance(key, str) and '.' in key:
            # Navigate nested path
            keys = key.split('.')
            obj = self
            for k in keys:
                obj = dict.__getitem__(obj, k)
            return obj
        return dict.__getitem__(self, key)
    
    def __setitem__(self, key, value):
        """Override to support path setting"""
        if isinstance(key, str) and '.' in key:
            # Navigate to parent and set
            keys = key.split('.')
            obj = self
            for k in keys[:-1]: 
                if k not in obj:
                    obj[k] = PDVTree()
                obj = obj[k]
            dict.__setitem__(obj, keys[-1], value)
        else:
            dict.__setitem__(self, key, value)

# Create global tree instance
tree = PDVTree()

# Set project root (will be injected by PDV)
import os
tree._set_project_root(os.environ.get('PDV_PROJECT_ROOT', os.getcwd()))

# Initialize tree structure
if 'data' not in tree:
    tree['data'] = PDVTree()
if 'scripts' not in tree:
    tree['scripts'] = PDVTree()
if 'results' not in tree:
    tree['results'] = PDVTree()
```

---

### Part 5: Add Script Methods to Julia Init Cell

**Location:** `electron/main/init/julia-init.jl`

**Add PDVTree type with run_script:**

```julia
# =============================================================================
# PDV Tree Object
# =============================================================================

"""
PDVTree

Enhanced Dict that acts as the tree object in kernel namespace.
"""
mutable struct PDVTree
    data::Dict{String, Any}
    project_root::String
    tree_root::String
    
    function PDVTree(project_root::String=pwd())
        tree_root = joinpath(project_root, "tree")
        new(Dict{String, Any}(), project_root, tree_root)
    end
end

# Make PDVTree behave like a Dict
Base.getindex(tree::PDVTree, key::String) = tree.data[key]
Base.setindex!(tree::PDVTree, value, key::String) = tree.data[key] = value
Base. haskey(tree::PDVTree, key::String) = haskey(tree.data, key)
Base.keys(tree::PDVTree) = keys(tree.data)
Base.values(tree::PDVTree) = values(tree.data)

"""
    run_script(tree:: PDVTree, script_path:: String; kwargs...)

Execute a script file with parameters.

# Arguments
- `tree`: The PDV tree object
- `script_path`: Path in tree (e.g., "scripts.analysis.fit_model")
- `kwargs...`: Parameters to pass to script's run() function

# Returns
- Result from script's run() function

# Example
```julia
result = run_script(tree, "scripts. analysis.fit_model", 
                   data_path="data.raw", model="linear")
```
"""
function run_script(tree::PDVTree, script_path::String; kwargs...)
    # Convert tree path to file path
    path_parts = split(script_path, '.')
    file_path = joinpath(tree.tree_root, path_parts.. .) * ".jl"
    
    if ! isfile(file_path)
        error("Script not found: $file_path")
    end
    
    # Include script in a temporary module
    script_module = Module()
    
    # Make tree available in script namespace
    Core.eval(script_module, :(tree = $tree))
    
    # Include script
    Base.include(script_module, file_path)
    
    # Check for run() function
    if !isdefined(script_module, : run)
        error("Script $script_path does not have a run() function")
    end
    
    # Call run() with tree and kwargs
    run_func = getfield(script_module, :run)
    return run_func(tree; kwargs...)
end

# Create global tree instance
tree = PDVTree(get(ENV, "PDV_PROJECT_ROOT", pwd()))

# Initialize tree structure
tree["data"] = Dict{String, Any}()
tree["scripts"] = Dict{String, Any}()
tree["results"] = Dict{String, Any}()
```

---

### Part 6: Update Config Type

**Location:** `electron/main/config.ts`

**Add editor config:**

```typescript
export interface Config {
  // ... existing fields ...
  editors?: {
    python?: string;
    julia?: string;
    default?: string;
  };
  projectRoot?: string;
}

// Update defaults
export function loadConfig(): Config {
  // ... existing load logic ...
  
  return {
    // ... existing defaults ...
    editors: {
      python: 'code %s',  // VS Code
      julia: 'code %s',
      default: 'open %s',  // System default
    },
    projectRoot: process.cwd(),
  };
}
```

---

### Part 7: Add Script Context Menu Actions to Tree

**Location:** `electron/renderer/src/components/Tree/ContextMenu.tsx`

**Update to handle script actions:**

```typescript
function getActionsForNode(node: TreeNodeData) {
  const actions = [];
  
  if (node.type === 'script') {
    actions.push(
      { id: 'run', label: 'Run... ', disabled: false },
      { id: 'edit', label: 'Edit', disabled: false },
      { id: 'reload', label: 'Reload', disabled: false },
      { id: 'view_source', label: 'View Source', disabled:  false }
    );
  } else if (node.type === 'folder') {
    actions.push(
      { id: 'refresh', label: 'Refresh', disabled: false }
    );
  } else {
    actions.push(
      { id: 'view', label: 'View', disabled:  false }
    );
  }
  
  actions.push(
    { id: 'copy_path', label: 'Copy Path', disabled: false },
    { id: 'delete', label: 'Delete', disabled: true }  // TODO: implement
  );
  
  return actions;
}
```

---

### Part 8: Create Script Parameter Dialog

**Location:** `electron/renderer/src/components/ScriptDialog/index.tsx` (NEW)

**Create dialog for script parameters:**

```typescript
import React, { useState, useEffect } from 'react';

interface ScriptParameter {
  name: string;
  type: string;
  default?: unknown;
  required?: boolean;
  description?: string;
}

interface ScriptDialogProps {
  scriptPath: string;
  scriptName: string;
  onRun: (params: Record<string, unknown>) => void;
  onCancel: () => void;
}

export const ScriptDialog: React.FC<ScriptDialogProps> = ({
  scriptPath,
  scriptName,
  onRun,
  onCancel,
}) => {
  const [params, setParams] = useState<ScriptParameter[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const fetchParams = async () => {
      setLoading(true);
      try {
        const result = await window.pdv.script.getParams(scriptPath);
        if (result.success && result.params) {
          setParams(result.params);
          
          // Initialize values with defaults
          const defaultValues: Record<string, unknown> = {};
          for (const param of result.params) {
            if (param.default !== undefined) {
              defaultValues[param.name] = param.default;
            }
          }
          setValues(defaultValues);
        } else {
          setError(result.error || 'Failed to load parameters');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message :  String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchParams();
  }, [scriptPath]);

  const handleChange = (paramName: string, value: unknown) => {
    setValues(prev => ({ ...prev, [paramName]: value }));
  };

  const handleRun = () => {
    onRun(values);
  };

  const canRun = () => {
    // Check if all required params have values
    return params.every(p => ! p.required || values[p. name] !== undefined);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="script-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Run Script</h3>
          <button className="close-btn" onClick={onCancel}>×</button>
        </div>

        <div className="dialog-body">
          <div className="script-info">
            <strong>{scriptName}</strong>
            <span className="script-path">{scriptPath}</span>
          </div>

          {loading && <div className="dialog-loading">Loading parameters...</div>}

          {error && <div className="dialog-error">{error}</div>}

          {!loading && !error && params.length === 0 && (
            <div className="dialog-info-text">This script has no parameters</div>
          )}

          {!loading && !error && params.length > 0 && (
            <div className="param-list">
              {params.map(param => (
                <div key={param.name} className="param-input">
                  <label>
                    {param.name}
                    {param.required && <span className="required">*</span>}
                    <span className="param-type">({param.type})</span>
                  </label>
                  
                  {param.type. includes('str') || param.type === 'String' ? (
                    <input
                      type="text"
                      value={(values[param.name] as string) || ''}
                      onChange={(e) => handleChange(param.name, e.target.value)}
                      placeholder={param.default ?  String(param.default) : ''}
                    />
                  ) : param.type. includes('int') || param.type. includes('Int') ? (
                    <input
                      type="number"
                      step="1"
                      value={(values[param.name] as number) || 0}
                      onChange={(e) => handleChange(param. name, parseInt(e.target.value))}
                      placeholder={param.default ? String(param.default) : '0'}
                    />
                  ) : param.type.includes('float') || param.type.includes('Float') ? (
                    <input
                      type="number"
                      step="0.01"
                      value={(values[param.name] as number) || 0}
                      onChange={(e) => handleChange(param.name, parseFloat(e. target.value))}
                      placeholder={param.default ? String(param.default) : '0.0'}
                    />
                  ) : param.type.includes('bool') || param.type === 'Bool' ? (
                    <input
                      type="checkbox"
                      checked={(values[param. name] as boolean) || false}
                      onChange={(e) => handleChange(param.name, e.target.checked)}
                    />
                  ) : (
                    <input
                      type="text"
                      value={String(values[param.name] || '')}
                      onChange={(e) => handleChange(param.name, e.target.value)}
                      placeholder={param.default ?  String(param.default) : ''}
                    />
                  )}
                  
                  {param.description && (
                    <span className="param-description">{param.description}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleRun}
            disabled={!canRun()}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
};
```

---

### Part 9: Wire Script Actions into App

**Location:** `electron/renderer/src/app/index.tsx`

**Add script dialog state and handlers:**

```typescript
const [scriptDialog, setScriptDialog] = useState<{
  scriptPath: string;
  scriptName: string;
} | null>(null);

const handleTreeAction = async (action: string, node: TreeNodeData) => {
  console.log('[App] Tree action:', action, node);

  if (action === 'run' && node.type === 'script') {
    // Show parameter dialog
    setScriptDialog({
      scriptPath: node.path,
      scriptName: node. key,
    });
  } else if (action === 'edit' && node.type === 'script') {
    // Open in external editor
    try {
      await window.pdv.script.edit(node.path);
    } catch (error) {
      console.error('[App] Failed to open editor:', error);
    }
  } else if (action === 'reload' && node.type === 'script') {
    // Reload script (Python:  importlib.reload, Julia:  Revise)
    if (currentKernelId) {
      const code = node.language === 'python'
        ? `import importlib; importlib.reload(${node.path. replace(/\./g, '_')})`
        : `Revise. revise()`;  // Or more specific reload
      
      await window.pdv.kernels. execute(currentKernelId, { code });
    }
  } else if (action === 'copy_path') {
    navigator.clipboard.writeText(node. path);
  }
};

const handleScriptRun = async (params: Record<string, unknown>) => {
  if (!scriptDialog || !currentKernelId) return;

  setScriptDialog(null);

  try {
    const result = await window.pdv.script. run(currentKernelId, {
      scriptPath: scriptDialog.scriptPath,
      params,
    });

    if (!result.success) {
      console.error('[App] Script execution failed:', result.error);
      // Show error in UI
    } else {
      console.log('[App] Script executed successfully:', result);
    }
  } catch (error) {
    console.error('[App] Script execution error:', error);
  }
};

// In render: 
{scriptDialog && (
  <ScriptDialog
    scriptPath={scriptDialog.scriptPath}
    scriptName={scriptDialog.scriptName}
    onRun={handleScriptRun}
    onCancel={() => setScriptDialog(null)}
  />
)}
```

---

### Part 10: Add Preload Methods

**Location:** `electron/preload.ts`

**Add script methods:**

```typescript
script:  {
  run: (kernelId: string, request: ScriptRunRequest): Promise<ScriptRunResult> =>
    ipcRenderer.invoke(IPC. script.run, kernelId, request),
  edit: (scriptPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer. invoke(IPC.script.edit, scriptPath),
  reload: (scriptPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.script.reload, scriptPath),
  getParams: (scriptPath: string): Promise<{ success: boolean; params?: ScriptParameter[]; error?: string }> =>
    ipcRenderer.invoke(IPC.script.get_params, scriptPath),
},
```

---

### Part 11: Add Styling

**Location:** `electron/renderer/src/styles/index.css`

**Add script dialog styles:**

```css
/* ===== SCRIPT DIALOG ===== */

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.script-dialog {
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  min-width: 500px;
  max-width:  700px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom:  1px solid var(--border-color);
}

.dialog-header h3 {
  font-size: 16px;
  font-weight:  600;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 24px;
  cursor: pointer;
  padding: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.close-btn:hover {
  color: var(--text-primary);
}

.dialog-body {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

.script-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 16px;
  padding: 12px;
  background-color:  var(--bg-tertiary);
  border-radius: 4px;
}

.script-info strong {
  color: var(--accent);
  font-size: 14px;
}

.script-path {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}

.dialog-loading,
.dialog-error,
.dialog-info-text {
  padding: 20px;
  text-align: center;
  color: var(--text-secondary);
}

.dialog-error {
  color: var(--error);
}

.param-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.param-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.param-input label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.required {
  color: var(--error);
}

.param-type {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: normal;
}

.param-input input[type="text"],
.param-input input[type="number"] {
  padding: 8px 12px;
  background-color: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: var(--font-mono);
}

.param-input input: focus {
  outline: none;
  border-color: var(--accent);
}

.param-input input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.param-description {
  font-size: 11px;
  color: var(--text-secondary);
  font-style: italic;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
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

2. **Create test project structure:**
   ```bash
   mkdir -p test_project/tree/scripts/analysis
   mkdir -p test_project/tree/data
   mkdir -p test_project/tree/results
   ```

3. **Create test script:**
   ```python
   # test_project/tree/scripts/analysis/test_script.py
   
   """Test script for Physics Data Viewer"""
   
   def run(tree:  dict, param1: int = 10, param2: str = "default"):
       """
       Test script that demonstrates parameter handling. 
       
       Args:
           tree: PDV tree object
           param1: A number parameter
           param2: A string parameter
       
       Returns: 
           dict: Result summary
       """
       print(f"Running with param1={param1}, param2={param2}")
       
       tree['results']['test_output'] = {
           'param1': param1,
           'param2': param2,
           'status': 'success'
       }
       
       return {'success': True, 'param1': param1, 'param2': param2}
   ```

4. **App launches and scans files:**
   ```bash
   npm run dev
   ```
   - Set project root to `test_project/` in config
   - Restart app
   - Tree tab shows `scripts/`, `data/`, `results/` folders

5. **Scripts appear in tree:**
   - Expand `scripts` → `analysis`
   - See `test_script.py` with preview (docstring first line)
   - Type badge shows "script"
   - Language badge shows "python"

6. **Right-click script → Run:**
   - Right-click `test_script.py`
   - Select "Run..."
   - Dialog opens with parameters: 
     - `param1` (int) default: 10
     - `param2` (str) default: "default"
   - Change values, click "Run"
   - Console shows execution result

7. **Right-click script → Edit:**
   - Right-click `test_script.py`
   - Select "Edit"
   - VS Code (or configured editor) opens with file
   - (Verify `code` command works in your terminal first)

8. **Script modifies tree:**
   - After running script, check Namespace tab
   - `tree['results']['test_output']` exists
   - Contains params passed to script

9. **No IDE warnings:**
   - Open `test_script.py` in VS Code
   - No red squiggles on `tree` parameter
   - Type hints work (if type stubs installed)
   - Autocomplete works for `tree` methods

10. **Julia script works:**
    - Create `test_project/tree/scripts/analysis/test_script.jl`:
    ```julia
    """Test Julia script"""
    
    function run(tree; param1:: Int=5, param2::String="default")
        println("Running with param1=$param1, param2=$param2")
        
        tree["results"]["test_output"] = Dict(
            "param1" => param1,
            "param2" => param2,
            "status" => "success"
        )
        
        return Dict("success" => true)
    end
    ```
    - Script appears in tree
    - Run dialog works
    - Executes in Julia kernel

11. **Error handling:**
    - Script with syntax error → shows error in console
    - Script without `run()` function → error message
    - Missing required parameter → Run button disabled
    - Script not found → error message

12. **Performance:**
    - Scanning 100 script files → < 500ms
    - Opening parameter dialog → instant
    - External editor launches → < 1s

---

## Files to Create/Modify (Checklist)

- [ ] `electron/main/file-scanner.ts` — NEW: File system scanner
- [ ] `electron/main/ipc. ts` — Add script channels and types
- [ ] `electron/main/index.ts` — Add script IPC handlers
- [ ] `electron/main/config.ts` — Add editor config
- [ ] `electron/main/init/python-init.py` — Add PDVTree class and run_script()
- [ ] `electron/main/init/julia-init.jl` — Add PDVTree type and run_script()
- [ ] `electron/preload.ts` — Add script methods
- [ ] `electron/renderer/src/components/ScriptDialog/index.tsx` — NEW: Parameter dialog
- [ ] `electron/renderer/src/components/Tree/ContextMenu.tsx` — Add script actions
- [ ] `electron/renderer/src/app/index.tsx` — Wire script actions
- [ ] `electron/renderer/src/styles/index.css` — Add dialog styles

---

## Notes

- **File watching:** Not implemented in this step.  Future enhancement:  use `fs.watch()` or `chokidar` to detect file changes and offer reload. 

- **Editor configuration:** Users can configure editor commands in settings.  Default is `code %s` (VS Code). Common alternatives: `nvim %s`, `subl %s`, `atom %s`.

- **Parameter type inference:** Basic type inference from Python type hints and Julia type annotations.   Advanced types (Union, Optional, custom classes) not yet supported.

- **Script reload:** Python's `importlib.reload()` works for simple scripts.   For complex imports, users may need to restart kernel.  Julia's `Revise.jl` provides better hot reload. 

- **Script namespaces:** Scripts execute in kernel's global namespace, so they have access to all variables.  Future enhancement: isolated namespaces per script.

- **Tree persistence:** Scripts don't modify the Tree UI directly—only kernel state.  To see changes in Tree, user must refresh or save project.

- **Relative imports:** Scripts can import other scripts if Python/Julia paths are configured correctly.  Consider adding `tree/scripts` to `sys.path` / `LOAD_PATH`.

---

## Testing Tips

**Manual test workflow:**

1. Create test project directory structure
2. Write test scripts (Python and Julia)
3. Launch app, set project root
4. Verify scripts appear in Tree
5. Right-click → Run → verify dialog
6. Run with different parameters
7. Check results in Namespace
8. Right-click → Edit → verify external editor opens
9. Modify script externally, see if reload works
10. Test error cases (missing function, syntax error, etc.)

**Edge cases:**

- Script with no parameters → dialog shows "no parameters", can run immediately
- Script with only required parameters → can't run until all filled
- Script with complex type (e.g., `List[int]`) → falls back to text input
- Very long script path → truncates in dialog
- Script file deleted externally → error on run, tree refreshes

**Performance tests:**

- 100 scripts in tree → loads in < 1s
- Large script file (10,000 lines) → docstring extraction fast
- Rapid script execution (10 times) → no memory leaks

---

## Future Enhancements (Not Required for This Step)

- File watcher for automatic reload on external changes
- Script templates (create new script from template)
- Script search/filter in Tree
- Script history (track which scripts ran when)
- Script dependencies (one script imports another)
- Script output to file (capture stdout to log file)
- Script scheduling (run periodically)
- Drag script to command box to insert `tree. run_script()` call
- Script breakpoints/debugging integration
- Multi-file scripts (script + supporting modules)