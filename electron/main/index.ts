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

import { ipcMain, BrowserWindow, dialog, app } from "electron";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";

import { CommRouter } from "./comm-router";
import { EnvironmentDetector } from "./environment-detector";
import { KernelManager, type KernelInfo } from "./kernel-manager";
import { ModuleManager } from "./module-manager";
import { ProjectManager, type ProjectModuleImport } from "./project-manager";
import { ConfigStore } from "./config";
import { updateRecentProjectsMenu } from "./menu";
import {
  CodeCellData,
  IPC,
  KernelCompleteResult,
  KernelInspectResult,
  KernelValidateResult,
  ImportedModuleDescriptor,
  ModuleActionRequest,
  ModuleActionResult,
  ModuleDescriptor,
  ModuleImportRequest,
  ModuleImportResult,
  ModuleInstallRequest,
  ModuleInstallResult,
  ModuleInputValue,
  ModuleHealthWarning,
  ModuleSettingsRequest,
  ModuleSettingsResult,
  ModuleUpdateResult,
  NamespaceQueryOptions,
  NamespaceVariable,
  PDVConfig,
  ScriptOperationResult,
  Theme,
  TreeCreateScriptResult,
  TreeNode,
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

let savedThemes: Theme[] = [];
let savedCodeCells: CodeCellData | null = null;

interface PushSubscription {
  commRouter: CommRouter;
  type: string;
  handler: (message: PDVMessage) => void;
}

const pushSubscriptions: PushSubscription[] = [];
const kernelWorkingDirs = new Map<string, string>();

const BOOTSTRAP_AND_OPEN_COMM = `
from IPython import get_ipython
import pdv_kernel
import pdv_kernel.comms as _pdv_comms
try:
    from ipykernel.comm import Comm
except Exception:
    from comm import Comm
_ip = get_ipython()
pdv_kernel.bootstrap(_ip)
if _pdv_comms._comm is None:
    _pdv_comm = Comm(target_name="pdv.kernel")
    _pdv_comms._comm = _pdv_comm
    _pdv_comm.on_msg(_pdv_comms._on_comm_message)
    _pdv_comms.send_message("pdv.ready", {})
`;

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
  const raw = configStore.getAll() as unknown as Partial<PDVConfig>;
  return { ...DEFAULT_CONFIG, ...raw };
}

/**
 * Resolve and expand an editor command for a given file path.
 *
 * The command string may contain `{}` as a placeholder for the file path.
 * If no placeholder is present the path is appended as the last argument.
 * Defaults to `"code {}"` (VS Code) when no command is configured.
 *
 * @param cmdString - Raw command string from config, e.g. `"nvim {}"`.
 * @param filePath  - Absolute path to the file to open.
 * @returns Object with the executable and expanded argument list.
 */
function buildEditorSpawn(
  cmdString: string | undefined,
  filePath: string,
): { file: string; args: string[] } {
  const raw = (cmdString ?? "code {}").trim() || "code {}";
  const parts = raw.split(/\s+/).filter(Boolean);
  const PLACEHOLDER = "{}";
  const hasPlaceholder = parts.includes(PLACEHOLDER);
  const expanded = hasPlaceholder
    ? parts.map((p) => (p === PLACEHOLDER ? filePath : p))
    : [...parts, filePath];
  return { file: expanded[0], args: expanded.slice(1) };
}

const TERMINAL_EDITORS = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "pico",
  "emacs",
  "kak",
  "hx",
  "helix",
]);

function isTerminalEditorCommand(command: string): boolean {
  const bin = path.basename(command).toLowerCase().replace(/\.exe$/, "");
  return TERMINAL_EDITORS.has(bin);
}

function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function resolveEditorSpawn(
  command: string,
  args: string[],
): { file: string; args: string[] } {
  if (process.platform === "darwin" && isTerminalEditorCommand(command)) {
    const shellCommand = [command, ...args].map(quoteShellArg).join(" ");
    return {
      file: "osascript",
      args: [
        "-e",
        `tell application "Terminal" to do script ${JSON.stringify(shellCommand)}`,
        "-e",
        'tell application "Terminal" to activate',
      ],
    };
  }
  return { file: command, args };
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

function normalizeModuleAlias(rawAlias: string): string {
  const trimmed = rawAlias.trim();
  if (!trimmed) {
    throw new Error("Module alias must be a non-empty string");
  }
  return trimmed.replace(/[./\\\s]+/g, "_");
}

function suggestModuleAlias(baseAlias: string, existingAliases: Set<string>): string {
  let i = 1;
  while (existingAliases.has(`${baseAlias}_${i}`)) {
    i += 1;
  }
  return `${baseAlias}_${i}`;
}

function isMissingActionScriptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Module action script does not exist") ||
    message.includes("Module action script is not a file")
  );
}

