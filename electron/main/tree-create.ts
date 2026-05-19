/**
 * tree-create.ts — Standalone helpers for creating tree-backed file nodes.
 *
 * The same allocate-uuid → mkdir → write-template → `*_REGISTER` flow is used
 * by two different callers: the renderer IPC handlers
 * (`ipc-register-tree-namespace-script.ts`) and the MCP `create_tree_node`
 * tool (Phase 2, ARCHITECTURE.md §15.5). Both go through these helpers so the
 * tree-create logic lives in exactly one place.
 *
 * What it does NOT do
 * - It does not register IPC channels — it is a pure helper.
 * - It does not understand non-file-backed nodes (plain dict, module). Those
 *   take a different path through `pdv.module.*` / `pdv.tree.create_node`.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §6.3 — UUID-based file storage
 */

import * as fs from "fs/promises";

import type { CommRouter } from "./comm-router";
import type { ConfigStore, PDVConfig } from "./config";
import type {
  TreeCreateLibResult,
  TreeCreateNoteResult,
  TreeCreateScriptResult,
} from "./ipc";
import type { KernelManager } from "./kernel-manager";
import {
  PDVMessageType,
  generateNodeUuid,
  resolveNodeDir,
  resolveNodePath,
  type PDVFileRegisterPayload,
} from "./pdv-protocol";
import type { ProjectManager } from "./project-manager";

/**
 * Analyse a tree target path against the set of known module aliases. Returns
 * `null` when the target is not inside any known module; otherwise returns
 * the owning module alias and the relative subdirectory inside that module
 * where a new file should land.
 *
 * Example: with `knownAliases = {"toy"}` and `targetPath = "toy.scripts.fit"`,
 * returns `{ moduleAlias: "toy", sourceRelDir: "scripts/fit" }`.
 *
 * @param targetPath - Dot-delimited tree path the new node will live under.
 * @param knownAliases - Set of module aliases registered with the project.
 * @returns Module placement info, or `null` when not in a module.
 */
export function analyseModuleTarget(
  targetPath: string,
  knownAliases: Set<string>,
): { moduleAlias: string; sourceRelDir: string } | null {
  const segments = targetPath.split(".").filter(Boolean);
  if (segments.length === 0) return null;
  const [alias, ...rest] = segments;
  if (!knownAliases.has(alias)) return null;
  return { moduleAlias: alias, sourceRelDir: rest.join("/") };
}

/** Shared parts of {@link AllocateScriptDeps} and {@link AllocateNoteDeps}. */
interface CreateBaseDeps {
  kernelManager: KernelManager;
  commRouter: CommRouter;
  projectManager: ProjectManager;
  configStore: ConfigStore;
  /** Map of kernel id → kernel working dir. May be mutated to add a new entry. */
  kernelWorkingDirs: Map<string, string>;
  /** Read the full config, applying defaults. */
  readConfig: (store: ConfigStore) => PDVConfig;
}

/** Dependencies for {@link allocateAndRegisterScript}. */
export interface AllocateScriptDeps extends CreateBaseDeps {
  /** Module aliases the project knows about (disk manifest + in-memory pending). */
  getKnownModuleAliases: () => Promise<Set<string>>;
  /** Sanitize a user-supplied script file name. */
  sanitizeScriptName: (scriptName: string, language?: "python" | "julia") => string;
  /** Write the language-appropriate `run(...)` stub if the file is absent. */
  ensureScriptFile: (scriptPath: string, language?: "python" | "julia") => Promise<void>;
}

/** Dependencies for {@link allocateAndRegisterNote}. */
export type AllocateNoteDeps = CreateBaseDeps;

/** Dependencies for {@link allocateAndRegisterLib}. */
export interface AllocateLibDeps extends CreateBaseDeps {
  /** Module aliases the project knows about (disk manifest + in-memory pending). */
  getKnownModuleAliases: () => Promise<Set<string>>;
  /** Write the language-appropriate lib template if the file is absent. */
  ensureLibFile: (
    libPath: string,
    language: "python" | "julia",
    moduleAlias?: string,
  ) => Promise<void>;
}

