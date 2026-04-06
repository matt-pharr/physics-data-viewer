/**
 * module-runtime.ts — Module aliasing, action argument conversion, and tree binding helpers.
 *
 * Responsibilities:
 * - Normalize/suggest module aliases for project imports.
 * - Convert module UI input values into Python argument expressions.
 * - Bind imported module actions into the kernel tree via SCRIPT_REGISTER.
 *
 * Non-responsibilities:
 * - Registering IPC handlers.
 * - Persisting module imports/settings to project manifests.
 * - Executing module actions.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { CommRouter } from "./comm-router";
import type { ModuleInputValue } from "./ipc";
import { KernelManager } from "./kernel-manager";
import { ModuleManager } from "./module-manager";
import { PDVMessageType } from "./pdv-protocol";
import { ProjectManager, type ProjectModuleImport } from "./project-manager";

/**
 * Normalize a user-provided module alias into a tree-safe identifier.
 *
 * @param rawAlias - Alias from import request.
 * @returns Normalized alias with separators/whitespace replaced by `_`.
 * @throws {Error} When alias is empty after trimming.
 */
export function normalizeModuleAlias(rawAlias: string): string {
  const trimmed = rawAlias.trim();
  if (!trimmed) {
    throw new Error("Module alias must be a non-empty string");
  }
  return trimmed.replace(/[./\\\s]+/g, "_");
}

/**
 * Suggest the next available alias using a `<base>_<n>` suffix.
 *
 * @param baseAlias - Base alias to start from.
 * @param existingAliases - Set of aliases already in use.
 * @returns First available alias candidate.
 */
export function suggestModuleAlias(baseAlias: string, existingAliases: Set<string>): string {
  let i = 1;
  while (existingAliases.has(`${baseAlias}_${i}`)) {
    i += 1;
  }
  return `${baseAlias}_${i}`;
}

/**
 * Detect module bind errors that indicate a missing/invalid action script file.
 *
 * @param error - Unknown thrown error.
 * @returns True when error text matches missing-script conditions.
 */
export function isMissingActionScriptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Module action script does not exist") ||
    message.includes("Module action script is not a file")
  );
}

/**
 * Convert one module input value into a Python argument expression.
 *
 * String values are treated as safe literals by default. Simple numeric and
 * scalar tokens are preserved to maintain compatibility with existing numeric
 * text inputs.
 *
 * @param value - Raw value from module settings/UI state.
 * @returns Python expression string, or null when the value is empty/invalid.
 */
export function toPythonArgumentValue(value: ModuleInputValue): string | null {
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
  if (/^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed === "True" || trimmed === "False" || trimmed === "None") {
    return trimmed;
  }
  // Produce a Python string literal. Use single quotes so that double quotes
  // inside the string don't need escaping (and vice-versa). Backslashes and
  // the chosen quote character are escaped.
  const escaped = trimmed
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `'${escaped}'`;
}

/**
 * Convert one module input value into a Julia argument expression.
 *
 * Mirrors {@link toPythonArgumentValue} but emits Julia syntax:
 * - booleans → `true` / `false`
 * - numeric strings → passed through as-is
 * - Julia keywords (`true`, `false`, `nothing`) → passed through
 * - other strings → JSON-encoded double-quoted literals
 *
 * @param value - Raw value from module settings/UI state.
 * @returns Julia expression string, or null when the value is empty/invalid.
 */
export function toJuliaArgumentValue(value: ModuleInputValue): string | null {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
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
  if (/^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed === "true" || trimmed === "false" || trimmed === "nothing") {
    return trimmed;
  }
  // JSON.stringify produces a safe, double-quoted Julia string literal.
  return JSON.stringify(trimmed);
}

/**
 * Build the kernel invocation code for a module action script.
 *
 * @param moduleAlias - Imported module alias.
 * @param scriptName - Action script name.
 * @param kwargs - Pre-formatted keyword argument strings (e.g. `["n=2", "tol=1e-8"]`).
 * @param language - Target kernel language.
 * @returns Kernel code string ready for execution.
 */
