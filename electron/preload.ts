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
  ScriptRunRequest,
  ScriptRunResult,
  ScriptParameter,
  CommandBoxData,
  Settings,
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
    create_script: 'tree:create_script',
  },
  script: {
    run: 'script:run',
    edit: 'script:edit',
    reload: 'script:reload',
    get_params: 'script:get_params',
  },
  files: {
    read: 'files:read',
    write: 'files:write',
    pickExecutable: 'files:pickExecutable',
    watch: 'files:watch',
    unwatch: 'files:unwatch',
  },
  namespace: {
    query: 'namespace:query',
  },
  config: {
    get: 'config:get',
    set: 'config:set',
  },
  commandBoxes: {
    load: 'commandBoxes:load',
    save: 'commandBoxes:save',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
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
    list: (kernelId: string, path?: string): Promise<TreeNode[]> =>
      ipcRenderer.invoke(IPC.tree.list, kernelId, path),

    get: (id: string, options?: TreeGetOptions): Promise<unknown> =>
      ipcRenderer.invoke(IPC.tree.get, id, options),

    save: (id: string, value: unknown): Promise<boolean> =>
      ipcRenderer.invoke(IPC.tree.save, id, value),

    createScript: (
      kernelId: string,
      targetPath: string,
      scriptName: string,
    ): Promise<{ success: boolean; error?: string; node?: TreeNode }> =>
      ipcRenderer.invoke(IPC.tree.create_script, kernelId, targetPath, scriptName),
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

  script: {
    run: (kernelId: string, request: ScriptRunRequest): Promise<ScriptRunResult> =>
      ipcRenderer.invoke(IPC.script.run, kernelId, request),
    edit: (scriptPath: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.script.edit, scriptPath),
    reload: (scriptPath: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.script.reload, scriptPath),
    getParams: (
      scriptPath: string,
    ): Promise<{ success: boolean; params?: ScriptParameter[]; error?: string }> =>
      ipcRenderer.invoke(IPC.script.get_params, scriptPath),
  },

  commandBoxes: {
    load: (): Promise<CommandBoxData | null> =>
      ipcRenderer.invoke(IPC.commandBoxes.load),
    save: (data: CommandBoxData): Promise<boolean> =>
      ipcRenderer.invoke(IPC.commandBoxes.save, data),
  },

  settings: {
    get: (): Promise<Settings> =>
      ipcRenderer.invoke(IPC.settings.get),
    set: (settings: Partial<Settings>): Promise<boolean> =>
      ipcRenderer.invoke(IPC.settings.set, settings),
    onOpenSettings: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('open-settings', handler);
      return () => ipcRenderer.removeListener('open-settings', handler);
    },
  },
};

// Expose the API to the renderer
contextBridge.exposeInMainWorld('pdv', api);

console.log('[preload] IPC bridge exposed as window.pdv');
