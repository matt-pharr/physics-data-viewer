/**
 * index.ts — IPC handler registration and comm push forwarding.
 *
 * Registers all `ipcMain.handle(...)` channels consumed by the preload
 * `window.pdv` API. Each handler translates renderer requests into either:
 * - direct `KernelManager` operations, or
 * - PDV comm requests via `CommRouter`.
 *
 * This module also forwards selected kernel push notifications to the
 * renderer using `BrowserWindow.webContents.send(...)`.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.1, §11.2, §11.3
 * ipc.ts — channel constants and API types
 */

import { ipcMain, BrowserWindow, app } from "electron";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";

import { CommRouter } from "./comm-router";
import { EnvironmentDetector } from "./environment-detector";
import { buildEditorSpawn, resolveEditorSpawn } from "./editor-spawn";
import { registerKernelIpcHandlers } from "./ipc-register-kernels";
import { registerModulesIpcHandlers } from "./ipc-register-modules";
import { registerProjectIpcHandlers } from "./ipc-register-project";
import { KernelManager } from "./kernel-manager";
import { ModuleManager } from "./module-manager";
import {
  bindProjectModulesToTree,
} from "./module-runtime";
import { ProjectManager, type ProjectModuleImport } from "./project-manager";
import { ConfigStore } from "./config";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import { registerModuleWindowIpcHandlers } from "./ipc-register-module-windows";
import { registerTreeNamespaceScriptIpcHandlers } from "./ipc-register-tree-namespace-script";
import { ModuleWindowManager } from "./module-window-manager";
import {
  IPC,
  NamespaceInspectTarget,
  ModuleHealthWarning,
  NamespaceQueryOptions,
  PDVConfig,
} from "./ipc";
import { PDVMessage, PDVMessageType } from "./pdv-protocol";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PDVConfig = {
  showPrivateVariables: false,
  showModuleVariables: false,
  showCallableVariables: false,
};

const REGISTERED_CHANNELS: readonly string[] = [
  IPC.kernels.list,
  IPC.kernels.start,
  IPC.kernels.stop,
  IPC.kernels.execute,
  IPC.kernels.interrupt,
  IPC.kernels.restart,
  IPC.kernels.complete,
  IPC.kernels.inspect,
  IPC.kernels.validate,
  IPC.tree.list,
  IPC.tree.get,
  IPC.tree.createScript,
  IPC.tree.createNote,
  IPC.tree.addFile,
  IPC.tree.invokeHandler,
  IPC.namespace.query,
  IPC.namespace.inspect,
  IPC.script.edit,
  IPC.script.run,
  IPC.note.save,
  IPC.note.read,
  IPC.modules.listInstalled,
  IPC.modules.install,
  IPC.modules.checkUpdates,
  IPC.modules.importToProject,
  IPC.modules.listImported,
  IPC.modules.saveSettings,
  IPC.modules.runAction,
  IPC.modules.removeImport,
  IPC.namelist.read,
  IPC.namelist.write,
  IPC.project.save,
  IPC.project.load,
  IPC.project.new,
  IPC.project.peekLanguages,
  IPC.config.get,
  IPC.config.set,
  IPC.themes.get,
  IPC.themes.save,
  IPC.codeCells.load,
  IPC.codeCells.save,
  IPC.menu.updateRecentProjects,
  IPC.menu.updateEnabled,
  IPC.menu.getModel,
  IPC.menu.popup,
  IPC.chrome.getInfo,
  IPC.chrome.minimize,
  IPC.chrome.toggleMaximize,
  IPC.chrome.close,
  IPC.moduleWindows.open,
  IPC.moduleWindows.close,
  IPC.moduleWindows.context,
  IPC.moduleWindows.executeInMain,
  IPC.files.pickExecutable,
  IPC.files.pickFile,
  IPC.files.pickDirectory,
  IPC.about.getVersion,
];

interface PushSubscription {
  commRouter: CommRouter;
  type: string;
  handler: (message: PDVMessage) => void;
}

const pushSubscriptions: PushSubscription[] = [];
const kernelWorkingDirs = new Map<string, string>();
const crashHandlers = new Map<string, (id: string) => void>();
const projectManifestMutationQueue = new Map<string, Promise<void>>();
let activeKernelManagerRef: KernelManager | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the current app configuration.
 *
 * @param configStore - Config store dependency.
 * @returns Current config snapshot.
 */
function readConfig(configStore: ConfigStore): PDVConfig {
  const raw = configStore.getAll();
  return { ...DEFAULT_CONFIG, ...raw };
}