export function buildModuleActionCode(
  moduleAlias: string,
  scriptName: string,
  kwargs: string[],
  language: "python" | "julia"
): string {
  const treePath = JSON.stringify(`${moduleAlias}.scripts.${scriptName}`);
  if (language === "julia") {
    const argStr = kwargs.length > 0 ? `; ${kwargs.join(", ")}` : "";
    return `PDVKernel.run_tree_script(pdv_tree, ${treePath}${argStr})`;
  }
  const argStr = kwargs.length > 0 ? `(${kwargs.join(", ")})` : "()";
  return `pdv_tree[${treePath}].run${argStr}`;
}

/**
 * Build the payload for the `pdv.modules.setup` comm message.
 *
 * For each imported module, resolves the lib directory path (already copied
 * to the working directory by {@link bindImportedModule}) and includes the
 * optional entry_point from the manifest.
 *
 * The kernel adds the lib_dir directly to `sys.path`/`LOAD_PATH`, making the
 * module importable without enumerating individual files.
 *
 * @param moduleManager - Module manager for manifest reads.
 * @param importedModules - List of project-imported modules.
 * @param workingDir - Kernel working directory where module files were copied.
 * @returns Payload object for pdv.modules.setup.
 */
export async function buildModulesSetupPayload(
  moduleManager: ModuleManager,
  importedModules: ProjectModuleImport[],
  workingDir?: string,
  projectDir?: string | null,
): Promise<{
  modules: Array<{
    lib_paths: string[];
    lib_dir?: string;
    entry_point?: string;
  }>;
}> {
  const modules: Array<{
    lib_paths: string[];
    lib_dir?: string;
    entry_point?: string;
  }> = [];
  for (const imp of importedModules) {
    try {
      const info = await moduleManager.getModuleSetupInfo(imp.module_id, projectDir);
      let libDir: string | undefined;
      if (workingDir && info.libDir) {
        libDir = path.join(workingDir, imp.alias, info.libDir);
      }
      modules.push({
        lib_paths: [],
        lib_dir: libDir,
        entry_point: info.entryPoint,
      });
    } catch (error) {
      console.warn(
        `[pdv] Failed to get module setup info for ${imp.module_id}:`,
        error
      );
    }
  }
  return { modules };
}

/**
 * Bind one imported v4 module into the kernel tree using module-index.json.
 *
 * Reads `module-index.json`, copies all `local_file` backend files to the
 * working directory, remaps storage paths, and sends a single MODULE_REGISTER
 * message with the full `module_index` for the kernel to reconstruct the tree.
 *
 * @param commRouter - Comm router for MODULE_REGISTER.
 * @param moduleManager - Module manager for install path and index reads.
 * @param importedModule - Imported module entry.
 * @param workingDir - Optional kernel working directory.
 * @param moduleName - Display name for the module.
 * @param moduleVersion - Version string for the module.
 */
async function bindImportedModuleV4(
  commRouter: CommRouter,
  moduleManager: ModuleManager,
  importedModule: ProjectModuleImport,
  workingDir: string | undefined,
  moduleName: string,
  moduleVersion: string,
  projectDir?: string | null,
): Promise<void> {
  const installPath = await moduleManager.resolveModuleDir(importedModule.module_id, projectDir);
  if (!installPath) return;

  const moduleIndex = await moduleManager.readModuleIndex(installPath);

  // Copy all local_file backend files to workingDir/<alias>/<relative_path>
  // and build a remapped index with updated relative_paths.
  const remappedIndex = await Promise.all(
    moduleIndex.map(async (node) => {
      const nodeAny = node as unknown as Record<string, unknown>;
      const storage = nodeAny.storage as Record<string, unknown> | undefined;
      if (!storage || storage.backend !== "local_file") return node;
      const relPath = typeof storage.relative_path === "string" ? storage.relative_path : "";
      if (!relPath || !workingDir) return node;

      const srcPath = path.join(installPath, relPath);
      const destRelPath = path.join(importedModule.alias, relPath);
      const destPath = path.join(workingDir, destRelPath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);

      return {
        ...node,
        storage: { ...storage, relative_path: destRelPath },
      };
    })
  );

  const dependencies = await moduleManager.getModuleDependencies(
    importedModule.module_id, projectDir,
  );

  await commRouter.request(PDVMessageType.MODULE_REGISTER, {
    path: importedModule.alias,
    module_id: importedModule.module_id,
    name: moduleName,
    version: moduleVersion,
    module_index: remappedIndex,
    dependencies,
  });
}

