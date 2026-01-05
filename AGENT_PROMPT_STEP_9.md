# Agent Task:    Step 9 - Data Loaders (HDF5/Zarr/Parquet/NPY)

## Context

You are continuing work on "Physics Data Viewer", an Electron + React + Vite + TypeScript app.     Step 8 implemented script execution with external editing.    Users can now run Python/Julia scripts from the Tree.   

**Your task is to implement data loaders that extract metadata from scientific data files without loading full datasets into memory.    Loaders should support:  HDF5, Zarr, Parquet, Arrow, NumPy (. npy), and images (PNG/JPG).   Data files appear in Tree with expandable structure (for HDF5 groups, Zarr arrays).   Double-clicking loads data into kernel namespace.**

**Reference files you should read first:**
- `PLAN.md` — Data loader architecture
- `electron/main/file-scanner.ts` — File scanner (already detects file types)
- `electron/main/init/python-init.py` — Python init cell (will need loader helpers)
- `electron/renderer/src/components/Tree/index.tsx` — Tree component

**Current state:**
- File scanner detects data files by extension
- Tree shows files but no metadata (shape, dtype, etc.)
- No way to load data into kernel
- No expandable structure for HDF5/Zarr

**After this step:**
- HDF5 files expandable to show groups/datasets with shape/dtype
- Zarr directories show array metadata
- Parquet files show schema and row count
- NPY files show array metadata via memmap
- Images show dimensions and thumbnail preview
- Double-click dataset → loads into kernel namespace
- Tree preview shows first N elements for small datasets
- Lazy loading:  metadata only until explicitly loaded

---

## Your Task

### Part 1: Loader Interface and Registry

**Location:** `electron/main/loaders/index.ts` (NEW)

**Define loader interface and registry:**

```typescript
/**
 * Data Loader System
 * 
 * Loaders extract metadata from data files without loading full content. 
 * Each loader handles specific file types (HDF5, Zarr, etc.).
 */

import { TreeNode } from '../ipc';

export interface LoaderMetadata {
  shape?:  number[];
  dtype?: string;
  size?: number;  // bytes
  rowCount?: number;
  columnCount?: number;
  columns?: string[];
  groups?: string[];
  datasets?: string[];
  attributes?: Record<string, unknown>;
  preview?: string;  // Short preview of data
}

export interface Loader {
  /**
   * Check if this loader can handle the file
   */
  canLoad(filePath: string, fileType: string): boolean;

  /**
   * Extract metadata without loading data
   */
  getMetadata(filePath: string): Promise<LoaderMetadata>;

  /**
   * Get child nodes (for hierarchical formats like HDF5)
   */
  getChildren?(filePath: string, groupPath?:  string): Promise<TreeNode[]>;

  /**
   * Load data (returns code to execute in kernel)
   */
  loadData(filePath: string, options?: LoadDataOptions): string;  // Returns Python/Julia code
}

export interface LoadDataOptions {
  language:  'python' | 'julia';
  variableName?: string;
  slice?: string;  // e.g., "[: 10, :]" for array slicing
  datasetPath?: string;  // For HDF5/Zarr:  path to specific dataset
}

/**
 * Loader Registry
 */
export class LoaderRegistry {
  private loaders:  Loader[] = [];

  register(loader: Loader): void {
    this.loaders.push(loader);
  }

  getLoader(filePath: string, fileType: string): Loader | undefined {
    return this.loaders.find(l => l.canLoad(filePath, fileType));
  }

  async getMetadata(filePath: string, fileType: string): Promise<LoaderMetadata | undefined> {
    const loader = this.getLoader(filePath, fileType);
    if (!loader) return undefined;
    return loader.getMetadata(filePath);
  }

  async getChildren(filePath: string, fileType: string, groupPath?: string): Promise<TreeNode[] | undefined> {
    const loader = this.getLoader(filePath, fileType);
    if (!loader || !loader.getChildren) return undefined;
    return loader.getChildren(filePath, groupPath);
  }

  loadData(filePath: string, fileType: string, options: LoadDataOptions): string | undefined {
    const loader = this.getLoader(filePath, fileType);
    if (!loader) return undefined;
    return loader. loadData(filePath, options);
  }
}

// Singleton
let registry: LoaderRegistry | null = null;

export function getLoaderRegistry(): LoaderRegistry {
  if (!registry) {
    registry = new LoaderRegistry();
    // Register loaders (done in registerLoaders())
  }
  return registry;
}
```

