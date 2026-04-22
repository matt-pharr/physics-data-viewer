/**
 * ipc-register-tree-namespace-script.ts — Register tree/namespace/script IPC handlers.
 *
 * Responsibilities:
 * - Register `tree:*`, `namespace:query`, and `script:*` ipcMain handlers.
 * - Translate renderer requests into PDV comm requests and local filesystem ops.
 *
 * Non-responsibilities:
 * - Kernel lifecycle handlers.
 * - Project/modules/config/theme/file-picker handlers.
 * - Push forwarding registration.
 */

import { spawn } from "child_process";
import { ipcMain } from "electron";
import * as fs from "fs/promises";
import * as path from "path";

import type { CommRouter } from "./comm-router";
import type { QueryRouter } from "./query-router";
import type { ConfigStore, PDVConfig } from "./config";
import { IPC, type HandlerInvokeResult, type NamelistReadResult, type NamelistWriteResult, type NamespaceInspectResult, type NamespaceInspectTarget, type NamespaceInspectorNode, type NamespaceQueryOptions, type NamespaceVariable, type ScriptParameter, type ScriptRunRequest, type ScriptRunResult, type TreeAddFileResult, type TreeCreateGuiResult, type TreeCreateLibResult, type TreeCreateNodeResult, type TreeCreateNoteResult, type TreeCreateScriptResult, type TreeDuplicateResult, type TreeMoveResult, type TreeRenameResult } from "./ipc";
import type { KernelManager } from "./kernel-manager";
import { PDVMessageType, generateNodeUuid, type PDVFileRegisterPayload } from "./pdv-protocol";
import type { ProjectManager } from "./project-manager";

