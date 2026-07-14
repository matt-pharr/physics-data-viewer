/**
 * index.ts — IPC handler registration and comm push forwarding.
 *
 * Registers all `handleIpc(...)` channels consumed by the preload
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

import { BrowserWindow, app } from "electron";
import { removeAllIpcHandlers } from "./ipc-registry";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";

import { CommRouter } from "./comm-router";
import { QueryRouter } from "./query-router";
import { EnvironmentDetector } from "./environment-detector";
import { buildEditorSpawn, resolveEditorSpawn } from "./editor-spawn";
import {
  registerKernelIpcHandlers,
  removeKernelMemoryListener,
} from "./ipc-register-kernels";
import { registerModulesIpcHandlers } from "./ipc-register-modules";
import { registerProjectIpcHandlers } from "./ipc-register-project";
import { shouldBumpOnSwap } from "./mcp/generation-guard";
import { KernelManager } from "./kernel-manager";
import { ModuleManager } from "./module-manager";
import { bindProjectModulesToTree } from "./module-runtime";
import { syncUvEnvironmentForLoad } from "./project-file-sync";
import {
  ProjectManager,
  type ProjectModuleImport,
  type ModuleOwnedFile,
  type ModuleManifestBundle,
} from "./project-manager";
import { ConfigStore, DEFAULT_AUTOSAVE_INTERVAL_S } from "./config";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import { registerAutosaveIpcHandlers } from "./ipc-register-autosave";
import { registerEnvironmentIpcHandlers } from "./ipc-register-environment";
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
  type ActiveEnvironmentInfo,
  type McpStatus,
} from "./ipc";
import { uvSync } from "./uv-runner";
import { PDVMessage, PDVMessageType, setAppVersion } from "./pdv-protocol";
import { registerLaunchersIpcHandlers } from "./ipc-register-launchers";
import type { McpServerHooks } from "./mcp/mcp-context";
import {
  allocateAndRegisterLib,
  allocateAndRegisterNote,
  allocateAndRegisterScript,
} from "./tree-create";

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

interface PushSubscription {
  commRouter: CommRouter;
  type: string;
  handler: (message: PDVMessage) => void;
}

const pushSubscriptions: PushSubscription[] = [];
const kernelWorkingDirs = new Map<string, string>();
/**
 * Per-kernel environment metadata: mode (uv vs shared), the interpreter the
 * kernel actually spawned on, and its resolved Python version. Populated by
 * `kernels.start`/`kernels.restart`, deleted on stop; survives crashes so a
 * crash-restart can carry the environment over. Authoritative source for
 * the manifest's `environment`/`interpreter_path` fields at save time
 * (§10.5) and for the Project Environment settings tab (`environment:activeInfo`).
 */
const kernelEnvMeta = new Map<string, ActiveEnvironmentInfo>();
const crashHandlers = new Map<string, (id: string) => void>();
const projectManifestMutationQueue = new Map<string, Promise<void>>();
let activeKernelManagerRef: KernelManager | null = null;
// The kernel:executionState listener attached by registerIpcHandlers(). Stored
// at module scope so unregisterIpcHandlers() can detach it symmetrically.
let trackedExecutionStateListener:
  | { km: KernelManager; fn: (kernelId: string, state: string) => void }
  | null = null;

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
 * The stem becomes the script's tree key, and tree keys are dot-path
 * segments — a `.` inside the stem would corrupt path addressing, so only
 * identifier characters survive. Mirrors the renderer-side preview in
 * `CreateTreeItemDialog`.
 *
 * @param scriptName - User-provided script name.
 * @param language - Target language (determines file extension).
 * @returns Sanitized filename (`<identifier-safe stem><ext>`).
 */
