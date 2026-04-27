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
import { QueryRouter } from "./query-router";
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
import { ProjectManager, type ProjectModuleImport, type ModuleOwnedFile, type ModuleManifestBundle } from "./project-manager";
import { ConfigStore } from "./config";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import { registerGuiEditorIpcHandlers } from "./ipc-register-gui-editor";
import { registerModuleWindowIpcHandlers } from "./ipc-register-module-windows";
import { registerTreeNamespaceScriptIpcHandlers } from "./ipc-register-tree-namespace-script";
import { GuiEditorWindowManager } from "./gui-editor-window-manager";
import { GuiViewerWindowManager } from "./gui-viewer-window-manager";
import { ModuleWindowManager } from "./module-window-manager";
import {
  IPC,
  NamespaceInspectTarget,
  ModuleHealthWarning,
  NamespaceQueryOptions,
  PDVConfig,
  type CodeCellData,
} from "./ipc";
import { PDVMessage, PDVMessageType, setAppVersion } from "./pdv-protocol";

// ---------------------------------------------------------------------------
// Unified version — set once before any handler uses getAppVersion()
// ---------------------------------------------------------------------------
setAppVersion(app.getVersion());

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PDVConfig = {
  showPrivateVariables: false,
  showModuleVariables: false,
  showCallableVariables: false,
  autoRefreshNamespace: false,
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
  IPC.tree.createNode,
  IPC.tree.rename,
  IPC.tree.move,
  IPC.tree.duplicate,
  IPC.tree.invokeHandler,
  IPC.tree.delete,
  IPC.namespace.query,
  IPC.namespace.inspect,
  IPC.script.edit,
  IPC.script.run,
  IPC.script.getParams,
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
  IPC.modules.uninstall,
  IPC.modules.update,
  IPC.namelist.read,
  IPC.namelist.write,
  IPC.project.save,
  IPC.project.load,
  IPC.project.new,
  IPC.project.peekLanguages,
  IPC.project.peekManifest,
  IPC.config.get,
  IPC.config.set,
  IPC.themes.get,
  IPC.themes.save,
  IPC.themes.openDir,
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
  IPC.app.confirmClose,
  IPC.moduleWindows.open,
  IPC.moduleWindows.close,
  IPC.moduleWindows.context,
  IPC.moduleWindows.executeInMain,
  IPC.guiEditor.open,
  IPC.guiEditor.openViewer,
  IPC.guiEditor.context,
  IPC.guiEditor.read,
  IPC.guiEditor.save,
  IPC.tree.createGui,
  IPC.files.pickExecutable,
  IPC.files.pickFile,
  IPC.files.pickDirectory,
  IPC.about.getVersion,
  IPC.updater.checkForUpdates,
  IPC.updater.downloadUpdate,
  IPC.updater.installUpdate,
  IPC.updater.openReleasesPage,
  IPC.environment.list,
  IPC.environment.check,
  IPC.environment.install,
  IPC.environment.refresh,
  IPC.autosave.run,
  IPC.autosave.clear,
  IPC.autosave.check,
  IPC.autosave.scanWorkingDirs,
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
 * Map a camelCase object to a snake_case payload using a typed key map.
 *
 * The key map must satisfy `Record<keyof T, string>`, so adding a new field
 * to `T` without updating the map is a compile-time error. Undefined values
 * are dropped from the output.
 */
function mapKeysToPayload<T extends object>(
  source: T,
  keymap: Record<keyof T, string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(keymap) as Array<keyof T>) {
    const value = source[key];
    if (value !== undefined) {
      result[keymap[key]] = value;
    }
  }
  return result;
}

/**
 * Wire-format key map for {@link NamespaceQueryOptions}. The `satisfies` clause
 * forces this map to enumerate every key in the type, so adding a new option
 * fails to compile until the map is updated.
 */
const NAMESPACE_QUERY_KEYMAP = {
  includePrivate: "include_private",
  includeModules: "include_modules",
  includeCallables: "include_callables",
} as const satisfies Record<keyof NamespaceQueryOptions, string>;

/**
 * Wire-format key map for {@link NamespaceInspectTarget}.
 */