---

### Part 2: HDF5 Loader

**Location:** `electron/main/loaders/hdf5-loader.ts` (NEW)

**Implement HDF5 loader (requires h5py in Python):**

```typescript
/**
 * HDF5 Loader
 * 
 * Extracts metadata from HDF5 files using h5py (Python).
 * Supports hierarchical group/dataset structure.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Loader, LoaderMetadata, LoadDataOptions } from './index';
import { TreeNode } from '../ipc';

const execAsync = promisify(exec);

export class HDF5Loader implements Loader {
  canLoad(filePath: string, fileType: string): boolean {
    return fileType === 'hdf5' || filePath.endsWith('.h5') || filePath.endsWith('.hdf5');
  }

  async getMetadata(filePath: string): Promise<LoaderMetadata> {
    // Use Python to extract HDF5 metadata
    const pythonCode = `
import h5py
import json

with h5py.File('${filePath. replace(/'/g, "\\'")}', 'r') as f:
    metadata = {
        'groups': list(f.keys()),
        'num_groups': len([k for k in f.keys() if isinstance(f[k], h5py.Group)]),
        'num_datasets': len([k for k in f.keys() if isinstance(f[k], h5py. Dataset)]),
        'size': 0,  # TODO: calculate file size
    }
    
    # Get first dataset for preview
    for key in f.keys():
        if isinstance(f[key], h5py.Dataset):
            ds = f[key]
            metadata['preview'] = f"Dataset '{key}':  {ds.shape} {ds.dtype}"
            break
    
    print(json.dumps(metadata))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`);
      const metadata = JSON.parse(stdout. trim());
      
      return {
        groups: metadata.groups,
        preview: metadata.preview || `HDF5 file: ${metadata.num_groups} groups, ${metadata.num_datasets} datasets`,
        size: metadata.size,
      };
    } catch (error) {
      console.error('[HDF5Loader] Failed to read metadata:', error);
      return { preview: 'HDF5 file (h5py required)' };
    }
  }

  async getChildren(filePath: string, groupPath:  string = ''): Promise<TreeNode[]> {
    // Use Python to list HDF5 group contents
    const pythonCode = `
import h5py
import json

with h5py.File('${filePath.replace(/'/g, "\\'")}', 'r') as f:
    group = f if not '${groupPath}' else f['${groupPath}']
    
    children = []
    for key in group.keys():
        item = group[key]
        child = {
            'key': key,
            'path': '${groupPath}.' + key if '${groupPath}' else key,
        }
        
        if isinstance(item, h5py.Group):
            child['type'] = 'group'
            child['hasChildren'] = True
            child['preview'] = f"Group ({len(item.keys())} items)"
        elif isinstance(item, h5py.Dataset):
            child['type'] = 'dataset'
            child['hasChildren'] = False
            child['shape'] = list(item.shape)
            child['dtype'] = str(item.dtype)
            child['size'] = item.nbytes
            child['preview'] = f"{item.dtype} {tuple(item.shape)}"
        
        children.append(child)
    
    print(json.dumps(children))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`);
      const children = JSON.parse(stdout. trim());
      
      return children.map((child:  any) => ({
        id: `${filePath}:: ${child. path}`,
        key: child.key,
        path: child.path,
        type: child.type,
        hasChildren: child.hasChildren || false,
        shape: child. shape,
        dtype: child. dtype,
        sizeBytes: child.size,
        preview: child.preview,
        _file_path: filePath,
        _dataset_path: child.path,
      }));
    } catch (error) {
      console.error('[HDF5Loader] Failed to read children:', error);
      return [];
    }
  }

  loadData(filePath: string, options: LoadDataOptions): string {
    const varName = options.variableName || 'data';
    const datasetPath = options.datasetPath || '';
    const slice = options.slice || '[:]';

    if (options.language === 'python') {
      return `