/**
 * Allocate a UUID-backed `.py` (or `.jl`) script under the kernel working dir,
 * write its run-stub, and register the node with the kernel.
 *
 * Mirrors the body of the `IPC.tree.createScript` handler so both that
 * handler and the MCP `create_tree_node` tool reuse one path.
 *
 * @param deps - Dependency bag (managers + injected helpers).
 * @param kernelId - The kernel whose working dir owns the new file.
 * @param targetPath - Parent tree path. Empty string for the root.
 * @param scriptName - User-supplied script name (sanitized).
 * @returns The script's absolute file path and the new tree path.
 * @throws {Error} When the kernel is not found.
 */
export async function allocateAndRegisterScript(
  deps: AllocateScriptDeps,
  kernelId: string,
  targetPath: string,
  scriptName: string,
): Promise<TreeCreateScriptResult> {
  const kernel = deps.kernelManager.getKernel(kernelId);
  if (!kernel) {
    throw new Error(`Kernel not found: ${kernelId}`);
  }
  const language = kernel.language;
  const workingDir = await ensureWorkingDir(deps, kernelId);
  const safeName = deps.sanitizeScriptName(scriptName, language);
  const scriptNodeName = stripExtension(safeName);

  const knownAliases = await deps.getKnownModuleAliases();
  const moduleInfo = analyseModuleTarget(targetPath, knownAliases);

  const nodeUuid = generateNodeUuid();
  const scriptPath = resolveNodePath(workingDir, nodeUuid, safeName);
  await fs.mkdir(resolveNodeDir(workingDir, nodeUuid), { recursive: true });
  await deps.ensureScriptFile(scriptPath, language);

  let sourceRelPath: string | undefined;
  let moduleId: string | undefined;
  if (moduleInfo) {
    sourceRelPath = moduleInfo.sourceRelDir
      ? `${moduleInfo.sourceRelDir}/${safeName}`
      : safeName;
    moduleId = moduleInfo.moduleAlias;
  }

  const treePath = targetPath ? `${targetPath}.${scriptNodeName}` : scriptNodeName;
  await deps.commRouter.request(PDVMessageType.SCRIPT_REGISTER, {
    parent_path: targetPath,
    name: scriptNodeName,
    uuid: nodeUuid,
    filename: safeName,
    language,
    module_id: moduleId,
    source_rel_path: sourceRelPath,
  });
  return { success: true, scriptPath, treePath };
}

/**
 * Allocate a UUID-backed `.md` note under the kernel working dir, write an
 * empty file, and register the node with the kernel.
 *
 * @param deps - Dependency bag.
 * @param kernelId - The kernel whose working dir owns the new file.
 * @param targetPath - Parent tree path. Empty string for the root.
 * @param noteName - User-supplied note name. Sanitized inline.
 * @returns The note's absolute file path and the new tree path.
 * @throws {Error} When the kernel is not found.
 */
export async function allocateAndRegisterNote(
  deps: AllocateNoteDeps,
  kernelId: string,
  targetPath: string,
  noteName: string,
): Promise<TreeCreateNoteResult> {
  if (!deps.kernelManager.getKernel(kernelId)) {
    throw new Error(`Kernel not found: ${kernelId}`);
  }
  const workingDir = await ensureWorkingDir(deps, kernelId);
  const safeName = sanitizeNoteName(noteName);
  const nodeUuid = generateNodeUuid();
  const noteFilename = `${safeName}.md`;
  const notePath = resolveNodePath(workingDir, nodeUuid, noteFilename);
  await fs.mkdir(resolveNodeDir(workingDir, nodeUuid), { recursive: true });
  try {
    await fs.access(notePath);
  } catch {
    await fs.writeFile(notePath, "", "utf-8");
  }
  const treePath = targetPath ? `${targetPath}.${safeName}` : safeName;
  await deps.commRouter.request(PDVMessageType.NOTE_REGISTER, {
    parent_path: targetPath,
    name: safeName,
    uuid: nodeUuid,
    filename: noteFilename,
  });
  return { success: true, notePath, treePath };
}