const NAMESPACE_INSPECT_KEYMAP = {
  rootName: "root_name",
  path: "path",
} as const satisfies Record<keyof NamespaceInspectTarget, string>;

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
  return mapKeysToPayload(options, NAMESPACE_QUERY_KEYMAP);
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
  return mapKeysToPayload(target, NAMESPACE_INSPECT_KEYMAP);
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
 * Seed a newly-created PDVLib file with a starter stub when it doesn't
 * already exist. Unlike PDVScript, libs have no ``run()`` contract —
 * they're plain importable modules — so the stub is just a docstring
 * header plus a commented-out example so users can see where to add
 * their own helpers.
 *
 * @param libPath - Absolute path to the target ``.py`` / ``.jl`` file.
 * @param language - Active kernel language (only Python is actually
 *   supported by the ``tree:createLib`` handler today; Julia falls back
 *   to a block-comment equivalent for future-proofing).
 * @param moduleAlias - Top-level tree alias of the owning PDVModule (if
 *   any), so the stub can reference it in the header.
 */
async function ensureLibFile(
  libPath: string,
  language: "python" | "julia",
  moduleAlias?: string
): Promise<void> {
  try {
    await fs.stat(libPath);
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
  const filename = path.basename(libPath);
  const context = moduleAlias
    ? `Library for PDVModule "${moduleAlias}"`
    : "Standalone project library";
  const template = language === "julia"
    ? "#=\n" +
      `  ${filename}\n` +
      `  ${context}\n` +
      `  created by ${user} on ${host} on ${date} at ${time}\n` +
      "=#\n\n" +
      "# Define helper functions below — they will be importable from\n" +
      `# sibling scripts as \`using ${path.parse(filename).name}\`.\n\n` +
      "# function example(x)\n" +
      "#     return x\n" +
      "# end\n"
    : '"""\n' +
      `${filename}\n` +
      `${context}\n` +
      `created by ${user} on ${host} on ${date} at ${time}\n` +
      '"""\n\n' +
      "# Define helper functions below — they will be importable from\n" +
      `# sibling scripts as \`from ${path.parse(filename).name} import ...\`.\n\n` +
      "# def example(x):\n" +
      "#     return x\n";
  await fs.writeFile(libPath, template, "utf8");
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
  queryRouter: QueryRouter,
  projectManager: ProjectManager,
  configStore: ConfigStore,
  pdvDir: string,
  setAllowClose: (allow: boolean) => void
): () => void {
  activeKernelManagerRef = kernelManager;
  unregisterIpcHandlers();

  // Derive per-purpose sub-directories within ~/.PDV
  const themesDir = path.join(pdvDir, "themes");
  const stateDir  = path.join(pdvDir, "state");
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
  const moduleWindowManager = new ModuleWindowManager(preloadPath);
  const guiEditorWindowManager = new GuiEditorWindowManager(preloadPath);
  const guiViewerWindowManager = new GuiViewerWindowManager(preloadPath);

  registerKernelIpcHandlers({
    win,
    kernelManager,
    commRouter,
    queryRouter,
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
      guiEditorWindowManager.closeAll();
      guiViewerWindowManager.closeAll();
    },
    resetKernelState: () => {
      pendingModuleImports = [];
      pendingModuleSettings = {};
      moduleHealthWarningsByAlias.clear();
      moduleWindowManager.closeAll();
      guiEditorWindowManager.closeAll();
      guiViewerWindowManager.closeAll();
    },
    setActiveKernelId: (id) => {
      activeKernelId = id;
      if (id) {
        const config = readConfig(configStore);
        const intervalMs = (config.autoSaveIntervalSeconds ?? 300) * 1000;
        projectManager.startAutosaveTimer(intervalMs, triggerAutosave);
      } else {
        projectManager.stopAutosaveTimer();
      }
    },
    getActiveKernelId: () => activeKernelId,
    getActiveProjectDir: () => activeProjectDir,
    getWorkingDirBase: () => readConfig(configStore).workingDirBase,
    bindActiveProjectModules,
  });

  registerTreeNamespaceScriptIpcHandlers({
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    configStore,
    kernelWorkingDirs,
    // Aggregate module aliases from the active on-disk manifest plus any
    // in-memory pending imports (the latter carries in-session modules
    // created by modules:createEmpty before the first save). The tree
    // create* handlers use this to route module-owned files through the
    // ``<workdir>/<alias>/...`` layout with source_rel_path set.
    getKnownModuleAliases: async (): Promise<Set<string>> => {
      const manifest = await readActiveProjectManifest();
      const disk = manifest?.modules ?? [];
      return new Set([
        ...disk.map((m) => m.alias),
        ...pendingModuleImports.map((m) => m.alias),
      ]);
    },
    readConfig,
    toNamespaceQueryPayload,
    toNamespaceInspectPayload,
    sanitizeScriptName,
    ensureScriptFile,
    ensureLibFile,
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
    moduleManager,
    commRouter,
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
    getInterpreterPath: () => {
      const config = readConfig(configStore);
      const lang = activeKernelId
        ? (kernelManager.getKernel(activeKernelId)?.language ?? "python")
        : "python";
      return lang === "julia" ? config.juliaPath : config.pythonPath;
    },
    onExplicitSaveCompleted: (saveDir) => {
      void ProjectManager.clearAutosave(saveDir);
      projectManager.resetAutosaveTimer();
    },
  });

  registerAppStateIpcHandlers({
    win,
    configStore,
    readConfig,
    themesDir,
    stateDir,
    setAllowClose,
  });

  registerModuleWindowIpcHandlers({
    moduleWindowManager,
    mainWindow: win,
  });

  registerGuiEditorIpcHandlers({
    guiEditorWindowManager,
    guiViewerWindowManager,
    commRouter,
  });

  registerEnvironmentIpcHandlers(win, configStore);

  // ---- Autosave IPC handlers and lifecycle wiring --------------------------

  function triggerAutosave(): void {
    if (!activeKernelId) return;
    const state = kernelManager.getExecutionState(activeKernelId);
    if (state !== "idle") {
      projectManager.setAutosavePending();
      return;
    }
    win.webContents.send(IPC.push.autosaveTrigger);
  }

  ipcMain.handle(IPC.autosave.run, async (_event, codeCells: unknown) => {
    const baseDir = activeProjectDir || kernelWorkingDirs.get(activeKernelId ?? "");
    if (!baseDir) return;
    const autosaveDir = path.join(baseDir, ".autosave");
    await projectManager.autosave(autosaveDir, codeCells as CodeCellData);
  });

  ipcMain.handle(IPC.autosave.clear, async (_event, dir?: string) => {
    const target = dir || activeProjectDir || kernelWorkingDirs.get(activeKernelId ?? "");
    if (target) {
      await ProjectManager.clearAutosave(target);
      projectManager.markAutosaveCacheDirty();
    }
  });

  ipcMain.handle(IPC.autosave.check, async (_event, dir: string) => {
    return ProjectManager.checkForAutosave(dir);
  });

  ipcMain.handle(IPC.autosave.scanWorkingDirs, async () => {
    const config = readConfig(configStore);
    const base = config.workingDirBase || path.join(os.homedir(), ".PDV", "working");
    return ProjectManager.scanForAutosaves(base);
  });

  // When kernel goes idle and an autosave was deferred, trigger it now.
  kernelManager.on("kernel:executionState", (kernelId: string, state: string) => {
    if (kernelId !== activeKernelId) return;
    if (state === "idle" && projectManager.consumeAutosavePending()) {
      triggerAutosave();
    }
  });

  registerCommPushForwarding(win, commRouter, projectManager, moduleWindowManager, guiEditorWindowManager, guiViewerWindowManager);

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
    guiEditorWindowManager.closeAll();
    guiViewerWindowManager.closeAll();
  }

  return resetSessionState;
}

