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
 * Build the payload for the `pdv.modules.setup` comm message.
 *
 * For each imported module, resolves the on-disk paths of lib/ Python files
 * (already copied to the working directory by {@link bindImportedModuleLibFiles})
 * and includes the optional entry_point from the manifest.
 *
 * The kernel adds the parent directory of each lib file path to `sys.path`,
 * making the modules importable.  This replaces the old `install_path`-based
 * approach and is forward-compatible with UUID-based file storage.
 *
 * @param moduleManager - Module manager for manifest reads.
 * @param importedModules - List of project-imported modules.
 * @param workingDir - Kernel working directory where lib files were copied.
 * @returns Payload object for pdv.modules.setup.
 */
export async function buildModulesSetupPayload(
  moduleManager: ModuleManager,
  importedModules: ProjectModuleImport[],
  workingDir?: string
): Promise<{
  modules: Array<{
    lib_paths: string[];
    entry_point?: string;
  }>;
}> {
  const modules: Array<{
    lib_paths: string[];
    entry_point?: string;
  }> = [];
  for (const imp of importedModules) {
    try {
      const info = await moduleManager.getModuleSetupInfo(imp.module_id);
      const libPaths = await resolveLibFilePaths(moduleManager, imp, workingDir);
      modules.push({
        lib_paths: libPaths,
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
 * Recursively collect all `.py` files under a directory, returning paths
 * relative to that directory.
 *
 * @param dir - Root directory to scan.
 * @returns Array of relative paths (e.g. `["n_pendulum.py"]` or `["pkg/utils.py"]`).
 */
async function collectPyFiles(dir: string): Promise<string[]> {
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
      const subFiles = await collectPyFiles(path.join(dir, rel));
      for (const sub of subFiles) {
        results.push(path.join(rel, sub));
      }
    }
  }
  return results;
}

/**
 * Copy `lib/` Python files from an installed module into the working directory
 * and register each as a PDVFile tree node under `<alias>.lib.<stem>`.
 *
 * At runtime the parent directory of each copied `.py` file is added to
 * `sys.path` (via `pdv.modules.setup`), making the modules importable from
 * scripts and entry points.  This is forward-compatible with UUID-based file
 * storage where each file gets its own directory.
 *
 * @param commRouter - Comm router for FILE_REGISTER messages.
 * @param moduleManager - Module manager for install path resolution.
 * @param importedModule - Imported module entry (module id + alias).
 * @param workingDir - Kernel working directory.
 */
export async function bindImportedModuleLibFiles(
  commRouter: CommRouter,
  moduleManager: ModuleManager,
  importedModule: ProjectModuleImport,
  workingDir: string | undefined
): Promise<void> {
  if (!workingDir) {
    return;
  }

  const installPath = await moduleManager.getModuleInstallPath(importedModule.module_id);
  if (!installPath) return;

  const libDir = path.join(installPath, "lib");
  const pyFiles = await collectPyFiles(libDir);
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

    // Register as a PDVLib in the tree.  The tree path encodes the lib
    // structure: e.g. "n_pendulum.lib.n_pendulum_py" for lib/n_pendulum.py.
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
 * Resolve the on-disk paths of lib/ Python files for an imported module.
 *
 * These paths are sent to the kernel via `pdv.modules.setup` so that the
 * parent directory of each file can be added to `sys.path`.
 *
 * @param moduleManager - Module manager for install path resolution.
 * @param importedModule - Imported module entry.
 * @param workingDir - Kernel working directory where lib files are copied.
 * @returns Array of absolute on-disk paths to `.py` files in the working dir.
 */
export async function resolveLibFilePaths(
  moduleManager: ModuleManager,
  importedModule: ProjectModuleImport,
  workingDir: string | undefined
): Promise<string[]> {
  if (!workingDir) return [];

  const installPath = await moduleManager.getModuleInstallPath(importedModule.module_id);
  if (!installPath) return [];

  const libDir = path.join(installPath, "lib");
  const pyFiles = await collectPyFiles(libDir);

  return pyFiles.map((relFile) =>
    path.join(
      workingDir,
      ...importedModule.alias.split(".").filter(Boolean),
      "lib",
      relFile
    )
  );
}

/**
 * Bind one imported module's action scripts under `<alias>.scripts.<name>`.
 *
 * @param commRouter - Comm router used for SCRIPT_REGISTER messages.
 * @param moduleManager - Module manager for action-script resolution.
 * @param importedModule - Imported module entry (module id + alias).
 * @param workingDir - Optional kernel working directory to copy editable script files into.
 * @returns Nothing.
 * @throws {Error} For structural module resolution errors (except missing script warnings).
 */
export async function bindImportedModuleScripts(
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

/**
 * Bind one imported module into the kernel tree with proper PDVModule/PDVGui nodes.
 *
 * 1. Sends MODULE_REGISTER to create a PDVModule node at the alias path.
 * 2. If the module has a GUI: copies gui.json to working dir, sends GUI_REGISTER.
 * 3. Binds scripts under `<alias>.scripts.<name>` as before.
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
  workingDir: string | undefined
): Promise<void> {
  // 1. Get module identity info
  const installed = await moduleManager.listInstalled();
  const moduleDesc = installed.find((m) => m.id === importedModule.module_id);
  const moduleName = moduleDesc?.name ?? importedModule.module_id;
  const moduleVersion = moduleDesc?.version ?? importedModule.version;

  // 2. Register PDVModule node at the alias path
  await commRouter.request(PDVMessageType.MODULE_REGISTER, {
    path: importedModule.alias,
    module_id: importedModule.module_id,
    name: moduleName,
    version: moduleVersion,
  });

  // 3. If module has a GUI, copy gui.json and register PDVGui node
  let guiInfo: { hasGui: boolean };
  try {
    guiInfo = await moduleManager.getModuleGuiInfo(importedModule.module_id);
  } catch {
    guiInfo = { hasGui: false };
  }
  if (guiInfo.hasGui && typeof moduleManager.getModuleInstallPath === "function") {
    const installPath = await moduleManager.getModuleInstallPath(importedModule.module_id);
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
      } catch {
        // gui.json may not exist for v2 modules — that's fine
      }
    }
  }

  // 4. Copy module files (namelists, fortran sources, etc.) and register them
  try {
    const moduleFiles = await moduleManager.resolveModuleFiles(importedModule.module_id);
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
  // Each .py file in lib/ is copied to the working directory so its parent
  // directory can be added to sys.path, making the module importable.
  await bindImportedModuleLibFiles(commRouter, moduleManager, importedModule, workingDir);

  // 6. Bind scripts as before
  await bindImportedModuleScripts(commRouter, moduleManager, importedModule, workingDir);
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
    await bindImportedModule(commRouter, moduleManager, importedModule, workingDir);
  }
}
