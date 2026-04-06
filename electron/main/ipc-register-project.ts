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

import * as fs from "fs/promises";
import * as path from "path";
import { ipcMain, type BrowserWindow } from "electron";

import { IPC } from "./ipc";
import { ModuleManager } from "./module-manager";
import { ProjectManager, type ProjectManifest, type ProjectModuleImport } from "./project-manager";
import { copyFilesForLoad } from "./project-file-sync";

interface RegisterProjectIpcHandlersOptions {
  projectManager: ProjectManager;
  moduleManager: ModuleManager;
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
  getMainWindow: () => BrowserWindow | null;
  getInterpreterPath: () => string | undefined;
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
    moduleManager,
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
    getMainWindow,
    getInterpreterPath,
  } = options;

  ipcMain.handle(
    IPC.project.save,
    async (_event, saveDir: string, codeCells: unknown) => {
      const saveResult = await projectManager.save(saveDir, codeCells, {
        language: getActiveKernelLanguage(),
        interpreterPath: getInterpreterPath(),
      });

      // Merge pending in-memory module imports/settings into the on-disk manifest.
      const pendingModuleImports = getPendingModuleImports();
      const pendingModuleSettings = getPendingModuleSettings();
      if (pendingModuleImports.length > 0 || Object.keys(pendingModuleSettings).length > 0) {
        // Copy pending module contents into the project-local modules directory.
        for (const pendingModule of pendingModuleImports) {
          const installPath = await moduleManager.getModuleInstallPath(pendingModule.module_id);
          if (installPath) {
            const dest = path.join(saveDir, "modules", pendingModule.module_id);
            await fs.mkdir(path.join(saveDir, "modules"), { recursive: true });
            // Overwrites any existing copy from a previous import (intentional).
            await fs.cp(installPath, dest, { recursive: true });
          }
        }
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
      if (workingDir) {
        const win = getMainWindow();
        await copyFilesForLoad(saveDir, workingDir, win ? (current, total) => {
          win.webContents.send(IPC.push.progress, {
            operation: "load",
            phase: "Copying files",
            current,
            total,
          });
        } : undefined);
      }
    }

    setActiveProjectDir(saveDir);
    setPendingModuleImports([]);
    setPendingModuleSettings({});
    await refreshProjectModuleHealth(saveDir);

    // Read the manifest checksum and version (the values stored at save time).
    let checksum: string | null = null;
    let savedPdvVersion: string | null = null;
    let nodeCount: number | null = null;
    try {
      const manifest = await ProjectManager.readManifest(saveDir);
      checksum = manifest.tree_checksum || null;
      savedPdvVersion = manifest.pdv_version || null;
    } catch {
      // Non-blocking — proceed with load even if manifest read fails
    }

    const { codeCells, postLoadChecksum } = await projectManager.load(saveDir);

    // Validate: compare the kernel's post-load checksum against the stored one.
    const checksumValid =
      postLoadChecksum != null && checksum != null
        ? postLoadChecksum === checksum
        : null;

    if (checksumValid === false) {
      console.warn(
        `[pdv] tree checksum mismatch after load: expected ${checksum}, got ${postLoadChecksum}`
      );
    }

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

    return { codeCells, checksum, checksumValid, nodeCount, savedPdvVersion };
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

  ipcMain.handle(
    IPC.project.peekManifest,
    async (_event, dir: string) => {
      try {
        const manifest = await ProjectManager.readManifest(dir);
        return {
          language: manifest.language,
          interpreterPath: manifest.interpreter_path,
          pdvVersion: manifest.pdv_version,
        };
      } catch {
        return { language: "python" as const };
      }
    }
  );
}
