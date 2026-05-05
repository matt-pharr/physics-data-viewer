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
    onKernelCrashed: (callback) => onPush(IPC.push.kernelCrashed, callback),
    onReconnected: (callback) => onPush(IPC.push.kernelReconnected, callback),
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
    createGui: (kernelId, targetPath, guiName) =>
      ipcRenderer.invoke(IPC.tree.createGui, kernelId, targetPath, guiName),
    createLib: (kernelId, targetPath, libName) =>
      ipcRenderer.invoke(IPC.tree.createLib, kernelId, targetPath, libName),
    createNode: (kernelId, targetPath, nodeName) =>
      ipcRenderer.invoke(IPC.tree.createNode, kernelId, targetPath, nodeName),
    rename: (kernelId, treePath, newName) =>
      ipcRenderer.invoke(IPC.tree.rename, kernelId, treePath, newName),
    move: (kernelId, treePath, newPath) =>
      ipcRenderer.invoke(IPC.tree.move, kernelId, treePath, newPath),
    duplicate: (kernelId, treePath, newPath) =>
      ipcRenderer.invoke(IPC.tree.duplicate, kernelId, treePath, newPath),
    addFile: (kernelId, sourcePath, targetTreePath, nodeType, filename) =>
      ipcRenderer.invoke(IPC.tree.addFile, kernelId, sourcePath, targetTreePath, nodeType, filename),
    invokeHandler: (kernelId, nodePath) =>
      ipcRenderer.invoke(IPC.tree.invokeHandler, kernelId, nodePath),
    delete: (kernelId, treePath) =>
      ipcRenderer.invoke(IPC.tree.delete, kernelId, treePath),
    onChanged: (callback) => onPush(IPC.push.treeChanged, callback),
  },
  namespace: {
    query: (kernelId, options) =>
      ipcRenderer.invoke(IPC.namespace.query, kernelId, options),
    inspect: (kernelId, target) =>
      ipcRenderer.invoke(IPC.namespace.inspect, kernelId, target),
  },
  script: {
    run: (kernelId, request) =>
      ipcRenderer.invoke(IPC.script.run, kernelId, request),
    edit: (kernelId, scriptPath) =>
      ipcRenderer.invoke(IPC.script.edit, kernelId, scriptPath),
    getParams: (kernelId, treePath) =>
      ipcRenderer.invoke(IPC.script.getParams, kernelId, treePath),
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
  environment: {
    list: () => ipcRenderer.invoke(IPC.environment.list),
    check: (pythonPath) => ipcRenderer.invoke(IPC.environment.check, pythonPath),
    install: (pythonPath) => ipcRenderer.invoke(IPC.environment.install, pythonPath),
    refresh: () => ipcRenderer.invoke(IPC.environment.refresh),
    onInstallOutput: (callback) => onPush(IPC.push.installOutput, callback),
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
    uninstall: (moduleId) => ipcRenderer.invoke(IPC.modules.uninstall, moduleId),
    update: (moduleId) => ipcRenderer.invoke(IPC.modules.update, moduleId),
    createEmpty: (request) => ipcRenderer.invoke(IPC.modules.createEmpty, request),
    updateMetadata: (request) => ipcRenderer.invoke(IPC.modules.updateMetadata, request),
    exportFromProject: (request) => ipcRenderer.invoke(IPC.modules.exportFromProject, request),
  },
  project: {
    save: (saveDir, codeCells, projectName) =>
      ipcRenderer.invoke(IPC.project.save, saveDir, codeCells, projectName),
    load: (saveDir, options) => ipcRenderer.invoke(IPC.project.load, saveDir, options),
    new: () => ipcRenderer.invoke(IPC.project.new),
    peekLanguages: (paths) =>
      ipcRenderer.invoke(IPC.project.peekLanguages, paths),
    peekManifest: (dir) =>
      ipcRenderer.invoke(IPC.project.peekManifest, dir),
    onLoaded: (callback) => onPush(IPC.push.projectLoaded, callback),
    onReloading: (callback) => onPush(IPC.push.projectReloading, callback),
  },
  progress: {
    onProgress: (callback) => onPush(IPC.push.progress, callback),
  },
  config: {
    get: () => ipcRenderer.invoke(IPC.config.get),
    set: (updates) => ipcRenderer.invoke(IPC.config.set, updates),
  },
  autosave: {
    run: (codeCells: unknown) => ipcRenderer.invoke(IPC.autosave.run, codeCells),
    clear: (dir?: string) => ipcRenderer.invoke(IPC.autosave.clear, dir),
    check: (dir: string) => ipcRenderer.invoke(IPC.autosave.check, dir),
    scanWorkingDirs: () => ipcRenderer.invoke(IPC.autosave.scanWorkingDirs),
    recoverUnsaved: (orphanDir: string) => ipcRenderer.invoke(IPC.autosave.recoverUnsaved, orphanDir),
    deleteOrphan: (orphanDir: string) => ipcRenderer.invoke(IPC.autosave.deleteOrphan, orphanDir),
    onTrigger: (cb: () => void) => onPush(IPC.push.autosaveTrigger, cb),
  },
  about: {
    getVersion: () => ipcRenderer.invoke(IPC.about.getVersion),
  },
  updater: {
    checkForUpdates: () => ipcRenderer.invoke(IPC.updater.checkForUpdates),
    downloadUpdate: () => ipcRenderer.invoke(IPC.updater.downloadUpdate),
    installUpdate: () => ipcRenderer.invoke(IPC.updater.installUpdate),
    openReleasesPage: () => ipcRenderer.invoke(IPC.updater.openReleasesPage),
    getStatus: () => ipcRenderer.invoke(IPC.updater.getStatus),
    onUpdateStatus: (cb) => onPush(IPC.push.updateStatus, cb),
  },
  themes: {
    get: () => ipcRenderer.invoke(IPC.themes.get),
    save: (theme) => ipcRenderer.invoke(IPC.themes.save, theme),
    openDir: () => ipcRenderer.invoke(IPC.themes.openDir),
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
  guiEditor: {
    open: (req) => ipcRenderer.invoke(IPC.guiEditor.open, req),
    openViewer: (req) => ipcRenderer.invoke(IPC.guiEditor.openViewer, req),
    context: () => ipcRenderer.invoke(IPC.guiEditor.context),
    read: (treePath) => ipcRenderer.invoke(IPC.guiEditor.read, treePath),
    save: (req) => ipcRenderer.invoke(IPC.guiEditor.save, req),
  },
  files: {
    pickExecutable: () => ipcRenderer.invoke(IPC.files.pickExecutable),
    pickFile: () => ipcRenderer.invoke(IPC.files.pickFile),
    pickDirectory: (defaultPath) => ipcRenderer.invoke(IPC.files.pickDirectory, defaultPath),
  },
  menu: {
    updateRecentProjects: (paths) =>
      ipcRenderer.invoke(IPC.menu.updateRecentProjects, paths),
    updateEnabled: (state) =>
      ipcRenderer.invoke(IPC.menu.updateEnabled, state),
    getModel: () => ipcRenderer.invoke(IPC.menu.getModel),
    popup: (menuId, x, y) => ipcRenderer.invoke(IPC.menu.popup, menuId, x, y),
    onAction: (callback) => onPush(IPC.push.menuAction, callback),
  },
  chrome: {
    getInfo: () => ipcRenderer.invoke(IPC.chrome.getInfo),
    minimize: () => ipcRenderer.invoke(IPC.chrome.minimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.chrome.toggleMaximize),
    close: () => ipcRenderer.invoke(IPC.chrome.close),
    onStateChanged: (callback) => onPush(IPC.push.chromeStateChanged, callback),
  },
  app: {
    confirmClose: () => ipcRenderer.invoke(IPC.app.confirmClose),
    onRequestClose: (callback) => onPush<void>(IPC.push.requestClose, callback),
  },
};

contextBridge.exposeInMainWorld("pdv", api);

declare global {
  interface Window {
    /** Typed preload bridge available in the renderer process. */
    pdv: PDVApi;
  }
}
