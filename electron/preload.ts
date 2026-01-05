/**
 * Preload Script
 * 
 * Exposes a safe, typed IPC bridge to the renderer process.
 * The renderer accesses this via window.pdv. 
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  KernelSpec,
  KernelInfo,
  KernelExecuteRequest,
  KernelExecuteResult,
  KernelCompleteResult,
  KernelInspectResult,
  TreeNode,
  TreeGetOptions,
  FileReadOptions,
  FileReadResult,
  Config,
  PDVApi,
  NamespaceQueryOptions,
  NamespaceVariable,
} from './main/ipc';

// IPC channel names (duplicated here to avoid runtime imports in preload context)
const IPC = {
  kernels: {
    list: 'kernels:list',
    start: 'kernels:start',
    stop: 'kernels:stop',
    execute: 'kernels:execute',
    interrupt: 'kernels:interrupt',
    restart: 'kernels:restart',
    complete: 'kernels:complete',
    inspect: 'kernels:inspect',
    validate: 'kernels:validate',
  },
  tree: {
    list: 'tree:list',
    get: 'tree:get',
    save: 'tree:save',
  },
  files: {
    read: 'files:read',
    write: 'files:write',
    pickExecutable: 'files:pickExecutable',
  },
  namespace: {
    query: 'namespace:query',
  },
  config: {
    get: 'config:get',
    set: 'config:set',
  },
} as const;

const api: PDVApi = {
  kernels: {
    list: (): Promise<KernelInfo[]> =>
      ipcRenderer.invoke(IPC.kernels.list),

    start: (spec?: Partial<KernelSpec>): Promise<KernelInfo> =>
      ipcRenderer.invoke(IPC.kernels.start, spec),

    stop: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.kernels.stop, id),

    execute: (id: string, request: KernelExecuteRequest): Promise<KernelExecuteResult> =>
      ipcRenderer.invoke(IPC.kernels.execute, id, request),

    interrupt: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.kernels.interrupt, id),

    restart: (id: string): Promise<KernelInfo> =>
      ipcRenderer.invoke(IPC.kernels.restart, id),

    complete: (id: string, code: string, cursorPos: number): Promise<KernelCompleteResult> =>
      ipcRenderer.invoke(IPC.kernels.complete, id, code, cursorPos),

    inspect: (id: string, code: string, cursorPos: number): Promise<KernelInspectResult> =>
      ipcRenderer.invoke(IPC.kernels.inspect, id, code, cursorPos),

    validate: (path: string, language: 'python' | 'julia'): Promise<{ valid: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.kernels.validate, path, language),
  },

  namespace: {
    query: (
      kernelId: string,
      options?: NamespaceQueryOptions,
    ): Promise<{ variables?: NamespaceVariable[]; error?: string }> =>
      ipcRenderer.invoke(IPC.namespace.query, kernelId, options),
  },

  tree: {
    list: (path?: string): Promise<TreeNode[]> =>
      ipcRenderer.invoke(IPC.tree.list, path),

    get: (id: string, options?: TreeGetOptions): Promise<unknown> =>
      ipcRenderer.invoke(IPC.tree.get, id, options),

    save: (id: string, value: unknown): Promise<boolean> =>
      ipcRenderer.invoke(IPC.tree.save, id, value),
  },

  files: {
    read: (path: string, options?: FileReadOptions): Promise<FileReadResult | null> =>
      ipcRenderer.invoke(IPC.files.read, path, options),

    write: (path: string, content: string | ArrayBuffer): Promise<boolean> =>
      ipcRenderer.invoke(IPC.files.write, path, content),

    pickExecutable: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.files.pickExecutable),
  },

  config: {
    get: (): Promise<Config> =>
      ipcRenderer.invoke(IPC.config.get),

    set: (config: Partial<Config>): Promise<boolean> =>
      ipcRenderer.invoke(IPC.config.set, config),
  },
};

// Expose the API to the renderer
contextBridge.exposeInMainWorld('pdv', api);

console.log('[preload] IPC bridge exposed as window.pdv');