/**
 * Convert one module input value into a Python argument expression.
 *
 * String values are treated as user-provided Python expressions for backward
 * compatibility with existing text inputs.
 *
 * @param value - Raw value from module settings/UI state.
 * @returns Python expression string, or null when the value is empty.
 */
function toPythonArgumentValue(value: ModuleInputValue): string | null {
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return String(value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

async function bindImportedModuleScripts(
  commRouter: CommRouter,
  moduleManager: ModuleManager,
  importedModule: ProjectModuleImport,
  workingDir: string | undefined
): Promise<void> {
  let scriptBindings: Awaited<ReturnType<ModuleManager["resolveActionScripts"]>>;
  try {
    scriptBindings = await moduleManager.resolveActionScripts(
      importedModule.module_id
    );
  } catch (error) {
    if (isMissingActionScriptError(error)) {
      return;
    }
    throw error;
  }
  const parentPath = `${importedModule.alias}.scripts`;
  for (const binding of scriptBindings) {
    let registeredPath = binding.scriptPath;

    // Copy the module script into the kernel working directory so that
    // editing (press E) opens a working copy rather than the module store
    // file under ~/.PDV.
    if (workingDir) {
      const destDir = path.join(
        workingDir,
        ...parentPath.split(".").filter(Boolean)
      );
      await fs.mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, path.basename(binding.scriptPath));
      await fs.copyFile(binding.scriptPath, destPath);
      registeredPath = destPath;
    }

    await commRouter.request(PDVMessageType.SCRIPT_REGISTER, {
      parent_path: parentPath,
      name: binding.name,
      relative_path: registeredPath,
      language: "python",
      reload: true,
    });
  }
}

async function bindProjectModulesToTree(
  kernelManager: KernelManager,
  commRouter: CommRouter,
  moduleManager: ModuleManager,
  activeKernelId: string | null,
  projectDir: string | null,
  importedModules?: ProjectModuleImport[],
  workingDir?: string
): Promise<void> {
  if (!activeKernelId || !projectDir) {
    return;
  }
  if (!kernelManager.getKernel(activeKernelId)) {
    return;
  }
  const modules =
    importedModules ?? (await ProjectManager.readManifest(projectDir)).modules;
  for (const importedModule of modules) {
    await bindImportedModuleScripts(commRouter, moduleManager, importedModule, workingDir);
  }
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

async function waitForPush(
  commRouter: CommRouter,
  type: string,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      commRouter.offPush(type, handler);
      reject(new Error(`Timed out waiting for push: ${type}`));
    }, timeoutMs);
    const handler = (): void => {
      clearTimeout(timer);
      commRouter.offPush(type, handler);
      resolve();
    };
    commRouter.onPush(type, handler);
  });
}

