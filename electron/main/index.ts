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
import { registerModulesIpcHandlers } from "./ipc-register-modules";
import { KernelManager, type KernelInfo } from "./kernel-manager";
import { initializeKernelSession } from "./kernel-session";
import { ModuleManager } from "./module-manager";
import {
  bindProjectModulesToTree,
} from "./module-runtime";
import { ProjectManager, type ProjectModuleImport } from "./project-manager";
import { copyFilesForLoad, copyFilesForSave } from "./project-file-sync";
import { ConfigStore } from "./config";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import { registerTreeNamespaceScriptIpcHandlers } from "./ipc-register-tree-namespace-script";
import {
  IPC,
  KernelValidateResult,
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
  IPC.tree.addFile,
  IPC.namespace.query,
  IPC.script.edit,
  IPC.script.reload,
  IPC.modules.listInstalled,
  IPC.modules.install,
  IPC.modules.checkUpdates,
  IPC.modules.importToProject,
  IPC.modules.listImported,
  IPC.modules.saveSettings,
  IPC.modules.runAction,
  IPC.modules.removeImport,
  IPC.project.save,
  IPC.project.load,
  IPC.project.new,
  IPC.config.get,
  IPC.config.set,
  IPC.themes.get,
  IPC.themes.save,
  IPC.codeCells.load,
  IPC.codeCells.save,
  IPC.menu.updateRecentProjects,
  IPC.files.pickExecutable,
  IPC.files.pickFile,
  IPC.files.pickDirectory,
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
// Working-directory helpers
// ---------------------------------------------------------------------------

/**
 * Delete the working directory for a kernel and remove its crash handler.
 *
 * @param projectManager - Project manager used for deletion.
 * @param kernelManager  - Kernel manager used to remove event listeners.
 * @param kernelId       - Kernel whose working dir should be cleaned up.
 */
async function cleanupKernelWorkingDir(
  projectManager: ProjectManager,
  kernelManager: KernelManager,
  kernelId: string
): Promise<void> {
  const oldDir = kernelWorkingDirs.get(kernelId);
  if (oldDir) {
    await projectManager.deleteWorkingDir(oldDir);
    kernelWorkingDirs.delete(kernelId);
  }
  const handler = crashHandlers.get(kernelId);
  if (handler) {
    kernelManager.removeListener("kernel:crashed", handler);
    crashHandlers.delete(kernelId);
  }
}

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
  const current = previous.catch(() => undefined).then(task);
  const completion = current.then(() => undefined, () => undefined);
  projectManifestMutationQueue.set(projectDir, completion);
  return current.finally(() => {
    if (projectManifestMutationQueue.get(projectDir) === completion) {
      projectManifestMutationQueue.delete(projectDir);
    }
  });
}

/**
 * Ensure script names are safe and end with `.py`.
 *
 * @param scriptName - User-provided script name.
 * @returns Sanitized filename.
 */
function sanitizeScriptName(scriptName: string): string {
  const trimmed = scriptName.trim() || "script";
  const withExt = trimmed.endsWith(".py") ? trimmed : `${trimmed}.py`;
  return withExt.replace(/[\\/]/g, "_");
}

function resolveScriptPath(
  kernelId: string,
  scriptPath: string,
  kernelWorkingDirs: Map<string, string>
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
  const leaf = parts[parts.length - 1];
  return path.join(workingDir, ...parts.slice(0, -1), `${leaf}.py`);
}

/**
 * Write a script stub if the file does not already exist.
 *
 * @param scriptPath - Absolute target script path.
 */