import h5py
with h5py.File('${filePath.replace(/'/g, "\\'")}', 'r') as f:
    ${varName} = f['${datasetPath}']${slice}
print(f"Loaded {${varName}. shape} from ${datasetPath}")
`;
    } else {
      // Julia (using HDF5.jl)
      return `
using HDF5
${varName} = h5open("${filePath}", "r") do f
    read(f, "${datasetPath}")${slice === '[:]' ? '' : slice}
end
println("Loaded ", size(${varName}), " from ${datasetPath}")
`;
    }
  }
}
```

---

### Part 3: Zarr Loader

**Location:** `electron/main/loaders/zarr-loader.ts` (NEW)

**Implement Zarr loader:**

```typescript
/**
 * Zarr Loader
 * 
 * Extracts metadata from Zarr arrays using zarr-python.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Loader, LoaderMetadata, LoadDataOptions } from './index';
import { TreeNode } from '../ipc';

const execAsync = promisify(exec);

export class ZarrLoader implements Loader {
  canLoad(filePath: string, fileType: string): boolean {
    return fileType === 'zarr' || filePath.endsWith('.zarr');
  }

  async getMetadata(filePath: string): Promise<LoaderMetadata> {
    const pythonCode = `
import zarr
import json

try:
    z = zarr.open('${filePath.replace(/'/g, "\\'")}', mode='r')
    
    if isinstance(z, zarr.Array):
        metadata = {
            'shape': list(z.shape),
            'dtype': str(z.dtype),
            'size': z.nbytes,
            'chunks': list(z.chunks) if hasattr(z, 'chunks') else None,
            'preview': f"{z.dtype} {tuple(z.shape)}"
        }
    elif isinstance(z, zarr.Group):
        arrays = list(z.arrays())
        metadata = {
            'num_arrays': len(arrays),
            'preview': f"Zarr group ({len(arrays)} arrays)"
        }
    else:
        metadata = {'preview': 'Zarr store'}
    
    print(json.dumps(metadata))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`);
      const metadata = JSON.parse(stdout.trim());
      
      if (metadata.error) {
        return { preview: 'Zarr array (zarr-python required)' };
      }
      
      return {
        shape: metadata.shape,
        dtype: metadata.dtype,
        size: metadata.size,
        preview: metadata.preview,
      };
    } catch (error) {
      console.error('[ZarrLoader] Failed to read metadata:', error);
      return { preview:  'Zarr array' };
    }
  }

  async getChildren(filePath:  string, groupPath: string = ''): Promise<TreeNode[]> {
    const pythonCode = `
import zarr
import json

z = zarr.open('${filePath.replace(/'/g, "\\'")}', mode='r')
group = z if not '${groupPath}' else z['${groupPath}']

children = []
if isinstance(group, zarr.Group):
    for key in group. keys():
        item = group[key]
        child = {
            'key': key,
            'path': '${groupPath}.' + key if '${groupPath}' else key,
        }
        
        if isinstance(item, zarr.Group):
            child['type'] = 'group'
            child['hasChildren'] = True
        elif isinstance(item, zarr. Array):
            child['type'] = 'dataset'
            child['hasChildren'] = False
            child['shape'] = list(item.shape)
            child['dtype'] = str(item.dtype)
            child['size'] = item.nbytes
            child['preview'] = f"{item.dtype} {tuple(item.shape)}"
        
        children.append(child)

print(json.dumps(children))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`);
      const children = JSON.parse(stdout. trim());
      
      return children.map((child: any) => ({
        id: `${filePath}::${child.path}`,
        key: child.key,
        path: child.path,
        type: child.type,
        hasChildren: child. hasChildren || false,
        shape: child.shape,
        dtype: child.dtype,
        sizeBytes: child.size,
        preview: child.preview,
        _file_path: filePath,
        _dataset_path:  child.path,
      }));
    } catch (error) {
      console.error('[ZarrLoader] Failed to read children:', error);
      return [];
    }
  }

  loadData(filePath: string, options:  LoadDataOptions): string {
    const varName = options.variableName || 'data';
    const datasetPath = options.datasetPath || '';
    const slice = options.slice || '[:]';

    if (options.language === 'python') {
      return `
