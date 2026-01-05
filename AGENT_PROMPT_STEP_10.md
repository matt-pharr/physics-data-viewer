# Agent Task:     Step 10 - Arbitrary Object Store & Project Persistence

## Context

You are continuing work on "Physics Data Viewer", an Electron + React + Vite + TypeScript app.      Step 9 implemented data loaders for scientific file formats (HDF5, Zarr, Parquet, NPY, images).    Users can now browse data files and load them into the kernel.    

**Your task is to implement the blob store for arbitrary Python/Julia objects (pickle/JLSO), define the project manifest structure, and implement save/load project functionality.     Projects should persist the tree structure (references to files + blobs) while keeping the namespace ephemeral.    Add auto-save and crash recovery.**

**Reference files you should read first:**
- `PLAN.md` — Project structure and persistence architecture
- `electron/main/file-scanner.ts` — File scanner (builds tree structure)
- `electron/main/init/python-init.py` — Python init cell (will need blob store methods)
- `electron/main/init/julia-init.jl` — Julia init cell (will need blob store methods)

**Current state:**
- Tree shows files and data with metadata
- Scripts execute and store results in kernel namespace
- No way to save arbitrary objects to disk
- No project save/load mechanism
- No auto-save or crash recovery
- Namespace is lost on app restart

**After this step:**
- Blob store saves arbitrary Python/Julia objects to `blobs/` directory (content-addressed by SHA256)
- `tree. save(path, object)` stores objects from kernel
- `tree.load(path)` retrieves objects back to kernel
- Trust flag UI warns on loading untrusted pickles/JLSO
- Project manifest (`project.pdv`) tracks tree structure, file references, and blob hashes
- Save/load project functionality (Ctrl/Cmd+S)
- Auto-save every 30 seconds
- Crash recovery dialog on restart
- File watcher detects external changes to scripts/data

---

## Your Task

### Part 1:  Blob Store Implementation

**Location:** `electron/main/blob-store.ts` (NEW)

**Implement content-addressed blob storage:**

```typescript
/**
 * Blob Store
 * 
 * Content-addressed storage for arbitrary objects (pickle/JLSO).
 * Blobs are stored in blobs/ directory, named by SHA256 hash.
 * Metadata (type, trusted flag) stored separately in project manifest.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface BlobMetadata {
  hash: string;
  type: 'pickle' | 'jlso' | 'json';
  size: number;
  created: string;
  trusted: boolean;
  pythonVersion?:  string;
  juliaVersion?: string;
  description?: string;
}

export class BlobStore {
  private blobsDir: string;
  private metadataCache: Map<string, BlobMetadata> = new Map();
  
  constructor(projectRoot: string) {
    this.blobsDir = path.join(projectRoot, 'blobs');
    
    // Create blobs directory if it doesn't exist
    if (!fs.existsSync(this.blobsDir)) {
      fs.mkdirSync(this.blobsDir, { recursive: true });
    }
  }
  
  /**
   * Store a blob (raw bytes)
   */
  async putBlob(data: Buffer, metadata:  Partial<BlobMetadata>): Promise<BlobMetadata> {
    // Compute SHA256 hash
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const blobPath = path.join(this.blobsDir, `${hash}.${metadata.type || 'bin'}`);
    
    // Write blob to disk
    fs.writeFileSync(blobPath, data);
    
    // Create full metadata
    const fullMetadata:  BlobMetadata = {
      hash,
      type: metadata. type || 'pickle',
      size: data.length,
      created: new Date().toISOString(),
      trusted: metadata. trusted || false,
      pythonVersion: metadata.pythonVersion,
      juliaVersion: metadata. juliaVersion,
      description:  metadata.description,
    };
    
    this.metadataCache.set(hash, fullMetadata);
    
    console.log(`[BlobStore] Stored blob ${hash} (${fullMetadata.size} bytes)`);
    
    return fullMetadata;
  }
  
  /**
   * Retrieve a blob by hash
   */
  async getBlob(hash: string): Promise<Buffer | null> {
    // Try all possible extensions
    const extensions = ['pickle', 'jlso', 'json', 'bin'];
    
    for (const ext of extensions) {
      const blobPath = path.join(this.blobsDir, `${hash}.${ext}`);
      if (fs.existsSync(blobPath)) {
        return fs.readFileSync(blobPath);
      }
    }
    
    console.warn(`[BlobStore] Blob not found: ${hash}`);
    return null;
  }
  
  /**
   * Get blob metadata
   */
  getMetadata(hash: string): BlobMetadata | null {
    // Check cache first
    if (this.metadataCache.has(hash)) {
      return this. metadataCache.get(hash)!;
    }
    
    // Try to read from disk and infer metadata
    const extensions = ['pickle', 'jlso', 'json'];
    for (const ext of extensions) {
      const blobPath = path. join(this.blobsDir, `${hash}.${ext}`);
      if (fs.existsSync(blobPath)) {
        const stats = fs.statSync(blobPath);
        const metadata: BlobMetadata = {
          hash,
          type: ext as 'pickle' | 'jlso' | 'json',
          size: stats.size,
          created: stats.birthtime.toISOString(),
          trusted: false,  // Default to untrusted
        };
        this.metadataCache.set(hash, metadata);
        return metadata;
      }
    }
    
    return null;
  }
  
  /**
   * Mark a blob as trusted
   */
  setTrusted(hash: string, trusted: boolean): void {
    const metadata = this.getMetadata(hash);
    if (metadata) {
      metadata.trusted = trusted;
      this.metadataCache. set(hash, metadata);
    }
  }
  
  /**
   * List all blobs
   */
  listBlobs(): BlobMetadata[] {
    const blobs: BlobMetadata[] = [];
    
    if (! fs.existsSync(this. blobsDir)) {
      return blobs;
    }
    
    const files = fs. readdirSync(this.blobsDir);
    
    for (const file of files) {
      const match = file.match(/^([a-f0-9]{64})\.(\w+)$/);
      if (match) {
        const hash = match[1];
        const metadata = this.getMetadata(hash);
        if (metadata) {
          blobs.push(metadata);
        }
      }
    }
    
    return blobs;
  }
  
  /**
   * Delete a blob
   */
  async deleteBlob(hash: string): Promise<boolean> {
    const extensions = ['pickle', 'jlso', 'json', 'bin'];
    let deleted = false;
    
    for (const ext of extensions) {
      const blobPath = path. join(this.blobsDir, `${hash}.${ext}`);
      if (fs.existsSync(blobPath)) {
        fs.unlinkSync(blobPath);
        deleted = true;
      }
    }
    
    if (deleted) {
      this.metadataCache.delete(hash);
      console.log(`[BlobStore] Deleted blob ${hash}`);
    }
    
    return deleted;
  }
  
  /**
   * Get total size of all blobs
   */
  getTotalSize(): number {
    return this.listBlobs().reduce((sum, blob) => sum + blob.size, 0);
  }
}

// Singleton
let blobStore: BlobStore | null = null;

export function getBlobStore(projectRoot: string): BlobStore {
  if (!blobStore) {
    blobStore = new BlobStore(projectRoot);
  }
  return blobStore;
}
```

