/**
 * IPC Handler Registration
 * 
 * Registers all IPC handlers for communication with the renderer.
 * Currently uses stub implementations; real implementations come in later steps.
 */

import { ipcMain } from 'electron';
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

// ============================================================================
// Stub Data
// ============================================================================

const stubKernel: KernelInfo = {
  id: 'stub-kernel-1',
  name: 'python3',
  language: 'python',
  status: 'idle',
};

const stubConfig: Config = {
  kernelSpec: 'python3',
  plotMode: 'native',
  cwd: process.cwd(),
  trusted: false,
  recentProjects: [],
  customKernels: [],
};

const stubTreeNodes: TreeNode[] = [
  {
    id: 'root',
    key: 'root',
    path: '',
    type: 'root',
    hasChildren: true,
    expandable: true,
  },
];

// ============================================================================
// Kernel Handlers
// ============================================================================

if (!ipcMain || typeof ipcMain.handle !== 'function') {
  console.warn('[main] ipcMain not available; skipping IPC handler registration');
} else {
  ipcMain.handle(IPC.kernels.list, async (): Promise<KernelInfo[]> => {
    console.log('[IPC] kernels:list');
    return [stubKernel];
  });

  ipcMain.handle(IPC.kernels.start, async (_event, spec): Promise<KernelInfo> => {
    console.log('[IPC] kernels:start', spec);
    return { ...stubKernel, id: `kernel-${Date.now()}` };
  });

  ipcMain.handle(IPC.kernels.stop, async (_event, id): Promise<boolean> => {
    console.log('[IPC] kernels:stop', id);
    return true;
  });

  ipcMain.handle(IPC.kernels.execute, async (_event, id, request): Promise<KernelExecuteResult> => {
    console.log('[IPC] kernels:execute', id, request);
    const start = Date.now();
    
    // Stub: echo back the code and return a mock result
    return {
      stdout: `[stub] Executed: ${request.code}`,
      stderr: undefined,
      result: request.code.includes('1+1') ? 2 : null,
      images: request.capture ? [] : undefined,
      error: undefined,
      duration: Date.now() - start,
    };
  });

  ipcMain.handle(IPC.kernels.interrupt, async (_event, id): Promise<boolean> => {
    console.log('[IPC] kernels:interrupt', id);
    return true;
  });

  ipcMain.handle(IPC.kernels.restart, async (_event, id): Promise<KernelInfo> => {
    console.log('[IPC] kernels:restart', id);
    return stubKernel;
  });

  ipcMain.handle(IPC.kernels.complete, async (_event, id, code, cursorPos): Promise<KernelCompleteResult> => {
    console.log('[IPC] kernels:complete', id, code, cursorPos);
    return {
      matches: [],
      cursor_start: cursorPos,
      cursor_end: cursorPos,
    };
  });

  ipcMain.handle(IPC.kernels.inspect, async (_event, id, code, cursorPos): Promise<KernelInspectResult> => {
    console.log('[IPC] kernels:inspect', id, code, cursorPos);
    return { found: false };
  });

  // ============================================================================
  // Tree Handlers
  // ============================================================================

  ipcMain.handle(IPC.tree.list, async (_event, path): Promise<TreeNode[]> => {
    console.log('[IPC] tree:list', path);
    
    // Return different stub data based on path
    if (!path || path === '' || path === 'root') {
      return [
        {
          id: 'data',
          key: 'data',
          path: 'data',
          type: 'folder',
          hasChildren: true,
          expandable: true,
        },
        {
          id: 'scripts',
          key: 'scripts',
          path: 'scripts',
          type: 'folder',
          hasChildren: true,
          expandable: true,
        },
        {
          id: 'results',
          key: 'results',
          path: 'results',
          type: 'folder',
          hasChildren: true,
          expandable: true,
        },
      ];
    }
    
    if (path === 'data') {
      return [
        {
          id: 'data.array1',
          key: 'array1',
          path: 'data.array1',
          type: 'ndarray',
          preview: 'float64 (100, 100)',
          hasChildren: false,
          shape: [100, 100],
          dtype: 'float64',
          sizeBytes: 80000,
        },
        {
          id: 'data.df1',
          key: 'df1',
          path: 'data.df1',
          type: 'dataframe',
          preview: 'DataFrame (1000 rows, 5 cols)',
          hasChildren: false,
          shape: [1000, 5],
          sizeBytes: 40000,
        },
      ];
    }
    
    if (path === 'scripts') {
      return [
        {
          id: 'scripts.analysis',
          key: 'analysis.py',
          path: 'scripts.analysis',
          type: 'file',
          preview: 'Python script',
          hasChildren: false,
          sizeBytes: 2048,
        },
        {
          id: 'scripts.plot',
          key: 'plot.jl',
          path: 'scripts.plot',
          type: 'file',
          preview: 'Julia script',
          hasChildren: false,
          sizeBytes: 1024,
        },
      ];
    }
    
    if (path === 'results') {
      return [
        {
          id: 'results.fig1',
          key: 'figure1.png',
          path: 'results.fig1',
          type: 'image',
          preview: 'PNG image (800x600)',
          hasChildren: false,
          sizeBytes: 50000,
        },
        {
          id: 'results.config',
          key: 'config.json',
          path: 'results.config',
          type: 'json',
          preview: '{"param1": 42, ...}',
          hasChildren: false,
          sizeBytes: 512,
        },
      ];
    }
    
    return [];
  });

  ipcMain.handle(IPC.tree.get, async (_event, id, options): Promise<unknown> => {
    console.log('[IPC] tree:get', id, options);
    
    // Return stub data based on ID
    if (id === 'data.array1') {
      return { type: 'ndarray', shape: [100, 100], dtype: 'float64', data: '<<binary>>' };
    }
    if (id === 'data.df1') {
      return { type: 'dataframe', columns: ['a', 'b', 'c', 'd', 'e'], rows: 1000 };
    }
    
    return null;
  });

  ipcMain.handle(IPC.tree.save, async (_event, id, value): Promise<boolean> => {
    console.log('[IPC] tree:save', id, value);
    return true;
  });

  // ============================================================================
  // File Handlers
  // ============================================================================

  ipcMain.handle(IPC.files.read, async (_event, path, options): Promise<FileReadResult | null> => {
    console.log('[IPC] files:read', path, options);
    
    // Stub: return mock file content
    return {
      content: `# Stub content for ${path}\nprint(\"Hello, world!\")`,
      size: 100,
      mtime: Date.now(),
    };
  });

  ipcMain.handle(IPC.files.write, async (_event, path, content): Promise<boolean> => {
    console.log('[IPC] files:write', path, typeof content === 'string' ? content.slice(0, 100) : '<binary>');
    return true;
  });

  // ============================================================================
  // Config Handlers
  // ============================================================================

  let currentConfig = { ...stubConfig };

  ipcMain.handle(IPC.config.get, async (): Promise<Config> => {
    console.log('[IPC] config:get');
    return currentConfig;
  });

  ipcMain.handle(IPC.config.set, async (_event, config): Promise<boolean> => {
    console.log('[IPC] config:set', config);
    currentConfig = { ...currentConfig, ...config };
    return true;
  });

  // ============================================================================

  console.log('[main] IPC handlers registered');
}
