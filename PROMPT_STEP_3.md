# Agent Task: Step 3 - Kernel Manager (Stub)

## Context

You are continuing work on "Physics Data Viewer", an Electron + React + Vite + TypeScript app.  Step 2 defined the IPC contracts and exposed `window.pdv` to the renderer. The app now has typed IPC communication with stub handlers.

**Your task is to create a proper KernelManager class that encapsulates all kernel operations, and update the IPC handlers to use it.  The implementation will still be stubbed (no real Jupyter kernels yet), but the architecture will be ready for `@jupyterlab/services` integration later.**

**Reference files you should read first:**
- `PLAN. md` — Overall architecture and kernel requirements
- `IMPLEMENTATION_STEPS.md` — Step 3 requirements
- `electron/main/ipc.ts` — Type definitions (KernelInfo, KernelExecuteRequest, etc.)
- `electron/main/index.ts` — Current inline stub handlers

**Current state:**
- IPC contracts defined in `ipc.ts`
- Stub handlers inline in `index.ts`
- `kernel-manager.ts` is an empty stub with TODO
- Init cell files exist with placeholder comments

**After this step:**
- `KernelManager` class handles all kernel operations
- IPC handlers delegate to KernelManager
- Init cell files have proper placeholder logic
- Architecture is ready for real kernel integration
- Unit tests for KernelManager

---

## Your Task

Implement the following files:

### 1. `electron/main/kernel-manager.ts`

Create a full KernelManager class: 