import zarr
z = zarr.open('${filePath.replace(/'/g, "\\'")}', mode='r')
${varName} = z${datasetPath ?  `['${datasetPath}']` : ''}${slice}
print(f"Loaded {${varName}.shape} from Zarr")
`;
    } else {
      // Julia (using Zarr.jl)
      return `
using Zarr
z = zopen("${filePath}", "r")
${varName} = z${datasetPath ? `["${datasetPath}"]` : ''}${slice === '[:]' ? '[:]' : slice}
println("Loaded ", size(${varName}), " from Zarr")
`;
    }
  }
}
```

---

### Part 4: Parquet Loader

**Location:** `electron/main/loaders/parquet-loader.ts` (NEW)

**Implement Parquet loader:**

```typescript
/**
 * Parquet Loader
 * 
 * Extracts schema from Parquet files using pyarrow.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Loader, LoaderMetadata, LoadDataOptions } from './index';

const execAsync = promisify(exec);

export class ParquetLoader implements Loader {
  canLoad(filePath: string, fileType: string): boolean {
    return fileType === 'parquet' || filePath.endsWith('. parquet');
  }

  async getMetadata(filePath:  string): Promise<LoaderMetadata> {
    const pythonCode = `
import pyarrow.parquet as pq
import json

try:
    table = pq.read_table('${filePath.replace(/'/g, "\\'")}')
    metadata = {
        'rowCount': table.num_rows,
        'columnCount': table. num_columns,
        'columns': table.column_names,
        'size': table.nbytes,
        'preview': f"Parquet ({table.num_rows} rows, {table.num_columns} cols)"
    }
    print(json.dumps(metadata))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`);
      const metadata = JSON. parse(stdout.trim());
      
      if (metadata.error) {
        return { preview: 'Parquet file (pyarrow required)' };
      }
      
      return {
        rowCount:  metadata.rowCount,
        columnCount: metadata.columnCount,
        columns: metadata.columns,
        size: metadata.size,
        preview: metadata.preview,
      };
    } catch (error) {
      console.error('[ParquetLoader] Failed to read metadata:', error);
      return { preview: 'Parquet file' };
    }
  }

  loadData(filePath: string, options: LoadDataOptions): string {
    const varName = options.variableName || 'data';

    if (options.language === 'python') {
      return `
import pyarrow.parquet as pq
${varName} = pq.read_table('${filePath.replace(/'/g, "\\'")}').to_pandas()
print(f"Loaded Parquet:  {${varName}.shape}")
`;
    } else {
      // Julia (using Parquet.jl)
      return `
using Parquet
${varName} = read_parquet("${filePath}")
println("Loaded Parquet:  ", size(${varName}))
`;
    }
  }
}
```

---

### Part 5: NumPy Loader

**Location:** `electron/main/loaders/npy-loader.ts` (NEW)

**Implement NPY loader:**

```typescript
/**
 * NumPy Loader
 * 
 * Extracts metadata from . npy files using numpy.lib.format.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Loader, LoaderMetadata, LoadDataOptions } from './index';

const execAsync = promisify(exec);

export class NPYLoader implements Loader {
  canLoad(filePath: string, fileType: string): boolean {
    return fileType === 'npy' || filePath.endsWith('.npy') || filePath.endsWith('.npz');
  }

  async getMetadata(filePath: string): Promise<LoaderMetadata> {
    const pythonCode = `
import numpy as np
import json

