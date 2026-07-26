/**
 * wire.ts — Assembly of the pdv-server core: session state + registrars.
 *
 * `wireServer()` builds everything that serves the renderer's session
 * channels: per-session closures (active kernel/project, generation
 * counter, pending module imports), the per-kernel state maps, the server
 * registrars (kernels, tree/namespace/script, modules, environment,
 * project, autosave, config, GUI files), comm→renderer push forwarding,
 * the MCP server + cell-RPC client, and the MCP lifecycle hooks. All
 * registrations land in the Electron-free invoke registry
 * (`server/invoke-registry.ts`).
 *
 * `server-main.ts` is the only production caller: it wires the session with
 * the stdio transport's push sender and a reverse-RPC confirm broker, then
 * serves the registry over `rpc-server`. Tests call `wireServer()` directly
 * with mock managers and dispatch through `dispatchInvoke`.
 *
 * This module does NOT import Electron, own shell channels (menu, chrome,
 * native pickers, launchers — see `index.ts`), or perform transport I/O.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";

import { autosaveDirFor } from "../autosave-sidecars";
import type { CommRouter } from "../comm-router";
import { ConfigStore, DEFAULT_AUTOSAVE_INTERVAL_S } from "../config";
import { EnvironmentDetector } from "../environment-detector";
import { HandlerInvokeTracker } from "../handler-invoke-tracker";
import {
  INTERNAL_CHANNELS,
  IPC,
  NamespaceInspectTarget,
  ModuleHealthWarning,
  NamespaceQueryOptions,
  type ActiveEnvironmentInfo,
  type CellsResponse,
  type McpStatus,
  type ProjectFailedNode,
} from "../ipc";
import { registerAutosaveIpcHandlers } from "../ipc-register-autosave";
import { readConfig, registerConfigIpcHandlers } from "../ipc-register-config";
import { registerEnvironmentIpcHandlers } from "../ipc-register-environment";
import { registerFileBrowseIpcHandlers } from "../ipc-register-file-browse";
import { registerGuiFilesIpcHandlers } from "../ipc-register-gui-files";
import {
  registerKernelIpcHandlers,
  removeKernelBootOutputListener,
  removeKernelMemoryListener,
} from "../ipc-register-kernels";
import { registerModulesIpcHandlers } from "../ipc-register-modules";
import { registerProjectIpcHandlers } from "../ipc-register-project";
import { registerTreeNamespaceScriptIpcHandlers } from "../ipc-register-tree-namespace-script";
import { resolveJuliaShim } from "../julia-discovery";
import { instantiateJuliaEnvironment } from "../julia-env";
import { checkJuliaVersionForLoad } from "../juliaup-runner";
import { KernelManager } from "../kernel-manager";
import { CellRpcClient } from "../mcp/cell-rpc";
import { shouldBumpOnSwap } from "../mcp/generation-guard";
import type { McpServerHooks } from "../mcp/mcp-context";
import { PdvMcpServer } from "../mcp/mcp-server";
import { ModuleManager } from "../module-manager";
import { bindProjectModulesToTree } from "../module-runtime";
import { PDVMessage, PDVMessageType, getAppVersion } from "../pdv-protocol";
import {
  ProjectManager,
  type ProjectModuleImport,
  type ModuleOwnedFile,
  type ModuleManifestBundle,
} from "../project-manager";
import { syncPkgEnvironmentForLoad, syncUvEnvironmentForLoad } from "../project-file-sync";
import type { QueryRouter } from "../query-router";
import {
  allocateAndRegisterLib,
  allocateAndRegisterNote,
  allocateAndRegisterScript,
} from "../tree-create";
import { uvSync } from "../uv-runner";
import { handleSystemResume } from "../wake-handler";
import type { ConfirmFn } from "./confirm";
import {
  handleInvoke,
  removeAllInvokeHandlers,
  type PushSender,
} from "./invoke-registry";

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

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
// The kernel:executionState listener attached by wireServer(). Stored at
// module scope so unwireServer() can detach it symmetrically.
let trackedExecutionStateListener:
  | { km: KernelManager; fn: (kernelId: string, state: string) => void }
  | null = null;

// The MCP server and cell-RPC client survive re-wiring (macOS window
// re-creation re-runs wireServer, but the HTTP server and its sessions
// must persist). Their push/confirm/hook dependencies are trampolines that
// always read the CURRENT wire's state, so a re-wire cannot leave them
// pointing at a destroyed window or a stale session closure.
let mcpServer: PdvMcpServer | null = null;
let cellRpc: CellRpcClient | null = null;
let currentPush: PushSender = () => undefined;
let currentConfirm: ConfirmFn = async () => 0;
/** The active wire's session accessors, refreshed by every wireServer call. */
let currentSession: WireSessionAccessors | null = null;