/**
 * Allocate a UUID-backed lib file (`.py` today) under the kernel working dir,
 * write its template, and register it via the file-register comm with
 * `node_type: "lib"`. Lib files are importable Python modules other PDV
 * scripts can `from <project>.<lib> import …` from.
 *
 * @param deps - Dependency bag.
 * @param kernelId - The kernel whose working dir owns the new file.
 * @param targetPath - Parent tree path. Empty string for the root.
 * @param libName - User-supplied lib name (sanitized to a Python identifier).
 * @returns The lib's absolute file path and the new tree path.
 * @throws {Error} When the kernel is not found or the name is empty after sanitization.
 */
export async function allocateAndRegisterLib(
  deps: AllocateLibDeps,
  kernelId: string,
  targetPath: string,
  libName: string,
): Promise<TreeCreateLibResult> {
  const kernel = deps.kernelManager.getKernel(kernelId);
  if (!kernel) {
    throw new Error(`Kernel not found: ${kernelId}`);
  }
  const language = kernel.language;
  const workingDir = await ensureWorkingDir(deps, kernelId);
  const stem = libName
    .trim()
    .replace(/\.py$/i, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "");
  if (!stem) {
    throw new Error("Lib name must contain at least one letter or number.");
  }
  const filename = `${stem}.py`;

  const knownAliases = await deps.getKnownModuleAliases();
  const moduleInfo = analyseModuleTarget(targetPath, knownAliases);

  const nodeUuid = generateNodeUuid();
  const libPath = resolveNodePath(workingDir, nodeUuid, filename);
  await fs.mkdir(resolveNodeDir(workingDir, nodeUuid), { recursive: true });
  await deps.ensureLibFile(libPath, language, moduleInfo?.moduleAlias);

  await deps.commRouter.request(PDVMessageType.FILE_REGISTER, {
    tree_path: targetPath,
    filename,
    uuid: nodeUuid,
    node_type: "lib",
    name: stem,
    ...(moduleInfo
      ? {
          module_id: moduleInfo.moduleAlias,
          source_rel_path: moduleInfo.sourceRelDir
            ? `${moduleInfo.sourceRelDir}/${filename}`
            : filename,
        }
      : {}),
  } satisfies PDVFileRegisterPayload);

  if (moduleInfo) {
    await deps.commRouter.request(PDVMessageType.MODULES_SETUP, {
      modules: [{ alias: moduleInfo.moduleAlias }],
    });
  }

  const treePath = targetPath ? `${targetPath}.${stem}` : stem;
  return { success: true, libPath, treePath };
}

/**
 * Ensure the kernel has a working dir; create one (and record it) on first use.
 *
 * @param deps - Dependency bag.
 * @param kernelId - The kernel id.
 * @returns The kernel's working dir path.
 */
async function ensureWorkingDir(
  deps: CreateBaseDeps,
  kernelId: string,
): Promise<string> {
  let workingDir = deps.kernelWorkingDirs.get(kernelId);
  if (!workingDir) {
    workingDir = await deps.projectManager.createWorkingDir(
      deps.readConfig(deps.configStore).workingDirBase,
    );
    deps.kernelWorkingDirs.set(kernelId, workingDir);
  }
  return workingDir;
}

/** Sanitize a user-supplied note name to a filesystem-safe slug. */
function sanitizeNoteName(noteName: string): string {
  return noteName
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Strip the file extension from `filename` (`"fit.py"` → `"fit"`). */
function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