try:
    if '${filePath}'. endswith('.npz'):
        with np.load('${filePath.replace(/'/g, "\\'")}') as data:
            arrays = list(data.keys())
            metadata = {
                'preview': f"NPZ archive ({len(arrays)} arrays)",
                'groups': arrays
            }
    else:
        # Use memmap to avoid loading entire array
        arr = np.load('${filePath.replace(/'/g, "\\'")}', mmap_mode='r')
        metadata = {
            'shape': list(arr.shape),
            'dtype': str(arr. dtype),
            'size': arr.nbytes,
            'preview': f"{arr.dtype} {tuple(arr.shape)}"
        }
    
    print(json.dumps(metadata))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`);
      const metadata = JSON.parse(stdout.trim());
      
      if (metadata.error) {
        return { preview: 'NPY file (numpy required)' };
      }
      
      return {
        shape: metadata. shape,
        dtype: metadata. dtype,
        size: metadata. size,
        groups: metadata.groups,
        preview: metadata.preview,
      };
    } catch (error) {
      console.error('[NPYLoader] Failed to read metadata:', error);
      return { preview: 'NPY file' };
    }
  }

  loadData(filePath: string, options: LoadDataOptions): string {
    const varName = options.variableName || 'data';
    const slice = options.slice || '[:]';

    if (options.language === 'python') {
      if (filePath.endsWith('.npz')) {
        return `
${varName}_archive = np.load('${filePath.replace(/'/g, "\\'")}')
${varName} = {key: ${varName}_archive[key] for key in ${varName}_archive.keys()}
print(f"Loaded NPZ with {len(${varName})} arrays")
`;
      } else {
        return `
${varName} = np.load('${filePath.replace(/'/g, "\\'")}', mmap_mode='r')${slice}
print(f"Loaded NPY:  {${varName}.shape}")
`;
      }
    } else {
      // Julia (using NPZ.jl)
      return `
using NPZ
${varName} = npzread("${filePath}")${slice === '[:]' ? '' :  slice}
println("Loaded NPY: ", size(${varName}))
`;
    }
  }
}
```

---

### Part 6: Image Loader

**Location:** `electron/main/loaders/image-loader.ts` (NEW)

**Implement image loader:**

```typescript
/**
 * Image Loader
 * 
 * Extracts dimensions from image files using PIL/Pillow.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Loader, LoaderMetadata, LoadDataOptions } from './index';

const execAsync = promisify(exec);

export class ImageLoader implements Loader {
  canLoad(filePath: string, fileType: string): boolean {
    return fileType === 'image' || 
           ['.png', '.jpg', '.jpeg', '. gif', '.bmp', '.tiff']. some(ext => filePath.endsWith(ext));
  }

  async getMetadata(filePath:  string): Promise<LoaderMetadata> {
    const pythonCode = `
from PIL import Image
import json

try:
    img = Image.open('${filePath.replace(/'/g, "\\'")}')
    metadata = {
        'shape': [img.height, img.width, len(img.getbands())],
        'dtype': img.mode,
        'preview': f"{img.mode} {img.width}x{img.height}"
    }
    print(json. dumps(metadata))
except Exception as e:
    print(json. dumps({'error': str(e)}))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`);
      const metadata = JSON.parse(stdout.trim());
      
      if (metadata.error) {
        return { preview: 'Image file (Pillow required)' };
      }
      
      return {
        shape: metadata.shape,
        dtype: metadata.dtype,
        preview: metadata.preview,
      };
    } catch (error) {
      console.error('[ImageLoader] Failed to read metadata:', error);
      return { preview: 'Image file' };
    }
  }

  loadData(filePath: string, options: LoadDataOptions): string {
    const varName = options.variableName || 'img';

    if (options.language === 'python') {
      return `
from PIL import Image
import numpy as np
${varName}_pil = Image.open('${filePath.replace(/'/g, "\\'")}')
${varName} = np.array(${varName}_pil)
print(f"Loaded image: {${varName}.shape}")
`;
    } else {
      // Julia (using Images.jl)
      return `
using Images
${varName} = load("${filePath}")
println("Loaded image: ", size(${varName}))
`;
    }
  }
}
```

---

### Part 7: Register All Loaders

**Location:** `electron/main/loaders/index.ts`

**Add registration function:**

```typescript
import { HDF5Loader } from './hdf5-loader';
import { ZarrLoader } from './zarr-loader';
import { ParquetLoader } from './parquet-loader';
import { NPYLoader } from './npy-loader';
import { ImageLoader } from './image-loader';

export function registerLoaders(registry: LoaderRegistry): void {
  registry.register(new HDF5Loader());
  registry.register(new ZarrLoader());
  registry.register(new ParquetLoader());
  registry.register(new NPYLoader());
  registry.register(new ImageLoader());
}

// Update getLoaderRegistry to auto-register
export function getLoaderRegistry(): LoaderRegistry {
  if (!registry) {
    registry = new LoaderRegistry();
    registerLoaders(registry);
  }
  return registry;
}
```