---

### Part 2: Project Manifest Schema

**Location:** `electron/main/project. ts` (NEW)

**Define project structure and save/load logic:**

```typescript
/**
 * Project Management
 * 
 * Handles project manifest (project.pdv) save/load.
 * Manifest tracks tree structure, file references, and blob metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TreeNode } from './ipc';
import { BlobMetadata } from './blob-store';

export interface ProjectManifest {
  version: string;
  name: string;
  created: string;
  modified: string;
  tree: ProjectTree;
  config: ProjectConfig;
  blobs: Record<string, BlobMetadata>;  // hash -> metadata
}

export interface ProjectTree {
  [key: string]: ProjectTreeNode;
}

export interface ProjectTreeNode {
  type: 'folder' | 'file' | 'blob' | 'reference';
  // For files: reference to file in tree/ directory
  relativePath?:  string;
  // For blobs: hash of stored object
  blobHash?: string;
  // For references: path to data in file (HDF5 dataset, etc.)
  filePath?: string;
  datasetPath?: string;
  // Metadata
  metadata?: {
    shape?: number[];
    dtype?: string;
    size?: number;
    preview?: string;
    [key: string]: unknown;
  };
  // Children (for folders)
  children?: ProjectTree;
}

export interface ProjectConfig {
  pythonPath?:  string;
  juliaPath?:  string;
  editors?: Record<string, string>;
  plotMode?: 'native' | 'capture';
  cwd?: string;
}

export class ProjectManager {
  private projectRoot: string;
  private manifestPath: string;
  private manifest: ProjectManifest | null = null;
  
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.manifestPath = path.join(projectRoot, 'project.pdv');
  }
  
  /**
   * Create a new project
   */
  createProject(name: string, config:  ProjectConfig): ProjectManifest {
    this.manifest = {
      version: '1.0.0',
      name,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      tree: {},
      config,
      blobs: {},
    };
    
    return this.manifest;
  }
  
  /**
   * Load project from disk
   */
  loadProject(): ProjectManifest | null {
    if (!fs.existsSync(this.manifestPath)) {
      console.log('[Project] No project file found');
      return null;
    }
    
    try {
      const json = fs.readFileSync(this.manifestPath, 'utf-8');
      this.manifest = JSON.parse(json);
      console.log(`[Project] Loaded project: ${this.manifest! .name}`);
      return this.manifest;
    } catch (error) {
      console.error('[Project] Failed to load project:', error);
      return null;
    }
  }
  
  /**
   * Save project to disk
   */
  saveProject(manifest: ProjectManifest): boolean {
    try {
      manifest.modified = new Date().toISOString();
      const json = JSON.stringify(manifest, null, 2);
      fs.writeFileSync(this.manifestPath, json, 'utf-8');
      this.manifest = manifest;
      console.log(`[Project] Saved project: ${manifest.name}`);
      return true;
    } catch (error) {
      console.error('[Project] Failed to save project:', error);
      return false;
    }
  }
  
  /**
   * Get current manifest
   */
  getManifest(): ProjectManifest | null {
    return this.manifest;
  }
  
  /**
   * Build tree structure from file system and blobs
   */
  async buildTreeFromManifest(manifest: ProjectManifest): Promise<TreeNode[]> {
    // This is a simplified version; real implementation would: 
    // 1. Scan tree/ directory for files
    // 2. Merge with blob references from manifest
    // 3. Apply metadata from manifest
    
    // For now, delegate to FileScanner and merge blob nodes
    return [];
  }
  
  /**
   * Update manifest with current tree state
   */
  updateManifestTree(manifest: ProjectManifest, treeNodes: TreeNode[]): void {
    // Convert TreeNode[] to ProjectTree structure
    manifest.tree = this.convertToProjectTree(treeNodes);
  }
  
  private convertToProjectTree(nodes: TreeNode[]): ProjectTree {
    const tree: ProjectTree = {};
    
    for (const node of nodes) {
      if (node.type === 'folder') {
        tree[node.key] = {
          type: 'folder',
          children: {},  // Would recursively convert children
        };
      } else if (node.type === 'blob') {
        tree[node. key] = {
          type:  'blob',
          blobHash: node._blob_hash,
          metadata: {
            shape: node.shape,
            dtype: node.dtype,
            preview: node.preview,
          },
        };
      } else if (node._file_path) {
        // File reference
        const relativePath = path.relative(
          path.join(this.projectRoot, 'tree'),
          node._file_path
        );
        tree[node.key] = {
          type: 'file',
          relativePath,
          metadata: {
            shape: node. shape,
            dtype: node. dtype,
            preview: node.preview,
          },
        };
      }
    }
    
    return tree;
  }
  
  /**
   * Create backup before save
   */
  createBackup(): boolean {
    if (!fs.existsSync(this.manifestPath)) {
      return false;
    }
    
    try {
      const backupPath = this.manifestPath + '.backup';
      fs.copyFileSync(this.manifestPath, backupPath);
      console.log('[Project] Created backup');
      return true;
    } catch (error) {
      console.error('[Project] Failed to create backup:', error);
      return false;
    }
  }
  
  /**
   * Restore from backup
   */
  restoreFromBackup(): boolean {
    const backupPath = this.manifestPath + '.backup';
    
    if (!fs.existsSync(backupPath)) {
      return false;
    }
    
    try {
      fs.copyFileSync(backupPath, this.manifestPath);
      console.log('[Project] Restored from backup');
      return true;
    } catch (error) {
      console.error('[Project] Failed to restore backup:', error);
      return false;
    }
  }
}

// Singleton
let projectManager: ProjectManager | null = null;

export function getProjectManager(projectRoot: string): ProjectManager {
  if (!projectManager || projectManager['projectRoot'] !== projectRoot) {
    projectManager = new ProjectManager(projectRoot);
  }
  return projectManager;
}
```

