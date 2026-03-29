/**
 * ipc-register-project.ts — Register project lifecycle IPC handlers.
 *
 * Responsibilities:
 * - Register `window.pdv.project.*` IPC channels (save/load/new).
 * - Coordinate file-sync between kernel working dirs and save dirs.
 * - Merge pending in-memory module state on save.
 *
 * Non-responsibilities:
 * - Kernel lifecycle handlers.
 * - Module/tree/namespace/script handlers.
 * - Config/theme/file-picker handlers.
 */

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { ipcMain } from "electron";

import { IPC } from "./ipc";
import { ProjectManager, type ProjectManifest, type ProjectModuleImport } from "./project-manager";
import { copyFilesForLoad } from "./project-file-sync";

interface RegisterProjectIpcHandlersOptions {
  projectManager: ProjectManager;
  kernelWorkingDirs: Map<string, string>;
  getActiveKernelId: () => string | null;
  getActiveKernelLanguage: () => "python" | "julia";
  setActiveProjectDir: (dir: string | null) => void;
  getPendingModuleImports: () => ProjectModuleImport[];
  setPendingModuleImports: (imports: ProjectModuleImport[]) => void;
  getPendingModuleSettings: () => Record<string, Record<string, unknown>>;
  setPendingModuleSettings: (settings: Record<string, Record<string, unknown>>) => void;
  clearModuleHealthWarnings: () => void;
  refreshProjectModuleHealth: (dir: string | null) => Promise<ProjectManifest | null>;
  runSerializedProjectManifestMutation: <T>(dir: string, task: () => Promise<T>) => Promise<T>;
}

/**
 * Register project-domain IPC handlers under `IPC.project.*`.
 *
 * @param options - Dependencies, shared state accessors, and callbacks.
 * @returns Nothing.
 * @throws {Error} Propagates filesystem and project errors to renderer callers.
 */
export function registerProjectIpcHandlers(
  options: RegisterProjectIpcHandlersOptions
): void {
  const {
    projectManager,
    kernelWorkingDirs,
    getActiveKernelId,
    getActiveKernelLanguage,
    setActiveProjectDir,
    getPendingModuleImports,
    setPendingModuleImports,
    getPendingModuleSettings,
    setPendingModuleSettings,
    clearModuleHealthWarnings,
    refreshProjectModuleHealth,
    runSerializedProjectManifestMutation,
  } = options;

  ipcMain.handle(
    IPC.project.save,
    async (_event, saveDir: string, codeCells: unknown) => {
      const saveResult = await projectManager.save(saveDir, codeCells, {
        language: getActiveKernelLanguage(),
      });

      // Merge pending in-memory module imports/settings into the on-disk manifest.
      const pendingModuleImports = getPendingModuleImports();
      const pendingModuleSettings = getPendingModuleSettings();
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
        setPendingModuleImports([]);
        setPendingModuleSettings({});
      }

      // NOTE: file-backed nodes are already copied to saveDir/tree/ by the
      // Python serializer (serialize_node writes directly to save_dir).
      // No additional copy step is needed here.

      setActiveProjectDir(saveDir);
      await refreshProjectModuleHealth(saveDir);
      return { checksum: saveResult.checksum, nodeCount: saveResult.nodeCount };
    }
  );

  ipcMain.handle(IPC.project.load, async (_event, saveDir: string) => {
    // Copy file-backed node files from save dir into working dir before kernel load.
    const activeKernelId = getActiveKernelId();
    if (activeKernelId) {
      const workingDir = kernelWorkingDirs.get(activeKernelId);
      if (workingDir) await copyFilesForLoad(saveDir, workingDir);
    }

    setActiveProjectDir(saveDir);
    setPendingModuleImports([]);
    setPendingModuleSettings({});
    await refreshProjectModuleHealth(saveDir);

    // Checksum validation (warn-only)
    let checksum: string | null = null;
    let checksumValid: boolean | null = null;
    let nodeCount: number | null = null;
    try {
      const manifest = await ProjectManager.readManifest(saveDir);
      checksum = manifest.tree_checksum || null;
      if (checksum) {
        const treeIndexRaw = await fs.readFile(
          path.join(saveDir, "tree-index.json"),
          "utf8"
        );
        const computed = crypto
          .createHash("sha256")
          .update(treeIndexRaw)
          .digest("hex");
        checksumValid = computed === checksum;
        if (!checksumValid) {
          console.warn(
            `[pdv] tree-index.json checksum mismatch: expected ${checksum}, got ${computed}`
          );
        }
      }
    } catch {
      // Non-blocking — proceed with load even if validation fails
    }

    const loaded = await projectManager.load(saveDir);

    // Read node count from tree-index.json
    try {
      const treeIndexRaw = await fs.readFile(
        path.join(saveDir, "tree-index.json"),
        "utf8"
      );
      const nodes = JSON.parse(treeIndexRaw);
      if (Array.isArray(nodes)) nodeCount = nodes.length;
    } catch {
      // Non-blocking
    }

    return { codeCells: loaded, checksum, checksumValid, nodeCount };
  });

  ipcMain.handle(IPC.project.new, async () => {
    setActiveProjectDir(null);
    setPendingModuleImports([]);
    setPendingModuleSettings({});
    clearModuleHealthWarnings();
    return true;
  });

  ipcMain.handle(
    IPC.project.peekLanguages,
    async (_event, paths: string[]): Promise<Record<string, "python" | "julia">> => {
      const result: Record<string, "python" | "julia"> = {};
      await Promise.all(
        paths.map(async (dir) => {
          try {
            const manifest = await ProjectManager.readManifest(dir);
            result[dir] = manifest.language;
          } catch {
            result[dir] = "python";
          }
        })
      );
      return result;
    }
  );
}