async function initializeKernelSession(
  kernelManager: KernelManager,
  commRouter: CommRouter,
  projectManager: ProjectManager,
  kernelId: string
): Promise<void> {
  const readyPromise = waitForPush(commRouter, PDVMessageType.READY, 15_000);
  const bootstrapResult = await kernelManager.execute(kernelId, {
    code: BOOTSTRAP_AND_OPEN_COMM,
    silent: true,
  });
  if (bootstrapResult.error) {
    throw new Error(bootstrapResult.error);
  }
  await readyPromise;
  const workingDir = await projectManager.createWorkingDir();
  await commRouter.request(PDVMessageType.INIT, {
    working_dir: workingDir,
    pdv_version: "1.0",
  });
  kernelWorkingDirs.set(kernelId, workingDir);
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
): void {
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
    } catch {
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

  fs.mkdir(themesDir, { recursive: true }).catch(() => {});
  fs.mkdir(stateDir,  { recursive: true }).catch(() => {});

  // Populate savedThemes from disk on first call: load PDV-saved themes +
  // any .json files the user has dropped in ~/.PDV/themes/.
  if (savedThemes.length === 0) {
    try {
      const entries = fsSync.readdirSync(themesDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = fsSync.readFileSync(path.join(themesDir, entry), "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            if (typeof obj.name === "string" && obj.colors && typeof obj.colors === "object") {
              savedThemes.push({ name: obj.name, colors: obj.colors as Record<string, string> });
            }
          }
        } catch {
          // skip malformed files
        }
      }
    } catch {
      // themes dir may not exist yet
    }
  }

  // Populate savedCodeCells from disk on first call.
  if (savedCodeCells === null) {
    try {
      const raw = fsSync.readFileSync(codeCellsPath, "utf8");
      savedCodeCells = JSON.parse(raw) as CodeCellData;
    } catch {
      // file may not exist yet
    }
  }

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
    const kernel = await kernelManager.start(
      spec as Parameters<KernelManager["start"]>[0]
    );
    commRouter.attach(kernelManager, kernel.id);
    await initializeKernelSession(kernelManager, commRouter, projectManager, kernel.id);
    activeKernelId = kernel.id;
    await bindProjectModulesToTree(
      kernelManager,
      commRouter,
      moduleManager,
      activeKernelId,
      activeProjectDir,
      undefined,
      kernelWorkingDirs.get(kernel.id)
    );
    return kernel;
  });

  // Handles kernels:stop requests from the renderer.
  // Input: kernelId (string).
  // Returns: true after stop completes.
  // On error: throws to renderer.
  ipcMain.handle(IPC.kernels.stop, async (_event, kernelId: string) => {
    await kernelManager.stop(kernelId);
    const workingDir = kernelWorkingDirs.get(kernelId);
    if (workingDir) {
      await projectManager.deleteWorkingDir(workingDir);
      kernelWorkingDirs.delete(kernelId);
    }
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
    const restartable = kernelManager as KernelManager & {
      restart?: (id: string) => Promise<KernelInfo>;
    };
    if (restartable.restart) {
      const restarted = await restartable.restart(kernelId);
      commRouter.attach(kernelManager, restarted.id);
      await initializeKernelSession(kernelManager, commRouter, projectManager, restarted.id);
      activeKernelId = restarted.id;
      await bindProjectModulesToTree(
        kernelManager,
        commRouter,
        moduleManager,
        activeKernelId,
        activeProjectDir,
        undefined,
        kernelWorkingDirs.get(restarted.id)
      );
      return restarted;
    }
    const current = kernelManager.getKernel(kernelId);
    if (!current) {
      throw new Error(`Kernel not found: ${kernelId}`);
    }
    await kernelManager.stop(kernelId);
    const restarted = await kernelManager.start({
      name: current.name,
      language: current.language,
    });
    commRouter.attach(kernelManager, restarted.id);
    await initializeKernelSession(kernelManager, commRouter, projectManager, restarted.id);
    activeKernelId = restarted.id;
    await bindProjectModulesToTree(
      kernelManager,
      commRouter,
      moduleManager,
      activeKernelId,
      activeProjectDir,
      undefined,
      kernelWorkingDirs.get(restarted.id)
    );
    return restarted;
  });

  // Handles kernels:complete requests from the renderer.
  // Input: kernelId (string), code (string), cursorPos (number).
  // Returns: KernelCompleteResult.
  // On error: throws to renderer.
  ipcMain.handle(
    IPC.kernels.complete,
    async (_event, kernelId: string, code: string, cursorPos: number) => {
      const completable = kernelManager as KernelManager & {
        complete?: (
          id: string,
          source: string,
          pos: number
        ) => Promise<KernelCompleteResult>;
      };
      if (completable.complete) {
        return completable.complete(kernelId, code, cursorPos);
      }
      return {
        matches: [],
        cursor_start: cursorPos,
        cursor_end: cursorPos,
      };
    }
  );

  // Handles kernels:inspect requests from the renderer.
  // Input: kernelId (string), code (string), cursorPos (number).
  // Returns: KernelInspectResult.
  // On error: throws to renderer.
  ipcMain.handle(
    IPC.kernels.inspect,
    async (_event, kernelId: string, code: string, cursorPos: number) => {
      const inspectable = kernelManager as KernelManager & {
        inspect?: (
          id: string,
          source: string,
          pos: number
        ) => Promise<KernelInspectResult>;
      };
      if (inspectable.inspect) {
        return inspectable.inspect(kernelId, code, cursorPos);
      }
      return { found: false };
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
      return { valid: true };
    }
  );

  // Handles tree:list requests from the renderer.
  // Input: kernelId (string), path (string, optional).
  // Returns: TreeNode[].
  // On error: returns [] if kernel is absent; otherwise throws.
  ipcMain.handle(IPC.tree.list, async (_event, kernelId: string, nodePath = "") => {
    if (!kernelManager.getKernel(kernelId)) {
      return [] as TreeNode[];
    }
    const response = await commRouter.request(PDVMessageType.TREE_LIST, {
      path: nodePath,
    });
    const nodes = (response.payload as { nodes?: unknown }).nodes;
    return Array.isArray(nodes) ? (nodes as TreeNode[]) : [];
  });

  // Handles tree:get requests from the renderer.
  // Input: kernelId (string), path (string).
  // Returns: Payload object from pdv.tree.get.response.
  // On error: throws to renderer.
  ipcMain.handle(IPC.tree.get, async (_event, kernelId: string, nodePath: string) => {
    if (!kernelManager.getKernel(kernelId)) {
      throw new Error(`Kernel not found: ${kernelId}`);
    }
    const response = await commRouter.request(PDVMessageType.TREE_GET, {
      path: nodePath,
    });
    return response.payload;
  });

  // Handles tree:createScript requests from the renderer.
  // Input: kernelId (string), targetPath (string), scriptName (string).
  // Returns: script creation result payload.
  // On error: throws to renderer.
  ipcMain.handle(
    IPC.tree.createScript,
    async (
      _event,
      kernelId: string,
      targetPath: string,
      scriptName: string
    ): Promise<TreeCreateScriptResult> => {
      if (!kernelManager.getKernel(kernelId)) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      let workingDir = kernelWorkingDirs.get(kernelId);
      if (!workingDir) {
        workingDir = await projectManager.createWorkingDir();
        kernelWorkingDirs.set(kernelId, workingDir);
      }
      const safeName = sanitizeScriptName(scriptName);
      const scriptNodeName = path.parse(safeName).name;
      const scriptsDir = path.join(
        workingDir,
        ...targetPath.split(".").filter(Boolean)
      );
      await fs.mkdir(scriptsDir, { recursive: true });
      const scriptPath = path.join(scriptsDir, safeName);
      await ensureScriptFile(scriptPath);

      await commRouter.request(PDVMessageType.SCRIPT_REGISTER, {
        parent_path: targetPath,
        name: scriptNodeName,
        relative_path: scriptPath,
        language: "python",
      });
      return { success: true, scriptPath };
    }
  );

  // Handles namespace:query requests from the renderer.
  // Input: kernelId (string), optional NamespaceQueryOptions.
  // Returns: NamespaceVariable[].
  // On error: throws to renderer.
  ipcMain.handle(
    IPC.namespace.query,
    async (
      _event,
      kernelId: string,
      options?: NamespaceQueryOptions
    ): Promise<NamespaceVariable[]> => {
      if (!kernelManager.getKernel(kernelId)) {
        return [];
      }
      const response = await commRouter.request(
        PDVMessageType.NAMESPACE_QUERY,
        toNamespaceQueryPayload(options)
      );
      const variables = (response.payload as { variables?: unknown }).variables;
      let normalized: NamespaceVariable[] = [];
      if (Array.isArray(variables)) {
        normalized = variables as NamespaceVariable[];
      } else if (variables && typeof variables === "object") {
        normalized = Object.entries(variables as Record<string, unknown>).map(
          ([name, value]) => ({
            name,
            ...(typeof value === "object" && value !== null
              ? (value as Record<string, unknown>)
              : {}),
          })
        ) as NamespaceVariable[];
      }
      if (!normalized.some((entry) => entry.name === "pdv_tree")) {
        normalized.unshift({
          name: "pdv_tree",
          type: "protected",
          preview: "PDVTree (protected)",
        });
      }
      if (!normalized.some((entry) => entry.name === "pdv")) {
        normalized.unshift({
          name: "pdv",
          type: "protected",
          preview: "PDV app object (protected)",
        });
      }
      return normalized;
    }
  );

  // Handles script:edit requests from the renderer.
  // Input: scriptPath (string).
  // Returns: ScriptOperationResult.
  // On error: throws to renderer.
  ipcMain.handle(IPC.script.edit, async (_event, kernelId: string, scriptPath: string) => {
    const config = readConfig(configStore);
    const resolvedScriptPath = resolveScriptPath(kernelId, scriptPath, kernelWorkingDirs);
    const isJulia = resolvedScriptPath.endsWith(".jl");
    const cmdString = isJulia ? config.juliaEditorCmd : config.pythonEditorCmd;
    const { file, args } = buildEditorSpawn(cmdString, resolvedScriptPath);
    const spawnSpec = resolveEditorSpawn(file, args);
    const child = spawn(spawnSpec.file, spawnSpec.args, { detached: true, stdio: "ignore" });
    child.unref();
    const result: ScriptOperationResult = { success: true };
    return result;
  });

  // Handles script:reload requests from the renderer.
  // Input: treePath (string) — dot-separated tree path for the script.
  // Returns: ScriptOperationResult.
  // On error: throws to renderer.
  ipcMain.handle(IPC.script.reload, async (_event, treePath: string) => {
    const lastDot = treePath.lastIndexOf(".");
    const parentPath = lastDot >= 0 ? treePath.slice(0, lastDot) : "";
    const name = lastDot >= 0 ? treePath.slice(lastDot + 1) : treePath;
    await commRouter.request(PDVMessageType.SCRIPT_REGISTER, {
      parent_path: parentPath,
      name,
      relative_path: treePath,
      language: "python",
      reload: true,
    });
    const result: ScriptOperationResult = { success: true };
    return result;
  });

  // Handles modules:listInstalled requests from the renderer.
  // Input: none.
  // Returns: installed module descriptors (empty until ModuleManager is implemented).
  ipcMain.handle(
    IPC.modules.listInstalled,
    async (): Promise<ModuleDescriptor[]> => moduleManager.listInstalled()
  );

  // Handles modules:install requests from the renderer.
  // Input: ModuleInstallRequest.
  // Returns: placeholder not-implemented result.
  ipcMain.handle(
    IPC.modules.install,
    async (_event, request: ModuleInstallRequest): Promise<ModuleInstallResult> =>
      moduleManager.install(request)
  );

  // Handles modules:checkUpdates requests from the renderer.
  // Input: moduleId (string).
  // Returns: placeholder not-implemented update status.
  ipcMain.handle(
    IPC.modules.checkUpdates,
    async (_event, moduleId: string): Promise<ModuleUpdateResult> =>
      moduleManager.checkUpdates(moduleId)
  );

  // Handles modules:importToProject requests from the renderer.
  // Input: ModuleImportRequest.
  // Returns: project-scoped import result with alias conflict handling.
  // Works both with a saved project (persists to disk) and without one
  // (holds imports in memory until the next project:save).
  ipcMain.handle(
    IPC.modules.importToProject,
    async (_event, request: ModuleImportRequest): Promise<ModuleImportResult> => {
      const installedModules = await moduleManager.listInstalled();
      const installed = installedModules.find(
        (entry) => entry.id === request.moduleId
      );
      if (!installed) {
        return {
          success: false,
          status: "error",
          error: `Installed module not found: ${request.moduleId}`,
        };
      }

      // Build the combined alias set from disk manifest (if any) + pending in-memory imports.
      let diskModules: ProjectModuleImport[] = [];
      if (activeProjectDir) {
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        diskModules = manifest.modules;
      }
      const allModules = [...diskModules, ...pendingModuleImports];
      const existingAliases = new Set(allModules.map((entry) => entry.alias));
      const baseAlias = normalizeModuleAlias(request.alias ?? installed.id);
      if (existingAliases.has(baseAlias)) {
        return {
          success: false,
          status: "conflict",
          alias: baseAlias,
          suggestedAlias: suggestModuleAlias(baseAlias, existingAliases),
          error: `Module alias already exists: ${baseAlias}`,
        };
      }
      const importedModule: ProjectModuleImport = {
        module_id: installed.id,
        alias: baseAlias,
        version: installed.version,
        revision: installed.revision,
      };

      if (activeProjectDir) {
        // Persist to disk immediately when a project directory exists.
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        const updatedManifest = {
          ...manifest,
          modules: [...manifest.modules, importedModule],
          module_settings: manifest.module_settings ?? {},
        };
        await ProjectManager.saveManifest(activeProjectDir, updatedManifest);
      } else {
        // No project saved yet — hold in memory until project:save.
        pendingModuleImports.push(importedModule);
      }

      const pythonVersion = await detectPythonVersion();
      const warnings = await moduleManager.evaluateHealth(importedModule.module_id, {
        pdvVersion: app.getVersion(),
        pythonVersion,
      });
      moduleHealthWarningsByAlias.set(baseAlias, warnings);
      if (activeKernelId && kernelManager.getKernel(activeKernelId)) {
        await bindImportedModuleScripts(
          commRouter, moduleManager, importedModule,
          kernelWorkingDirs.get(activeKernelId)
        );
      }
      win.webContents.send(IPC.push.treeChanged, {
        changed_paths: [baseAlias],
        change_type: "updated",
      });
      return {
        success: true,
        status: "imported",
        alias: baseAlias,
        warnings,
      };
    }
  );

  // Handles modules:listImported requests from the renderer.
  // Input: none.
  // Returns: imported modules for the active project (disk + in-memory pending).
  ipcMain.handle(
    IPC.modules.listImported,
    async (): Promise<ImportedModuleDescriptor[]> => {
      // Combine disk-persisted imports (if project is saved) with pending in-memory imports.
      let diskModules: ProjectModuleImport[] = [];
      let diskSettings: Record<string, Record<string, unknown>> = {};
      if (activeProjectDir) {
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        diskModules = manifest.modules;
        diskSettings = manifest.module_settings;
      }
      const allModules = [...diskModules, ...pendingModuleImports];
      const allSettings = { ...diskSettings, ...pendingModuleSettings };

      if (allModules.length === 0) {
        return [];
      }

      const installedModules = await moduleManager.listInstalled();
      const installedById = new Map(
        installedModules.map((entry) => [entry.id, entry] as const)
      );
      const pythonVersion = await detectPythonVersion();
      return Promise.all(
        allModules.map(async (entry) => {
          let actions: Awaited<ReturnType<ModuleManager["resolveActionScripts"]>>;
          try {
            actions = await moduleManager.resolveActionScripts(entry.module_id);
          } catch (error) {
            if (isMissingActionScriptError(error)) {
              actions = [];
            } else {
              throw error;
            }
          }
          return {
            moduleId: entry.module_id,
            name: installedById.get(entry.module_id)?.name ?? entry.module_id,
            alias: entry.alias,
            version: entry.version,
            revision: entry.revision,
            inputs: await moduleManager.getModuleInputs(entry.module_id),
            actions: actions.map((action) => ({
              id: action.actionId,
              label: action.actionLabel,
              scriptName: action.name,
              inputIds: action.inputIds,
              ...(action.actionTab ? { tab: action.actionTab } : {}),
            })),
            settings: allSettings[entry.alias] ?? {},
            warnings:
              moduleHealthWarningsByAlias.get(entry.alias) ??
              (await moduleManager.evaluateHealth(entry.module_id, {
                pdvVersion: app.getVersion(),
                pythonVersion,
              })),
          };
        })
      );
    }
  );

  // Handles modules:saveSettings requests from the renderer.
  // Input: ModuleSettingsRequest.
  // Returns: success status after persisting project module settings.
  // Works both with a saved project (persists to disk) and without one
  // (holds settings in memory until the next project:save).
  ipcMain.handle(
    IPC.modules.saveSettings,
    async (_event, request: ModuleSettingsRequest): Promise<ModuleSettingsResult> => {
      if (!request.values || typeof request.values !== "object" || Array.isArray(request.values)) {
        return {
          success: false,
          error: "Module settings values must be an object",
        };
      }

      // Check that the alias exists among disk imports + pending imports.
      let diskModules: ProjectModuleImport[] = [];
      if (activeProjectDir) {
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        diskModules = manifest.modules;
      }
      const allModules = [...diskModules, ...pendingModuleImports];
      const imported = allModules.find(
        (entry) => entry.alias === request.moduleAlias
      );
      if (!imported) {
        return {
          success: false,
          error: `Imported module alias not found: ${request.moduleAlias}`,
        };
      }

      if (activeProjectDir) {
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        const updatedManifest = {
          ...manifest,
          module_settings: {
            ...manifest.module_settings,
            [request.moduleAlias]: request.values,
          },
        };
        await ProjectManager.saveManifest(activeProjectDir, updatedManifest);
      } else {
        // Hold in memory until project:save.
        pendingModuleSettings[request.moduleAlias] = request.values;
      }
      return {
        success: true,
      };
    }
  );

  // Handles modules:runAction requests from the renderer.
  // Input: ModuleActionRequest.
  // Returns: generated execution code for one imported module action.
  // Works both with and without a saved project directory.
  ipcMain.handle(
    IPC.modules.runAction,
    async (_event, request: ModuleActionRequest): Promise<ModuleActionResult> => {
      if (!kernelManager.getKernel(request.kernelId)) {
        return {
          success: false,
          status: "error",
          error: `Kernel not found: ${request.kernelId}`,
        };
      }
      // Look up the imported module across disk + pending in-memory imports.
      let diskModules: ProjectModuleImport[] = [];
      if (activeProjectDir) {
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        diskModules = manifest.modules;
      }
      const allModules = [...diskModules, ...pendingModuleImports];
      const imported = allModules.find(
        (entry) => entry.alias === request.moduleAlias
      );
      if (!imported) {
        return {
          success: false,
          status: "error",
          error: `Imported module alias not found: ${request.moduleAlias}`,
        };
      }
      const actions = await moduleManager.resolveActionScripts(imported.module_id);
      const action = actions.find((entry) => entry.actionId === request.actionId);
      if (!action) {
        return {
          success: false,
          status: "error",
          error: `Module action not found: ${request.actionId}`,
        };
      }
      // Build kwargs from inputValues: { inputId: value } → kwarg pairs.
      const kwargs: string[] = [];
      if (request.inputValues) {
        // Only include inputs that this action actually references.
        const allowedIds = new Set(action.inputIds ?? []);
        for (const [inputId, value] of Object.entries(request.inputValues)) {
          if (allowedIds.size > 0 && !allowedIds.has(inputId)) continue;
          const expression = toPythonArgumentValue(value);
          if (expression !== null) {
            kwargs.push(`${inputId}=${expression}`);
          }
        }
      }

      const invocation = kwargs.length > 0 ? `(${kwargs.join(", ")})` : "()";
      const executionCode = `pdv_tree[${JSON.stringify(
        `${request.moduleAlias}.scripts.${action.name}`
      )}].run${invocation}`;
      return {
        success: true,
        status: "queued",
        executionCode,
      };
    }
  );

  // Handles modules:removeImport requests from the renderer.
  // Input: moduleAlias (string).
  // Returns: success status after removing the import from project manifest or pending state.
  ipcMain.handle(
    IPC.modules.removeImport,
    async (_event, moduleAlias: string): Promise<ModuleSettingsResult> => {
      // Remove from pending in-memory imports.
      const pendingIndex = pendingModuleImports.findIndex(
        (entry) => entry.alias === moduleAlias
      );
      if (pendingIndex >= 0) {
        pendingModuleImports.splice(pendingIndex, 1);
        delete pendingModuleSettings[moduleAlias];
        moduleHealthWarningsByAlias.delete(moduleAlias);
        return { success: true };
      }

      // Remove from disk manifest if project is saved.
      if (activeProjectDir) {
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        const moduleIndex = manifest.modules.findIndex(
          (entry) => entry.alias === moduleAlias
        );
        if (moduleIndex >= 0) {
          manifest.modules.splice(moduleIndex, 1);
          delete manifest.module_settings[moduleAlias];
          await ProjectManager.saveManifest(activeProjectDir, manifest);
          moduleHealthWarningsByAlias.delete(moduleAlias);
          return { success: true };
        }
      }

      return {
        success: false,
        error: `Imported module alias not found: ${moduleAlias}`,
      };
    }
  );

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
        const manifest = await ProjectManager.readManifest(saveDir);
        const mergedManifest = {
          ...manifest,
          modules: [...manifest.modules, ...pendingModuleImports],
          module_settings: { ...manifest.module_settings, ...pendingModuleSettings },
        };
        await ProjectManager.saveManifest(saveDir, mergedManifest);
        pendingModuleImports = [];
        pendingModuleSettings = {};
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
    const loaded = await projectManager.load(saveDir);
    activeProjectDir = saveDir;
    pendingModuleImports = [];
    pendingModuleSettings = {};
    const manifest = await refreshProjectModuleHealth(activeProjectDir);
    await bindProjectModulesToTree(
      kernelManager,
      commRouter,
      moduleManager,
      activeKernelId,
      activeProjectDir,
      manifest?.modules,
      activeKernelId ? kernelWorkingDirs.get(activeKernelId) : undefined
    );
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

  // Handles config:get requests from the renderer.
  // Input: none.
  // Returns: merged PDVConfig object.
  // On error: throws to renderer.
  ipcMain.handle(IPC.config.get, async () => {
    return readConfig(configStore);
  });

  // Handles about:getVersion — returns the running app version.
  // Input: none.
  // Returns: version string from package.json (via Electron app.getVersion()).
  ipcMain.handle(IPC.about.getVersion, () => app.getVersion());

  // Handles config:set requests from the renderer.
  // Input: Partial<PDVConfig>.
  // Returns: merged PDVConfig after persistence.
  // On error: throws to renderer.
  ipcMain.handle(IPC.config.set, async (_event, updates: Partial<PDVConfig>) => {
    const writableStore = configStore as unknown as {
      set(key: string, value: unknown): void;
      getAll(): PDVConfig;
    };

    const current = readConfig(configStore);
    const merged: PDVConfig = { ...current, ...updates };
    const record = updates as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value !== undefined) {
        writableStore.set(key, value);
      }
    }
    return { ...merged, ...writableStore.getAll() };
  });

  // Handles themes:get requests from the renderer.
  // Input: none.
  // Returns: Theme[] currently saved in memory.
  // On error: throws to renderer.
  ipcMain.handle(IPC.themes.get, async () => {
    return savedThemes;
  });

  // Handles themes:save requests from the renderer.
  // Input: theme payload.
  // Returns: true after save/replace.
  // On error: throws to renderer.
  ipcMain.handle(IPC.themes.save, async (_event, theme: Theme) => {
    const existing = savedThemes.findIndex((entry) => entry.name === theme.name);
    if (existing >= 0) {
      savedThemes[existing] = theme;
    } else {
      savedThemes = [...savedThemes, theme];
    }
    // Persist to ~/.PDV/themes/<name>.json (sanitise name for filename)
    const safeName = theme.name.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    const filePath = path.join(themesDir, `${safeName}.json`);
    await fs.writeFile(filePath, JSON.stringify(theme, null, 2), "utf8");
    return true;
  });

  // Handles codeCells:load requests from the renderer.
  // Input: none.
  // Returns: last saved code-cell data or null.
  // On error: throws to renderer.
  ipcMain.handle(IPC.codeCells.load, async () => {
    return savedCodeCells;
  });

  // Handles codeCells:save requests from the renderer.
  // Input: code-cell payload.
  // Returns: true after save.
  // On error: throws to renderer.
  ipcMain.handle(IPC.codeCells.save, async (_event, data: CodeCellData) => {
    savedCodeCells = data;
    await fs.writeFile(codeCellsPath, JSON.stringify(data, null, 2), "utf8");
    return true;
  });

  // Handles menu:updateRecentProjects requests from the renderer.
  // Input: string[] recent project directories.
  // Returns: true after menu refresh.
  // On error: throws to renderer.
  ipcMain.handle(IPC.menu.updateRecentProjects, async (_event, paths: string[]) => {
    updateRecentProjectsMenu(Array.isArray(paths) ? paths : []);
    return true;
  });

  // Handles files:pickExecutable requests from the renderer.
  // Input: none.
  // Returns: selected executable file path or null when cancelled.
  // On error: throws to renderer.
  ipcMain.handle(IPC.files.pickExecutable, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  // Handles files:pickFile requests from the renderer.
  // Input: none.
  // Returns: selected file path or null when cancelled.
  // On error: throws to renderer.
  ipcMain.handle(IPC.files.pickFile, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  // Handles files:pickDirectory requests from the renderer.
  // Input: none.
  // Returns: selected directory path or null when cancelled.
  // On error: throws to renderer.
  ipcMain.handle(IPC.files.pickDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  registerPushForwarding(win, commRouter);
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
  kernelWorkingDirs.clear();
  clearPushSubscriptions();
}