```typescript
/**
 * Kernel Manager
 * 
 * Manages Jupyter kernel lifecycles and execution. 
 * Currently a stub implementation; will integrate @jupyterlab/services later.
 * 
 * Architecture:
 * - Maintains a map of active kernels
 * - Handles kernel start/stop/restart
 * - Executes code and returns results
 * - Injects init cells on kernel start
 * - Supports both Python and Julia kernels
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  KernelSpec,
  KernelInfo,
  KernelExecuteRequest,
  KernelExecuteResult,
  KernelCompleteResult,
  KernelInspectResult,
} from './ipc';

// ============================================================================
// Types
// ============================================================================

interface ManagedKernel {
  info: KernelInfo;
  spec: KernelSpec;
  startedAt: number;
  lastActivity: number;
  executionCount: number;
}

interface ExecutionOptions {
  silent?: boolean;
  storeHistory?: boolean;
  timeout?: number;
}

// ============================================================================
// Init Cell Loader
// ============================================================================

/**
 * Load init cell content for a given language
 */
function loadInitCell(language: 'python' | 'julia'): string {
  const filename = language === 'python' ? 'python-init.py' : 'julia-init. jl';
  const initPath = path.join(__dirname, 'init', filename);
  
  try {
    if (fs.existsSync(initPath)) {
      return fs.readFileSync(initPath, 'utf-8');
    }
  } catch (error) {
    console.warn(`[KernelManager] Failed to load init cell for ${language}:`, error);
  }
  
  // Fallback minimal init
  if (language === 'python') {
    return '# Physics Data Viewer - Python kernel\nprint("PDV Python kernel ready")';
  } else {
    return '# Physics Data Viewer - Julia kernel\nprintln("PDV Julia kernel ready")';
  }
}

// ============================================================================
// Kernel Manager Class
// ============================================================================

export class KernelManager {
  private kernels: Map<string, ManagedKernel> = new Map();
  private defaultSpecs: Map<string, KernelSpec> = new Map();
  
  constructor() {
    // Register default kernel specs
    this.defaultSpecs.set('python3', {
      name: 'python3',
      displayName: 'Python 3',
      language: 'python',
    });
    
    this.defaultSpecs.set('julia', {
      name: 'julia',
      displayName: 'Julia',
      language: 'julia',
    });
    
    console.log('[KernelManager] Initialized with default specs:', 
      Array.from(this. defaultSpecs.keys()));
  }

  // ==========================================================================
  // Kernel Lifecycle
  // ==========================================================================

  /**
   * List all available kernel specs
   */
  async listSpecs(): Promise<KernelSpec[]> {
    // TODO: In real implementation, query jupyter kernelspec list
    return Array.from(this.defaultSpecs.values());
  }

  /**
   * List all running kernels
   */
  async list(): Promise<KernelInfo[]> {
    return Array.from(this.kernels.values()).map(k => k.info);
  }

  /**
   * Start a new kernel
   */
  async start(spec?:  Partial<KernelSpec>): Promise<KernelInfo> {
    const id = `kernel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const language = spec?.language || 'python';
    const name = spec?.name || (language === 'python' ? 'python3' : 'julia');
    
    const kernelSpec:  KernelSpec = {
      name,
      displayName: spec?.displayName || this.defaultSpecs.get(name)?.displayName || name,
      language,
      argv: spec?.argv,
      env: spec?.env,
    };

    const kernelInfo:  KernelInfo = {
      id,
      name,
      language,
      status: 'starting',
    };

    const managed:  ManagedKernel = {
      info: kernelInfo,
      spec: kernelSpec,
      startedAt: Date. now(),
      lastActivity: Date.now(),
      executionCount: 0,
    };

    this.kernels.set(id, managed);
    console.log(`[KernelManager] Starting kernel:  ${id} (${language})`);

    // Simulate startup delay
    await this.simulateDelay(100);

    // Run init cell
    const initCell = loadInitCell(language);
    await this.executeInternal(id, initCell, { silent: true, storeHistory: false });

    // Update status to idle
    managed.info.status = 'idle';
    managed.lastActivity = Date. now();

    console.log(`[KernelManager] Kernel ready: ${id}`);
    return { ...managed.info };
  }

  /**
   * Stop a kernel
   */
  async stop(id: string): Promise<boolean> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      console.warn(`[KernelManager] Kernel not found: ${id}`);
      return false;
    }

    console.log(`[KernelManager] Stopping kernel: ${id}`);
    kernel.info.status = 'dead';
    this.kernels.delete(id);
    
    return true;
  }

  /**
   * Restart a kernel
   */
  async restart(id: string): Promise<KernelInfo> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      throw new Error(`Kernel not found: ${id}`);
    }

    console.log(`[KernelManager] Restarting kernel: ${id}`);
    
    // Mark as restarting
    kernel. info.status = 'starting';
    kernel.executionCount = 0;
    
    // Simulate restart delay
    await this.simulateDelay(200);
    
    // Re-run init cell
    const initCell = loadInitCell(kernel. spec.language);
    await this.executeInternal(id, initCell, { silent: true, storeHistory: false });
    
    // Mark as ready
    kernel.info.status = 'idle';
    kernel. lastActivity = Date.now();
    
    console.log(`[KernelManager] Kernel restarted: ${id}`);
    return { ...kernel.info };
  }

  /**
   * Interrupt a running kernel
   */
  async interrupt(id: string): Promise<boolean> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      console.warn(`[KernelManager] Kernel not found: ${id}`);
      return false;
    }

    console.log(`[KernelManager] Interrupting kernel: ${id}`);
    
    // In real implementation, send SIGINT to kernel process
    // For stub, just set status back to idle
    kernel.info.status = 'idle';
    kernel. lastActivity = Date.now();
    
    return true;
  }

  // ==========================================================================
  // Code Execution
  // ==========================================================================

  /**
   * Execute code in a kernel
   */
  async execute(id: string, request: KernelExecuteRequest): Promise<KernelExecuteResult> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      return {
        error: `Kernel not found: ${id}`,
        duration: 0,
      };
    }

    const startTime = Date.now();
    kernel.info.status = 'busy';
    kernel.lastActivity = Date.now();
    kernel.executionCount++;

    console.log(`[KernelManager] Execute [${kernel.executionCount}] on ${id}: `, 
      request.code. slice(0, 100) + (request.code.length > 100 ? '...' : ''));

    try {
      const result = await this.executeInternal(id, request.code, {
        storeHistory: true,
        timeout: 30000,
      });

      // Handle capture mode for plots
      if (request.capture && result.stdout?. includes('plt.show')) {
        result.images = [{
          mime: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', // 1x1 transparent PNG stub
        }];
        result.stdout = result.stdout.replace('plt.show()', '[Figure captured]');
      }

      result.duration = Date.now() - startTime;
      return result;

    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    } finally {
      kernel.info. status = 'idle';
      kernel.lastActivity = Date.now();
    }
  }

  /**
   * Internal execution (used for init cells and user code)
   */
  private async executeInternal(
    id: string, 
    code: string, 
    options: ExecutionOptions = {}
  ): Promise<KernelExecuteResult> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      throw new Error(`Kernel not found: ${id}`);
    }

    // Simulate execution delay based on code complexity
    const delay = Math.min(50 + code.length / 10, 500);
    await this.simulateDelay(delay);

    // Stub execution logic
    const result:  KernelExecuteResult = {
      stdout: '',
      stderr: undefined,
      result: undefined,
      images: undefined,
      error: undefined,
    };

    // Parse and "execute" the code (stub logic)
    const lines = code. split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Handle print statements
      const printMatch = trimmed.match(/^print\s*\(\s*["'](.*)["']\s*\)/);
      if (printMatch) {
        result.stdout = (result.stdout || '') + printMatch[1] + '\n';
        continue;
      }
      
      // Handle println (Julia)
      const printlnMatch = trimmed.match(/^println\s*\(\s*["'](.*)["']\s*\)/);
      if (printlnMatch) {
        result.stdout = (result.stdout || '') + printlnMatch[1] + '\n';
        continue;
      }

      // Handle simple expressions
      if (trimmed.match(/^\d+\s*[\+\-\*\/]\s*\d+$/)) {
        try {
          result.result = eval(trimmed);
        } catch {
          // Ignore eval errors in stub
        }
        continue;
      }

      // Handle variable assignments (just acknowledge)
      if (trimmed.match(/^[a-zA-Z_]\w*\s*=/)) {
        continue;
      }

      // Handle import statements
      if (trimmed. startsWith('import ') || trimmed.startsWith('using ') || trimmed.startsWith('from ')) {
        continue;
      }
    }

    // Clean up stdout
    if (result.stdout) {
      result.stdout = result.stdout. trim();
    } else {
      result.stdout = undefined;
    }

    return result;
  }

  // ==========================================================================
  // Completions and Inspection
  // ==========================================================================

  /**
   * Get code completions
   */
  async complete(id: string, code: string, cursorPos: number): Promise<KernelCompleteResult> {
    const kernel = this.kernels.get(id);
    if (!kernel) {
      return { matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    console.log(`[KernelManager] Complete on ${id} at position ${cursorPos}`);

    // Stub:  provide some common completions based on language
    const beforeCursor = code.slice(0, cursorPos);
    const wordMatch = beforeCursor.match(/[\w. ]+$/);
    const word = wordMatch ? wordMatch[0] : '';
    const wordStart = cursorPos - word.length;

    let matches: string[] = [];

    if (kernel.spec.language === 'python') {
      const pythonKeywords = [
        'import', 'from', 'def', 'class', 'return', 'if', 'else', 'elif',
        'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'lambda',
        'print', 'len', 'range', 'list', 'dict', 'set', 'tuple', 'str', 'int', 'float',
        'numpy', 'pandas', 'matplotlib', 'plt', 'np', 'pd',
      ];
      matches = pythonKeywords.filter(k => k.startsWith(word) && k !== word);
    } else {
      const juliaKeywords = [
        'using', 'import', 'function', 'end', 'if', 'else', 'elseif',
        'for', 'while', 'try', 'catch', 'finally', 'return', 'struct',
        'println', 'print', 'length', 'size', 'typeof', 'convert',
        'Array', 'Vector', 'Matrix', 'Dict', 'Set', 'Tuple',
        'Plots', 'DataFrames', 'LinearAlgebra',
      ];
      matches = juliaKeywords.filter(k => k.startsWith(word) && k !== word);
    }

    return {
      matches:  matches.slice(0, 20),
      cursor_start: wordStart,
      cursor_end:  cursorPos,
    };
  }

  /**
   * Inspect an object
   */
  async inspect(id: string, code: string, cursorPos: number): Promise<KernelInspectResult> {
    const kernel = this. kernels.get(id);
    if (!kernel) {
      return { found: false };
    }

    console.log(`[KernelManager] Inspect on ${id} at position ${cursorPos}`);

    // Extract word at cursor
    const beforeCursor = code. slice(0, cursorPos);
    const afterCursor = code.slice(cursorPos);
    const wordBefore = beforeCursor.match(/[\w.]+$/) || [''];
    const wordAfter = afterCursor.match(/^[\w.]*/) || [''];
    const word = wordBefore[0] + wordAfter[0];

    if (!word) {
      return { found: false };
    }

    // Stub: provide documentation for common items
    const docs:  Record<string, string> = {
      'print': 'print(*args, sep=" ", end="\\n")\n\nPrint objects to the text stream.',
      'len': 'len(obj)\n\nReturn the number of items in a container.',
      'range': 'range(stop) or range(start, stop, step)\n\nReturn an immutable sequence.',
      'numpy': 'NumPy:  The fundamental package for scientific computing with Python.',
      'np': 'NumPy: The fundamental package for scientific computing with Python.',
      'pandas': 'pandas:  Powerful data structures for data analysis.',
      'pd': 'pandas: Powerful data structures for data analysis.',
      'matplotlib': 'Matplotlib: Comprehensive library for creating visualizations.',
      'plt': 'matplotlib. pyplot: State-based interface to matplotlib.',
      'println': 'println([io:: IO], xs... )\n\nPrint objects to io followed by a newline.',
      'Plots': 'Plots. jl: Powerful convenience for visualization in Julia.',
    };

    const docText = docs[word];
    if (docText) {
      return {
        found: true,
        data: {
          'text/plain': docText,
        },
      };
    }

    return { found: false };
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Get kernel info by ID
   */
  getKernel(id: string): KernelInfo | undefined {
    return this.kernels.get(id)?.info;
  }

  /**
   * Check if a kernel exists
   */
  hasKernel(id:  string): boolean {
    return this.kernels.has(id);
  }

  /**
   * Get execution count for a kernel
   */
  getExecutionCount(id: string): number {
    return this.kernels.get(id)?.executionCount || 0;
  }

  /**
   * Shutdown all kernels
   */
  async shutdownAll(): Promise<void> {
    console.log(`[KernelManager] Shutting down ${this.kernels.size} kernel(s)`);
    const ids = Array.from(this.kernels.keys());
    for (const id of ids) {
      await this.stop(id);
    }
  }

  /**
   * Simulate async delay (for stub implementation)
   */
  private simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: KernelManager | null = null;

export function getKernelManager(): KernelManager {
  if (!instance) {
    instance = new KernelManager();
  }
  return instance;
}

export function resetKernelManager(): void {
  if (instance) {
    instance.shutdownAll();
    instance = null;
  }
}
```

### 2. `electron/main/index.ts`

Update to use the KernelManager:

```typescript
/**
 * IPC Handler Registration
 * 
 * Registers all IPC handlers for communication with the renderer. 
 * Kernel operations are delegated to the KernelManager class.
 */

import { ipcMain, app } from 'electron';
import {
  IPC,
  KernelInfo,
  KernelExecuteResult,
  KernelCompleteResult,
  KernelInspectResult,
  TreeNode,
  FileReadResult,
  Config,
} from './ipc';
import { getKernelManager, resetKernelManager } from './kernel-manager';

// ============================================================================
// Kernel Manager Instance
// ============================================================================

const kernelManager = getKernelManager();

// Cleanup on app quit
app.on('before-quit', async () => {
  console.log('[main] App quitting, shutting down kernels...');
  await kernelManager.shutdownAll();
});

// ============================================================================
// Kernel Handlers
// ============================================================================

ipcMain.handle(IPC. kernels. list, async (): Promise<KernelInfo[]> => {
  return kernelManager.list();
});

ipcMain.handle(IPC.kernels. start, async (_event, spec): Promise<KernelInfo> => {
  return kernelManager. start(spec);
});

ipcMain.handle(IPC. kernels.stop, async (_event, id): Promise<boolean> => {
  return kernelManager.stop(id);
});

ipcMain.handle(IPC.kernels.execute, async (_event, id, request): Promise<KernelExecuteResult> => {
  return kernelManager.execute(id, request);
});

ipcMain.handle(IPC.kernels. interrupt, async (_event, id): Promise<boolean> => {
  return kernelManager.interrupt(id);
});

ipcMain.handle(IPC.kernels.restart, async (_event, id): Promise<KernelInfo> => {
  return kernelManager.restart(id);
});

ipcMain.handle(IPC.kernels.complete, async (_event, id, code, cursorPos): Promise<KernelCompleteResult> => {
  return kernelManager.complete(id, code, cursorPos);
});

ipcMain.handle(IPC.kernels.inspect, async (_event, id, code, cursorPos): Promise<KernelInspectResult> => {
  return kernelManager.inspect(id, code, cursorPos);
});

// ============================================================================
// Tree Handlers (unchanged from Step 2)
// ============================================================================

ipcMain.handle(IPC. tree.list, async (_event, path): Promise<TreeNode[]> => {
  console.log('[IPC] tree: list', path);
  
  if (! path || path === '' || path === 'root') {
    return [
      { id: 'data', key: 'data', path: 'data', type: 'folder', hasChildren: true, expandable: true },
      { id: 'scripts', key: 'scripts', path: 'scripts', type: 'folder', hasChildren: true, expandable: true },
      { id: 'results', key: 'results', path: 'results', type: 'folder', hasChildren: true, expandable: true },
    ];
  }
  
  if (path === 'data') {
    return [
      { id: 'data. array1', key: 'array1', path: 'data. array1', type: 'ndarray', preview: 'float64 (100, 100)', hasChildren: false, shape: [100, 100], dtype: 'float64', sizeBytes: 80000 },
      { id: 'data.df1', key: 'df1', path: 'data.df1', type: 'dataframe', preview: 'DataFrame (1000 rows, 5 cols)', hasChildren: false, shape:  [1000, 5], sizeBytes: 40000 },
    ];
  }
  
  if (path === 'scripts') {
    return [
      { id: 'scripts.analysis', key: 'analysis. py', path: 'scripts. analysis', type: 'file', preview: 'Python script', hasChildren: false, sizeBytes: 2048 },
      { id: 'scripts.plot', key: 'plot.jl', path: 'scripts. plot', type: 'file', preview: 'Julia script', hasChildren: false, sizeBytes:  1024 },
    ];
  }
  
  if (path === 'results') {
    return [
      { id: 'results.fig1', key: 'figure1.png', path: 'results.fig1', type: 'image', preview: 'PNG image (800x600)', hasChildren: false, sizeBytes: 50000 },
      { id:  'results.config', key: 'config.json', path: 'results.config', type: 'json', preview: '{ "param1": 42, ...  }', hasChildren: false, sizeBytes: 512 },
    ];
  }
  
  return [];
});

ipcMain.handle(IPC.tree.get, async (_event, id, options): Promise<unknown> => {
  console.log('[IPC] tree:get', id, options);
  if (id === 'data. array1') {
    return { type: 'ndarray', shape: [100, 100], dtype: 'float64', data: '<<binary>>' };
  }
  if (id === 'data. df1') {
    return { type: 'dataframe', columns: ['a', 'b', 'c', 'd', 'e'], rows: 1000 };
  }
  return null;
});

ipcMain.handle(IPC.tree.save, async (_event, id, value): Promise<boolean> => {
  console.log('[IPC] tree:save', id, value);
  return true;
});

// ============================================================================
// File Handlers (unchanged from Step 2)
// ============================================================================

ipcMain.handle(IPC. files.read, async (_event, path, options): Promise<FileReadResult | null> => {
  console. log('[IPC] files:read', path, options);
  return {
    content: `# Stub content for ${path}\nprint("Hello, world!")`,
    size: 100,
    mtime: Date.now(),
  };
});

ipcMain.handle(IPC.files.write, async (_event, path, content): Promise<boolean> => {
  console.log('[IPC] files:write', path, typeof content === 'string' ? content. slice(0, 100) : '<binary>');
  return true;
});

// ============================================================================
// Config Handlers (unchanged from Step 2)
// ============================================================================

let currentConfig: Config = {
  kernelSpec: 'python3',
  plotMode: 'native',
  cwd: process.cwd(),
  trusted: false,
  recentProjects: [],
  customKernels: [],
};

ipcMain.handle(IPC.config.get, async (): Promise<Config> => {
  return currentConfig;
});

ipcMain.handle(IPC.config.set, async (_event, config): Promise<boolean> => {
  console.log('[IPC] config:set', config);
  currentConfig = { ...currentConfig, ...config };
  return true;
});

// ============================================================================

console.log('[main] IPC handlers registered');
```

### 3. `electron/main/init/python-init.py`

Update with proper placeholder logic:

```python
"""
Physics Data Viewer - Python Kernel Initialization

This file is executed when a Python kernel starts. 
It sets up the environment, configures plot backends, and defines helper functions.
"""

# =============================================================================
# Standard Imports (always available in namespace)
# =============================================================================

# Uncomment these once real kernel integration is done: 
# import sys
# import os
# import io
# import base64

# =============================================================================
# Matplotlib Backend Configuration
# =============================================================================

def _pdv_setup_matplotlib(capture_mode=False):
    """
    Configure matplotlib backend based on capture mode.
    
    Args:
        capture_mode:  If True, use Agg backend for image capture. 
                      If False, use interactive backend (Qt/MacOSX/Tk).
    """
    try:
        import matplotlib
        
        if capture_mode:
            # Non-interactive backend for capturing figures
            matplotlib.use('Agg')
            print("[PDV] Matplotlib backend:  Agg (capture mode)")
        else:
            # Try interactive backends in order of preference
            backends_to_try = ['QtAgg', 'Qt5Agg', 'MacOSX', 'TkAgg', 'Agg']
            
            for backend in backends_to_try:
                try:
                    matplotlib.use(backend)
                    print(f"[PDV] Matplotlib backend: {backend}")
                    break
                except Exception: 
                    continue
            else: 
                print("[PDV] Warning: No interactive matplotlib backend available")
                
    except ImportError:
        print("[PDV] Matplotlib not installed")

# =============================================================================
# Plot Capture Helper
# =============================================================================

def pdv_show(fig=None, fmt='png', dpi=100):
    """
    Capture a matplotlib figure and return it as base64 for display in PDV UI.
    
    Args:
        fig: The figure to capture.  If None, uses the current figure. 
        fmt: Output format ('png' or 'svg').
        dpi: Resolution for raster formats.
    
    Returns:
        dict: {'mime':  'image/png', 'data': '<base64 string>'}
    
    Example:
        >>> import matplotlib.pyplot as plt
        >>> plt.plot([1, 2, 3], [1, 4, 9])
        >>> pdv_show()  # Captures and returns the figure
    """
    try:
        import matplotlib. pyplot as plt
        import io
        import base64
        
        if fig is None:
            fig = plt.gcf()
        
        buf = io.BytesIO()
        fig.savefig(buf, format=fmt, dpi=dpi, bbox_inches='tight')
        buf.seek(0)
        data = base64.b64encode(buf.read()).decode('utf-8')
        buf.close()
        
        # Optionally close the figure to free memory
        # plt.close(fig)
        
        return {'mime': f'image/{fmt}', 'data': data}
        
    except ImportError:
        return {'error': 'matplotlib not installed'}
    except Exception as e:
        return {'error': str(e)}

# =============================================================================
# Data Inspection Helpers
# =============================================================================

def pdv_info(obj):
    """
    Get detailed information about an object for display in the Tree. 
    
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
        info['size'] = obj.nbytes if hasattr(obj, 'nbytes') else None
        info['preview'] = f"{obj.dtype} {tuple(obj.shape)}"
    
    # Pandas DataFrames
    elif hasattr(obj, 'columns') and hasattr(obj, 'index'):
        info['shape'] = list(obj.shape)
        info['columns'] = list(obj.columns)
        info['preview'] = f"DataFrame ({len(obj)} rows, {len(obj.columns)} cols)"
    
    # Pandas Series
    elif hasattr(obj, 'index') and hasattr(obj, 'dtype') and not hasattr(obj, 'columns'):
        info['shape'] = [len(obj)]
        info['dtype'] = str(obj.dtype)
        info['preview'] = f"Series ({len(obj)}) [{obj.dtype}]"
    
    # Lists, tuples, sets
    elif isinstance(obj, (list, tuple, set)):
        info['length'] = len(obj)
        info['preview'] = f"{type(obj).__name__} ({len(obj)} items)"
    
    # Dicts
    elif isinstance(obj, dict):
        info['length'] = len(obj)
        info['keys'] = list(obj.keys())[: 10]  # First 10 keys
        info['preview'] = f"dict ({len(obj)} items)"
    
    # Strings
    elif isinstance(obj, str):
        info['length'] = len(obj)
        info['preview'] = repr(obj[: 50]) + ('...' if len(obj) > 50 else '')
    
    # Numbers
    elif isinstance(obj, (int, float, complex)):
        info['preview'] = repr(obj)
    
    else:
        info['preview'] = repr(obj)[:100]
    
    return info

# =============================================================================
# Namespace Management
# =============================================================================

def pdv_namespace():
    """
    Get the current namespace as a dict suitable for the Tree view.
    Filters out private variables, modules, and built-ins.
    """
    import sys
    
    # Get the main namespace (this is a stub; real impl gets IPython's namespace)
    namespace = {}
    
    # Filter and process
    result = {}
    for name, obj in namespace.items():
        # Skip private and dunder names
        if name.startswith('_'):
            continue
        # Skip modules
        if isinstance(obj, type(sys)):
            continue
        # Skip callables (functions, classes) unless explicitly requested
        if callable(obj) and not hasattr(obj, 'shape'):
            continue
            
        result[name] = pdv_info(obj)
    
    return result

# =============================================================================
# Initialization
# =============================================================================

# Set up matplotlib with native windows by default
# _pdv_setup_matplotlib(capture_mode=False)

print("Physics Data Viewer Python kernel initialized.")
print("  - pdv_show(): Capture current figure")
print("  - pdv_info(obj): Get object metadata")
```

### 4. `electron/main/init/julia-init.jl`

Update with proper placeholder logic:

```julia
#=
Physics Data Viewer - Julia Kernel Initialization

This file is executed when a Julia kernel starts.
It sets up the environment, configures plot backends, and defines helper functions.
=#

# =============================================================================
# Plot Backend Configuration
# =============================================================================

"""
    _pdv_setup_plots(capture_mode:: Bool=false)

Configure Plots. jl backend based on capture mode. 

# Arguments
- `capture_mode`: If true, configure for image capture; otherwise use interactive display. 
"""
function _pdv_setup_plots(capture_mode::Bool=false)
    try
        using Plots
        
        if capture_mode
            # Use GR with no display for capturing
            gr(show=false)
            println("[PDV] Plots backend: GR (capture mode)")
        else
            # Use GR with interactive display
            gr()
            println("[PDV] Plots backend: GR (interactive)")
        end
    catch e
        println("[PDV] Plots. jl not installed: $e")
    end
end

# =============================================================================
# Plot Capture Helper
# =============================================================================

"""
    pdv_show(p=nothing; fmt=: png, dpi=100)

Capture a plot and return it as base64 for display in PDV UI.

# Arguments
- `p`: The plot to capture. If nothing, uses the current plot.
- `fmt`: Output format (`:png` or `:svg`).
- `dpi`: Resolution for raster formats. 

# Returns
- `Dict`: `{"mime" => "image/png", "data" => "<base64 string>"}`

# Example
```julia
using Plots
plot([1, 2, 3], [1, 4, 9])
pdv_show()  # Captures and returns the figure
```
"""
function pdv_show(p=nothing; fmt=:png, dpi=100)
    try
        using Plots
        using Base64
        
        if p === nothing
            p = Plots.current()
        end
        
        io = IOBuffer()
        savefig(p, io, fmt)
        data = base64encode(take!(io))
        
        return Dict("mime" => "image/$fmt", "data" => data)
        
    catch e
        return Dict("error" => string(e))
    end
end

# =============================================================================
# Data Inspection Helpers
# =============================================================================

"""
    pdv_info(obj)

Get detailed information about an object for display in the Tree.

# Returns
- `Dict`: Object metadata including type, shape, dtype, preview, etc. 
"""
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
    
    # DataFrames (if available)
    elseif hasproperty(obj, :columns) && hasproperty(obj, :nrow)
        info["shape"] = [obj.nrow, length(obj. columns)]
        info["columns"] = string.(obj.columns)
        info["preview"] = "DataFrame ($(obj.nrow) rows, $(length(obj.columns)) cols)"
    
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
    
    else
        info["preview"] = repr(obj)[1:min(100, end)]
    end
    
    return info
end

# =============================================================================
# Namespace Management
# =============================================================================

"""
    pdv_namespace()

Get the current namespace as a Dict suitable for the Tree view.
"""
function pdv_namespace()
    # This is a stub; real implementation would inspect Main module
    result = Dict{String, Any}()
    
    for name in names(Main, all=false, imported=false)
        # Skip private names
        startswith(string(name), "_") && continue
        
        try
            obj = getfield(Main, name)
            # Skip functions and modules
            obj isa Function && continue
            obj isa Module && continue
            
            result[string(name)] = pdv_info(obj)
        catch
            continue
        end
    end
    
    return result
end

# =============================================================================
# Revise. jl Integration (optional hot reload)
# =============================================================================

function _pdv_setup_revise()
    try
        using Revise
        println("[PDV] Revise. jl loaded - hot reload enabled")
    catch
        println("[PDV] Revise.jl not available - hot reload disabled")
    end
end

# =============================================================================
# Initialization
# =============================================================================

# Uncomment to enable Revise.jl:
# _pdv_setup_revise()

# Uncomment to set up Plots: 
# _pdv_setup_plots(capture_mode=false)

println("Physics Data Viewer Julia kernel initialized.")
println("  - pdv_show(): Capture current plot")
println("  - pdv_info(obj): Get object metadata")
```

### 5. `electron/main/kernel-manager.test.ts`

Create unit tests for the KernelManager:

```typescript
/**
 * KernelManager Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KernelManager, getKernelManager, resetKernelManager } from './kernel-manager';

describe('KernelManager', () => {
  let manager: KernelManager;

  beforeEach(() => {
    resetKernelManager();
    manager = new KernelManager();
  });

  afterEach(() => {
    resetKernelManager();
  });

  describe('Kernel Lifecycle', () => {
    it('should start with no kernels', async () => {
      const kernels = await manager.list();
      expect(kernels).toHaveLength(0);
    });

    it('should start a Python kernel', async () => {
      const kernel = await manager.start({ language: 'python' });
      
      expect(kernel.id).toBeDefined();
      expect(kernel.language).toBe('python');
      expect(kernel.status).toBe('idle');
      
      const kernels = await manager. list();
      expect(kernels).toHaveLength(1);
    });

    it('should start a Julia kernel', async () => {
      const kernel = await manager.start({ language: 'julia' });
      
      expect(kernel. id).toBeDefined();
      expect(kernel.language).toBe('julia');
      expect(kernel.status).toBe('idle');
    });

    it('should stop a kernel', async () => {
      const kernel = await manager.start();
      expect(await manager.list()).toHaveLength(1);
      
      const stopped = await manager.stop(kernel. id);
      expect(stopped).toBe(true);
      expect(await manager.list()).toHaveLength(0);
    });

    it('should restart a kernel', async () => {
      const kernel = await manager.start();
      const originalId = kernel.id;
      
      const restarted = await manager.restart(kernel.id);
      expect(restarted. id).toBe(originalId);
      expect(restarted.status).toBe('idle');
    });

    it('should handle stopping non-existent kernel', async () => {
      const stopped = await manager.stop('non-existent');
      expect(stopped).toBe(false);
    });

    it('should throw when restarting non-existent kernel', async () => {
      await expect(manager.restart('non-existent')).rejects.toThrow();
    });
  });

  describe('Code Execution', () => {
    it('should execute simple code', async () => {
      const kernel = await manager.start();
      const result = await manager.execute(kernel.id, { code: 'print("hello")' });
      
      expect(result. error).toBeUndefined();
      expect(result.stdout).toContain('hello');
      expect(result.duration).toBeDefined();
    });

    it('should evaluate expressions', async () => {
      const kernel = await manager.start();
      const result = await manager.execute(kernel.id, { code: '1 + 1' });
      
      expect(result.error).toBeUndefined();
      expect(result. result).toBe(2);
    });

    it('should return error for non-existent kernel', async () => {
      const result = await manager.execute('non-existent', { code: 'test' });
      expect(result. error).toBeDefined();
    });

    it('should handle capture mode', async () => {
      const kernel = await manager.start();
      const result = await manager. execute(kernel.id, { 
        code: 'plt.show()', 
        capture:  true 
      });
      
      // Stub returns image data when capture is true and code contains plt.show
      expect(result.images).toBeDefined();
    });
  });

  describe('Completions', () => {
    it('should return Python completions', async () => {
      const kernel = await manager.start({ language: 'python' });
      const result = await manager.complete(kernel.id, 'pri', 3);
      
      expect(result.matches).toContain('print');
      expect(result.cursor_start).toBe(0);
      expect(result.cursor_end).toBe(3);
    });

    it('should return Julia completions', async () => {
      const kernel = await manager.start({ language: 'julia' });
      const result = await manager.complete(kernel.id, 'print', 5);
      
      expect(result.matches).toContain('println');
    });

    it('should return empty for non-existent kernel', async () => {
      const result = await manager.complete('non-existent', 'test', 4);
      expect(result.matches).toHaveLength(0);
    });
  });

  describe('Inspection', () => {
    it('should return docs for known functions', async () => {
      const kernel = await manager.start({ language: 'python' });
      const result = await manager.inspect(kernel.id, 'print', 5);
      
      expect(result.found).toBe(true);
      expect(result.data?. ['text/plain']).toContain('print');
    });

    it('should return not found for unknown items', async () => {
      const kernel = await manager.start();
      const result = await manager. inspect(kernel.id, 'unknown_variable', 15);
      
      expect(result.found).toBe(false);
    });
  });

  describe('Singleton', () => {
    it('should return same instance from getKernelManager', () => {
      const instance1 = getKernelManager();
      const instance2 = getKernelManager();
      expect(instance1).toBe(instance2);
    });

    it('should reset singleton with resetKernelManager', async () => {
      const instance1 = getKernelManager();
      await instance1.start();
      expect(await instance1.list()).toHaveLength(1);
      
      resetKernelManager();
      
      const instance2 = getKernelManager();
      expect(instance2).not.toBe(instance1);
      expect(await instance2.list()).toHaveLength(0);
    });
  });
});
```

### 6. Update `electron/renderer/src/app/index.tsx`

Update the IPC test to use the new kernel lifecycle:

Find the `useEffect` block and replace it with:

```typescript
// Test IPC connection and kernel on mount
useEffect(() => {
  const testKernelManager = async () => {
    try {
      console.log('[App] Testing Kernel Manager...');
      
      // Start a kernel
      const kernel = await window.pdv.kernels.start({ language: 'python' });
      console.log('[App] Kernel started:', kernel);

      // List kernels
      const kernels = await window.pdv.kernels.list();
      console.log('[App] Running kernels:', kernels);

      // Execute code
      const result1 = await window.pdv. kernels.execute(kernel.id, { 
        code: 'print("Hello from PDV!")' 
      });
      console.log('[App] Execute result:', result1);

      // Execute expression
      const result2 = await window.pdv.kernels. execute(kernel.id, { 
        code: '2 + 2' 
      });
      console.log('[App] Expression result:', result2);

      // Test completions
      const completions = await window.pdv.kernels. complete(kernel.id, 'pri', 3);
      console.log('[App] Completions for "pri":', completions. matches);

      // Test inspection
      const inspection = await window.pdv.kernels.inspect(kernel.id, 'print', 5);
      console.log('[App] Inspection for "print":', inspection);

      // Get config
      const config = await window. pdv.config.get();
      console.log('[App] Config:', config);

      // Get tree nodes
      const treeNodes = await window.pdv.tree.list('');
      console.log('[App] Tree nodes:', treeNodes);

      console.log('[App] ✓ All IPC tests passed!');
      
    } catch (error) {
      console.error('[App] IPC test failed:', error);
    }
  };

  testKernelManager();
}, []);
```

---

## Exit Criteria

After completing this step, verify: 

1. **TypeScript compiles**: 
   ```bash
   cd electron
   npm run build
   ```
   Should complete without errors.

2. **Tests pass**:
   ```bash
   npm run test
   ```
   Should show all KernelManager tests passing (12+ tests).

3. **App launches**:
   ```bash
   npm run dev
   ```
   Electron window opens. 

4. **Kernel lifecycle works**:
   Open DevTools console and verify the test output: 
   ```
   [App] Testing Kernel Manager...
   [App] Kernel started: {id: 'kernel-... ', language: 'python', status: 'idle', ...}
   [App] Running kernels: [{... }]
   [App] Execute result: {stdout: 'Hello from PDV! ', duration: ... }
   [App] Expression result: {result: 4, duration: ...}
   [App] Completions for "pri": ['print']
   [App] Inspection for "print": {found: true, data: {... }}
   [App] ✓ All IPC tests passed!
   ```

5. **Main process logs**:
   Check the terminal for kernel manager logs: 
   ```
   [KernelManager] Initialized with default specs:  ['python3', 'julia']
   [KernelManager] Starting kernel: kernel-...  (python)
   [KernelManager] Kernel ready: kernel-... 
   [KernelManager] Execute [1] on kernel-.. .: print("Hello from PDV!")
   [KernelManager] Execute [2] on kernel-...: 2 + 2
   [KernelManager] Complete on kernel-...  at position 3
   [KernelManager] Inspect on kernel-... at position 5
   ```

6. **Init cells are loaded**:
   The kernel stdout should include:
   ```
   Physics Data Viewer Python kernel initialized.
   ```

---

## Files to Create/Modify (Checklist)

- [ ] `electron/main/kernel-manager.ts` — Full KernelManager implementation
- [ ] `electron/main/index.ts` — Updated to use KernelManager
- [ ] `electron/main/init/python-init.py` — Updated with helper functions
- [ ] `electron/main/init/julia-init. jl` — Updated with helper functions
- [ ] `electron/main/kernel-manager.test.ts` — NEW:  Unit tests
- [ ] `electron/renderer/src/app/index.tsx` — Updated IPC test

---

## Notes

- The KernelManager is still a stub; it simulates kernel behavior without real Jupyter integration. 
- Real `@jupyterlab/services` integration will be added in a future step.
- The init cells define helper functions (`pdv_show`, `pdv_info`) that will be useful when real kernels are connected.
- The singleton pattern (`getKernelManager`/`resetKernelManager`) makes testing easier and ensures only one instance manages kernels. 
- Kernel cleanup happens automatically on app quit via the `before-quit` handler.