/**
 * Convert renderer namespace query filters to protocol payload keys.
 *
 * @param options - Renderer query options.
 * @returns Protocol payload object for `pdv.namespace.query`.
 */
function toNamespaceQueryPayload(
  options?: NamespaceQueryOptions
): Record<string, unknown> {
  if (!options) return {};
  return {
    include_private: options.includePrivate,
    include_modules: options.includeModules,
    include_callables: options.includeCallables,
  };
}

/**
 * Convert renderer namespace inspect targets to protocol payload keys.
 *
 * @param target - Renderer inspect target.
 * @returns Protocol payload object for `pdv.namespace.inspect`.
 */
function toNamespaceInspectPayload(
  target: NamespaceInspectTarget
): Record<string, unknown> {
  return {
    root_name: target.rootName,
    path: target.path,
  };
}

/**
 * Serialize project-manifest read/modify/write tasks per project directory.
 *
 * @param projectDir - Project directory owning one `project.json`.
 * @param task - Manifest mutation task to run after queued tasks complete.
 * @returns Task result.
 * @throws {Error} Re-throws task errors after preserving queue continuity.
 */
function runSerializedProjectManifestMutation<T>(
  projectDir: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = projectManifestMutationQueue.get(projectDir) ?? Promise.resolve();
  const current = previous.catch((err) => { console.warn("[pdv] manifest mutation queue: prior task failed", err); }).then(task);
  const completion = current.then(() => undefined, () => undefined);
  projectManifestMutationQueue.set(projectDir, completion);
  return current.finally(() => {
    if (projectManifestMutationQueue.get(projectDir) === completion) {
      projectManifestMutationQueue.delete(projectDir);
    }
  });
}

/**
 * Ensure script names are safe and end with the correct language extension.
 *
 * @param scriptName - User-provided script name.
 * @param language - Target language (determines file extension).
 * @returns Sanitized filename.
 */
function sanitizeScriptName(scriptName: string, language: "python" | "julia" = "python"): string {
  const ext = language === "julia" ? ".jl" : ".py";
  const trimmed = scriptName.trim() || "script";
  const withExt = trimmed.endsWith(ext) ? trimmed : `${trimmed}${ext}`;
  return withExt.replace(/[\\/]/g, "_");
}

function resolveScriptPath(
  kernelId: string,
  scriptPath: string,
  kernelWorkingDirs: Map<string, string>,
  language: "python" | "julia" = "python"
): string {
  if (path.isAbsolute(scriptPath)) {
    return scriptPath;
  }
  const workingDir = kernelWorkingDirs.get(kernelId);
  if (!workingDir) {
    throw new Error(`Kernel working directory not initialized: ${kernelId}`);
  }
  if (scriptPath.includes("/") || scriptPath.includes("\\")) {
    return path.join(workingDir, scriptPath);
  }
  const parts = scriptPath.split(".").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Invalid script path");
  }
  const ext = language === "julia" ? ".jl" : ".py";
  const leaf = parts[parts.length - 1];
  return path.join(workingDir, ...parts.slice(0, -1), `${leaf}${ext}`);
}

/**
 * Write a script stub if the file does not already exist.
 *
 * @param scriptPath - Absolute target script path.
 * @param language - Target language (determines template syntax).
 */
async function ensureScriptFile(scriptPath: string, language: "python" | "julia" = "python"): Promise<void> {
  try {
    await fs.stat(scriptPath);
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }
  const now = new Date();
  const date = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const user = process.env.USER ?? process.env.USERNAME ?? "user";
  const host = os.hostname();
  const filename = path.basename(scriptPath);
  const template = language === "julia"
    ? "#=\n" +
      `  ${filename}\n` +
      `  created by ${user} on ${host} on ${date} at ${time}\n` +
      "  Description: add your script description here.\n" +
      "=#\n\n" +
      "function run(pdv_tree::Dict)\n" +
      "    # add your code here\n" +
      "    return Dict()\n" +
      "end\n"
    : '"""\n' +
      `${filename}\n` +
      `created by ${user} on ${host} on ${date} at ${time}\n` +
      "Description: add your script description here.\n" +
      '"""\n\n' +
      "def run(pdv_tree: dict, ) -> dict:\n" +
      "    # add your code here\n" +
      "    return {}\n";
  await fs.writeFile(scriptPath, template, "utf8");
}

/**
 * Remove all registered push subscriptions.
 */