---

### Part 3: Add Blob Methods to Python Init Cell

**Location:** `electron/main/init/python-init.py`

**Add blob save/load to PDVTree:**

```python
# Add to PDVTree class

def save(self, path, obj, description=None, trusted=True):
    """
    Save an arbitrary object to the tree using blob storage.
    
    Args:
        path: Tree path (e.g., 'results. my_output')
        obj: Object to save (will be pickled)
        description: Optional description
        trusted: Mark blob as trusted (default: True for user-saved objects)
    
    Example:
        >>> tree. save('results.my_model', trained_model, "Trained neural network")
    """
    import pickle
    import sys
    
    # Serialize object
    try:
        blob_data = pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception as e:
        raise ValueError(f"Failed to pickle object: {e}")
    
    # Call PDV to store blob (via special print message)
    # This is intercepted by the kernel manager
    print(f"__PDV_SAVE_BLOB__|{path}|{len(blob_data)}|{description or ''}|{trusted}")
    
    # Write blob data to stdout as base64
    import base64
    blob_b64 = base64.b64encode(blob_data).decode('utf-8')
    print(f"__PDV_BLOB_DATA__|{blob_b64}")
    
    # Store reference in tree
    self[path] = {
        '_pdv_blob':  True,
        'type': type(obj).__name__,
        'description': description,
    }
    
    return True

def load(self, path, trusted_override=None):
    """
    Load an object from blob storage.
    
    Args:
        path: Tree path (e.g., 'results. my_output')
        trusted_override: If True, load even if untrusted (user confirms)
    
    Returns:
        Deserialized object
    
    Example:
        >>> model = tree.load('results.my_model')
    """
    import pickle
    import base64
    
    node = self[path]
    
    if not isinstance(node, dict) or not node. get('_pdv_blob'):
        raise ValueError(f"Path {path} is not a blob reference")
    
    # Request blob from PDV
    print(f"__PDV_LOAD_BLOB__|{path}")
    
    # PDV will inject blob data into namespace as _pdv_blob_data
    # (This is a simplified protocol; real implementation uses IPC)
    
    # For now, return placeholder
    # Real implementation:  kernel manager intercepts and injects data
    raise NotImplementedError("Blob loading requires kernel manager integration")
```

