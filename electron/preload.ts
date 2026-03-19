/**
 * preload.ts — Typed renderer bridge (`window.pdv`).
 *
 * Exposes a strictly-scoped API surface to the renderer via
 * `contextBridge.exposeInMainWorld("pdv", ...)`. The renderer does not access
 * Node.js/Electron APIs directly; all IPC goes through this bridge.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.1, §11.2
 * main/ipc.ts — IPC channel and API type source of truth
 */

import { contextBridge, ipcRenderer } from "electron";
import { IPC, type PDVApi } from "./main/ipc";

/**
 * Register an IPC push listener and return an unsubscribe callback.
 *
 * @param channel - IPC push channel name.
 * @param callback - Renderer callback invoked with push payload.
 * @returns Function that removes the registered listener.
 */
function onPush<TPayload>(
  channel: string,
  callback: (payload: TPayload) => void
): () => void {
  const listener = (_event: unknown, payload: TPayload): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * Concrete implementation of the preload API contract.
 */
const api: PDVApi = {
  kernels: {
    list: () => ipcRenderer.invoke(IPC.kernels.list),
    start: (spec) => ipcRenderer.invoke(IPC.kernels.start, spec),
    stop: (kernelId) => ipcRenderer.invoke(IPC.kernels.stop, kernelId),
    execute: (kernelId, request) =>
      ipcRenderer.invoke(IPC.kernels.execute, kernelId, request),
    interrupt: (kernelId) => ipcRenderer.invoke(IPC.kernels.interrupt, kernelId),
    restart: (kernelId) => ipcRenderer.invoke(IPC.kernels.restart, kernelId),
    complete: (kernelId, code, cursorPos) =>
      ipcRenderer.invoke(IPC.kernels.complete, kernelId, code, cursorPos),
    inspect: (kernelId, code, cursorPos) =>
      ipcRenderer.invoke(IPC.kernels.inspect, kernelId, code, cursorPos),
    validate: (executablePath, language) =>
      ipcRenderer.invoke(IPC.kernels.validate, executablePath, language),
    onOutput: (callback) => onPush(IPC.push.executeOutput, callback),
    onKernelStatus: (callback) => onPush(IPC.push.kernelStatus, callback),
  },
  tree: {
    list: (kernelId, nodePath = "") =>
      ipcRenderer.invoke(IPC.tree.list, kernelId, nodePath),
    get: (kernelId, nodePath) =>
      ipcRenderer.invoke(IPC.tree.get, kernelId, nodePath),
    createScript: (kernelId, targetPath, scriptName) =>
      ipcRenderer.invoke(IPC.tree.createScript, kernelId, targetPath, scriptName),
    createNote: (kernelId, targetPath, noteName) =>
      ipcRenderer.invoke(IPC.tree.createNote, kernelId, targetPath, noteName),
    addFile: (kernelId, sourcePath, targetTreePath, nodeType, filename) =>
      ipcRenderer.invoke(IPC.tree.addFile, kernelId, sourcePath, targetTreePath, nodeType, filename),
    invokeHandler: (kernelId, nodePath) =>
      ipcRenderer.invoke(IPC.tree.invokeHandler, kernelId, nodePath),
    onChanged: (callback) => onPush(IPC.push.treeChanged, callback),
  },
  namespace: {
    query: (kernelId, options) =>
      ipcRenderer.invoke(IPC.namespace.query, kernelId, options),
  },
  script: {
    edit: (kernelId, scriptPath) =>
      ipcRenderer.invoke(IPC.script.edit, kernelId, scriptPath),
  },
  note: {
    save: (kernelId, treePath, content) =>
      ipcRenderer.invoke(IPC.note.save, kernelId, treePath, content),
    read: (kernelId, treePath) =>
      ipcRenderer.invoke(IPC.note.read, kernelId, treePath),
  },
  namelist: {
    read: (kernelId, treePath) =>
      ipcRenderer.invoke(IPC.namelist.read, kernelId, treePath),
    write: (kernelId, treePath, data) =>
      ipcRenderer.invoke(IPC.namelist.write, kernelId, treePath, data),
  },
  modules: {
    listInstalled: () => ipcRenderer.invoke(IPC.modules.listInstalled),
    install: (request) => ipcRenderer.invoke(IPC.modules.install, request),
    checkUpdates: (moduleId) => ipcRenderer.invoke(IPC.modules.checkUpdates, moduleId),
    importToProject: (request) =>
      ipcRenderer.invoke(IPC.modules.importToProject, request),
    listImported: () => ipcRenderer.invoke(IPC.modules.listImported),
    saveSettings: (request) => ipcRenderer.invoke(IPC.modules.saveSettings, request),
    runAction: (request) => ipcRenderer.invoke(IPC.modules.runAction, request),
    removeImport: (moduleAlias) => ipcRenderer.invoke(IPC.modules.removeImport, moduleAlias),
  },
  project: {
    save: (saveDir, codeCells) =>
      ipcRenderer.invoke(IPC.project.save, saveDir, codeCells),
    load: (saveDir) => ipcRenderer.invoke(IPC.project.load, saveDir),
    new: () => ipcRenderer.invoke(IPC.project.new),
    onLoaded: (callback) => onPush(IPC.push.projectLoaded, callback),
    onReloading: (callback) => onPush(IPC.push.projectReloading, callback),
  },
  config: {
    get: () => ipcRenderer.invoke(IPC.config.get),
    set: (updates) => ipcRenderer.invoke(IPC.config.set, updates),
  },
  about: {
    getVersion: () => ipcRenderer.invoke(IPC.about.getVersion),
  },
  themes: {
    get: () => ipcRenderer.invoke(IPC.themes.get),
    save: (theme) => ipcRenderer.invoke(IPC.themes.save, theme),
  },
  codeCells: {
    load: () => ipcRenderer.invoke(IPC.codeCells.load),
    save: (data) => ipcRenderer.invoke(IPC.codeCells.save, data),
  },
  moduleWindows: {
    open: (req) => ipcRenderer.invoke(IPC.moduleWindows.open, req),
    close: (alias) => ipcRenderer.invoke(IPC.moduleWindows.close, alias),
    context: () => ipcRenderer.invoke(IPC.moduleWindows.context),
    executeInMain: (code) => ipcRenderer.invoke(IPC.moduleWindows.executeInMain, code),
    onExecuteRequest: (cb) => onPush(IPC.push.moduleExecuteRequest, cb),
  },
  files: {
    pickExecutable: () => ipcRenderer.invoke(IPC.files.pickExecutable),
    pickFile: () => ipcRenderer.invoke(IPC.files.pickFile),
    pickDirectory: () => ipcRenderer.invoke(IPC.files.pickDirectory),
  },
  menu: {
    updateRecentProjects: (paths) =>
      ipcRenderer.invoke(IPC.menu.updateRecentProjects, paths),
    onAction: (callback) => onPush(IPC.push.menuAction, callback),
  },
};

contextBridge.exposeInMainWorld("pdv", api);

declare global {
  interface Window {
    /** Typed preload bridge available in the renderer process. */
    pdv: PDVApi;
  }
}
