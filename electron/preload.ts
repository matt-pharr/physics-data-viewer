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
import {
  DEFAULT_PYTHON_VERSION,
  SUPPORTED_PYTHON_VERSIONS,
} from "./main/python-versions";
import {
  DEFAULT_JULIA_VERSION,
  SUPPORTED_JULIA_VERSIONS,
} from "./main/julia-versions";

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
 * Invoke an IPC channel, stripping Electron's rejection prefix.
 *
 * When a main-process handler throws, Electron rewrites the message to
 * `Error invoking remote method '<channel>': Error: <original>`. Every
 * renderer error surface (console entries, dialogs, status banners) would
 * otherwise have to strip that noise itself — doing it once here keeps the
 * boundary's error shape uniform: callers always catch an `Error` whose
 * message is the handler's original message.
 *
 * @param channel - IPC channel name (a constant from `ipc.ts`).
 * @param args - Handler arguments, exactly as `ipcRenderer.invoke` accepts.
 * @returns The handler's result.
 * @throws {Error} The handler's failure, with the Electron prefix removed.
 */
/**
 * Per-channel invoke counters, populated only under E2E (`PDV_E2E=1`).
 * The round-trip-budget spec reads these to assert the renderer's latency
 * discipline — idle traffic O(1) per tick, ≤1 round trip per interaction —
 * which is what keeps PDV usable when every invoke is a network hop in
 * remote mode.
 */
const invokeCounts: Record<string, number> = {};
const COUNT_INVOKES = process.env.PDV_E2E === "1";

async function invoke<TResult>(channel: string, ...args: unknown[]): Promise<TResult> {
  if (COUNT_INVOKES) {
    invokeCounts[channel] = (invokeCounts[channel] ?? 0) + 1;
  }
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as TResult;
  } catch (err) {
    if (err instanceof Error) {
      err.message = err.message.replace(
        /^Error invoking remote method '[^']*': (?:Error: )?/,
        ""
      );
    }
    throw err;
  }
}

/**
 * Concrete implementation of the preload API contract.
 */