/** Session accessors the stable MCP hooks delegate to. */
interface WireSessionAccessors {
  getActiveKernelId: () => string | null;
  getActiveProjectDir: () => string | null;
  getGeneration: () => number;
  bumpGeneration: () => void;
  treeCreate: McpServerHooks["treeCreate"];
}

/**
 * Stable MCP lifecycle hooks (one object identity for the app's lifetime).
 * Delegates to the active wire's closures, so the singleton MCP server
 * follows window re-creation instead of capturing the first wire's state.
 */
const stableMcpHooks: McpServerHooks = {
  getActiveKernelId: () => currentSession?.getActiveKernelId() ?? null,
  getActiveProjectDir: () => currentSession?.getActiveProjectDir() ?? null,
  getActiveWorkingDir: () => {
    const kernelId = currentSession?.getActiveKernelId() ?? null;
    return kernelId ? (kernelWorkingDirs.get(kernelId) ?? null) : null;
  },
  getGeneration: () => currentSession?.getGeneration() ?? 0,
  bumpGeneration: () => currentSession?.bumpGeneration(),
  treeCreate: {
    script: (kernelId, parentPath, scriptName) => {
      if (!currentSession) return Promise.reject(new Error("Server not wired"));
      return currentSession.treeCreate.script(kernelId, parentPath, scriptName);
    },
    note: (kernelId, parentPath, noteName) => {
      if (!currentSession) return Promise.reject(new Error("Server not wired"));
      return currentSession.treeCreate.note(kernelId, parentPath, noteName);
    },
    lib: (kernelId, parentPath, libName) => {
      if (!currentSession) return Promise.reject(new Error("Server not wired"));
      return currentSession.treeCreate.lib(kernelId, parentPath, libName);
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Public wiring API
// ---------------------------------------------------------------------------

/** Dependencies `wireServer` needs from its host process. */
export interface ServerContext {
  /**
   * Renderer-push sender. In the pdv-server this is the transport's push
   * writer; the shell side of the bridge owns the window fan-out (including
   * `BROADCAST_PUSH_CHANNELS` to child windows). Tests inject a spy.
   */
  push: PushSender;
  /** Native-confirmation function (blocking user decision). */
  confirm: ConfirmFn;
  /** `~/.PDV` — module store, themes, state, config live under here. */
  pdvDir: string;
  kernelManager: KernelManager;
  commRouter: CommRouter;
  queryRouter: QueryRouter;
  projectManager: ProjectManager;
  configStore: ConfigStore;
  /**
   * Closes GUI editor/viewer and module child windows on session/project
   * resets. Child windows live in the shell, so `server-main.ts` supplies a
   * hook that emits the reserved `pdv.rpc.closeChildWindows` push and lets
   * the shell do the closing. Optional — tests wire a spy or omit it.
   */
  closeChildWindows?: () => void;
  /**
   * Start the MCP HTTP server after construction. Defaults to false so
   * tests can wire without opening sockets; the app front ends pass true.
   */
  startMcp?: boolean;
}

/** Live handles into the active wire, returned by {@link wireServer}. */
export interface WireHandle {
  /**
   * Reset in-session state (active project/kernel, pending imports, module
   * health, child windows). Called on every renderer load/reload so stale
   * state from a previous renderer session cannot leak into the new one.
   */
  resetSessionState: () => void;
  /**
   * Full session reset for `pdv.rpc.sessionReset`: everything
   * `resetSessionState` does, plus per-kernel state cleanup (working
   * directories removed from disk, env metadata and crash handlers
   * cleared) and the autosave timer stopped — restoring the state a fresh
   * unwire + re-wire would produce, without re-registering handlers.
   */
  sessionReset: () => void;
  /** Active kernel/project context for the shell's launcher handlers. */
  getLauncherContext: () => {
    kernelId: string | null;
    workingDir: string | null;
    projectDir: string | null;
  };
  /** Live MCP server status (valid before start: `running` is false). */
  getMcpStatus: () => McpStatus;
  /**
   * Persist everything preservable before an idle shutdown (the session
   * daemon's autosave gate). Delegates to the autosave registrar's
   * `autosaveForShutdown`: a fresh `.autosave` snapshot with code cells
   * from the working-dir mirror, true with nothing to save (no kernel, or
   * a dead one), false — blocking the shutdown — when a live kernel's
   * snapshot failed.
   */
  autosaveForShutdown: () => Promise<boolean>;
  /**
   * Resolve a tree path to its backing file via the kernel (query socket
   * first, comm fallback). Returns null when the node has no backing file.
   */
  resolveTreeFile: (treePath: string) => Promise<string | null>;
}

/**
 * Wire the pdv-server core: build session state, register every server
 * invoke channel, subscribe comm push forwarding, and (once per process)
 * construct the MCP server + cell-RPC client.
 *
 * Call {@link unwireServer} before re-wiring; registering twice trips the
 * invoke registry's duplicate-handler guard.
 *
 * @param ctx - Host-process dependencies; see {@link ServerContext}.
 * @returns Live handles into this wire; see {@link WireHandle}.
 * @throws {Error} When a channel is registered twice (missing unwire).
 */
export function wireServer(ctx: ServerContext): WireHandle {
  const {
    push,
    confirm,
    pdvDir,
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    configStore,
  } = ctx;
  activeKernelManagerRef = kernelManager;
  currentPush = push;
  currentConfirm = confirm;
  const closeChildWindows = ctx.closeChildWindows ?? ((): void => undefined);

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
        pdvVersion: getAppVersion(),
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

  // Autosave handlers + the snapshot routines shared with the kernel
  // registrar (pre-restart snapshot, post-restart recovery) and the
  // execution-state idle listener below.
  const autosave = registerAutosaveIpcHandlers({
    push,
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

  // Shared between the kernel and tree registrars: gives each double-click
  // handler invoke a real console entry (measured duration, routed output).
  const handlerInvokeTracker = new HandlerInvokeTracker(push);

  registerKernelIpcHandlers({
    push,
    kernelManager,
    commRouter,
    queryRouter,
    handlerInvokeTracker,
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
      closeChildWindows();
    },
    resetKernelState: () => {
      pendingModuleImports = [];
      pendingModuleSettings = {};
      moduleHealthWarningsByAlias.clear();
      closeChildWindows();
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
    handlerInvokeTracker,
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
  });

  registerModulesIpcHandlers({
    push,
    confirm,
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
    getPdvVersion: () => getAppVersion(),
    runWithProjectManifestWriteLock: runSerializedProjectManifestMutation,
  });

  // Environment discovery/install + Packages tab + installModule. Returns
  // the import-cache refresher the project-load env sync below reuses.
  const { refreshKernelImportCaches } = registerEnvironmentIpcHandlers({
    push,
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
    getActiveProjectDir: () => activeProjectDir,
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
    push,
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
            push,
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
    // pkg-mode analog (§10.6.6): re-point the running Julia session's project
    // environment at the opened project and Pkg.instantiate it. No import-
    // cache refresh exists or is needed on the Julia side.
    syncPkgEnvironmentForLoad: async (saveDir, workingDir) =>
      syncPkgEnvironmentForLoad(saveDir, workingDir, {
        runPkgInstantiate: async (cwd) => {
          // Prefer the live kernel's binary (already shim-bypassed at
          // launch); the configured-path and bare-PATH fallbacks must be
          // resolved here — this was the last spawn site that could hit the
          // julialauncher shim (§10.7.2, PR #347 review).
          const juliaPath =
            (activeKernelId
              ? kernelEnvMeta.get(activeKernelId)?.interpreterPath
              : undefined) ??
            resolveJuliaShim(readConfig(configStore).juliaPath ?? "julia");
          const result = await instantiateJuliaEnvironment(cwd, juliaPath, {
            push,
            pushChannel: IPC.push.envActivity,
          });
          return { success: result.success, output: result.output };
        },
      }),
    // Advisory Julia-version assessment on pkg-project open (§10.7.5).
    checkJuliaVersionForLoad: (saveDir, runningVersion) =>
      checkJuliaVersionForLoad(saveDir, runningVersion),
    onExplicitSaveCompleted: (saveDir) => {
      void ProjectManager.clearAutosave(saveDir);
      projectManager.resetAutosaveTimer();
    },
  });

  registerConfigIpcHandlers({
    configStore,
    onConfigChanged: (prev, next) => {
      if (prev.autoSaveIntervalSeconds !== next.autoSaveIntervalSeconds && activeKernelId) {
        const intervalMs = (next.autoSaveIntervalSeconds ?? DEFAULT_AUTOSAVE_INTERVAL_S) * 1000;
        projectManager.startAutosaveTimer(intervalMs, autosave.triggerAutosave);
      }
    },
  });

  registerGuiFilesIpcHandlers({ commRouter });
  registerFileBrowseIpcHandlers();

  // When kernel goes idle and an autosave was deferred, trigger it now.
  // Tracked in `trackedExecutionStateListener` so unwireServer can detach
  // it; otherwise repeated wireServer calls (tests, macOS window
  // re-creation) would accumulate listeners.
  const executionStateListener = (kernelId: string, state: string): void => {
    if (kernelId !== activeKernelId) return;
    if (state === "idle" && projectManager.consumeAutosavePending()) {
      console.log("[autosave] kernel idle, running deferred autosave");
      autosave.triggerAutosave();
    }
  };
  kernelManager.on("kernel:executionState", executionStateListener);
  trackedExecutionStateListener = { km: kernelManager, fn: executionStateListener };

  registerCommPushForwarding(push, commRouter, projectManager);

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
    closeChildWindows();
  }

  // Publish the session accessors the stable MCP hooks delegate to
  // (ARCHITECTURE.md §15).
  const treeCreateBaseDeps = {
    kernelManager,
    commRouter,
    projectManager,
    configStore,
    kernelWorkingDirs,
    readConfig,
  };
  currentSession = {
    getActiveKernelId: () => activeKernelId,
    getActiveProjectDir: () => activeProjectDir,
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

  // Construct the MCP server + cell-RPC client once per process; register
  // their invoke channels on every wire (the registry is cleared by
  // unwireServer). Push/confirm/hook deps are trampolines into the current
  // wire, so the singletons survive re-wiring correctly.
  if (!cellRpc) {
    cellRpc = new CellRpcClient((channel, payload) => currentPush(channel, payload));
  }
  if (!mcpServer) {
    mcpServer = new PdvMcpServer({
      kernelManager,
      commRouter,
      queryRouter,
      projectManager,
      configStore,
      hooks: stableMcpHooks,
      appVersion: getAppVersion(),
      cellRpc,
      push: (channel, payload) => currentPush(channel, payload),
      confirm: (options) => currentConfirm(options),
    });
  }
  const mcp = mcpServer;
  const cells = cellRpc;
  handleInvoke(IPC.mcp.getStatus, () => mcp.status);
  handleInvoke(IPC.cells.respond, (_ctx, response: CellsResponse) => {
    cells.deliver(response);
  });
  if (ctx.startMcp) {
    void mcp.start().catch((error) => {
      console.error("[PDV] Failed to start MCP server:", error);
    });
  }

  /** Try query socket first (works during execution); fall back to comm. */
  const queryRequest = async (type: string, payload: Record<string, unknown>): Promise<PDVMessage> => {
    if (queryRouter.isAttached()) {
      try {
        return await queryRouter.request(type, payload);
      } catch {
        // Fall through to comm router.
      }
    }
    return await commRouter.request(type, payload);
  };

  const handle: WireHandle = {
    resetSessionState,
    sessionReset: (): void => {
      resetSessionState();
      cleanupKernelState();
      projectManager.stopAutosaveTimer();
    },
    getLauncherContext: () => ({
      kernelId: activeKernelId,
      workingDir: activeKernelId
        ? (kernelWorkingDirs.get(activeKernelId) ?? null)
        : null,
      projectDir: activeProjectDir,
    }),
    getMcpStatus: () => mcp.status,
    autosaveForShutdown: autosave.autosaveForShutdown,
    resolveTreeFile: async (treePath: string): Promise<string | null> => {
      const response = await queryRequest(PDVMessageType.TREE_RESOLVE_FILE, {
        path: treePath,
      });
      const filePath = (response.payload as Record<string, unknown> | undefined)
        ?.file_path;
      return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
    },
  };

  // Internal shell → server channels (`INTERNAL_CHANNELS` in ipc.ts):
  // session-state accessors the shell needs but the renderer never sees.
  // Registered here so they ride the transport like every server channel.
  handleInvoke(INTERNAL_CHANNELS.launcherContext, () =>
    handle.getLauncherContext()
  );
  handleInvoke(INTERNAL_CHANNELS.resolveTreeFile, (_ctx, treePath: string) =>
    handle.resolveTreeFile(treePath)
  );
  handleInvoke(INTERNAL_CHANNELS.systemResumed, (ctx) =>
    handleSystemResume(kernelManager, ctx.push)
  );
  handleInvoke(INTERNAL_CHANNELS.resetSessionState, () => {
    handle.resetSessionState();
  });

  return handle;
}

/**
 * Live MCP server singleton, if a wire has constructed it. Read by the
 * shell's quit path to stop the HTTP server.
 *
 * @returns The MCP server, or null before the first wire.
 */
export function getWiredMcpServer(): PdvMcpServer | null {
  return mcpServer;
}

/**
 * Live cell-RPC client singleton, if a wire has constructed it. Read by
 * the shell's quit path to reject in-flight cell requests.
 *
 * @returns The cell-RPC client, or null before the first wire.
 */
export function getWiredCellRpc(): CellRpcClient | null {
  return cellRpc;
}

/**
 * Forward kernel-originated push events from the CommRouter to the renderer
 * via the injected push sender.
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
 * `chromeStateChanged`, `requestClose`) are emitted directly by their
 * respective owners (menu, environment installer, auto-updater, kernel crash
 * watcher, execute streamer, etc.) — they have no comm-router source, so
 * routing them through this function would be a misnomer. The split is
 * intentional, not abandoned scaffolding.
 *
 * Child-window fan-out for `IPC.push.treeChanged` is not handled here: the
 * shell's push implementation broadcasts every `BROADCAST_PUSH_CHANNELS`
 * push to module/GUI windows, so this forwarder emits each push once.
 *
 * @param push - Renderer-push sender.
 * @param commRouter - Comm router instance.
 * @param projectManager - Project manager (kernel-save result caching).
 * @returns Nothing.
 */
export function registerCommPushForwarding(
  push: PushSender,
  commRouter: CommRouter,
  projectManager: ProjectManager
): void {
  const subscribe = (type: string, channel: string): void => {
    const handler = (message: PDVMessage): void => {
      push(channel, message.payload);
    };
    commRouter.onPush(type, handler);
    pushSubscriptions.push({ commRouter, type, handler });
  };

  subscribe(PDVMessageType.TREE_CHANGED, IPC.push.treeChanged);
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
      push(IPC.push.menuAction, { action, path: payload.save_dir });
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
        failedNodes: Array.isArray(payload.failed_nodes)
          ? (payload.failed_nodes as ProjectFailedNode[])
          : [],
      });
      push(IPC.push.menuAction, { action: "project:save", path: saveDir });
    };
    commRouter.onPush(PDVMessageType.PROJECT_SAVE_COMPLETED, handler);
    pushSubscriptions.push({ commRouter, type: PDVMessageType.PROJECT_SAVE_COMPLETED, handler });
  }
}

/**
 * Clear per-kernel state: detach crash handlers, remove working
 * directories from disk, and clear the working-dir/env-metadata maps.
 *
 * A working directory holding an autosave snapshot is left on disk. For an
 * unsaved session the autosave lives at `<workingDir>/.autosave` (the
 * autosave handler falls back to the kernel working dir when there is no
 * project dir), and that snapshot is the only copy of the user's work —
 * it is what the welcome screen offers as a "Recoverable Unsaved Session".
 * `app.ts`'s startup orphan scan applies the same rule and reclaims these
 * directories once the user picks Recover or Discard.
 */
function cleanupKernelState(): void {
  for (const [id, dir] of kernelWorkingDirs) {
    const handler = crashHandlers.get(id);
    if (handler) activeKernelManagerRef?.removeListener("kernel:crashed", handler);
    try {
      if (fsSync.existsSync(path.join(autosaveDirFor(dir), "tree-index.json"))) {
        console.log(`[pdv] preserving autosaved working dir: ${dir}`);
        continue;
      }
      fsSync.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[pdv] failed to remove kernel working dir: ${dir}`, error);
    }
  }
  kernelWorkingDirs.clear();
  kernelEnvMeta.clear();
  crashHandlers.clear();
}

/**
 * Tear down everything a `wireServer()` call registered: every invoke
 * handler, the kernel manager listeners, per-kernel state (working dirs
 * removed from disk), and the comm push subscriptions. The MCP server and
 * cell-RPC client singletons survive (they outlive window re-creation);
 * their invoke channels are re-registered by the next wire.
 *
 * @returns Nothing.
 */
export function unwireServer(): void {
  removeAllInvokeHandlers();
  removeKernelMemoryListener();
  removeKernelBootOutputListener();
  if (trackedExecutionStateListener) {
    trackedExecutionStateListener.km.removeListener(
      "kernel:executionState",
      trackedExecutionStateListener.fn,
    );
    trackedExecutionStateListener = null;
  }
  cleanupKernelState();
  clearPushSubscriptions();
}