**Alternative simpler approach using file system directly:**

```python
def save(self, path, obj, description=None):
    """Save object to blob store (pickle)"""
    import pickle
    import os
    import hashlib
    
    # Serialize
    blob_data = pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL)
    
    # Compute hash
    hash_hex = hashlib.sha256(blob_data).hexdigest()
    
    # Write to blobs directory
    blobs_dir = os.path.join(self._project_root, 'blobs')
    os.makedirs(blobs_dir, exist_ok=True)
    blob_path = os.path.join(blobs_dir, f"{hash_hex}.pickle")
    
    with open(blob_path, 'wb') as f:
        f.write(blob_data)
    
    # Store reference in tree
    self[path] = {
        '_pdv_blob': True,
        '_blob_hash': hash_hex,
        'type': type(obj).__name__,
        'description': description,
        'size': len(blob_data),
    }
    
    print(f"[PDV] Saved {type(obj).__name__} to {path} (hash: {hash_hex[: 8]}...)")
    
    return hash_hex

def load(self, path):
    """Load object from blob store"""
    import pickle
    import os
    
    node = self[path]
    
    if not isinstance(node, dict) or not node.get('_pdv_blob'):
        raise ValueError(f"Path {path} is not a blob")
    
    hash_hex = node. get('_blob_hash')
    if not hash_hex:
        raise ValueError(f"No blob hash for {path}")
    
    # Read from blobs directory
    blobs_dir = os.path.join(self._project_root, 'blobs')
    blob_path = os.path.join(blobs_dir, f"{hash_hex}.pickle")
    
    if not os.path.exists(blob_path):
        raise FileNotFoundError(f"Blob not found: {hash_hex}")
    
    # TODO: Trust check - warn if untrusted
    # For now, load directly
    
    with open(blob_path, 'rb') as f:
        obj = pickle.load(f)
    
    print(f"[PDV] Loaded {type(obj).__name__} from {path}")
    
    return obj
```

---

### Part 4: Add Blob Methods to Julia Init Cell

**Location:** `electron/main/init/julia-init.jl`

**Add blob save/load:**