/**
 * Register IPC handlers for Python environment discovery and installation.
 *
 * @param win - Main BrowserWindow for streaming install output.
 */
function registerEnvironmentIpcHandlers(win: BrowserWindow, configStore: ConfigStore): void {

  ipcMain.handle(IPC.environment.list, async () => {
    const config = configStore.getAll();
    return EnvironmentDetector.listEnvironmentInfo(config.pythonPath);
  });

  ipcMain.handle(IPC.environment.check, async (_event, pythonPath: string) => {
    return EnvironmentDetector.checkEnvironment(pythonPath);
  });

  ipcMain.handle(IPC.environment.install, async (_event, pythonPath: string) => {
    return EnvironmentDetector.installPDVFromBundle(pythonPath, win, IPC.push.installOutput);
  });

  ipcMain.handle(IPC.environment.refresh, async () => {
    EnvironmentDetector.clearCache();
    const config = configStore.getAll();
    return EnvironmentDetector.listEnvironmentInfo(config.pythonPath);
  });
}

/**
 * Forward kernel-originated push events from the CommRouter to the renderer
 * process via `webContents.send`.
 *
 * This function bridges PDV protocol push messages (kernel → app, with no
 * `in_reply_to`) onto IPC push channels. Only messages that originate from
 * the comm router go through here:
 *
 * - {@link PDVMessageType.TREE_CHANGED} → `IPC.push.treeChanged`
 * - {@link PDVMessageType.PROJECT_LOADED} → `IPC.push.projectLoaded`
 * - {@link PDVMessageType.PROGRESS} → `IPC.push.progress`
 *
 * Other `IPC.push.*` channels (`menuAction`, `installOutput`, `updateStatus`,
 * `kernelCrashed`, `executeOutput`, `moduleExecuteRequest`, `projectReloading`,
 * `chromeStateChanged`, `requestClose`) are emitted directly by the main
 * process from their respective handlers (menu, environment installer,
 * auto-updater, kernel crash watcher, execute streamer, etc.) — they have no
 * comm-router source, so routing them through this function would be a
 * misnomer. The split is intentional, not abandoned scaffolding.
 *
 * @param win - Main BrowserWindow.
 * @param commRouter - Comm router instance.
 * @param moduleWindowManager - Optional module-window manager for broadcasts.
 * @param guiEditorWindowManager - Optional GUI editor window manager.
 * @param guiViewerWindowManager - Optional GUI viewer window manager.
 * @returns Nothing.
 */