function clearPushSubscriptions(): void {
  for (const sub of pushSubscriptions) {
    sub.commRouter.offPush(sub.type, sub.handler);
  }
  pushSubscriptions.length = 0;
}

// ---------------------------------------------------------------------------
// Public registration API
// ---------------------------------------------------------------------------

/**
 * Register all `ipcMain.handle(...)` channels required by Step 5.
 *
 * @param win - Main browser window used for push forwarding.
 * @param kernelManager - Kernel manager instance.
 * @param commRouter - Comm router bound to the active kernel.
 * @param projectManager - Project manager dependency.
 * @param configStore - Config persistence dependency.
 * @returns Nothing.
 */
export function registerIpcHandlers(
  win: BrowserWindow,
  kernelManager: KernelManager,
  commRouter: CommRouter,
  projectManager: ProjectManager,
  configStore: ConfigStore,
  pdvDir: string
): () => void {
  activeKernelManagerRef = kernelManager;
  unregisterIpcHandlers();

  // Derive per-purpose sub-directories within ~/.PDV
  const themesDir = path.join(pdvDir, "themes");
  const stateDir  = path.join(pdvDir, "state");
  const codeCellsPath = path.join(stateDir, "code-cells.json");
  const moduleManager = new ModuleManager(pdvDir);
  let activeProjectDir: string | null = null;
  let activeKernelId: string | null = null;
  const moduleHealthWarningsByAlias = new Map<string, ModuleHealthWarning[]>();

  // In-memory module state for imports made before the project is saved to disk.
  // Merged into the manifest on first project:save, cleared on project:load/new.
  let pendingModuleImports: ProjectModuleImport[] = [];
  let pendingModuleSettings: Record<string, Record<string, unknown>> = {};

  const detectPythonVersion = async (): Promise<string | undefined> => {
    const config = readConfig(configStore);
    try {
      const detected = await EnvironmentDetector.detect(config.pythonPath);
      return detected.pythonVersion;
    } catch (error) {
      console.warn("[pdv] unable to detect python version for module health", error);
      return undefined;
    }
  };

  const refreshProjectModuleHealth = async (
    projectDir: string | null
  ): Promise<Awaited<ReturnType<typeof ProjectManager.readManifest>> | null> => {
    moduleHealthWarningsByAlias.clear();
    if (!projectDir) {
      return null;
    }
    const manifest = await ProjectManager.readManifest(projectDir);
    const pythonVersion = await detectPythonVersion();
    for (const importedModule of manifest.modules) {
      const warnings = await moduleManager.evaluateHealth(importedModule.module_id, {
        pdvVersion: app.getVersion(),
        pythonVersion,
      });
      moduleHealthWarningsByAlias.set(importedModule.alias, warnings);
    }
    return manifest;
  };

  /**
   * Read the active project manifest when a project is loaded.
   *
   * @returns Current active manifest, or null when no project is active.
   */
  const readActiveProjectManifest = async (): Promise<
    Awaited<ReturnType<typeof ProjectManager.readManifest>> | null
  > => {
    if (!activeProjectDir) {
      return null;
    }
    return ProjectManager.readManifest(activeProjectDir);
  };

  /**
   * Bind active-project module scripts into one kernel working directory.
   *
   * @param kernelId - Kernel to bind module scripts for.
   * @param importedModules - Optional already-loaded module imports.
   */
  const bindActiveProjectModules = async (
    kernelId: string | null,
    importedModules?: ProjectModuleImport[]
  ): Promise<void> => {
    await bindProjectModulesToTree(
      kernelManager,
      commRouter,
      moduleManager,
      kernelId,
      activeProjectDir,
      importedModules,
      kernelId ? kernelWorkingDirs.get(kernelId) : undefined
    );
  };

  const preloadPath = path.join(__dirname, "..", "preload.js");
  const moduleWindowManager = new ModuleWindowManager(win, preloadPath);

  registerKernelIpcHandlers({
    win,
    kernelManager,
    commRouter,
    projectManager,
    moduleManager,
    kernelWorkingDirs,
    crashHandlers,
    resetProjectState: () => {
      activeProjectDir = null;
      pendingModuleImports = [];
      pendingModuleSettings = {};
      moduleHealthWarningsByAlias.clear();
      moduleWindowManager.closeAll();
    },
    resetKernelState: () => {
      pendingModuleImports = [];
      pendingModuleSettings = {};
      moduleHealthWarningsByAlias.clear();
      moduleWindowManager.closeAll();
    },
    setActiveKernelId: (id) => { activeKernelId = id; },
    getActiveKernelId: () => activeKernelId,
    getActiveProjectDir: () => activeProjectDir,
    bindActiveProjectModules,
  });

  registerTreeNamespaceScriptIpcHandlers({
    kernelManager,
    commRouter,
    projectManager,
    configStore,
    kernelWorkingDirs,
    readConfig,
    toNamespaceQueryPayload,
    toNamespaceInspectPayload,
    sanitizeScriptName,
    ensureScriptFile,
    resolveScriptPath,
    buildEditorSpawn,
    resolveEditorSpawn,
  });

  registerModulesIpcHandlers({
    win,
    kernelManager,
    commRouter,
    moduleManager,
    kernelWorkingDirs,
    readActiveProjectManifest,
    getActiveProjectDir: () => activeProjectDir,
    getActiveKernelId: () => activeKernelId,
    getPendingModuleImports: () => pendingModuleImports,
    getPendingModuleSettings: () => pendingModuleSettings,
    getModuleHealthWarningsByAlias: () => moduleHealthWarningsByAlias,
    detectPythonVersion,
    getPdvVersion: () => app.getVersion(),
    runWithProjectManifestWriteLock: runSerializedProjectManifestMutation,
  });

  registerProjectIpcHandlers({
    projectManager,
    kernelWorkingDirs,
    getActiveKernelId: () => activeKernelId,
    getActiveKernelLanguage: () => {
      if (activeKernelId) {
        const kernel = kernelManager.getKernel(activeKernelId);
        if (kernel) return kernel.language;
      }
      return "python";
    },
    setActiveProjectDir: (dir) => { activeProjectDir = dir; },
    getPendingModuleImports: () => pendingModuleImports,
    setPendingModuleImports: (imports) => { pendingModuleImports = imports; },
    getPendingModuleSettings: () => pendingModuleSettings,
    setPendingModuleSettings: (settings) => { pendingModuleSettings = settings; },
    clearModuleHealthWarnings: () => moduleHealthWarningsByAlias.clear(),
    refreshProjectModuleHealth,
    runSerializedProjectManifestMutation,
    getMainWindow: () => win,
  });

  registerAppStateIpcHandlers({
    win,
    configStore,
    readConfig,
    themesDir,
    stateDir,
    codeCellsPath,
  });

  registerModuleWindowIpcHandlers({
    moduleWindowManager,
    mainWindow: win,
  });

  registerPushForwarding(win, commRouter, moduleWindowManager);

  /**
   * Reset all in-session state. Called whenever the renderer reloads so that
   * stale pending imports, project dirs, and health warnings from a previous
   * renderer session don't leak into the new one.
   */
  function resetSessionState(): void {
    activeProjectDir = null;
    activeKernelId = null;
    pendingModuleImports = [];
    pendingModuleSettings = {};
    moduleHealthWarningsByAlias.clear();
    moduleWindowManager.closeAll();
  }

  return resetSessionState;
}