---

### Part 8: Update File Scanner to Use Loaders

**Location:** `electron/main/file-scanner.ts`

**Update `createFileNode` to extract metadata:**

```typescript
import { getLoaderRegistry } from './loaders';

private async createFileNode(
  filePath: string,
  fileName: string,
  nodePath: string,
  stats: fs.Stats
): Promise<TreeNode> {
  const ext = path.extname(fileName);
  const fileType = this.detectFileType(ext);
  
  const node:  TreeNode = {
    id:  nodePath,
    key: fileName,
    path: nodePath,
    type: fileType,
    hasChildren: false,
    sizeBytes: stats.size,
    _file_path: filePath,
    _modified:  stats.mtime. toISOString(),
  };
  
  // Extract metadata using loaders
  const loaderRegistry = getLoaderRegistry();
  
  if (['hdf5', 'zarr', 'parquet', 'npy', 'image']. includes(fileType)) {
    try {
      const metadata = await loaderRegistry.getMetadata(filePath, fileType);
      
      if (metadata) {
        node.shape = metadata.shape;
        node.dtype = metadata.dtype;
        node.preview = metadata.preview;
        node.sizeBytes = metadata.size || stats.size;
        
        // Mark as expandable if has groups
        if (metadata.groups && metadata.groups.length > 0) {
          node.hasChildren = true;
        }
        
        // HDF5 and Zarr are expandable
        if (fileType === 'hdf5' || fileType === 'zarr') {
          node.hasChildren = true;
        }
      }
    } catch (error) {
      console.warn(`[FileScanner] Failed to load metadata for ${filePath}:`, error);
    }
    
    node.actions = ['load', 'inspect', 'preview'];
  }
  
  // ...  rest of existing code for scripts, etc.
  
  return node;
}
```

**Update `getChildren` to use loaders for hierarchical data:**

```typescript
async getChildren(nodePath: string): Promise<TreeNode[]> {
  // Check if this is a data file node (HDF5/Zarr)
  if (nodePath.includes(':: ')) {
    // Format: "filepath::datasetpath"
    const [filePath, datasetPath] = nodePath.split('::');
    const loaderRegistry = getLoaderRegistry();
    const fileType = this.detectFileType(path.extname(filePath));
    
    const children = await loaderRegistry.getChildren(filePath, fileType, datasetPath);
    return children || [];
  }
  
  // Otherwise, scan directory as before
  const relativePathParts = nodePath.split('.');
  const dirPath = path.join(this.treeRoot, ... relativePathParts);
  
  if (! fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return [];
  }
  
  return this.scanDirectory(dirPath, nodePath);
}
```

---

### Part 9: Add Load Data IPC Handler

**Location:** `electron/main/index.ts`

**Add data loading handler:**

```typescript
import { getLoaderRegistry } from './loaders';

// Data:   Load
ipcMain.handle('data:load', async (_event, kernelId: string, filePath:  string, options: any) => {
  console.log('[IPC] data:load', kernelId, filePath, options);
  
  try {
    const kernelManager = getKernelManager();
    const kernel = kernelManager.getKernel(kernelId);
    
    if (!kernel) {
      return { success: false, error: `Kernel not found: ${kernelId}` };
    }
    
    const loaderRegistry = getLoaderRegistry();
    const fileType = options.fileType || 'unknown';
    
    const loadCode = loaderRegistry.loadData(filePath, fileType, {
      language: kernel.language,
      variableName: options.variableName || 'data',
      slice:  options.slice,
      datasetPath: options.datasetPath,
    });
    
    if (! loadCode) {
      return { success: false, error: `No loader found for ${fileType}` };
    }
    
    // Execute load code in kernel
    const result = await kernelManager.execute(kernelId, { code: loadCode });
    
    if (result.error) {
      return { success:  false, error: result.error };
    }
    
    return { success: true, result: result.stdout };
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
```

**Add to IPC types:**