```julia
"""
    save(tree:: PDVTree, path::String, obj; description::Union{String, Nothing}=nothing)

Save an object to blob storage using JLSO. 
"""
function save(tree::PDVTree, path::String, obj; description::Union{String, Nothing}=nothing)
    using JLSO
    using SHA
    
    # Serialize object
    blob_data = JLSO.save(IOBuffer(), : data => obj)
    seekstart(blob_data)
    blob_bytes = read(blob_data)
    
    # Compute hash
    hash_hex = bytes2hex(sha256(blob_bytes))
    
    # Write to blobs directory
    blobs_dir = joinpath(tree.project_root, "blobs")
    mkpath(blobs_dir)
    blob_path = joinpath(blobs_dir, "$(hash_hex).jlso")
    
    open(blob_path, "w") do f
        write(f, blob_bytes)
    end
    
    # Store reference in tree
    tree[path] = Dict(
        "_pdv_blob" => true,
        "_blob_hash" => hash_hex,
        "type" => string(typeof(obj)),
        "description" => description,
        "size" => length(blob_bytes)
    )
    
    println("[PDV] Saved $(typeof(obj)) to $path (hash: $(hash_hex[1:8])...)")
    
    return hash_hex
end

"""
    load(tree:: PDVTree, path::String)

Load an object from blob storage. 
"""
function load(tree:: PDVTree, path::String)
    using JLSO
    
    node = tree[path]
    
    if !isa(node, Dict) || !get(node, "_pdv_blob", false)
        error("Path $path is not a blob")
    end
    
    hash_hex = get(node, "_blob_hash", nothing)
    if hash_hex === nothing
        error("No blob hash for $path")
    end
    
    # Read from blobs directory
    blobs_dir = joinpath(tree. project_root, "blobs")
    blob_path = joinpath(blobs_dir, "$(hash_hex).jlso")
    
    if !isfile(blob_path)
        error("Blob not found: $hash_hex")
    end
    
    # TODO: Trust check
    
    # Load object
    jlso = JLSO.load(blob_path)
    obj = jlso[: data]
    
    println("[PDV] Loaded $(typeof(obj)) from $path")
    
    return obj
end
```

---

### Part 5: Add Project Save/Load IPC Handlers

**Location:** `electron/main/index.ts`

**Add project handlers:**

```typescript
import { getProjectManager } from './project';
import { getBlobStore } from './blob-store';

// Project:  Save
ipcMain.handle('project:save', async (_event) => {
  console.log('[IPC] project:save');
  
  try {
    const config = loadConfig();
    const projectRoot = config.projectRoot || process.cwd();
    
    const projectManager = getProjectManager(projectRoot);
    const blobStore = getBlobStore(projectRoot);
    
    // Get or create manifest
    let manifest = projectManager.getManifest();
    
    if (!manifest) {
      // Create new project
      manifest = projectManager.createProject(
        path.basename(projectRoot),
        {
          pythonPath: config. pythonPath,
          juliaPath: config.juliaPath,
          editors: config.editors,
          plotMode: config.plotMode,
          cwd: config.cwd,
        }
      );
    }
    
    // Update blob metadata in manifest
    const blobs = blobStore.listBlobs();
    manifest.blobs = {};
    for (const blob of blobs) {
      manifest.blobs[blob.hash] = blob;
    }
    
    // Update tree structure (simplified - real implementation would scan FileScanner)
    // manifest.tree = ...  (build from current tree state)
    
    // Save manifest
    const success = projectManager. saveProject(manifest);
    
    if (success) {
      return { success: true, path: projectManager['manifestPath'] };
    } else {
      return { success: false, error: 'Failed to save project' };
    }
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

// Project: Load
ipcMain.handle('project:load', async (_event, projectPath?:  string) => {
  console.log('[IPC] project:load', projectPath);
  
  try {
    const projectRoot = projectPath || loadConfig().projectRoot || process.cwd();
    
    const projectManager = getProjectManager(projectRoot);
    const manifest = projectManager.loadProject();
    
    if (!manifest) {
      return { success: false, error: 'No project found' };
    }
    
    // Update config with project settings
    const config = loadConfig();
    Object.assign(config, manifest. config);
    saveConfig(config);
    
    return { success: true, manifest };
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

// Project: Get Info
ipcMain.handle('project:info', async (_event) => {
  const config = loadConfig();
  const projectRoot = config.projectRoot || process.cwd();
  
  const projectManager = getProjectManager(projectRoot);
  const manifest = projectManager.getManifest() || projectManager.loadProject();
  
  const blobStore = getBlobStore(projectRoot);
  const blobCount = blobStore.listBlobs().length;
  const blobSize = blobStore.getTotalSize();
  
  return {
    projectRoot,
    manifest:  manifest ?  {
      name: manifest.name,
      created: manifest.created,
      modified: manifest.modified,
    } : null,
    blobCount,
    blobSize,
  };
});
```

**Add to IPC channels:**

```typescript
// In electron/main/ipc.ts
export const IPC = {
  // ...  existing
  project: {
    save: 'project:save',
    load: 'project:load',
    info: 'project:info',
  },
} as const;
```

---

### Part 6: Add Auto-Save

**Location:** `electron/main/app.ts`

**Add auto-save timer:**