const api: PDVApi = {
  kernels: {
    list: () => invoke(IPC.kernels.list),
    start: (spec, uvContext) => invoke(IPC.kernels.start, spec, uvContext),
    stop: (kernelId) => invoke(IPC.kernels.stop, kernelId),
    execute: (kernelId, request) =>
      invoke(IPC.kernels.execute, kernelId, request),
    interrupt: (kernelId) => invoke(IPC.kernels.interrupt, kernelId),
    restart: (kernelId) => invoke(IPC.kernels.restart, kernelId),
    complete: (kernelId, code, cursorPos) =>
      invoke(IPC.kernels.complete, kernelId, code, cursorPos),
    inspect: (kernelId, code, cursorPos) =>
      invoke(IPC.kernels.inspect, kernelId, code, cursorPos),
    validate: (executablePath, language) =>
      invoke(IPC.kernels.validate, executablePath, language),
    onOutput: (callback) => onPush(IPC.push.executeOutput, callback),
    onExecuteBegin: (callback) => onPush(IPC.push.executeBegin, callback),
    onExecuteFinish: (callback) => onPush(IPC.push.executeFinish, callback),
    onKernelCrashed: (callback) => onPush(IPC.push.kernelCrashed, callback),
    onReconnected: (callback) => onPush(IPC.push.kernelReconnected, callback),
    onMemory: (callback) => onPush(IPC.push.kernelMemory, callback),
  },
  tree: {
    list: (kernelId, nodePath = "") =>
      invoke(IPC.tree.list, kernelId, nodePath),
    get: (kernelId, nodePath) =>
      invoke(IPC.tree.get, kernelId, nodePath),
    getVersion: (kernelId) =>
      invoke(IPC.tree.getVersion, kernelId),
    createScript: (kernelId, targetPath, scriptName) =>
      invoke(IPC.tree.createScript, kernelId, targetPath, scriptName),
    createNote: (kernelId, targetPath, noteName) =>
      invoke(IPC.tree.createNote, kernelId, targetPath, noteName),
    createGui: (kernelId, targetPath, guiName) =>
      invoke(IPC.tree.createGui, kernelId, targetPath, guiName),
    createLib: (kernelId, targetPath, libName) =>
      invoke(IPC.tree.createLib, kernelId, targetPath, libName),
    createNode: (kernelId, targetPath, nodeName) =>
      invoke(IPC.tree.createNode, kernelId, targetPath, nodeName),
    rename: (kernelId, treePath, newName) =>
      invoke(IPC.tree.rename, kernelId, treePath, newName),
    move: (kernelId, treePath, newPath) =>
      invoke(IPC.tree.move, kernelId, treePath, newPath),
    duplicate: (kernelId, treePath, newPath) =>
      invoke(IPC.tree.duplicate, kernelId, treePath, newPath),
    addFile: (kernelId, sourcePath, targetTreePath, nodeType, filename) =>
      invoke(IPC.tree.addFile, kernelId, sourcePath, targetTreePath, nodeType, filename),
    invokeHandler: (kernelId, nodePath) =>
      invoke(IPC.tree.invokeHandler, kernelId, nodePath),
    delete: (kernelId, treePath) =>
      invoke(IPC.tree.delete, kernelId, treePath),
    print: (kernelId, request) =>
      invoke(IPC.tree.print, kernelId, request),
    onChanged: (callback) => onPush(IPC.push.treeChanged, callback),
  },
  namespace: {
    query: (kernelId, options) =>
      invoke(IPC.namespace.query, kernelId, options),
    inspect: (kernelId, target) =>
      invoke(IPC.namespace.inspect, kernelId, target),
  },
  script: {
    run: (kernelId, request) =>
      invoke(IPC.script.run, kernelId, request),
    edit: (kernelId, scriptPath) =>
      invoke(IPC.script.edit, kernelId, scriptPath),
    getParams: (kernelId, treePath) =>
      invoke(IPC.script.getParams, kernelId, treePath),
  },
  note: {
    save: (kernelId, treePath, content) =>
      invoke(IPC.note.save, kernelId, treePath, content),
    read: (kernelId, treePath) =>
      invoke(IPC.note.read, kernelId, treePath),
  },
  namelist: {
    read: (kernelId, treePath) =>
      invoke(IPC.namelist.read, kernelId, treePath),
    write: (kernelId, treePath, data) =>
      invoke(IPC.namelist.write, kernelId, treePath, data),
  },
  environment: {
    list: () => invoke(IPC.environment.list),
    check: (pythonPath) => invoke(IPC.environment.check, pythonPath),
    install: (pythonPath) => invoke(IPC.environment.install, pythonPath),
    refresh: () => invoke(IPC.environment.refresh),
    onInstallOutput: (callback) => onPush(IPC.push.installOutput, callback),
    onEnvActivity: (callback) => onPush(IPC.push.envActivity, callback),
    listPackages: () => invoke(IPC.environment.listPackages),
    addPackage: (specs) => invoke(IPC.environment.addPackage, specs),
    removePackage: (names) => invoke(IPC.environment.removePackage, names),
    upgradePackage: (names) => invoke(IPC.environment.upgradePackage, names),
    activeInfo: () => invoke(IPC.environment.activeInfo),
    installModule: (kernelId, moduleName) =>
      invoke(IPC.environment.installModule, kernelId, moduleName),
    listJulia: () => invoke(IPC.environment.juliaList),
    checkJulia: (juliaPath) => invoke(IPC.environment.juliaCheck, juliaPath),
    installJulia: (juliaPath) => invoke(IPC.environment.juliaInstall, juliaPath),
    juliaupStatus: () => invoke(IPC.environment.juliaupStatus),
    juliaupChannels: () => invoke(IPC.environment.juliaupChannels),
    juliaupAdd: (channel) => invoke(IPC.environment.juliaupAdd, channel),
    installJuliaup: () => invoke(IPC.environment.juliaupInstall),
  },
  modules: {
    listInstalled: () => invoke(IPC.modules.listInstalled),
    install: (request) => invoke(IPC.modules.install, request),
    checkUpdates: (moduleId) => invoke(IPC.modules.checkUpdates, moduleId),
    importToProject: (request) =>
      invoke(IPC.modules.importToProject, request),
    listImported: () => invoke(IPC.modules.listImported),
    saveSettings: (request) => invoke(IPC.modules.saveSettings, request),
    runAction: (request) => invoke(IPC.modules.runAction, request),
    removeImport: (moduleAlias) => invoke(IPC.modules.removeImport, moduleAlias),
    uninstall: (moduleId) => invoke(IPC.modules.uninstall, moduleId),
    update: (moduleId) => invoke(IPC.modules.update, moduleId),
    createEmpty: (request) => invoke(IPC.modules.createEmpty, request),
    updateMetadata: (request) => invoke(IPC.modules.updateMetadata, request),
    exportFromProject: (request) => invoke(IPC.modules.exportFromProject, request),
  },
  project: {
    save: (saveDir, codeCells, projectName) =>
      invoke(IPC.project.save, saveDir, codeCells, projectName),
    load: (saveDir, options) => invoke(IPC.project.load, saveDir, options),
    new: () => invoke(IPC.project.new),
    peekLanguages: (paths) =>
      invoke(IPC.project.peekLanguages, paths),
    peekManifest: (dir) =>
      invoke(IPC.project.peekManifest, dir),
    onLoaded: (callback) => onPush(IPC.push.projectLoaded, callback),
    onReloading: (callback) => onPush(IPC.push.projectReloading, callback),
  },
  progress: {
    onProgress: (callback) => onPush(IPC.push.progress, callback),
  },
  config: {
    get: () => invoke(IPC.config.get),
    set: (updates) => invoke(IPC.config.set, updates),
  },
  mcp: {
    getStatus: () => invoke(IPC.mcp.getStatus),
    onClientStatus: (callback) => onPush(IPC.push.mcpClientStatus, callback),
  },
  window: {
    setBackgroundColor: (color) => invoke(IPC.window.setBackgroundColor, color),
  },
  autosave: {
    run: (codeCells: unknown) => invoke(IPC.autosave.run, codeCells),
    clear: (dir?: string) => invoke(IPC.autosave.clear, dir),
    check: (dir: string) => invoke(IPC.autosave.check, dir),
    scanWorkingDirs: () => invoke(IPC.autosave.scanWorkingDirs),
    recoverUnsaved: (orphanDir: string) => invoke(IPC.autosave.recoverUnsaved, orphanDir),
    deleteOrphan: (orphanDir: string) => invoke(IPC.autosave.deleteOrphan, orphanDir),
    onTrigger: (cb: () => void) => onPush(IPC.push.autosaveTrigger, cb),
    onInFlightChange: (cb: (inFlight: boolean) => void) => {
      const offStart = onPush<void>(IPC.push.autosaveStarted, () => cb(true));
      const offEnd = onPush<void>(IPC.push.autosaveEnded, () => cb(false));
      return () => { offStart(); offEnd(); };
    },
  },
  cells: {
    onRequest: (cb) => onPush(IPC.push.cellsRequest, cb),
    onWrite: (cb) => onPush(IPC.push.cellWrite, cb),
    respond: (response) => invoke(IPC.cells.respond, response),
  },
  about: {
    getVersion: () => invoke(IPC.about.getVersion),
    openRepoPage: () => invoke(IPC.about.openRepoPage),
    openIssuesPage: () => invoke(IPC.about.openIssuesPage),
    openDocsPage: () => invoke(IPC.about.openDocsPage),
  },
  remote: {
    listHosts: () => invoke(IPC.remote.listHosts),
    connect: (host) => invoke(IPC.remote.connect, host),
    respond: (text) => invoke(IPC.remote.respond, text),
    cancel: () => invoke(IPC.remote.cancel),
    disconnect: () => invoke(IPC.remote.disconnect),
    getStatus: () => invoke(IPC.remote.getStatus),
    startSession: () => invoke(IPC.remote.startSession),
    endSession: () => invoke(IPC.remote.endSession),
    getHostConfig: (host) => invoke(IPC.remote.getHostConfig, host),
    setHostConfig: (host, update) => invoke(IPC.remote.setHostConfig, host, update),
    listConfiguredHosts: () => invoke(IPC.remote.listConfiguredHosts),
    testSetupScript: (host, script) => invoke(IPC.remote.testSetupScript, host, script),
    onStatus: (cb) => onPush(IPC.push.remoteStatus, cb),
    onSessionState: (cb) => onPush(IPC.push.sessionState, cb),
  },
  updater: {
    checkForUpdates: () => invoke(IPC.updater.checkForUpdates),
    downloadUpdate: () => invoke(IPC.updater.downloadUpdate),
    installUpdate: () => invoke(IPC.updater.installUpdate),
    openReleasesPage: () => invoke(IPC.updater.openReleasesPage),
    getStatus: () => invoke(IPC.updater.getStatus),
    onUpdateStatus: (cb) => onPush(IPC.push.updateStatus, cb),
  },
  themes: {
    get: () => invoke(IPC.themes.get),
    save: (theme) => invoke(IPC.themes.save, theme),
    openDir: () => invoke(IPC.themes.openDir),
  },
  codeCells: {
    load: () => invoke(IPC.codeCells.load),
    save: (data) => invoke(IPC.codeCells.save, data),
  },
  moduleWindows: {
    open: (req) => invoke(IPC.moduleWindows.open, req),
    close: (alias) => invoke(IPC.moduleWindows.close, alias),
    context: () => invoke(IPC.moduleWindows.context),
    executeInMain: (code) => invoke(IPC.moduleWindows.executeInMain, code),
    onExecuteRequest: (cb) => onPush(IPC.push.moduleExecuteRequest, cb),
  },
  guiEditor: {
    open: (req) => invoke(IPC.guiEditor.open, req),
    openViewer: (req) => invoke(IPC.guiEditor.openViewer, req),
    context: () => invoke(IPC.guiEditor.context),
    read: (treePath) => invoke(IPC.guiEditor.read, treePath),
    save: (req) => invoke(IPC.guiEditor.save, req),
  },
  files: {
    pickExecutable: () => invoke(IPC.files.pickExecutable),
    pickFile: () => invoke(IPC.files.pickFile),
    pickDirectory: (defaultPath) => invoke(IPC.files.pickDirectory, defaultPath),
    listDir: (dirPath) => invoke(IPC.files.listDir, dirPath),
  },
  menu: {
    updateRecentProjects: (paths) =>
      invoke(IPC.menu.updateRecentProjects, paths),
    updateEnabled: (state) =>
      invoke(IPC.menu.updateEnabled, state),
    getModel: () => invoke(IPC.menu.getModel),
    popup: (menuId, x, y) => invoke(IPC.menu.popup, menuId, x, y),
    onAction: (callback) => onPush(IPC.push.menuAction, callback),
  },
  system: {
    // Read once at preload time and snapshot. `process.platform` is a constant
    // for the life of the process, so there is no point routing it through an
    // IPC channel — renderers read this synchronously from `window.pdv`.
    platform: process.platform,
    // Compile-time constants from python-versions.ts; same rationale.
    supportedPythonVersions: SUPPORTED_PYTHON_VERSIONS,
    defaultPythonVersion: DEFAULT_PYTHON_VERSION,
    // Julia siblings from julia-versions.ts (§10.6.5).
    supportedJuliaVersions: SUPPORTED_JULIA_VERSIONS,
    defaultJuliaVersion: DEFAULT_JULIA_VERSION,
    // E2E-only diagnostics: per-channel invoke counts for the
    // round-trip-budget spec. Returns a snapshot copy; empty outside E2E.
    getInvokeCounts: () => ({ ...invokeCounts }),
  },
  launchers: {
    openAgent: () => invoke(IPC.launchers.openAgent),
    openWorkingDir: () => invoke(IPC.launchers.openWorkingDir),
    checkAvailability: (check) => invoke(IPC.launchers.checkAvailability, check),
  },
  chrome: {
    getInfo: () => invoke(IPC.chrome.getInfo),
    minimize: () => invoke(IPC.chrome.minimize),
    toggleMaximize: () => invoke(IPC.chrome.toggleMaximize),
    close: () => invoke(IPC.chrome.close),
    onStateChanged: (callback) => onPush(IPC.push.chromeStateChanged, callback),
  },
  app: {
    confirmClose: () => invoke(IPC.app.confirmClose),
    onRequestClose: (callback) => onPush<void>(IPC.push.requestClose, callback),
    setDocumentEdited: (edited) =>
      invoke(IPC.app.setDocumentEdited, edited),
  },
};

contextBridge.exposeInMainWorld("pdv", api);

declare global {
  interface Window {
    /** Typed preload bridge available in the renderer process. */
    pdv: PDVApi;
  }
}