```typescript
// In electron/main/ipc. ts
export const IPC = {
  // ... existing
  data: {
    load: 'data:load',
  },
} as const;
```

---

### Part 10: Update Preload

**Location:** `electron/preload.ts`

**Add data loading method:**

```typescript
data: {
  load: (kernelId: string, filePath:  string, options?:  {
    fileType?: string;
    variableName?: string;
    slice?:  string;
    datasetPath?:  string;
  }): Promise<{ success: boolean; result?:  string; error?: string }> =>
    ipcRenderer.invoke(IPC.data.load, kernelId, filePath, options),
},
```

---

### Part 11: Wire Data Loading into Tree

**Location:** `electron/renderer/src/components/Tree/index.tsx`

**Update action handler:**

```typescript
const handleContextAction = async (action: string, node: TreeNodeData) => {
  console.log('[Tree] Action:', action, node);
  
  if (action === 'load') {
    // Load data into kernel
    if (! currentKernelId) {
      console.error('[Tree] No kernel active');
      return;
    }
    
    try {
      const result = await window.pdv.data.load(currentKernelId, node._file_path, {
        fileType: node.type,
        variableName: node.key. replace(/[^a-zA-Z0-9_]/g, '_'),  // Sanitize name
        datasetPath: node._dataset_path,
      });
      
      if (result.success) {
        console.log('[Tree] Data loaded:', result.result);
      } else {
        console.error('[Tree] Load failed:', result.error);
      }
    } catch (error) {
      console.error('[Tree] Load error:', error);
    }
  } else if (action === 'inspect') {
    // Show metadata in a dialog (future enhancement)
    console.log('[Tree] Inspect:', node);
  }
  
  // ... other actions
};
```

---

## Exit Criteria

After completing this step, verify:   

1. **Build succeeds:**
   ```bash
   cd electron
   npm run build
   ```

2. **Create test data files:**
   ```bash
   cd test_project/tree/data
   
   # Python script to create test files
   python3 << EOF
   import numpy as np
   import h5py
   
   # Create HDF5 file
   with h5py.File('test. h5', 'w') as f:
       f.create_group('experiments')
       f['experiments'].create_dataset('shot_001', data=np.random.rand(100, 100))
       f['experiments'].create_dataset('shot_002', data=np. random.rand(100, 100))
       f. create_dataset('metadata', data=np.array([1, 2, 3]))
   
   # Create NPY file
   np.save('array.npy', np.random. rand(50, 50))
   
   print("Test files created")
   EOF
   ```

3. **App launches and scans data:**
   ```bash
   npm run dev
   ```
   - Tree shows `data/` folder
   - Expand `data/`
   - See `test.h5` and `array.npy`

4. **HDF5 metadata extracted:**
   - `test.h5` shows preview:  "HDF5 file:  1 groups, 1 datasets"
   - Type badge shows "hdf5"
   - Arrow indicates expandable

5. **HDF5 expansion works:**
   - Click arrow on `test.h5`
   - Shows: 
     - `experiments` (group, expandable)
     - `metadata` (dataset, shape [3], dtype int64)
   - Expand `experiments`
   - Shows: 
     - `shot_001` (dataset, shape [100, 100], dtype float64)
     - `shot_002` (dataset, shape [100, 100], dtype float64)

6. **NPY metadata extracted:**
   - `array.npy` shows preview: "float64 (50, 50)"
   - Shape and dtype displayed in tree

7. **Load data to kernel:**
   - Right-click `array.npy` → "Load"
   - Console shows: "Loaded NPY: (50, 50)"
   - Switch to Namespace tab
   - Variable `array_npy` appears with shape [50, 50]

8. **Load HDF5 dataset:**
   - Right-click `experiments/shot_001` → "Load"
   - Console shows: "Loaded (100, 100) from experiments/shot_001"
   - Namespace shows `shot_001` variable

9. **Parquet files (if available):**
   - Create test:  `df.to_parquet('test.parquet')`
   - Appears in tree with schema/row count
   - Load to kernel → becomes pandas DataFrame

10. **Images (if available):**
    - Add PNG image to `data/`
    - Shows dimensions in preview:  "RGB 800x600"
    - Load → becomes numpy array