```typescript
import { getProjectManager } from './project';

// After creating window
let autoSaveInterval: NodeJS.Timeout | null = null;

function setupAutoSave() {
  // Auto-save every 30 seconds
  autoSaveInterval = setInterval(async () => {
    console.log('[AutoSave] Running.. .');
    
    try {
      const config = loadConfig();
      const projectRoot = config.projectRoot || process.cwd();
      const projectManager = getProjectManager(projectRoot);
      
      const manifest = projectManager.getManifest();
      if (manifest) {
        projectManager.saveProject(manifest);
        console.log('[AutoSave] Project saved');
      }
    } catch (error) {
      console.error('[AutoSave] Failed:', error);
    }
  }, 30000);  // 30 seconds
}

app.whenReady().then(() => {
  createWindow();
  setupAutoSave();
  // ... 
});

app.on('before-quit', () => {
  if (autoSaveInterval) {
    clearInterval(autoSaveInterval);
  }
});
```

---

### Part 7: Add Crash Recovery

**Location:** `electron/main/app.ts`

**Detect unclean shutdown:**

```typescript
import * as fs from 'fs';
import * as path from 'path';

function checkCrashRecovery() {
  const config = loadConfig();
  const projectRoot = config.projectRoot || process.cwd();
  const lockFile = path.join(projectRoot, '.pdv. lock');
  
  if (fs.existsSync(lockFile)) {
    // App was not closed cleanly
    console.log('[Recovery] Detected unclean shutdown');
    
    // Send message to renderer to show recovery dialog
    if (mainWindow) {
      mainWindow. webContents.send('show-recovery-dialog');
    }
  }
  
  // Create lock file
  fs.writeFileSync(lockFile, new Date().toISOString());
}

function cleanupLockFile() {
  const config = loadConfig();
  const projectRoot = config.projectRoot || process.cwd();
  const lockFile = path.join(projectRoot, '.pdv.lock');
  
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
  }
}

app.whenReady().then(() => {
  createWindow();
  checkCrashRecovery();
  setupAutoSave();
});

app.on('before-quit', () => {
  cleanupLockFile();
  // ...  existing cleanup
});
```

---

### Part 8: Add File Watcher

**Location:** `electron/main/file-watcher.ts` (NEW)

**Watch for external file changes:**

```typescript
/**
 * File Watcher
 * 
 * Watches tree/ directory for external changes to scripts and data files. 
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';

export class FileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private window: BrowserWindow;
  
  constructor(window: BrowserWindow) {
    this.window = window;
  }
  
  /**
   * Start watching a directory
   */
  watch(projectRoot: string): void {
    const treeDir = path.join(projectRoot, 'tree');
    
    if (!fs.existsSync(treeDir)) {
      console.warn('[FileWatcher] Tree directory not found');
      return;
    }
    
    console.log(`[FileWatcher] Watching ${treeDir}`);
    
    this.watcher = fs.watch(treeDir, { recursive: true }, (eventType, filename) => {
      if (! filename) return;
      
      console.log(`[FileWatcher] ${eventType}:  ${filename}`);
      
      // Notify renderer of change
      this.window.webContents.send('file-changed', {
        eventType,
        filename,
        path: path.join(treeDir, filename),
      });
    });
  }
  
  /**
   * Stop watching
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[FileWatcher] Stopped watching');
    }
  }
}
```

**Wire into app:**

```typescript
// In electron/main/app.ts
import { FileWatcher } from './file-watcher';

let fileWatcher: FileWatcher | null = null;

function createWindow() {
  // ... existing window creation ... 
  
  // Setup file watcher
  fileWatcher = new FileWatcher(mainWindow);
  
  const config = loadConfig();
  const projectRoot = config.projectRoot || process.cwd();
  fileWatcher.watch(projectRoot);
}

app.on('before-quit', () => {
  if (fileWatcher) {
    fileWatcher.unwatch();
  }
  // ... existing cleanup
});
```

---

### Part 9: Add Frontend Save/Load UI

**Location:** `electron/renderer/src/app/index.tsx`

**Add save/load handlers:**

```typescript
const [projectInfo, setProjectInfo] = useState<any>(null);
const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

// Load project info on mount
useEffect(() => {
  const loadProjectInfo = async () => {
    const info = await window.pdv.project.info();
    setProjectInfo(info);
  };
  
  loadProjectInfo();
}, []);

// Save project (Ctrl/Cmd+S)
useEffect(() => {
  const handleSave = async (e: KeyboardEvent) => {
    if ((e.ctrlKey || e. metaKey) && e.key === 's') {
      e.preventDefault();
      await handleSaveProject();
    }
  };
  
  window. addEventListener('keydown', handleSave);
  return () => window.removeEventListener('keydown', handleSave);
}, []);

const handleSaveProject = async () => {
  console.log('[App] Saving project...');
  
  try {
    const result = await window.pdv.project.save();
    
    if (result.success) {
      console.log('[App] Project saved:', result.path);
      setHasUnsavedChanges(false);
      // Show toast notification
    } else {
      console.error('[App] Save failed:', result.error);
    }
  } catch (error) {
    console.error('[App] Save error:', error);
  }
};

// Listen for file changes
useEffect(() => {
  const handleFileChanged = (event: any, data: any) => {
    console.log('[App] File changed:', data);
    // Show notification or refresh tree
  };
  
  // Electron IPC listener (requires adding to preload)
  // window.pdv.on('file-changed', handleFileChanged);
  
  // return () => window.pdv.off('file-changed', handleFileChanged);
}, []);

// Update window title with unsaved indicator
useEffect(() => {
  const title = projectInfo?.manifest?.name || 'Physics Data Viewer';
  document.title = hasUnsavedChanges ? `${title} •` : title;
}, [projectInfo, hasUnsavedChanges]);
```

