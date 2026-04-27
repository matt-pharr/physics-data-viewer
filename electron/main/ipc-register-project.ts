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

import type { CommRouter } from "./comm-router";
import type { CodeCellData } from "./ipc";
import { IPC } from "./ipc";
import { ModuleManager } from "./module-manager";
import { setupProjectModuleNamespaces } from "./module-runtime";
import {
  ProjectManager,
  assertCodeCellData,
  type ModuleManifestBundle,
  type ModuleOwnedFile,
  type ProjectManifest,
  type ProjectModuleImport,
} from "./project-manager";
import { copyFilesForLoad } from "./project-file-sync";
import {
  writeModuleIndex,
  writeModuleManifest,
} from "./module-manifest-writer";

interface RegisterProjectIpcHandlersOptions {
  projectManager: ProjectManager;
  moduleManager: ModuleManager;
  commRouter: CommRouter;
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
 * Mirror each module-owned file's working-dir copy into the project-local
 * module directory (``<saveDir>/modules/<module_id>/<source_rel_path>``).
 *
 * Called at the tail of ``IPC.project.save`` so that edits made to imported
 * or in-session module files (scripts, libs, guis, namelists) survive a
 * save → close → reopen cycle and can be exported back to the global
 * store later. Skips entries whose ``workdir_path`` no longer exists
 * (e.g. files deleted from the tree between serialization and this copy).
 *
 * Same-file short-circuit: when the working dir and save dir resolve to
 * the same inode (mostly a test fixture scenario), ``fs.copyFile`` would
 * fail with EBUSY — we detect and skip that case explicitly.
 *
 * @param saveDir - Absolute project save directory.
 * @param moduleOwnedFiles - Entries from the kernel's save response.
 * @returns Nothing. Errors are logged but do not fail the save — the
 *   kernel-side serialization (the authoritative part) has already
 *   succeeded by the time this runs.
 */
async function syncModuleOwnedFilesToSaveDir(
  saveDir: string,
  moduleOwnedFiles: ModuleOwnedFile[] | undefined,
): Promise<string[]> {
  const failedPaths: string[] = [];
  if (!moduleOwnedFiles || moduleOwnedFiles.length === 0) return failedPaths;
  for (const entry of moduleOwnedFiles) {
    if (!entry.module_id || !entry.source_rel_path || !entry.workdir_path) {
      continue;
    }
    const dest = path.join(
      saveDir,
      "modules",
      entry.module_id,
      entry.source_rel_path,
    );
    try {
      const srcResolved = path.resolve(entry.workdir_path);
      const destResolved = path.resolve(dest);
      if (srcResolved === destResolved) {
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(srcResolved, destResolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        failedPaths.push(`${entry.module_id}/${entry.source_rel_path}`);
        continue;
      }
      console.warn(
        `[pdv] failed to sync module file ${entry.module_id}/${entry.source_rel_path} to save dir:`,
        error,
      );
    }
  }
  return failedPaths;
}

/**
 * Stamp ``pdv-module.json`` + ``module-index.json`` into
 * ``<saveDir>/modules/<module_id>/`` for every module in the tree.
 *
 * Called at project-save time after the file-sync step (§3) has already
 * placed each module-owned file's contents at the right on-disk
 * location. The writer is authoritative on the schema shape; we just
 * pipe the kernel-emitted bundle through. Errors are logged but never
 * thrown — a manifest write failure must not block the save (the tree
 * content itself is already persisted by the time we get here).
 *
 * @param saveDir - Active project save directory.
 * @param bundles - Per-module manifest bundles from the save response.
 * @returns Nothing.
 */
async function readManifestOnlyFields(
  moduleDir: string,
  moduleId: string,
  moduleManager: ModuleManager,
): Promise<{ entryPoint?: string; defaultGui?: string }> {
  // Try the project-local manifest first (written by a previous save that
  // already had the fix, or copied from the global store on first import).
  try {
    const raw = await fs.readFile(path.join(moduleDir, "pdv-module.json"), "utf8");
    const existing = JSON.parse(raw) as Record<string, unknown>;
    const entryPoint = typeof existing.entry_point === "string" ? existing.entry_point : undefined;
    const defaultGui = typeof existing.default_gui === "string" ? existing.default_gui : undefined;
    if (entryPoint || defaultGui) return { entryPoint, defaultGui };
  } catch {
    // No existing project-local manifest — fall through to installed source.
  }

  // Fallback: read from the globally installed or bundled module. Covers
  // projects saved before this fix was in place, where the project-local
  // pdv-module.json was overwritten without these fields.
  try {
    const installPath = await moduleManager.resolveModuleDir(moduleId, null);
    if (installPath && installPath !== moduleDir) {
      const raw = await fs.readFile(path.join(installPath, "pdv-module.json"), "utf8");
      const source = JSON.parse(raw) as Record<string, unknown>;
      return {
        entryPoint: typeof source.entry_point === "string" ? source.entry_point : undefined,
        defaultGui: typeof source.default_gui === "string" ? source.default_gui : undefined,
      };
    }
  } catch {
    // Module not installed globally — best-effort.
  }

  return {};
}

async function writeModuleManifestsToSaveDir(
  saveDir: string,
  bundles: ModuleManifestBundle[] | undefined,
  moduleManager: ModuleManager,
): Promise<void> {
  if (!bundles || bundles.length === 0) return;
  for (const bundle of bundles) {
    if (!bundle.module_id) continue;
    const moduleDir = path.join(saveDir, "modules", bundle.module_id);

    // Preserve entry_point and default_gui — these are set during module
    // import/install and are not tracked in the kernel tree, so the
    // kernel-side _collect_module_manifests cannot emit them. Without them,
    // project load cannot import custom serializers (entry_point) or
    // display the module in the activity bar (default_gui).
    const { entryPoint, defaultGui } = await readManifestOnlyFields(
      moduleDir, bundle.module_id, moduleManager,
    );

    try {
      await writeModuleManifest(moduleDir, {
        id: bundle.module_id,
        name: bundle.name,
        version: bundle.version,
        description: bundle.description,
        language: bundle.language,
        dependencies: bundle.dependencies,
        entryPoint,
        defaultGui,
        // Default lib_dir for the v4 manifest. Kept for external tooling
        // that reads the on-disk manifest; the TS/kernel setup path no
        // longer consumes this field — the kernel walker in
        // handle_modules_setup derives sys.path entries directly from
        // the live PDVModule subtree.
        libDir: "lib",
      });
      await writeModuleIndex(moduleDir, bundle.entries ?? []);
    } catch (error) {
      console.warn(
        `[pdv] failed to write module manifest for ${bundle.module_id}:`,
        error,
      );
    }
  }
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
    commRouter,
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

  // Serialize concurrent saves so a rapid second call waits for the first to
  // finish rather than racing on the filesystem and kernel shell channel.
  let activeSave: Promise<unknown> = Promise.resolve();
  let saveSeq = 0;

  ipcMain.handle(
    IPC.project.save,
    async (_event, saveDir: string, codeCells: unknown, projectName?: string) => {
      assertCodeCellData(codeCells);
      const seq = ++saveSeq;
      console.debug(`[project:save] IPC received seq=${seq} saveDir=${saveDir}`);

      const doSave = async (): Promise<{ checksum: string; nodeCount: number; projectName?: string; missingFiles?: string[] }> => {
        console.debug(`[project:save] seq=${seq} starting (was queued behind previous save)`);
        const saveResult = await projectManager.save(saveDir, codeCells, {
          language: getActiveKernelLanguage(),
          interpreterPath: getInterpreterPath(),
          projectName,
        });

        // If the serializer detected missing backing files it aborted before
        // writing tree-index.json or project.json, so the existing save dir is
        // still intact. Return immediately so the renderer can block the save
        // and offer Save As.
        if (saveResult.missingFiles.length > 0) {
          console.debug(`[project:save] seq=${seq} BLOCKED — missing backing files`);
          return {
            checksum: saveResult.checksum,
            nodeCount: saveResult.nodeCount,
            missingFiles: saveResult.missingFiles,
          };
        }

        const pendingModuleImports = getPendingModuleImports();
        const pendingModuleSettings = getPendingModuleSettings();
        if (pendingModuleImports.length > 0 || Object.keys(pendingModuleSettings).length > 0) {
          for (const pendingModule of pendingModuleImports) {
            const installPath = await moduleManager.getModuleInstallPath(pendingModule.module_id);
            if (installPath) {
              const dest = path.join(saveDir, "modules", pendingModule.module_id);
              await fs.mkdir(path.join(saveDir, "modules"), { recursive: true });
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

        // Mirror edited working-dir copies of module-owned files back into
        // <saveDir>/modules/<id>/<source_rel_path>. See ARCHITECTURE.md §5.13
        // and the #140 module editing workflow plan §3.
        // TODO(#182): propagate deletions — if a module-owned file was removed
        // from the tree, the pristine copy under <saveDir>/modules/<id>/ is
        // left behind. Safe lacuna for now; fix alongside the GitHub push flow.
        const syncFailedPaths = await syncModuleOwnedFilesToSaveDir(saveDir, saveResult.moduleOwnedFiles);
        await writeModuleManifestsToSaveDir(saveDir, saveResult.moduleManifests, moduleManager);

        setActiveProjectDir(saveDir);
        await refreshProjectModuleHealth(saveDir);

        let savedProjectName: string | undefined;
        try {
          const manifest = await ProjectManager.readManifest(saveDir);
          savedProjectName = manifest.project_name;
        } catch {
          // Non-blocking
        }

        const allMissingFiles = [...(saveResult.missingFiles ?? []), ...syncFailedPaths];
        console.debug(`[project:save] seq=${seq} DONE`);
        return {
          checksum: saveResult.checksum,
          nodeCount: saveResult.nodeCount,
          projectName: savedProjectName,
          missingFiles: allMissingFiles.length > 0 ? allMissingFiles : undefined,
        };
      };

      // Chain behind any in-flight save so they never overlap.
      const queued = activeSave.then(doSave, doSave);
      activeSave = queued.catch(() => {});
      return queued;
    }
  );

  ipcMain.handle(IPC.project.load, async (_event, saveDir: string) => {
    // Copy file-backed node files from save dir into working dir before kernel load.
    let loadFailedPaths: string[] = [];
    const activeKernelId = getActiveKernelId();
    if (activeKernelId) {
      const workingDir = kernelWorkingDirs.get(activeKernelId);
      if (workingDir) {
        const win = getMainWindow();
        loadFailedPaths = await copyFilesForLoad(saveDir, workingDir, win ? (current, total) => {
          win.webContents.send(IPC.push.progress, {
            operation: "load",
            phase: "Copying files",
            current,
            total,
          });
        } : undefined);
        if (loadFailedPaths.length > 0) {
          console.warn(
            `[pdv] load: ${loadFailedPaths.length} file(s) could not be copied from save directory:`,
            loadFailedPaths,
          );
        }
      }
    }

    setActiveProjectDir(saveDir);
    setPendingModuleImports([]);
    setPendingModuleSettings({});
    await refreshProjectModuleHealth(saveDir);

    // Read the manifest checksum and version (the values stored at save time).
    let checksum: string | null = null;
    let savedPdvVersion: string | null = null;
    let projectName: string | null = null;
    let nodeCount: number | null = null;
    try {
      const manifest = await ProjectManager.readManifest(saveDir);
      checksum = manifest.tree_checksum || null;
      savedPdvVersion = manifest.pdv_version || null;
      projectName = manifest.project_name ?? null;
    } catch {
      // Non-blocking — proceed with load even if manifest read fails
    }

    const { codeCells, postLoadChecksum } = await projectManager.load(saveDir);

    // Mirror the project's code-cells.json into the active kernel's working
    // directory so the per-session autosave file is in sync with the loaded
    // project state. The working-dir file is the single source of truth for
    // the UI autosave loop during a session; the saveDir copy is the durable
    // snapshot bundled with the project.
    if (activeKernelId) {
      const workingDir = kernelWorkingDirs.get(activeKernelId);
      if (workingDir && codeCells != null) {
        try {
          await fs.writeFile(
            path.join(workingDir, "code-cells.json"),
            JSON.stringify(codeCells, null, 2),
            "utf8"
          );
        } catch (err) {
          console.warn("[ipc-register-project] mirror code-cells to working dir failed", err);
        }
      }
    }

    // Now that the kernel tree has been repopulated from tree-index.json,
    // wire each module's lib parent dirs into sys.path. The kernel walker
    // in handle_modules_setup is the sole owner of this, so project load
    // must trigger a setup pass whenever it repopulates the tree.
    await setupProjectModuleNamespaces(commRouter, moduleManager, saveDir);

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

    return {
      codeCells, checksum, checksumValid, nodeCount, savedPdvVersion, projectName,
      missingFiles: loadFailedPaths.length > 0 ? loadFailedPaths : undefined,
    };
  });

  // Kernel-working-dir scoped code-cell autosave. Replaces the previous
  // global ~/.PDV/state/code-cells.json file (audit #5): tying cells to the
  // kernel lifetime eliminates cross-project contamination and aligns with
  // "the tree/working dir is the only persistent surface" from ARCHITECTURE.md.
  const codeCellsFilePath = (): string | null => {
    const kernelId = getActiveKernelId();
    if (!kernelId) return null;
    const workingDir = kernelWorkingDirs.get(kernelId);
    if (!workingDir) return null;
    return path.join(workingDir, "code-cells.json");
  };

  ipcMain.handle(IPC.codeCells.load, async (): Promise<CodeCellData | null> => {
    const filePath = codeCellsFilePath();
    if (!filePath) return null;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as CodeCellData;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return null;
      console.warn("[ipc-register-project] codeCells.load failed", err);
      return null;
    }
  });

  ipcMain.handle(IPC.codeCells.save, async (_event, data: unknown): Promise<boolean> => {
    assertCodeCellData(data);
    const filePath = codeCellsFilePath();
    if (!filePath) return false;
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
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
          projectName: manifest.project_name,
        };
      } catch {
        return { language: "python" as const };
      }
    }
  );
}