/**
 * Register kernel push forwarding from CommRouter to the renderer process.
 *
 * @param win - Main BrowserWindow.
 * @param commRouter - Comm router instance.
 * @returns Nothing.
 */
export function registerPushForwarding(
  win: BrowserWindow,
  commRouter: CommRouter,
  moduleWindowManager?: ModuleWindowManager
): void {
  const subscribe = (type: string, channel: string, broadcast?: boolean): void => {
    const handler = (message: PDVMessage): void => {
      win.webContents.send(channel, message.payload);
      if (broadcast && moduleWindowManager) {
        moduleWindowManager.broadcastToAll(channel, message.payload);
      }
    };
    commRouter.onPush(type, handler);
    pushSubscriptions.push({ commRouter, type, handler });
  };

  subscribe(PDVMessageType.TREE_CHANGED, IPC.push.treeChanged, true);
  subscribe(PDVMessageType.PROJECT_LOADED, IPC.push.projectLoaded);
  subscribe(PDVMessageType.PROGRESS, IPC.push.progress);
}

/**
 * Unregister every IPC handler and push subscription registered by this module.
 *
 * @returns Nothing.
 */
export function unregisterIpcHandlers(): void {
  for (const channel of REGISTERED_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
  for (const [id, dir] of kernelWorkingDirs) {
    const handler = crashHandlers.get(id);
    if (handler) activeKernelManagerRef?.removeListener("kernel:crashed", handler);
    try {
      fsSync.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[pdv] failed to remove kernel working dir: ${dir}`, error);
    }
  }
  kernelWorkingDirs.clear();
  crashHandlers.clear();
  clearPushSubscriptions();
}
