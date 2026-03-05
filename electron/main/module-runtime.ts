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
  return JSON.stringify(trimmed);
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
    await bindImportedModuleScripts(commRouter, moduleManager, importedModule, workingDir);
  }
}
