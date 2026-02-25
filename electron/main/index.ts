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

import { ipcMain, BrowserWindow, dialog } from "electron";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { CommRouter } from "./comm-router";
import { KernelManager, type KernelInfo } from "./kernel-manager";
import { ProjectManager } from "./project-manager";
import { ConfigStore } from "./config";
import {
  CommandBoxData,
  IPC,
  KernelCompleteResult,
  KernelInspectResult,
  KernelValidateResult,
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
  IPC.project.save,
  IPC.project.load,
  IPC.project.new,
  IPC.config.get,
  IPC.config.set,
  IPC.themes.get,
  IPC.themes.save,
  IPC.commandBoxes.load,
  IPC.commandBoxes.save,
  IPC.files.pickExecutable,
  IPC.files.pickDirectory,
];

let savedThemes: Theme[] = [];
let savedCommandBoxes: CommandBoxData | null = null;

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
 * Resolve an editor command for `script.edit`.
 *
 * @param config - Current app config.
 * @returns Executable command string.
 */
function resolveEditorCommand(config: PDVConfig): string {
  const configured = (
    config as unknown as Record<string, unknown>
  ).editorCommand;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return "code";
}

function parseCommand(command: string): { file: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { file: "code", args: [] };
  }
  return { file: parts[0], args: parts.slice(1) };
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
 */
export function registerIpcHandlers(
  win: BrowserWindow,
  kernelManager: KernelManager,
  commRouter: CommRouter,
  projectManager: ProjectManager,
  configStore: ConfigStore
): void {
  unregisterIpcHandlers();

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
    commRouter.detach();
    return true;
  });

  // Handles kernels:execute requests from the renderer.
  // Input: kernelId (string), execute request payload.
  // Returns: KernelExecuteResult.
  // On error: throws to renderer.
  ipcMain.handle(IPC.kernels.execute, async (_event, kernelId, request) => {
    return kernelManager.execute(
      kernelId as string,
      request as Parameters<KernelManager["execute"]>[1]
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
    const editor = resolveEditorCommand(config);
    const resolvedScriptPath = resolveScriptPath(kernelId, scriptPath, kernelWorkingDirs);
    const parsed = parseCommand(editor);
    const child = spawn(parsed.file, [...parsed.args, resolvedScriptPath], {
      detached: true,
      stdio: "ignore",
    });
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

  // Handles project:save requests from the renderer.
  // Input: saveDir (string), commandBoxes payload.
  // Returns: true on success.
  // On error: throws to renderer.
  ipcMain.handle(
    IPC.project.save,
    async (_event, saveDir: string, commandBoxes: unknown) => {
      await projectManager.save(saveDir, commandBoxes);
      return true;
    }
  );

  // Handles project:load requests from the renderer.
  // Input: saveDir (string).
  // Returns: command box payload loaded by ProjectManager.
  // On error: throws to renderer.
  ipcMain.handle(IPC.project.load, async (_event, saveDir: string) => {
    return projectManager.load(saveDir);
  });

  // Handles project:new requests from the renderer.
  // Input: none.
  // Returns: true.
  // On error: throws to renderer.
  ipcMain.handle(IPC.project.new, async () => {
    return true;
  });

  // Handles config:get requests from the renderer.
  // Input: none.
  // Returns: merged PDVConfig object.
  // On error: throws to renderer.
  ipcMain.handle(IPC.config.get, async () => {
    return readConfig(configStore);
  });

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
    return true;
  });

  // Handles commandBoxes:load requests from the renderer.
  // Input: none.
  // Returns: last saved command-box data or null.
  // On error: throws to renderer.
  ipcMain.handle(IPC.commandBoxes.load, async () => {
    return savedCommandBoxes;
  });

  // Handles commandBoxes:save requests from the renderer.
  // Input: command-box payload.
  // Returns: true after save.
  // On error: throws to renderer.
  ipcMain.handle(IPC.commandBoxes.save, async (_event, data: CommandBoxData) => {
    savedCommandBoxes = data;
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
 */
export function unregisterIpcHandlers(): void {
  for (const channel of REGISTERED_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
  kernelWorkingDirs.clear();
  clearPushSubscriptions();
}
