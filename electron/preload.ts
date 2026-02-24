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
  Theme,
  LspServerInfo,
  LspServerStatus,
  LspUserConfig,
} from './main/ipc';

// IPC channel names are duplicated here to keep preload runtime isolated from
// main-process module loading concerns.
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
  themes: {
    get: 'themes:get',
    save: 'themes:save',
  },
  settings: {
    open: 'settings:open',
  },
  commandBoxes: {
    load: 'commandBoxes:load',
    save: 'commandBoxes:save',
  },
  lsp: {
    list: 'lsp:list',
    detect: 'lsp:detect',
    connect: 'lsp:connect',
    disconnect: 'lsp:disconnect',
    status: 'lsp:status',
    configure: 'lsp:configure',
    stateChange: 'lsp:state-change',
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

    watch: (path: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.files.watch, path),

    unwatch: (path: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.files.unwatch, path),
  },

  config: {
    get: (): Promise<Config> =>
      ipcRenderer.invoke(IPC.config.get),

    set: (config: Partial<Config>): Promise<boolean> =>
      ipcRenderer.invoke(IPC.config.set, config),
  },

  themes: {
    get: (): Promise<Theme[]> =>
      ipcRenderer.invoke(IPC.themes.get),
    save: (theme: Theme): Promise<boolean> =>
      ipcRenderer.invoke(IPC.themes.save, theme),
  },

  settings: {
    onOpen: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC.settings.open, handler);
      return () => {
        ipcRenderer.removeListener(IPC.settings.open, handler);
      };
    },
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

  lsp: {
    list: (): Promise<LspServerInfo[]> =>
      ipcRenderer.invoke(IPC.lsp.list),

    detect: (languageId: string): Promise<LspServerStatus> =>
      ipcRenderer.invoke(IPC.lsp.detect, languageId),

    connect: (languageId: string): Promise<LspServerStatus> =>
      ipcRenderer.invoke(IPC.lsp.connect, languageId),

    disconnect: (languageId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.lsp.disconnect, languageId),

    status: (languageId: string): Promise<LspServerStatus> =>
      ipcRenderer.invoke(IPC.lsp.status, languageId),

    configure: (languageId: string, config: Partial<LspUserConfig>): Promise<boolean> =>
      ipcRenderer.invoke(IPC.lsp.configure, languageId, config),

    onStateChange: (callback: (status: LspServerStatus) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LspServerStatus) => callback(status);
      ipcRenderer.on(IPC.lsp.stateChange, handler);
      return () => {
        ipcRenderer.removeListener(IPC.lsp.stateChange, handler);
      };
    },
  },
};

// Expose the API to the renderer
contextBridge.exposeInMainWorld('pdv', api);

console.log('[preload] IPC bridge exposed as window.pdv');