---

### Part 10: Add Preload Methods

**Location:** `electron/preload. ts`

**Add project methods:**

```typescript
project: {
  save: (): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.project.save),
  load: (projectPath?: string): Promise<{ success: boolean; manifest?: any; error?: string }> =>
    ipcRenderer.invoke(IPC.project.load, projectPath),
  info: (): Promise<{ projectRoot: string; manifest?: any; blobCount: number; blobSize: number }> =>
    ipcRenderer.invoke(IPC. project.info),
},
```

---

### Part 11: Add Recovery Dialog

**Location:** `electron/renderer/src/components/RecoveryDialog/index.tsx` (NEW)

**Create crash recovery dialog:**

```typescript
import React from 'react';

interface RecoveryDialogProps {
  onRecover: () => void;
  onDiscard: () => void;
}

export const RecoveryDialog: React. FC<RecoveryDialogProps> = ({ onRecover, onDiscard }) => {
  return (
    <div className="modal-overlay">
      <div className="recovery-dialog">
        <div className="dialog-header">
          <h3>⚠️ Crash Recovery</h3>
        </div>

        <div className="dialog-body">
          <p>
            The app did not close properly last time. 
            There may be unsaved changes. 
          </p>
          <p>
            Would you like to attempt recovery?
          </p>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-secondary" onClick={onDiscard}>
            Discard Changes
          </button>
          <button className="btn btn-primary" onClick={onRecover}>
            Recover
          </button>
        </div>
      </div>
    </div>
  );
};
```

**Wire into App:**

```typescript
const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);

useEffect(() => {
  // Listen for recovery signal from main process
  // (Requires IPC listener setup in preload)
  const handleShowRecovery = () => {
    setShowRecoveryDialog(true);
  };
  
  // window.pdv.on('show-recovery-dialog', handleShowRecovery);
  
  // return () => window.pdv.off('show-recovery-dialog', handleShowRecovery);
}, []);

const handleRecover = async () => {
  setShowRecoveryDialog(false);
  // Load from backup
  await window.pdv. project.load();
};

const handleDiscardRecovery = () => {
  setShowRecoveryDialog(false);
  // Continue with fresh state
};

// In render:
{showRecoveryDialog && (
  <RecoveryDialog
    onRecover={handleRecover}
    onDiscard={handleDiscardRecovery}
  />
)}
```

---

## Exit Criteria

After completing this step, verify:    

1. **Build succeeds:**
   ```bash
   cd electron
   npm run build
   ```

2. **Create test project with blobs:**
   ```python
   # In Python kernel
   import numpy as np
   
   # Create some data
   my_array = np.random.rand(100, 100)
   my_dict = {'a': 1, 'b':  2, 'c': [1, 2, 3]}
   
   # Save to tree
   tree.save('results.my_array', my_array, "Test array")
   tree.save('results.my_dict', my_dict, "Test dict")
   ```

3. **Blobs stored:**
   - Check `test_project/blobs/` directory
   - See `.pickle` files with SHA256 names
   - File sizes match expected

4. **Save project (Ctrl/Cmd+S):**
   - Press Ctrl/Cmd+S or File → Save
   - `project. pdv` created/updated in project root
   - Contains blob references with hashes

5. **Load saved blobs:**
   ```python
   # Restart kernel
   loaded_array = tree.load('results.my_array')
   print(loaded_array. shape)  # (100, 100)
   
   loaded_dict = tree.load('results.my_dict')
   print(loaded_dict)  # {'a': 1, 'b': 2, 'c': [1, 2, 3]}
   ```

6. **Auto-save works:**
   - Make changes (save blobs, modify tree)
   - Wait 30 seconds
   - Check console:   "[AutoSave] Project saved"
   - `project.pdv` updated with new timestamp

