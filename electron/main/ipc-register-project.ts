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

import { ipcMain } from "electron";

import { IPC } from "./ipc";
import { ProjectManager, type ProjectModuleImport } from "./project-manager";
import { copyFilesForLoad, copyFilesForSave } from "./project-file-sync";

type ProjectManifest = Awaited<ReturnType<typeof ProjectManager.readManifest>>;

interface RegisterProjectIpcHandlersOptions {
  projectManager: ProjectManager;
  kernelWorkingDirs: Map<string, string>;
  getActiveKernelId: () => string | null;
  setActiveProjectDir: (dir: string | null) => void;
  getPendingModuleImports: () => ProjectModuleImport[];
  setPendingModuleImports: (imports: ProjectModuleImport[]) => void;
  getPendingModuleSettings: () => Record<string, Record<string, unknown>>;
  setPendingModuleSettings: (settings: Record<string, Record<string, unknown>>) => void;
  clearModuleHealthWarnings: () => void;
  refreshProjectModuleHealth: (dir: string | null) => Promise<ProjectManifest | null>;
  bindActiveProjectModules: (kernelId: string | null, modules?: ProjectModuleImport[]) => Promise<void>;
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
    setActiveProjectDir,
    getPendingModuleImports,
    setPendingModuleImports,
    getPendingModuleSettings,
    setPendingModuleSettings,
    clearModuleHealthWarnings,
    refreshProjectModuleHealth,
    bindActiveProjectModules,
    runSerializedProjectManifestMutation,
  } = options;

  ipcMain.handle(
    IPC.project.save,
    async (_event, saveDir: string, codeCells: unknown) => {
      await projectManager.save(saveDir, codeCells);

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

      // Copy file-backed node files from working dir into save dir.
      const activeKernelId = getActiveKernelId();
      if (activeKernelId) {
        const workingDir = kernelWorkingDirs.get(activeKernelId);
        if (workingDir) await copyFilesForSave(workingDir, saveDir);
      }

      setActiveProjectDir(saveDir);
      await refreshProjectModuleHealth(saveDir);
      return true;
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
    const manifest = await refreshProjectModuleHealth(saveDir);

    // Pass module binding as a pre-push callback so that module nodes
    // (scripts, gui, namelist) are registered in the kernel tree BEFORE
    // the pdv.project.loaded push is forwarded to the renderer.
    const loaded = await projectManager.load(saveDir, async () => {
      await bindActiveProjectModules(activeKernelId, manifest?.modules);
    });
    return loaded;
  });

  ipcMain.handle(IPC.project.new, async () => {
    setActiveProjectDir(null);
    setPendingModuleImports([]);
    setPendingModuleSettings({});
    clearModuleHealthWarnings();
    return true;
  });
}