async function ensureScriptFile(scriptPath: string): Promise<void> {
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
  const template =
    '"""\n' +
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

  // Handles kernels:list requests from the renderer.
  // Input: none.
  // Returns: KernelInfo[] snapshot.
  // On error: throws to renderer.
  ipcMain.handle(IPC.kernels.list, async () => {
    return kernelManager.list();
  });

  // Handles kernels:start requests from the renderer.
  // Input: optional Partial<KernelSpec>.
  // Returns: KernelInfo for the started kernel.
  // On error: throws to renderer.
  ipcMain.handle(IPC.kernels.start, async (_event, spec) => {
    const requestedSpec = spec as Parameters<KernelManager["start"]>[0];
    const pythonPath =
      requestedSpec?.env?.PYTHON_PATH ??
      (Array.isArray(requestedSpec?.argv) ? requestedSpec.argv[0] : undefined);
    if ((requestedSpec?.language ?? "python") === "python" && pythonPath) {
      const installStatus = await EnvironmentDetector.checkPDVInstalled(pythonPath);
      if (!installStatus.installed) {
        throw new Error(
          `Selected Python runtime is missing pdv_kernel. Install it with: cd pdv-python && ${pythonPath} -m pip install -e ".[dev]"`
        );
      }
    }
    // Starting a new kernel always means a new session — clear any in-memory
    // project state from a previous session (pending imports, active project
    // dir, health warnings) so they don't carry over.
    activeProjectDir = null;
    pendingModuleImports = [];
    pendingModuleSettings = {};
    moduleHealthWarningsByAlias.clear();

    const kernel = await kernelManager.start(
      requestedSpec
    );
    commRouter.attach(kernelManager, kernel.id);
    await initializeKernelSession(
      kernelManager,
      commRouter,
      projectManager,
      kernel.id,
      kernelWorkingDirs
    );
    activeKernelId = kernel.id;
    await bindActiveProjectModules(activeKernelId);

    const onCrash = async (crashedId: string): Promise<void> => {
      if (crashedId !== kernel.id) return;
      await cleanupKernelWorkingDir(projectManager, kernelManager, crashedId);
      if (activeKernelId === crashedId) activeKernelId = null;
      win.webContents.send(IPC.push.kernelStatus, { kernelId: crashedId, status: "dead" });
    };
    crashHandlers.set(kernel.id, onCrash);
    kernelManager.on("kernel:crashed", onCrash);

    return kernel;
  });

  // Handles kernels:stop requests from the renderer.
  // Input: kernelId (string).
  // Returns: true after stop completes.
  // On error: throws to renderer.
  ipcMain.handle(IPC.kernels.stop, async (_event, kernelId: string) => {
    await cleanupKernelWorkingDir(projectManager, kernelManager, kernelId);
    await kernelManager.stop(kernelId);
    if (activeKernelId === kernelId) {
      activeKernelId = null;
    }
    commRouter.detach();
    return true;
  });

  // Handles kernels:execute requests from the renderer.
  // Input: kernelId (string), execute request payload.
  // Returns: KernelExecuteResult.
  // On error: throws to renderer.
  ipcMain.handle(IPC.kernels.execute, async (event, kernelId, request) => {
    return kernelManager.execute(
      kernelId as string,
      request as Parameters<KernelManager["execute"]>[1],
      (chunk) => event.sender.send(IPC.push.executeOutput, chunk)
    );
  });

  // Handles kernels:interrupt requests from the renderer.
  // Input: kernelId (string).
  // Returns: true after interrupt is sent.
  // On error: throws to renderer.
  ipcMain.handle(IPC.kernels.interrupt, async (_event, kernelId: string) => {
    await kernelManager.interrupt(kernelId);
    return true;
  });

  // Handles kernels:restart requests from the renderer.
  // Input: kernelId (string).
  // Returns: KernelInfo for the restarted kernel.
  // On error: throws to renderer.
  ipcMain.handle(IPC.kernels.restart, async (_event, kernelId: string) => {
    // Restart clears the tree — reset in-memory project state so stale
    // pending imports and project dir don't persist into the new session.
    activeProjectDir = null;
    pendingModuleImports = [];
    pendingModuleSettings = {};
    moduleHealthWarningsByAlias.clear();

    const restartable = kernelManager as KernelManager & {
      restart?: (id: string) => Promise<KernelInfo>;
    };
    if (restartable.restart) {
      await cleanupKernelWorkingDir(projectManager, kernelManager, kernelId);
      const restarted = await restartable.restart(kernelId);
      commRouter.attach(kernelManager, restarted.id);
      await initializeKernelSession(
        kernelManager,
        commRouter,
        projectManager,
        restarted.id,
        kernelWorkingDirs
      );
      activeKernelId = restarted.id;
      await bindActiveProjectModules(activeKernelId);
      return restarted;
    }
    const current = kernelManager.getKernel(kernelId);
    if (!current) {
      throw new Error(`Kernel not found: ${kernelId}`);
    }
    await cleanupKernelWorkingDir(projectManager, kernelManager, kernelId);
    await kernelManager.stop(kernelId);
    const restarted = await kernelManager.start({
      name: current.name,
      language: current.language,
    });
    commRouter.attach(kernelManager, restarted.id);
    await initializeKernelSession(
      kernelManager,
      commRouter,
      projectManager,
      restarted.id,
      kernelWorkingDirs
    );
    activeKernelId = restarted.id;
    await bindActiveProjectModules(activeKernelId);
    return restarted;
  });

  // Handles kernels:complete requests from the renderer.
  // Input: kernelId (string), code (string), cursorPos (number).
  // Returns: KernelCompleteResult.
  // On error: throws to renderer.
  ipcMain.handle(
    IPC.kernels.complete,
    async (_event, kernelId: string, code: string, cursorPos: number) => {
      return kernelManager.complete(kernelId, code, cursorPos);
    }
  );

  // Handles kernels:inspect requests from the renderer.
  // Input: kernelId (string), code (string), cursorPos (number).
  // Returns: KernelInspectResult.
  // On error: throws to renderer.
  ipcMain.handle(
    IPC.kernels.inspect,
    async (_event, kernelId: string, code: string, cursorPos: number) => {
      return kernelManager.inspect(kernelId, code, cursorPos);
    }
  );

  // Handles kernels:validate requests from the renderer.
  // Input: executablePath (string), language ('python' | 'julia').
  // Returns: KernelValidateResult.
  // On error: throws to renderer.
  ipcMain.handle(
    IPC.kernels.validate,
    async (_event, executablePath: string, language: "python" | "julia") => {
      const validatable = kernelManager as KernelManager & {
        validate?: (
          execPath: string,
          lang: "python" | "julia"
        ) => Promise<KernelValidateResult>;
      };
      if (validatable.validate) {
        return validatable.validate(executablePath, language);
      }
      if (!executablePath.trim()) {
        return { valid: false, error: "Executable path is required" };
      }
      if (language === "python") {
        const installStatus = await EnvironmentDetector.checkPDVInstalled(
          executablePath.trim()
        );
        if (!installStatus.installed) {
          return {
            valid: false,
            error:
              'Missing pdv_kernel. Install it with: cd pdv-python && <python> -m pip install -e ".[dev]"',
          };
        }
      }
      return { valid: true };
    }
  );

  registerTreeNamespaceScriptIpcHandlers({
    kernelManager,
    commRouter,
    projectManager,
    configStore,
    kernelWorkingDirs,
    readConfig,
    toNamespaceQueryPayload,
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

  // Handles project:save requests from the renderer.
  // Input: saveDir (string), codeCells payload.
  // Returns: true on success.
  // On error: throws to renderer.
  // Merges any pending in-memory module imports/settings into the saved manifest.
  ipcMain.handle(
    IPC.project.save,
    async (_event, saveDir: string, codeCells: unknown) => {
      await projectManager.save(saveDir, codeCells);

      // Merge pending in-memory module imports/settings into the on-disk manifest.
      if (pendingModuleImports.length > 0 || Object.keys(pendingModuleSettings).length > 0) {
        await runSerializedProjectManifestMutation(saveDir, async () => {
          const manifest = await ProjectManager.readManifest(saveDir);
          const mergedManifest = {
            ...manifest,
            modules: [...manifest.modules, ...pendingModuleImports],
            module_settings: { ...manifest.module_settings, ...pendingModuleSettings },
          };
          await ProjectManager.saveManifest(saveDir, mergedManifest);
        });
        pendingModuleImports = [];
        pendingModuleSettings = {};
      }

      // Copy file-backed node files from working dir into save dir.
      if (activeKernelId) {
        const workingDir = kernelWorkingDirs.get(activeKernelId);
        if (workingDir) await copyFilesForSave(workingDir, saveDir);
      }

      activeProjectDir = saveDir;
      await refreshProjectModuleHealth(activeProjectDir);
      return true;
    }
  );

  // Handles project:load requests from the renderer.
  // Input: saveDir (string).
  // Returns: code cell payload loaded by ProjectManager.
  // On error: throws to renderer.
  ipcMain.handle(IPC.project.load, async (_event, saveDir: string) => {
    // Copy file-backed node files from save dir into working dir before kernel load.
    if (activeKernelId) {
      const workingDir = kernelWorkingDirs.get(activeKernelId);
      if (workingDir) await copyFilesForLoad(saveDir, workingDir);
    }

    const loaded = await projectManager.load(saveDir);
    activeProjectDir = saveDir;
    pendingModuleImports = [];
    pendingModuleSettings = {};
    const manifest = await refreshProjectModuleHealth(activeProjectDir);
    await bindActiveProjectModules(activeKernelId, manifest?.modules);
    return loaded;
  });

  // Handles project:new requests from the renderer.
  // Input: none.
  // Returns: true.
  // On error: throws to renderer.
  ipcMain.handle(IPC.project.new, async () => {
    activeProjectDir = null;
    pendingModuleImports = [];
    pendingModuleSettings = {};
    moduleHealthWarningsByAlias.clear();
    return true;
  });

  registerAppStateIpcHandlers({
    configStore,
    readConfig,
    themesDir,
    stateDir,
    codeCellsPath,
  });

  registerPushForwarding(win, commRouter);

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
  commRouter: CommRouter
): void {
  const subscribe = (type: string, channel: string): void => {
    const handler = (message: PDVMessage): void => {
      win.webContents.send(channel, message.payload);
    };
    commRouter.onPush(type, handler);
    pushSubscriptions.push({ commRouter, type, handler });
  };

  subscribe(PDVMessageType.TREE_CHANGED, IPC.push.treeChanged);
  subscribe(PDVMessageType.PROJECT_LOADED, IPC.push.projectLoaded);
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