11. **Error handling:**
    - HDF5 without h5py installed → preview shows "(h5py required)"
    - Corrupted file → error message, doesn't crash
    - Missing file → error on load

12. **Performance:**
    - Scanning directory with 100 data files → < 2s
    - Expanding HDF5 with 1000 datasets → < 1s (metadata only)
    - Loading large array (1GB) → progress indication (future)

---

## Files to Create/Modify (Checklist)

- [ ] `electron/main/loaders/index.ts` — NEW:  Loader interface and registry
- [ ] `electron/main/loaders/hdf5-loader.ts` — NEW: HDF5 loader
- [ ] `electron/main/loaders/zarr-loader. ts` — NEW: Zarr loader
- [ ] `electron/main/loaders/parquet-loader.ts` — NEW: Parquet loader
- [ ] `electron/main/loaders/npy-loader.ts` — NEW: NumPy loader
- [ ] `electron/main/loaders/image-loader.ts` — NEW: Image loader
- [ ] `electron/main/file-scanner.ts` — Update to use loaders for metadata
- [ ] `electron/main/ipc.ts` — Add data: load channel
- [ ] `electron/main/index.ts` — Add data load handler
- [ ] `electron/preload.ts` — Add data. load method
- [ ] `electron/renderer/src/components/Tree/index.tsx` — Wire load action

---

## Notes

- **Python dependencies:** Loaders require Python packages (h5py, zarr, pyarrow, pillow).  Document these in README.  Users install in their kernel environment.  

- **Subprocess overhead:** Calling `python3 -c` for each metadata extraction is slow.   Future optimization:  use persistent Python process or integrate Python interpreter directly.

- **Julia loaders:** Currently Python-only.   Julia equivalents (HDF5.jl, Zarr.jl) should be added for Julia kernels.

- **Large files:** Metadata extraction is fast (memmap/header reads), but UI may freeze if Python subprocess hangs.  Consider timeout. 

- **Caching:** Metadata could be cached to avoid re-extraction on every tree refresh.  Store in `project. pdv` or `.pdv_cache/`.

- **Preview data:** "First N elements" preview not yet implemented.  Future enhancement: load small slice and display in tooltip or preview pane.

- **Thumbnail images:** Image previews could show actual thumbnail.  Use PIL to generate base64 thumbnail, display in tree.

- **Progress bars:** Large data loads should show progress.   Future:   stream data chunks and update progress bar.

---

## Testing Tips

**Manual test workflow:**

1. Create test HDF5, NPY, Parquet files using Python script
2. Launch app, navigate to data directory
3. Verify files appear with metadata
4. Expand HDF5 → verify groups/datasets
5. Right-click dataset → Load
6. Check Namespace for loaded variable
7. Test with large file (1GB+) → memmap, no freeze
8. Test with missing dependency (uninstall h5py) → error message
9. Test with corrupted file → graceful error

**Edge cases:**

- Empty HDF5 group → shows "Group (0 items)"
- 1D array → shape shows [N]
- NPZ archive → shows multiple arrays
- Image with alpha channel → shape includes 4th dimension
- Symlinked file → resolves correctly
- File deleted externally → error on expand, tree refreshes

**Performance tests:**

- 1000 HDF5 datasets → metadata extraction < 5s
- 10GB NPY file → memmap loads instantly (no data transfer)
- Expand/collapse 100 times → no memory leak

---

## Future Enhancements (Not Required for This Step)

- **Data preview pane:** Show first N rows/elements in sidebar
- **Lazy chunked reading:** Load data in chunks with progress bar
- **Data filtering:** Filter datasets by name/shape/dtype before loading
- **Data export:** Export subset of data to new file
- **Plot preview:** Generate thumbnail plot for 1D/2D arrays
- **Zarr remote:** Load Zarr from S3/HTTP
- **HDF5 attributes:** Display HDF5 attributes in tooltip
- **SQL databases:** Add loader for SQLite, PostgreSQL
- **FITS files:** Add loader for astronomical FITS format
- **NetCDF:** Add loader for NetCDF files (common in climate science)
- **Metadata search:** Full-text search across all dataset metadata