/**
 * Bind one imported module into the kernel tree.
 *
 * For v4 modules: reads module-index.json, copies files, sends MODULE_REGISTER
 * with the full tree index so the kernel reconstructs the subtree in one pass.
 *
 * For v1/v2/v3 modules: uses the legacy per-node registration flow
 * (MODULE_REGISTER → GUI_REGISTER → FILE_REGISTER → SCRIPT_REGISTER).
 *
 * @param commRouter - Comm router used for comm messages.
 * @param moduleManager - Module manager for manifest resolution.
 * @param importedModule - Imported module entry (module id + alias).
 * @param workingDir - Optional kernel working directory.
 * @returns Nothing.
 * @throws {Error} For structural module resolution errors.
 */
export async function bindImportedModule(
  commRouter: CommRouter,
  moduleManager: ModuleManager,
  importedModule: ProjectModuleImport,
  workingDir: string | undefined,
  projectDir?: string | null,
): Promise<void> {
  // 1. Get module identity info
  const installed = await moduleManager.listInstalled();
  const moduleDesc = installed.find((m) => m.id === importedModule.module_id);
  const moduleName = moduleDesc?.name ?? importedModule.module_id;
  const moduleVersion = moduleDesc?.version ?? importedModule.version;

  // Check if this is a v4 module (uses module-index.json)
  const isV4 = await moduleManager.isV4Module(importedModule.module_id, projectDir);
  if (isV4) {
    await bindImportedModuleV4(commRouter, moduleManager, importedModule, workingDir, moduleName, moduleVersion, projectDir);
    return;
  }

  const installPath = await moduleManager.resolveModuleDir(importedModule.module_id, projectDir);

  // 2. Register PDVModule node at the alias path
  const dependencies = await moduleManager.getModuleDependencies(
    importedModule.module_id, projectDir,
  );
  await commRouter.request(PDVMessageType.MODULE_REGISTER, {
    path: importedModule.alias,
    module_id: importedModule.module_id,
    name: moduleName,
    version: moduleVersion,
    dependencies,
  });

  // 3. If module has a GUI, copy gui.json and register PDVGui node
  let guiInfo: { hasGui: boolean };
  try {
    guiInfo = await moduleManager.getModuleGuiInfo(importedModule.module_id, projectDir);
  } catch {
    guiInfo = { hasGui: false };
  }
  if (guiInfo.hasGui) {
    if (installPath && workingDir) {
      const sourceGuiPath = path.join(installPath, "gui.json");
      try {
        await fs.stat(sourceGuiPath);
        const destDir = path.join(workingDir, importedModule.alias);
        await fs.mkdir(destDir, { recursive: true });
        const destGuiPath = path.join(destDir, "gui.gui.json");
        await fs.copyFile(sourceGuiPath, destGuiPath);

        await commRouter.request(PDVMessageType.GUI_REGISTER, {
          parent_path: importedModule.alias,
          name: "gui",
          relative_path: destGuiPath,
          module_id: importedModule.module_id,
        });
      } catch (error) {
        console.warn('[pdv] gui.json register failed:', error);
      }
    }
  }

  // 4. Copy module files (namelists, fortran sources, etc.) and register them
  try {
    const moduleFiles = await moduleManager.resolveModuleFiles(importedModule.module_id, projectDir);
    for (const file of moduleFiles) {
      if (!workingDir) continue;
      const segments = importedModule.alias.split(".").filter(Boolean);
      const destDir = path.join(workingDir, ...segments);
      await fs.mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, path.basename(file.path));
      await fs.copyFile(file.path, destPath);

      await commRouter.request(PDVMessageType.FILE_REGISTER, {
        tree_path: importedModule.alias,
        filename: path.basename(file.path),
        node_type: file.type,
        name: file.name,
      });
    }
  } catch (error) {
    console.warn(
      `[pdv] Failed to register module files for ${importedModule.module_id}:`,
      error
    );
  }

  // 5. Copy lib/ Python files and register as PDVFile nodes.
  await bindImportedModuleLibFilesLegacy(commRouter, moduleManager, importedModule, workingDir, projectDir);

  // 6. Bind scripts
  await bindImportedModuleScriptsLegacy(commRouter, moduleManager, importedModule, workingDir, projectDir);
}

