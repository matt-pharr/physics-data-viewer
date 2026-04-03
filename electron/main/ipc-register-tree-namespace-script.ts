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
import { IPC, type HandlerInvokeResult, type NamelistReadResult, type NamelistWriteResult, type NamespaceInspectResult, type NamespaceInspectTarget, type NamespaceInspectorNode, type NamespaceQueryOptions, type NamespaceVariable, type ScriptParameter, type ScriptRunRequest, type ScriptRunResult, type TreeAddFileResult, type TreeCreateNoteResult, type TreeCreateScriptResult } from "./ipc";
import type { KernelManager } from "./kernel-manager";
import { PDVMessageType, type PDVFileRegisterPayload } from "./pdv-protocol";
import type { ProjectManager } from "./project-manager";

interface RegisterTreeNamespaceScriptIpcHandlersOptions {
  kernelManager: KernelManager;
  commRouter: CommRouter;
  queryRouter: QueryRouter;
  projectManager: ProjectManager;
  configStore: ConfigStore;
  kernelWorkingDirs: Map<string, string>;
  readConfig: (configStore: ConfigStore) => PDVConfig;
  toNamespaceQueryPayload: (
    options?: NamespaceQueryOptions
  ) => Record<string, unknown>;
  toNamespaceInspectPayload: (
    target: NamespaceInspectTarget
  ) => Record<string, unknown>;
  sanitizeScriptName: (scriptName: string, language?: "python" | "julia") => string;
  ensureScriptFile: (scriptPath: string, language?: "python" | "julia") => Promise<void>;
  resolveScriptPath: (
    kernelId: string,
    scriptPath: string,
    kernelWorkingDirs: Map<string, string>,
    language?: "python" | "julia"
  ) => string;
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
    readConfig,
    toNamespaceQueryPayload,
    toNamespaceInspectPayload,
    sanitizeScriptName,
    ensureScriptFile,
    resolveScriptPath,
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
      const scriptsDir = path.join(workingDir, ...targetPath.split(".").filter(Boolean));
      await fs.mkdir(scriptsDir, { recursive: true });
      const scriptPath = path.join(scriptsDir, safeName);
      await ensureScriptFile(scriptPath, language);

      await commRouter.request(PDVMessageType.SCRIPT_REGISTER, {
        parent_path: targetPath,
        name: scriptNodeName,
        relative_path: scriptPath,
        language,
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
      const noteDir = path.join(workingDir, "tree", ...targetPath.split(".").filter(Boolean));
      await fs.mkdir(noteDir, { recursive: true });
      const notePath = path.join(noteDir, safeName + ".md");

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
        relative_path: notePath,
      });
      return { success: true, notePath, treePath };
    }
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

      const segments = targetTreePath.split(".").filter(Boolean);
      const destDir = segments.length > 0 ? path.join(workingDir, ...segments) : workingDir;
      await fs.mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, filename);
      await fs.copyFile(sourcePath, destPath);

      await commRouter.request(PDVMessageType.FILE_REGISTER, {
        tree_path: targetTreePath,
        filename,
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

    // Resolve the file path — try the kernel comm first (handles all
    // PDVFile types including lib/namelist), fall back to the legacy
    // tree-path-to-filesystem derivation for plain scripts.
    let resolvedPath: string | undefined;
    try {
      const response = await queryRequest(
        PDVMessageType.TREE_RESOLVE_FILE,
        { path: scriptPath }
      );
      const filePath = (response.payload as Record<string, unknown> | undefined)?.file_path;
      if (typeof filePath === "string" && filePath.length > 0) {
        resolvedPath = filePath;
      }
    } catch {
      // Comm failed — fall through to legacy resolution
    }
    if (!resolvedPath) {
      const kernel = kernelManager.getKernel(kernelId);
      const language = kernel?.language ?? "python";
      resolvedPath = resolveScriptPath(kernelId, scriptPath, kernelWorkingDirs, language);
    }

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
        const workingDir = kernelWorkingDirs.get(kernelId);
        if (!workingDir) throw new Error(`Working dir not initialized: ${kernelId}`);
        const segments = treePath.split(".").filter(Boolean);
        const lastSeg = segments.pop();
        if (!lastSeg) throw new Error("Invalid tree path");
        const noteDir = segments.length > 0
          ? path.join(workingDir, "tree", ...segments)
          : path.join(workingDir, "tree");
        const filePath = path.join(noteDir, lastSeg + ".md");
        await fs.mkdir(noteDir, { recursive: true });
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
        const workingDir = kernelWorkingDirs.get(kernelId);
        if (!workingDir) throw new Error(`Working dir not initialized: ${kernelId}`);
        const segments = treePath.split(".").filter(Boolean);
        const lastSeg = segments.pop();
        if (!lastSeg) throw new Error("Invalid tree path");
        const noteDir = segments.length > 0
          ? path.join(workingDir, "tree", ...segments)
          : path.join(workingDir, "tree");
        const filePath = path.join(noteDir, lastSeg + ".md");
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