export function registerCommPushForwarding(
  win: BrowserWindow,
  commRouter: CommRouter,
  projectManager: ProjectManager,
  moduleWindowManager?: ModuleWindowManager,
  guiEditorWindowManager?: GuiEditorWindowManager,
  guiViewerWindowManager?: GuiViewerWindowManager
): void {
  const subscribe = (type: string, channel: string, broadcast?: boolean): void => {
    const handler = (message: PDVMessage): void => {
      win.webContents.send(channel, message.payload);
      if (broadcast) {
        moduleWindowManager?.broadcastToAll(channel, message.payload);
        guiEditorWindowManager?.broadcastToAll(channel, message.payload);
        guiViewerWindowManager?.broadcastToAll(channel, message.payload);
      }
    };
    commRouter.onPush(type, handler);
    pushSubscriptions.push({ commRouter, type, handler });
  };

  subscribe(PDVMessageType.TREE_CHANGED, IPC.push.treeChanged, true);
  subscribe(PDVMessageType.PROJECT_LOADED, IPC.push.projectLoaded);
  subscribe(PDVMessageType.PROGRESS, IPC.push.progress);

  // Kernel-initiated project operations — forward as menu actions so the
  // renderer drives the full save/load workflow (including code-cell
  // serialization and UI state updates).
  const forwardAsMenuAction = (
    type: string,
    action: "project:save" | "project:saveAs" | "project:openRecent",
  ): void => {
    const handler = (msg: PDVMessage): void => {
      const payload = msg.payload as { save_dir?: string };
      console.log(`[forwardAsMenuAction] received push ${type} → forwarding as ${action} (path=${payload.save_dir ?? "none"})`);
      win.webContents.send(IPC.push.menuAction, { action, path: payload.save_dir });
    };
    commRouter.onPush(type, handler);
    pushSubscriptions.push({ commRouter, type, handler });
  };
  forwardAsMenuAction(PDVMessageType.PROJECT_SAVE_REQUEST, "project:save");
  forwardAsMenuAction(PDVMessageType.PROJECT_SAVE_AS_REQUEST, "project:saveAs");
  forwardAsMenuAction(PDVMessageType.PROJECT_OPEN_REQUEST, "project:openRecent");

  // Kernel-initiated save (pdv.save_project()) — tree is already serialized.
  // Cache the results so ProjectManager.save() skips the comm round-trip
  // (which would deadlock while the kernel shell is still executing user code).
  {
    const handler = (msg: PDVMessage): void => {
      const payload = msg.payload as Record<string, unknown>;
      const saveDir = payload.save_dir as string | undefined;
      if (!saveDir) return;
      console.log(`[save_completed] kernel serialized tree to ${saveDir}, caching results`);
      projectManager.cacheKernelSaveResults(saveDir, {
        checksum: (payload.checksum as string) ?? "",
        nodeCount: (payload.node_count as number) ?? 0,
        moduleOwnedFiles: Array.isArray(payload.module_owned_files)
          ? (payload.module_owned_files as unknown as ModuleOwnedFile[])
          : [],
        moduleManifests: Array.isArray(payload.module_manifests)
          ? (payload.module_manifests as unknown as ModuleManifestBundle[])
          : [],
        missingFiles: Array.isArray(payload.missing_files)
          ? (payload.missing_files as string[])
          : [],
      });
      win.webContents.send(IPC.push.menuAction, { action: "project:save", path: saveDir });
    };
    commRouter.onPush(PDVMessageType.PROJECT_SAVE_COMPLETED, handler);
    pushSubscriptions.push({ commRouter, type: PDVMessageType.PROJECT_SAVE_COMPLETED, handler });
  }
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