function sanitizeScriptName(scriptName: string, language: "python" | "julia" = "python"): string {
  const ext = language === "julia" ? ".jl" : ".py";
  const stem =
    scriptName
      .trim()
      .replace(/\.(py|jl)$/i, "")
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_]/g, "") || "script";
  return `${stem}${ext}`;
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
      // pdv_tree is a PDVTree — an AbstractDict subtype, not a concrete Dict —
      // so the annotation must be AbstractDict for dispatch to accept it.
      "function run(pdv_tree::AbstractDict; kwargs...)\n" +
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
 * @param language - Active kernel language. Python stubs are plain modules;
 *   Julia stubs wrap a ``module <stem> ... end`` so the include-based lib
 *   loader can bind and re-export them.
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
      "=#\n" +
      // The lib loader (`load_lib_file!`) includes this file into Main and
      // binds `Main.<stem>` — the module wrapper is what makes the lib's
      // exports visible to sibling scripts, so it must not be removed.
      `module ${path.parse(filename).name}\n\n` +
      "# Define helper functions below — exported names become available\n" +
      "# in sibling scripts automatically.\n\n" +
      "# export example\n" +
      "# function example(x)\n" +
      "#     return x\n" +
      "# end\n\n" +
      `end # module ${path.parse(filename).name}\n`
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
 * Register all `handleIpc(...)` channels required by Step 5.
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
  // Project/kernel generation counter — bumped on project switch/reload,
  // kernel restart, and environment change so connected MCP sessions can
  // detect that the project changed underneath them (ARCHITECTURE.md §15.3).
  let generation = 0;
  const bumpGeneration = (): void => {
    generation += 1;
  };
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

  // Autosave handlers + the snapshot routines shared with the kernel
  // registrar (pre-restart snapshot, post-restart recovery) and the
  // execution-state idle listener below.
  const autosave = registerAutosaveIpcHandlers({
    win,
    kernelManager,
    commRouter,
    projectManager,
    moduleManager,
    configStore,
    kernelWorkingDirs,
    readConfig,
    getActiveKernelId: () => activeKernelId,
    getActiveProjectDir: () => activeProjectDir,
    getPendingModuleImports: () => pendingModuleImports,
    getPendingModuleSettings: () => pendingModuleSettings,
    setPendingModuleState: (imports, settings) => {
      pendingModuleImports = imports;
      pendingModuleSettings = settings;
    },
  });

  registerKernelIpcHandlers({
    win,
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    moduleManager,
    kernelWorkingDirs,
    kernelEnvMeta,
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
      const prevId = activeKernelId;
      activeKernelId = id;
      // A kernel switch (restart, language change) invalidates connected MCP
      // sessions. See `shouldBumpOnSwap` for the no-bump cases (initial set,
      // re-assertion of the same id).
      if (shouldBumpOnSwap(prevId, id)) {
        bumpGeneration();
      }
      if (id) {
        const config = readConfig(configStore);
        const intervalMs = (config.autoSaveIntervalSeconds ?? DEFAULT_AUTOSAVE_INTERVAL_S) * 1000;
        projectManager.startAutosaveTimer(intervalMs, autosave.triggerAutosave);
      } else {
        projectManager.stopAutosaveTimer();
      }
    },
    getActiveKernelId: () => activeKernelId,
    getActiveProjectDir: () => activeProjectDir,
    getWorkingDirBase: () => readConfig(configStore).workingDirBase,
    getDefaultPackages: () => readConfig(configStore).defaultPackages ?? [],
    getUvBinaryPath: () => readConfig(configStore).uv?.binaryPath,
    bindActiveProjectModules,
    autosaveBeforeRestart: autosave.autosaveBeforeRestart,
    recoverUnsavedAfterRestart: async (orphanDir: string) => {
      await autosave.recoverUnsavedSession(orphanDir);
    },
  });

  // Aggregate module aliases from the active on-disk manifest plus any
  // in-memory pending imports (the latter carries in-session modules
  // created by modules:createEmpty before the first save). Both the tree
  // create* IPC handlers and the MCP `create_tree_node` tool consume this
  // to route module-owned files through the `<workdir>/<alias>/...` layout
  // with `source_rel_path` set.
  const getKnownModuleAliases = async (): Promise<Set<string>> => {
    const manifest = await readActiveProjectManifest();
    const disk = manifest?.modules ?? [];
    return new Set([
      ...disk.map((m) => m.alias),
      ...pendingModuleImports.map((m) => m.alias),
    ]);
  };

  registerTreeNamespaceScriptIpcHandlers({
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    configStore,
    kernelWorkingDirs,
    getKnownModuleAliases,
    readConfig,
    toNamespaceQueryPayload,
    toNamespaceInspectPayload,
    sanitizeScriptName,
    ensureScriptFile,
    ensureLibFile,
    buildEditorSpawn,
    resolveEditorSpawn,
  });

  registerLaunchersIpcHandlers({
    kernelWorkingDirs,
    getActiveKernelId: () => activeKernelId,
    getActiveProjectDir: () => activeProjectDir,
    getConfig: () => readConfig(configStore),
    getMcpStatus: () => mcpServerInstance?.status ?? null,
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

  // Environment discovery/install + Packages tab + installModule. Returns
  // the import-cache refresher the project-load env sync below reuses.
  const { refreshKernelImportCaches } = registerEnvironmentIpcHandlers({
    win,
    configStore,
    kernelManager,
    kernelWorkingDirs,
    kernelEnvMeta,
    getActiveKernelId: () => activeKernelId,
    readConfig,
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
    setActiveProjectDir: (dir) => {
      const prevDir = activeProjectDir;
      activeProjectDir = dir;
      // Only a real switch invalidates connected MCP sessions. See
      // `shouldBumpOnSwap` for the no-bump cases (initial set; re-assertion
      // of the same dir, which `project:save` does on every save).
      if (shouldBumpOnSwap(prevDir, dir)) {
        bumpGeneration();
      }
    },
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
    getActiveKernelEnvMeta: () =>
      activeKernelId ? kernelEnvMeta.get(activeKernelId) : undefined,
    // Re-point the running uv session's environment at the opened project:
    // copy its env files over the previous project's, `uv sync` the venv
    // (streamed over envActivity), and refresh the kernel's import caches so
    // newly synced packages import without a restart (§10.5.11 mechanism).
    syncUvEnvironmentForLoad: async (saveDir, workingDir) => {
      const result = await syncUvEnvironmentForLoad(saveDir, workingDir, {
        runningPythonVersion: activeKernelId
          ? kernelEnvMeta.get(activeKernelId)?.pythonVersion
          : undefined,
        runUvSync: async (cwd) => {
          const sync = await uvSync({
            cwd,
            win,
            pushChannel: IPC.push.envActivity,
            binaryPath: readConfig(configStore).uv?.binaryPath,
            // In-place sync under a live kernel: --inexact keeps pdv-python
            // (installed outside the lock) from being uninstalled.
            inexact: true,
          });
          return { success: sync.success, output: sync.output };
        },
      });
      if (result.synced) await refreshKernelImportCaches();
      return result;
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
    onConfigChanged: (prev, next) => {
      if (prev.autoSaveIntervalSeconds !== next.autoSaveIntervalSeconds && activeKernelId) {
        const intervalMs = (next.autoSaveIntervalSeconds ?? DEFAULT_AUTOSAVE_INTERVAL_S) * 1000;
        projectManager.startAutosaveTimer(intervalMs, autosave.triggerAutosave);
      }
    },
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

  // When kernel goes idle and an autosave was deferred, trigger it now.
  // Tracked in `executionStateListener` so unregisterIpcHandlers can detach
  // it; otherwise repeated registerIpcHandlers calls (tests, future re-init)
  // would accumulate listeners.
  const executionStateListener = (kernelId: string, state: string): void => {
    if (kernelId !== activeKernelId) return;
    if (state === "idle" && projectManager.consumeAutosavePending()) {
      console.log("[autosave] kernel idle, running deferred autosave");
      autosave.triggerAutosave();
    }
  };
  kernelManager.on("kernel:executionState", executionStateListener);
  trackedExecutionStateListener = { km: kernelManager, fn: executionStateListener };

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

  // Publish the lifecycle hooks the MCP server reads (ARCHITECTURE.md §15).
  const treeCreateBaseDeps = {
    kernelManager,
    commRouter,
    projectManager,
    configStore,
    kernelWorkingDirs,
    readConfig,
  };
  mcpServerHooks = {
    getActiveKernelId: () => activeKernelId,
    getActiveProjectDir: () => activeProjectDir,
    getActiveWorkingDir: () =>
      activeKernelId ? (kernelWorkingDirs.get(activeKernelId) ?? null) : null,
    getGeneration: () => generation,
    bumpGeneration,
    treeCreate: {
      script: (kernelId, parentPath, scriptName) =>
        allocateAndRegisterScript(
          {
            ...treeCreateBaseDeps,
            getKnownModuleAliases,
            sanitizeScriptName,
            ensureScriptFile,
          },
          kernelId,
          parentPath,
          scriptName,
        ),
      note: (kernelId, parentPath, noteName) =>
        allocateAndRegisterNote(
          treeCreateBaseDeps,
          kernelId,
          parentPath,
          noteName,
        ),
      lib: (kernelId, parentPath, libName) =>
        allocateAndRegisterLib(
          {
            ...treeCreateBaseDeps,
            getKnownModuleAliases,
            ensureLibFile,
          },
          kernelId,
          parentPath,
          libName,
        ),
    },
  };

  return resetSessionState;
}

/**
 * MCP server lifecycle hooks, populated by {@link registerIpcHandlers} when
 * the window's IPC handlers are registered. `null` before that point.
 */
let mcpServerHooks: McpServerHooks | null = null;

/**
 * Get the MCP server lifecycle hooks.
 *
 * @returns The hooks, or `null` if IPC handlers have not been registered yet.
 */
export function getMcpServerHooks(): McpServerHooks | null {
  return mcpServerHooks;
}

/**
 * Live MCP server reference, set by `bootstrap.ts` once the server has
 * started. The agent-launcher IPC handler reads `.status` from it at
 * click time. `null` before the server starts (and in tests).
 *
 * Typed structurally so this module does not import the `PdvMcpServer`
 * class (which would pull MCP-server transitive deps into every importer).
 */
let mcpServerInstance: { status: McpStatus } | null = null;

/**
 * Register (or clear) the live MCP server reference.
 *
 * @param server - The running MCP server, or `null` to clear.
 */
export function setMcpServerInstance(
  server: { status: McpStatus } | null,
): void {
  mcpServerInstance = server;
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
  removeAllIpcHandlers();
  removeKernelMemoryListener();
  if (trackedExecutionStateListener) {
    trackedExecutionStateListener.km.removeListener(
      "kernel:executionState",
      trackedExecutionStateListener.fn,
    );
    trackedExecutionStateListener = null;
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
  kernelEnvMeta.clear();
  crashHandlers.clear();
  clearPushSubscriptions();
}