7. **Crash recovery:**
   - Make changes (don't save)
   - Kill app forcefully (kill process)
   - Restart app
   - Recovery dialog appears
   - Click "Recover" → loads backup
   - Click "Discard" → starts fresh

8. **File watcher:**
   - Edit script externally (VS Code)
   - Console shows:  "[FileWatcher] change: scripts/..."
   - Notification appears (future enhancement)

9. **Project info:**
   - Check File → Project Info (or similar)
   - Shows:   project name, created date, blob count, total size

10. **Julia blobs (if installed):**
    ```julia
    # Save Julia object
    my_data = rand(50, 50)
    save(tree, "results.my_data", my_data, description="Julia array")
    
    # Restart kernel
    loaded = load(tree, "results.my_data")
    ```

11. **Trust warnings (future):**
    - Load pickle from untrusted source
    - Warning dialog appears
    - User can choose to trust or cancel

12. **Performance:**
    - Saving 100 small blobs → < 5s
    - Loading project with 100 blob references → < 1s
    - Auto-save with large project → < 500ms

---

## Files to Create/Modify (Checklist)

- [ ] `electron/main/blob-store.ts` — NEW:   Blob storage implementation
- [ ] `electron/main/project.ts` — NEW: Project manifest management
- [ ] `electron/main/file-watcher.ts` — NEW: File system watcher
- [ ] `electron/main/init/python-init.py` — Add tree. save() and tree.load()
- [ ] `electron/main/init/julia-init.jl` — Add save() and load()
- [ ] `electron/main/ipc.ts` — Add project channels
- [ ] `electron/main/index.ts` — Add project IPC handlers
- [ ] `electron/main/app.ts` — Add auto-save and crash recovery
- [ ] `electron/preload.ts` — Add project methods
- [ ] `electron/renderer/src/components/RecoveryDialog/index. tsx` — NEW: Recovery UI
- [ ] `electron/renderer/src/app/index.tsx` — Wire save/load/recovery
- [ ] `electron/renderer/src/styles/index.css` — Add recovery dialog styles

---

## Notes

- **Pickle security:** Unpickling untrusted data can execute arbitrary code.   Trust flag is critical.  Future:   add confirmation dialog for untrusted pickles. 

- **JLSO/JLD2:** Julia's JLSO is safer than pickle but has similar risks.  JLD2 is more performant for large arrays. 

- **Content addressing:** SHA256 hash prevents duplication—same object saved twice uses same blob. 

- **Garbage collection:** Blobs not referenced in manifest should be cleaned up periodically.  Add "Clean Blobs" button to remove orphaned files.

- **Large objects:** Pickle can handle large objects (GB+), but serialization is slow.  Consider chunked/streaming storage for huge arrays.

- **Version compatibility:** Pickles may not work across Python versions.  Store Python version in blob metadata, warn on mismatch.

- **File watcher performance:** `fs.watch()` with `recursive: true` can be slow on large directories.  Consider debouncing or using `chokidar` package.

- **Backup strategy:** Currently only `.backup` file.   Consider timestamped backups or git integration.

- **Network storage:** Blob store and project. pdv work on network drives, but file watching may be unreliable.

---

## Testing Tips

**Manual test workflow:**

1. Create project directory
2. Start app, run code, save objects to tree
3. Press Ctrl/Cmd+S → verify project. pdv created
4. Check blobs/ directory for pickle files
5. Restart app → verify objects loadable
6. Make changes, wait 30s → verify auto-save
7. Kill app forcefully → verify recovery dialog on restart
8. Edit script externally → verify file watcher detects change
9. Test with large object (100MB) → verify save/load works
10. Test with Julia objects (if installed)

**Edge cases:**

- Save same object twice → uses same blob (content-addressed)
- Save unpicklable object → error message
- Load from corrupted blob → error, doesn't crash
- Disk full during save → error, doesn't corrupt existing file
- Project.pdv corrupted → loads from backup
- Very large project (1000+ blobs) → save/load still fast

**Performance tests:**

- Save 100 small objects → < 5s
- Save 1 large object (1GB) → depends on disk speed, but doesn't freeze UI
- Auto-save with no changes → instant (no write)
- File watcher with 1000 files → no excessive CPU usage

---

## Future Enhancements (Not Required for This Step)

- Trust confirmation dialog for untrusted pickles
- Garbage collection for orphaned blobs
- Compression for large blobs (gzip, lz4)
- Incremental saves (only changed blobs)
- Git integration (commit project. pdv automatically)
- Remote blob storage (S3, Azure Blob)
- Blob browser UI (view all blobs, inspect metadata)
- Import/export blobs between projects
- Versioned blobs (keep history of changes)
- Encrypted blobs (for sensitive data)