/**
 * Legacy (v1/v2/v3): Copy lib/ Python files and register as PDVFile nodes.
 */
async function bindImportedModuleLibFilesLegacy(
  commRouter: CommRouter,
  moduleManager: ModuleManager,
  importedModule: ProjectModuleImport,
  workingDir: string | undefined,
  projectDir?: string | null,
): Promise<void> {
  if (!workingDir) return;

  const installPath = await moduleManager.resolveModuleDir(importedModule.module_id, projectDir);
  if (!installPath) return;

  const libDir = path.join(installPath, "lib");
  const pyFiles = await collectPyFilesLegacy(libDir);
  if (pyFiles.length === 0) return;

  for (const relFile of pyFiles) {
    const srcPath = path.join(libDir, relFile);
    const destDir = path.join(
      workingDir,
      ...importedModule.alias.split(".").filter(Boolean),
      "lib",
      path.dirname(relFile)
    );
    await fs.mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(relFile));
    await fs.copyFile(srcPath, destPath);

    const stem = relFile.replace(/[/\\]/g, "_").replace(/\.py$/, "_py");
    await commRouter.request(PDVMessageType.FILE_REGISTER, {
      tree_path: `${importedModule.alias}.lib`,
      filename: path.basename(relFile),
      node_type: "lib",
      name: stem,
      module_id: importedModule.module_id,
    });
  }
}

/**
 * Legacy (v1/v2/v3): Recursively collect all `.py` files under a directory.
 */
async function collectPyFilesLegacy(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as import("fs").Dirent[];
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = entry.name;
    if (entry.isFile() && rel.endsWith(".py")) {
      results.push(rel);
    } else if (entry.isDirectory()) {
      const subFiles = await collectPyFilesLegacy(path.join(dir, rel));
      for (const sub of subFiles) {
        results.push(path.join(rel, sub));
      }
    }
  }
  return results;
}

/**
 * Legacy (v1/v2/v3): Bind action scripts under `<alias>.scripts.<name>`.
 */
async function bindImportedModuleScriptsLegacy(
  commRouter: CommRouter,
  moduleManager: ModuleManager,
  importedModule: ProjectModuleImport,
  workingDir: string | undefined,
  projectDir?: string | null,
): Promise<void> {
  let scriptBindings: Awaited<ReturnType<ModuleManager["resolveActionScripts"]>>;
  try {
    scriptBindings = await moduleManager.resolveActionScripts(importedModule.module_id, projectDir);
  } catch (error) {
    if (isMissingActionScriptError(error)) return;
    throw error;
  }
  const parentPath = `${importedModule.alias}.scripts`;
  for (const binding of scriptBindings) {
    let registeredPath = binding.scriptPath;
    if (workingDir) {
      const destDir = path.join(workingDir, ...parentPath.split(".").filter(Boolean));
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

/**
 * Bind all project-imported modules for the active project into the active kernel tree.
 *
 * @param kernelManager - Kernel manager used to verify kernel liveness.
 * @param commRouter - Comm router used for script registration.
 * @param moduleManager - Module manager used for action script resolution.
 * @param activeKernelId - Active kernel id.
 * @param projectDir - Active project directory.
 * @param importedModules - Optional preloaded module imports.
 * @param workingDir - Optional active kernel working directory.
 * @returns Nothing.
 * @throws {Error} Propagates errors from manifest reads and bind operations.
 */
export async function bindProjectModulesToTree(
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
    await bindImportedModule(commRouter, moduleManager, importedModule, workingDir, projectDir);
  }
}
