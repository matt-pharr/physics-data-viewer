/**
 * Preload Script
 * 
 * Exposes a safe, typed IPC bridge to the renderer process.
 * The renderer accesses this via window.pdv. 
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
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
} from './main/ipc';

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