interface RegisterTreeNamespaceScriptIpcHandlersOptions {
  kernelManager: KernelManager;
  commRouter: CommRouter;
  queryRouter: QueryRouter;
  projectManager: ProjectManager;
  configStore: ConfigStore;
  kernelWorkingDirs: Map<string, string>;
  /**
   * Returns the set of currently-known module aliases (active project
   * manifest ∪ pending-imports). Used by ``tree:createScript`` /
   * ``tree:createGui`` / ``tree:createLib`` to decide whether a new
   * file lives inside a module subtree — in which case it needs
   * ``source_rel_path`` set so the save-time sync (§3) can mirror it
   * back to ``<saveDir>/modules/<id>/`` and its on-disk location must
   * match the ``<workdir>/<alias>/...`` layout used by the module bind
   * path rather than the ``<workdir>/tree/...`` layout used for plain
   * project files.
   */
  getKnownModuleAliases: () => Promise<Set<string>>;
  readConfig: (configStore: ConfigStore) => PDVConfig;
  toNamespaceQueryPayload: (
    options?: NamespaceQueryOptions
  ) => Record<string, unknown>;
  toNamespaceInspectPayload: (
    target: NamespaceInspectTarget
  ) => Record<string, unknown>;
  sanitizeScriptName: (scriptName: string, language?: "python" | "julia") => string;
  ensureScriptFile: (scriptPath: string, language?: "python" | "julia") => Promise<void>;
  ensureLibFile: (
    libPath: string,
    language: "python" | "julia",
    moduleAlias: string,
  ) => Promise<void>;
  buildEditorSpawn: (
    cmdString: string | undefined,
    filePath: string
  ) => { file: string; args: string[] };
  resolveEditorSpawn: (
    command: string,
    args: string[]
  ) => { file: string; args: string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Analyse a target tree path against a set of known module aliases.
 *
 * When the first dot-segment of ``targetPath`` matches an alias, the
 * returned descriptor tells the caller:
 *
 * - ``moduleAlias`` — the owning module's alias (first segment).
 * - ``sourceRelDir`` — the remaining tree segments joined with ``/``,
 *   which becomes the directory portion of ``source_rel_path`` for any
 *   file authored here (e.g. ``targetPath = "toy.scripts.helpers"``
 *   inside module ``toy`` yields ``sourceRelDir = "scripts/helpers"``).
 *   Empty when the target equals the module root.
 * Returns ``null`` when ``targetPath`` is not inside any known module.
 */
function analyseModuleTarget(
  targetPath: string,
  knownAliases: Set<string>,
): { moduleAlias: string; sourceRelDir: string } | null {
  const segments = targetPath.split(".").filter(Boolean);
  if (segments.length === 0) return null;
  const [alias, ...rest] = segments;
  if (!knownAliases.has(alias)) return null;
  return {
    moduleAlias: alias,
    sourceRelDir: rest.join("/"),
  };
}

function toNamespaceVariable(
  name: string,
  value: unknown
): NamespaceVariable {
  if (!isRecord(value)) {
    return {
      name,
      kind: "unknown",
      type: "unknown",
      path: [],
      expression: name,
    };
  }
  const descriptor: NamespaceVariable = {
    name,
    kind: typeof value.kind === "string" ? value.kind : "unknown",
    type: typeof value.type === "string" ? value.type : "unknown",
    path: Array.isArray(value.path) ? value.path as NamespaceVariable["path"] : [],
    expression: typeof value.expression === "string" ? value.expression : name,
  };
  if (typeof value.module === "string") descriptor.module = value.module;
  if (
    Array.isArray(value.shape) &&
    value.shape.every((entry) => typeof entry === "number")
  ) {
    descriptor.shape = value.shape;
  }
  if (typeof value.dtype === "string") descriptor.dtype = value.dtype;
  if (typeof value.length === "number") descriptor.length = value.length;
  if (typeof value.size === "number") descriptor.size = value.size;
  if (typeof value.preview === "string") descriptor.preview = value.preview;
  if (typeof value.has_children === "boolean") descriptor.hasChildren = value.has_children;
  if (typeof value.child_count === "number") descriptor.childCount = value.child_count;
  return descriptor;
}

function toNamespaceInspectorNode(value: unknown): NamespaceInspectorNode {
  if (!isRecord(value)) {
    return {
      name: "<unknown>",
      kind: "unknown",
      type: "unknown",
      path: [],
      expression: "<unknown>",
    };
  }
  const descriptor: NamespaceInspectorNode = {
    name: typeof value.name === "string" ? value.name : "<unknown>",
    kind: typeof value.kind === "string" ? value.kind : "unknown",
    type: typeof value.type === "string" ? value.type : "unknown",
    path: Array.isArray(value.path) ? value.path as NamespaceInspectorNode["path"] : [],
    expression:
      typeof value.expression === "string"
        ? value.expression
        : (typeof value.name === "string" ? value.name : "<unknown>"),
  };
  if (typeof value.module === "string") descriptor.module = value.module;
  if (
    Array.isArray(value.shape) &&
    value.shape.every((entry) => typeof entry === "number")
  ) {
    descriptor.shape = value.shape;
  }
  if (typeof value.dtype === "string") descriptor.dtype = value.dtype;
  if (typeof value.length === "number") descriptor.length = value.length;
  if (typeof value.size === "number") descriptor.size = value.size;
  if (typeof value.preview === "string") descriptor.preview = value.preview;
  if (typeof value.has_children === "boolean") descriptor.hasChildren = value.has_children;
  if (typeof value.child_count === "number") descriptor.childCount = value.child_count;
  return descriptor;
}

function normalizeNamespaceVariables(rawVariables: unknown): NamespaceVariable[] {
  if (Array.isArray(rawVariables)) {
    return rawVariables as NamespaceVariable[];
  }
  if (isRecord(rawVariables)) {
    return Object.entries(rawVariables).map(([name, value]) =>
      toNamespaceVariable(name, value)
    );
  }
  return [];
}

function normalizeNamespaceInspectResult(rawPayload: unknown): NamespaceInspectResult {
  const payload = isRecord(rawPayload) ? rawPayload : {};
  const rawChildren = Array.isArray(payload.children) ? payload.children : [];
  const result: NamespaceInspectResult = {
    children: rawChildren.map((child) => toNamespaceInspectorNode(child)),
    truncated: payload.truncated === true,
  };
  if (typeof payload.total_children === "number") {
    result.totalChildren = payload.total_children;
  }
  return result;
}

/**
 * Register tree, namespace, and script IPC handlers.
 *
 * @param options - Dependency bag used by handler implementations.
 * @returns Nothing.
 * @throws {Error} Propagates handler execution errors to renderer callers.
 */
export function registerTreeNamespaceScriptIpcHandlers(
  options: RegisterTreeNamespaceScriptIpcHandlersOptions
): void {
  const {
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
  } = options;

  /** Try query socket first (works during execution); fall back to comm. */
  const queryRequest = async (type: string, payload: Record<string, unknown>) => {
    if (queryRouter.isAttached()) {
      try {
        return await queryRouter.request(type, payload);
      } catch {
        // Fall through to comm router.
      }
    }
    return await commRouter.request(type, payload);
  };

  ipcMain.handle(IPC.tree.list, async (_event, kernelId: string, nodePath = "") => {
    if (!kernelManager.getKernel(kernelId)) {
      return [];
    }
    const response = await queryRequest(PDVMessageType.TREE_LIST, {
      path: nodePath,
    });
    const nodes = (response.payload as { nodes?: unknown }).nodes;
    return Array.isArray(nodes) ? nodes : [];
  });

  ipcMain.handle(IPC.tree.get, async (_event, kernelId: string, nodePath: string) => {
    if (!kernelManager.getKernel(kernelId)) {
      throw new Error(`Kernel not found: ${kernelId}`);
    }
    const response = await queryRequest(PDVMessageType.TREE_GET, {
      path: nodePath,
    });
    return response.payload;
  });

  ipcMain.handle(
    IPC.tree.createScript,
    async (
      _event,
      kernelId: string,
      targetPath: string,
      scriptName: string
    ): Promise<TreeCreateScriptResult> => {
      const kernel = kernelManager.getKernel(kernelId);
      if (!kernel) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      const language = kernel.language;
      let workingDir = kernelWorkingDirs.get(kernelId);
      if (!workingDir) {
        workingDir = await projectManager.createWorkingDir();
        kernelWorkingDirs.set(kernelId, workingDir);
      }
      const safeName = sanitizeScriptName(scriptName, language);
      const scriptNodeName = path.parse(safeName).name;

      const knownAliases = await getKnownModuleAliases();
      const moduleInfo = analyseModuleTarget(targetPath, knownAliases);

      const nodeUuid = generateNodeUuid();
      const scriptDir = path.join(workingDir, "tree", nodeUuid);
      await fs.mkdir(scriptDir, { recursive: true });
      const scriptPath = path.join(scriptDir, safeName);
      await ensureScriptFile(scriptPath, language);

      let sourceRelPath: string | undefined;
      let moduleId: string | undefined;
      if (moduleInfo) {
        sourceRelPath = moduleInfo.sourceRelDir
          ? `${moduleInfo.sourceRelDir}/${safeName}`
          : safeName;
        moduleId = moduleInfo.moduleAlias;
      }

      await commRouter.request(PDVMessageType.SCRIPT_REGISTER, {
        parent_path: targetPath,
        name: scriptNodeName,
        uuid: nodeUuid,
        filename: safeName,
        language,
        module_id: moduleId,
        source_rel_path: sourceRelPath,
      });
      return { success: true, scriptPath };
    }
  );

  ipcMain.handle(
    IPC.tree.createNote,
    async (
      _event,
      kernelId: string,
      targetPath: string,
      noteName: string
    ): Promise<TreeCreateNoteResult> => {
      if (!kernelManager.getKernel(kernelId)) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      let workingDir = kernelWorkingDirs.get(kernelId);
      if (!workingDir) {
        workingDir = await projectManager.createWorkingDir();
        kernelWorkingDirs.set(kernelId, workingDir);
      }
      const safeName = noteName.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
      const nodeUuid = generateNodeUuid();
      const noteFilename = safeName + ".md";
      const noteDir = path.join(workingDir, "tree", nodeUuid);
      await fs.mkdir(noteDir, { recursive: true });
      const notePath = path.join(noteDir, noteFilename);

      // Create the .md file if it doesn't exist
      try {
        await fs.access(notePath);
      } catch {
        await fs.writeFile(notePath, "", "utf-8");
      }

      const treePath = targetPath ? `${targetPath}.${safeName}` : safeName;
      await commRouter.request(PDVMessageType.NOTE_REGISTER, {
        parent_path: targetPath,
        name: safeName,
        uuid: nodeUuid,
        filename: noteFilename,
      });
      return { success: true, notePath, treePath };
    }
  );

  ipcMain.handle(
    IPC.tree.createGui,
    async (
      _event,
      kernelId: string,
      targetPath: string,
      guiName: string
    ): Promise<TreeCreateGuiResult> => {
      if (!kernelManager.getKernel(kernelId)) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      let workingDir = kernelWorkingDirs.get(kernelId);
      if (!workingDir) {
        workingDir = await projectManager.createWorkingDir();
        kernelWorkingDirs.set(kernelId, workingDir);
      }
      const safeName = guiName.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
      if (!safeName) {
        return { success: false, error: "GUI name must contain at least one alphanumeric character" };
      }

      const knownAliases = await getKnownModuleAliases();
      const moduleInfo = analyseModuleTarget(targetPath, knownAliases);

      const nodeUuid = generateNodeUuid();
      const guiFilename = safeName + ".gui.json";
      const guiDir = path.join(workingDir, "tree", nodeUuid);
      await fs.mkdir(guiDir, { recursive: true });
      const guiPath = path.join(guiDir, guiFilename);

      let sourceRelPath: string | undefined;
      let moduleId: string | null = null;
      if (moduleInfo) {
        sourceRelPath = moduleInfo.sourceRelDir
          ? `${moduleInfo.sourceRelDir}/${guiFilename}`
          : guiFilename;
        moduleId = moduleInfo.moduleAlias;
      }

      const defaultManifest = {
        has_gui: true,
        gui: { layout: { type: "column", children: [] } },
        inputs: [],
        actions: [],
      };

      try {
        await fs.access(guiPath);
      } catch {
        await fs.writeFile(guiPath, JSON.stringify(defaultManifest, null, 2) + "\n", "utf-8");
      }

      const treePath = targetPath ? `${targetPath}.${safeName}` : safeName;
      await commRouter.request(PDVMessageType.GUI_REGISTER, {
        parent_path: targetPath,
        name: safeName,
        uuid: nodeUuid,
        filename: guiFilename,
        module_id: moduleId,
        source_rel_path: sourceRelPath,
      });
      return { success: true, guiPath, treePath };
    }
  );

  ipcMain.handle(
    IPC.tree.createLib,
    async (
      _event,
      kernelId: string,
      targetPath: string,
      libName: string,
    ): Promise<TreeCreateLibResult> => {
      const kernel = kernelManager.getKernel(kernelId);
      if (!kernel) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      const language = kernel.language;
      let workingDir = kernelWorkingDirs.get(kernelId);
      if (!workingDir) {
        workingDir = await projectManager.createWorkingDir();
        kernelWorkingDirs.set(kernelId, workingDir);
      }
      // Sanitize the filename — Python libs need their stem to be a valid
      // import name, so we keep the usual alphanumeric-plus-underscore
      // convention and guarantee a ``.py`` extension.
      const rawName = libName.trim();
      const stem = rawName.replace(/\.py$/i, "").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
      if (!stem) {
        return {
          success: false,
          error: "Lib name must contain at least one alphanumeric character",
        };
      }
      const filename = `${stem}.py`;

      // Libs are workflow-A/B territory — only allow creation when the
      // target sits under a known module alias. Free-floating project
      // libs are out of scope for this pass (and for v4 modules lib/
      // is the only supported location).
      const knownAliases = await getKnownModuleAliases();
      const moduleInfo = analyseModuleTarget(targetPath, knownAliases);
      if (!moduleInfo) {
        return {
          success: false,
          error: `tree:createLib target must live inside a known module — got ${JSON.stringify(targetPath)}`,
        };
      }

      const nodeUuid = generateNodeUuid();
      const libDir = path.join(workingDir, "tree", nodeUuid);
      await fs.mkdir(libDir, { recursive: true });
      const libPath = path.join(libDir, filename);
      await ensureLibFile(libPath, language, moduleInfo.moduleAlias);

      const sourceRelPath = moduleInfo.sourceRelDir
        ? `${moduleInfo.sourceRelDir}/${filename}`
        : filename;

      await commRouter.request(PDVMessageType.FILE_REGISTER, {
        tree_path: targetPath,
        filename,
        uuid: nodeUuid,
        node_type: "lib",
        name: stem,
        module_id: moduleInfo.moduleAlias,
        source_rel_path: sourceRelPath,
      } satisfies PDVFileRegisterPayload);

      // Wire sys.path for the newly-created lib. The kernel walker in
      // handle_modules_setup is the sole owner of sys.path for module
      // libs — we re-run it for the affected module whenever a new
      // PDVLib is added to the tree so its parent directory lands on
      // sys.path. Entry point is intentionally omitted: create_empty
      // modules do not have one, and imported-module entry points have
      // already been imported at import time.
      await commRouter.request(PDVMessageType.MODULES_SETUP, {
        modules: [{ alias: moduleInfo.moduleAlias }],
      });

      const treePath = targetPath ? `${targetPath}.${stem}` : stem;
      return { success: true, libPath, treePath };
    },
  );

  ipcMain.handle(
    IPC.tree.addFile,
    async (
      _event,
      kernelId: string,
      sourcePath: string,
      targetTreePath: string,
      nodeType: "namelist" | "lib" | "file",
      filename: string
    ): Promise<TreeAddFileResult> => {
      if (!kernelManager.getKernel(kernelId)) throw new Error(`Kernel not found: ${kernelId}`);
      const workingDir = kernelWorkingDirs.get(kernelId);
      if (!workingDir) throw new Error(`Working dir not initialized: ${kernelId}`);

      const nodeUuid = generateNodeUuid();
      const destDir = path.join(workingDir, "tree", nodeUuid);
      await fs.mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, filename);
      await fs.copyFile(sourcePath, destPath);

      await commRouter.request(PDVMessageType.FILE_REGISTER, {
        tree_path: targetTreePath,
        filename,
        uuid: nodeUuid,
        node_type: nodeType,
      } satisfies PDVFileRegisterPayload);

      return { success: true, workingDirPath: destPath };
    }
  );

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
      const response = await queryRequest(
        PDVMessageType.NAMESPACE_QUERY,
        toNamespaceQueryPayload(options)
      );
      const payload = isRecord(response.payload) ? response.payload : {};
      const normalized = normalizeNamespaceVariables(payload.variables);
      if (!normalized.some((entry) => entry.name === "pdv_tree")) {
        normalized.unshift({
          name: "pdv_tree",
          kind: "protected",
          type: "protected",
          preview: "PDVTree (protected)",
          path: [],
          expression: "pdv_tree",
        });
      }
      if (!normalized.some((entry) => entry.name === "pdv")) {
        normalized.unshift({
          name: "pdv",
          kind: "protected",
          type: "protected",
          preview: "PDV app object (protected)",
          path: [],
          expression: "pdv",
        });
      }
      return normalized;
    }
  );

  ipcMain.handle(
    IPC.namespace.inspect,
    async (
      _event,
      kernelId: string,
      target: NamespaceInspectTarget
    ): Promise<NamespaceInspectResult> => {
      if (!kernelManager.getKernel(kernelId)) {
        return { children: [], truncated: false };
      }
      const response = await queryRequest(
        PDVMessageType.NAMESPACE_INSPECT,
        toNamespaceInspectPayload(target)
      );
      return normalizeNamespaceInspectResult(response.payload);
    }
  );

  ipcMain.handle(IPC.script.run, async (_event, kernelId: string, request: ScriptRunRequest): Promise<ScriptRunResult> => {
    const kernel = kernelManager.getKernel(kernelId);
    if (!kernel) throw new Error(`Kernel not found: ${kernelId}`);

    const { treePath, params, executionId, origin } = request;

    // Lib reload preflight: if this looks like a module-owned script (its
    // tree path has at least one dot), ask the kernel to importlib.reload
    // any lib files under ``<workdir>/<alias>/lib/`` so edits take effect
    // on the next run. The kernel short-circuits when the first segment
    // is not actually a PDVModule, so this is cheap for plain project
    // scripts. Errors are swallowed — a reload failure must not block a
    // script run; the error will surface again when the script actually
    // imports the broken lib. See the #140 workflow plan §4.
    const firstDot = treePath.indexOf(".");
    if (firstDot > 0) {
      const alias = treePath.slice(0, firstDot);
      try {
        await commRouter.request(PDVMessageType.MODULE_RELOAD_LIBS, { alias });
      } catch (error) {
        console.warn(`[pdv] reload_libs preflight failed for ${alias}:`, error);
      }
    }

    let code: string;

    if (kernel.language === "julia") {
      const kwargs = Object.entries(params)
        .map(([key, value]) => {
          if (typeof value === "string") return `${key}=${JSON.stringify(value)}`;
          if (typeof value === "boolean") return `${key}=${value ? "true" : "false"}`;
          return `${key}=${value}`;
        })
        .join(", ");
      const pathStr = JSON.stringify(treePath);
      code = kwargs
        ? `PDVKernel.run_tree_script(pdv_tree, ${pathStr}; ${kwargs})`
        : `PDVKernel.run_tree_script(pdv_tree, ${pathStr})`;
    } else {
      // Python
      const kwargs = Object.entries(params)
        .map(([key, value]) => {
          if (typeof value === "string") return `${key}=${JSON.stringify(value)}`;
          if (typeof value === "boolean") return `${key}=${value ? "True" : "False"}`;
          return `${key}=${value}`;
        })
        .join(", ");
      code = kwargs
        ? `pdv_tree[${JSON.stringify(treePath)}].run(${kwargs})`
        : `pdv_tree[${JSON.stringify(treePath)}].run()`;
    }

    const result = await kernelManager.execute(kernelId, { code, executionId, origin });
    return { code, executionId, origin, result };
  });

  ipcMain.handle(IPC.script.edit, async (_event, kernelId: string, scriptPath: string) => {
    const config = readConfig(configStore);

    const response = await queryRequest(
      PDVMessageType.TREE_RESOLVE_FILE,
      { path: scriptPath }
    );
    const filePath = (response.payload as Record<string, unknown> | undefined)?.file_path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { success: false, error: `Could not resolve file path for "${scriptPath}".` };
    }
    const resolvedPath = filePath;

    const isJulia = resolvedPath.endsWith(".jl");
    const cmdString = isJulia ? config.juliaEditorCmd : config.pythonEditorCmd;
    const { file, args } = buildEditorSpawn(cmdString, resolvedPath);
    const spawnSpec = resolveEditorSpawn(file, args);
    try {
      const child = spawn(spawnSpec.file, spawnSpec.args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        const msg = err && (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `Editor command not found: "${spawnSpec.file}". Configure your editor in Settings → General.`
          : `Failed to launch editor: ${err.message}`;
        console.error("[pdv] editor spawn error:", msg);
      });
      child.unref();
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to launch editor: ${error}` };
    }
  });

  ipcMain.handle(
    IPC.script.getParams,
    async (_event, kernelId: string, treePath: string): Promise<ScriptParameter[]> => {
      const response = await commRouter.request(PDVMessageType.SCRIPT_PARAMS, {
        path: treePath,
      });
      const params = (response.payload as Record<string, unknown> | undefined)?.params;
      return Array.isArray(params) ? (params as ScriptParameter[]) : [];
    }
  );

  ipcMain.handle(
    IPC.note.save,
    async (_event, kernelId: string, treePath: string, content: string) => {
      try {
        const response = await queryRequest(
          PDVMessageType.TREE_RESOLVE_FILE,
          { path: treePath }
        );
        const filePath = (response.payload as Record<string, unknown> | undefined)?.file_path;
        if (typeof filePath !== "string" || !filePath) {
          throw new Error(`Could not resolve file path for note at "${treePath}"`);
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf-8");
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.note.read,
    async (_event, kernelId: string, treePath: string) => {
      try {
        const response = await queryRequest(
          PDVMessageType.TREE_RESOLVE_FILE,
          { path: treePath }
        );
        const filePath = (response.payload as Record<string, unknown> | undefined)?.file_path;
        if (typeof filePath !== "string" || !filePath) {
          throw new Error(`Could not resolve file path for note at "${treePath}"`);
        }
        const content = await fs.readFile(filePath, "utf-8");
        return { success: true, content };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.tree.invokeHandler,
    async (
      _event,
      kernelId: string,
      nodePath: string
    ): Promise<HandlerInvokeResult> => {
      if (!kernelManager.getKernel(kernelId)) {
        return { success: false, error: `Kernel not found: ${kernelId}` };
      }
      const response = await commRouter.request(PDVMessageType.HANDLER_INVOKE, {
        path: nodePath,
      });
      const payload = response.payload as { dispatched: boolean; error?: string };
      return { success: payload.dispatched, error: payload.error };
    }
  );

  /**
   * Register a tree IPC handler that delegates to commRouter.request.
   *
   * Handles kernel-not-found checks, error wrapping, and payload extraction
   * via a caller-supplied transform.
   */
  function treeCommHandler<T extends { success: boolean; error?: string }>(
    channel: string,
    msgType: string,
    buildPayload: (...args: string[]) => Record<string, unknown>,
    mapResult: (payload: Record<string, unknown>) => T,
  ): void {
    ipcMain.handle(channel, async (_event, kernelId: string, ...rest: string[]): Promise<T> => {
      if (!kernelManager.getKernel(kernelId)) {
        return { success: false, error: `Kernel not found: ${kernelId}` } as T;
      }
      try {
        const response = await commRouter.request(msgType, buildPayload(...rest));
        return mapResult(response.payload as Record<string, unknown>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message } as T;
      }
    });
  }

  treeCommHandler<TreeCreateNodeResult>(
    IPC.tree.createNode,
    PDVMessageType.TREE_CREATE_NODE,
    (targetPath, nodeName) => ({ parent_path: targetPath, name: nodeName }),
    (p) => ({ success: true, treePath: p.path as string | undefined }),
  );

  treeCommHandler<TreeRenameResult>(
    IPC.tree.rename,
    PDVMessageType.TREE_RENAME,
    (treePath, newName) => ({ path: treePath, new_name: newName }),
    (p) => ({ success: true, oldPath: p.old_path as string | undefined, newPath: p.new_path as string | undefined }),
  );

  treeCommHandler<TreeMoveResult>(
    IPC.tree.move,
    PDVMessageType.TREE_MOVE,
    (treePath, newPath, filename) => ({ path: treePath, new_path: newPath, ...(filename ? { filename } : {}) }),
    (p) => ({ success: true, oldPath: p.old_path as string | undefined, newPath: p.new_path as string | undefined }),
  );

  treeCommHandler<TreeDuplicateResult>(
    IPC.tree.duplicate,
    PDVMessageType.TREE_DUPLICATE,
    (treePath, newPath, filename) => ({ path: treePath, new_path: newPath, ...(filename ? { filename } : {}) }),
    (p) => ({ success: true, newPath: p.new_path as string | undefined }),
  );

  ipcMain.handle(
    IPC.tree.delete,
    async (
      _event,
      kernelId: string,
      treePath: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!kernelManager.getKernel(kernelId)) {
        return { success: false, error: `Kernel not found: ${kernelId}` };
      }
      try {
        await commRouter.request(PDVMessageType.TREE_DELETE, {
          path: treePath,
        });
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    }
  );

  ipcMain.handle(
    IPC.namelist.read,
    async (
      _event,
      kernelId: string,
      treePath: string
    ): Promise<NamelistReadResult> => {
      if (!kernelManager.getKernel(kernelId)) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      const response = await commRouter.request(PDVMessageType.NAMELIST_READ, {
        tree_path: treePath,
      });
      return response.payload as unknown as NamelistReadResult;
    }
  );

  ipcMain.handle(
    IPC.namelist.write,
    async (
      _event,
      kernelId: string,
      treePath: string,
      data: Record<string, Record<string, unknown>>
    ): Promise<NamelistWriteResult> => {
      if (!kernelManager.getKernel(kernelId)) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      const response = await commRouter.request(PDVMessageType.NAMELIST_WRITE, {
        tree_path: treePath,
        data,
      });
      return response.payload as unknown as NamelistWriteResult;
    }
  );
}
