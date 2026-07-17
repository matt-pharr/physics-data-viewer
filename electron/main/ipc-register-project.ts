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
import { type BrowserWindow } from "electron";
import { handleIpc } from "./ipc-registry";

import type { CommRouter } from "./comm-router";
import type { ActiveEnvironmentInfo, CodeCellData, JuliaVersionLoadCheck, ProjectFailedNode } from "./ipc";
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
import { copyEnvFilesForSave, copyFilesForLoad, overlayAutosaveTreeFiles, type LoadEnvSyncResult } from "./project-file-sync";
import {
  writeModuleIndex,
  writeModuleManifest,
} from "./module-manifest-writer";
import { atomicCopyFile } from "./atomic-write";

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
  /**
   * Run *fn* serially against any other ``project.json`` mutation. Same
   * lock that ``ipc-register-modules.ts`` takes around its read-modify-write
   * settings/imports mutations; acquired here around the whole explicit
   * save body so a module-settings update can't race the manifest
   * snapshot taken inside ``ProjectManager.save`` and get silently
   * overwritten by the final ``commitProjectManifest``.
   */
  runSerializedProjectManifestMutation: <T>(dir: string, task: () => Promise<T>) => Promise<T>;
  getMainWindow: () => BrowserWindow | null;
  /**
   * Fallback interpreter path from the global config, used only when the
   * active kernel has no recorded environment metadata (legacy sessions).
   */
  getInterpreterPath: () => string | undefined;
  /**
   * Environment metadata of the active kernel (mode, actual interpreter,
   * resolved Python version), recorded by `kernels.start`/`restart`. The
   * authoritative source for the manifest's `environment` and
   * `interpreter_path` fields at save time (§10.5); undefined when no
   * kernel is active or the entry is missing.
   */
  getActiveKernelEnvMeta: () => ActiveEnvironmentInfo | undefined;
  /**
   * Bring the running uv session's environment in line with the project
   * being opened (`copy env files + uv sync`, see
   * {@link syncUvEnvironmentForLoad} in project-file-sync.ts). Called by
   * `project:load` when the active kernel is uv-mode; the returned warning
   * (if any) is surfaced to the renderer via the load result.
   */
  syncUvEnvironmentForLoad?: (
    saveDir: string,
    workingDir: string
  ) => Promise<LoadEnvSyncResult>;
  /**
   * Julia analog for `mode: "pkg"` sessions (§10.6.6): copy the opened
   * project's `Project.toml`/`Manifest.toml` over the working dir's and
   * `Pkg.instantiate`. Called by `project:load` when the active kernel is
   * pkg-mode.
   */
  syncPkgEnvironmentForLoad?: (
    saveDir: string,
    workingDir: string
  ) => Promise<LoadEnvSyncResult>;
  /**
   * Compare the opened pkg project's `Manifest.toml` `julia_version` with
   * the session's Julia and the installed juliaup channels (§10.7.5 —
   * `checkJuliaVersionForLoad` in juliaup-runner.ts). The result rides the
   * load result so the renderer can offer a `juliaup add`; advisory only,
   * never blocks the load.
   */
  checkJuliaVersionForLoad?: (
    saveDir: string,
    runningVersion?: string
  ) => Promise<JuliaVersionLoadCheck | undefined>;
  /** Called after a successful explicit save to clean up autosave state. */
  onExplicitSaveCompleted?: (saveDir: string) => void;
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
export async function syncModuleOwnedFilesToSaveDir(
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
      // Atomic copy: write to <dest>.tmp then rename onto dest, so a
      // crash mid-copy leaves the prior version of the user-edited
      // module file intact. The previous direct fs.copyFile overwrote
      // dest in place, briefly torn while the write was in progress.
      await atomicCopyFile(srcResolved, destResolved);
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

/**
 * Write each module's v4 `pdv-module.json` + `module-index.json` under
 * `<saveDir>/modules/<id>/` at save time.
 *
 * `entry_point` and `default_gui` are recovered from the installed module's
 * manifest (via {@link readManifestOnlyFields}) because they are set during
 * import/install and are not tracked in the kernel tree, so the kernel-side
 * descriptor bundles can't carry them.
 *
 * @param saveDir - Absolute path to the project save directory.
 * @param bundles - Per-module manifest bundles from the kernel save response;
 *   a no-op when undefined or empty (project has no `PDVModule` nodes).
 * @param moduleManager - Used to resolve the installed module directory when
 *   recovering manifest-only fields.
 * @returns Nothing.
 */
export async function writeModuleManifestsToSaveDir(
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
    getActiveKernelEnvMeta,
    syncUvEnvironmentForLoad,
    syncPkgEnvironmentForLoad,
    checkJuliaVersionForLoad,
    onExplicitSaveCompleted,
  } = options;

  // Serialization of concurrent saves and autosaves is done by the shared
  // `projectManager.runWithSaveLock` mutex (see ProjectManager). Both the
  // IPC.project.save handler below and the IPC.autosave.run handler in
  // electron/main/index.ts acquire the same lock so a rapid second save
  // waits for the first to finish, and autosave never overlaps an
  // explicit save.
  let saveSeq = 0;

  handleIpc(
    IPC.project.save,
    async (_event, saveDir: string, codeCells: unknown, projectName?: string) => {
      assertCodeCellData(codeCells);
      const seq = ++saveSeq;
      console.debug(`[project:save] IPC received seq=${seq} saveDir=${saveDir}`);

      const doSave = async (): Promise<{
        checksum: string;
        nodeCount: number;
        projectName?: string;
        missingFiles?: string[];
        failedNodes?: ProjectFailedNode[];
      }> => {
        console.debug(`[project:save] seq=${seq} starting (was queued behind previous save)`);

        // A uv project is identified by a pyproject.toml in the working dir
        // (generated for new projects, copied for opened ones); a pkg-mode
        // Julia project by a Project.toml (§10.6). Record the mode in the
        // manifest and write the env files back to the save dir
        // (§10.5.10 / §10.6.7).
        const activeKernelId = getActiveKernelId();
        const activeLanguage = getActiveKernelLanguage();
        const uvWorkingDir = activeKernelId ? kernelWorkingDirs.get(activeKernelId) : undefined;

        // Manifest-based guard (PR #347 review): loading a legacy shared
        // save into a live per-project-env session leaves the PREVIOUS
        // project's env files in the working dir — the load-time sync
        // no-ops when the save dir has none. Working-dir presence alone
        // would then re-stamp this project "uv"/"pkg" and copy that foreign
        // env spec into its save dir. When the project already has a
        // manifest, its recorded mode wins; only a manifest-less save dir
        // (Save As / first save) falls back to working-dir detection.
        let priorEnvMode: string | undefined;
        const manifestExists = await fs
          .access(path.join(saveDir, "project.json"))
          .then(() => true)
          .catch(() => false);
        if (manifestExists) {
          try {
            const priorManifest = await ProjectManager.readManifest(saveDir);
            priorEnvMode = priorManifest.environment?.mode ?? "shared";
          } catch {
            priorEnvMode = undefined; // unreadable manifest — detect from the working dir
          }
        }

        const isUvProject =
          uvWorkingDir &&
          activeLanguage !== "julia" &&
          (priorEnvMode === undefined || priorEnvMode === "uv")
            ? await fs
                .access(path.join(uvWorkingDir, "pyproject.toml"))
                .then(() => true)
                .catch(() => false)
            : false;
        const isPkgProject =
          uvWorkingDir &&
          activeLanguage === "julia" &&
          (priorEnvMode === undefined || priorEnvMode === "pkg")
            ? await fs
                .access(path.join(uvWorkingDir, "Project.toml"))
                .then(() => true)
                .catch(() => false)
            : false;

        // Environment recording (§10.5 / §10.6): uv projects record mode +
        // the resolved Python version, pkg projects mode + the Julia version
        // (the environment paths are ephemeral, so no interpreter_path);
        // shared projects record the interpreter the kernel actually spawned
        // on — falling back to the global config value only when no
        // per-kernel metadata exists (legacy sessions).
        const envMeta = getActiveKernelEnvMeta();
        const saveResult = await projectManager.save(saveDir, codeCells, {
          language: activeLanguage,
          interpreterPath: isUvProject || isPkgProject
            ? undefined
            : (envMeta?.interpreterPath ?? getInterpreterPath()),
          projectName,
          environment: isUvProject
            ? { mode: "uv", python_version: envMeta?.pythonVersion }
            : isPkgProject
              ? { mode: "pkg", julia_version: envMeta?.juliaVersion }
              : { mode: "shared" },
        });

        // If the serializer detected missing backing files it aborted before
        // writing code-cells.json or project.json, so the existing save dir is
        // still intact. Return immediately so the renderer can block the save
        // and offer Save As.
        if (saveResult.missingFiles.length > 0) {
          console.debug(`[project:save] seq=${seq} BLOCKED — missing backing files`);
          return {
            checksum: saveResult.checksum,
            nodeCount: saveResult.nodeCount,
            missingFiles: saveResult.missingFiles,
            failedNodes: saveResult.failedNodes?.length ? saveResult.failedNodes : undefined,
          };
        }

        // `pendingManifest` is the manifest staged by `save()` carrying any
        // pre-existing modules/settings forward. Pending imports merge into
        // it below, then it gets committed atomically at the end.
        // The check on `missingFiles.length` above guarantees this is
        // present; the runtime guard is belt-and-suspenders so the type
        // narrows cleanly without a non-null assertion.
        const finalManifest: ProjectManifest | undefined = saveResult.pendingManifest;
        if (!finalManifest) {
          throw new Error(
            "[project:save] internal invariant: ProjectManager.save did not return a pendingManifest despite no missingFiles",
          );
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
          finalManifest.modules = [...finalManifest.modules, ...pendingModuleImports];
          finalManifest.module_settings = { ...finalManifest.module_settings, ...pendingModuleSettings };
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

        // Commit gate: atomically write project.json as the very last
        // file. Until this returns, the prior project.json (if any) is
        // untouched. After this returns, every other persistent artifact
        // of the save is already on disk, so a parseable project.json
        // implies the save is complete.
        await projectManager.commitProjectManifest(saveDir, finalManifest);

        // Persist the environment spec alongside the manifest. Only files
        // present in the working dir are copied, so a failed sync (no uv.lock)
        // never clobbers a previously-saved lock (§10.5.10 / §10.6.7).
        if (isUvProject && uvWorkingDir) {
          await copyEnvFilesForSave(uvWorkingDir, saveDir);
        } else if (isPkgProject && uvWorkingDir) {
          await copyEnvFilesForSave(uvWorkingDir, saveDir, "julia");
        }

        setActiveProjectDir(saveDir);
        await refreshProjectModuleHealth(saveDir);
        onExplicitSaveCompleted?.(saveDir);

        const allMissingFiles = [...(saveResult.missingFiles ?? []), ...syncFailedPaths];
        console.debug(`[project:save] seq=${seq} DONE`);
        return {
          checksum: saveResult.checksum,
          nodeCount: saveResult.nodeCount,
          projectName: finalManifest.project_name,
          missingFiles: allMissingFiles.length > 0 ? allMissingFiles : undefined,
          // Nodes the kernel skipped because they refused to serialize — the
          // save completed without them, so the renderer must warn (a save
          // that skipped nodes must not be indistinguishable from complete).
          failedNodes: saveResult.failedNodes?.length ? saveResult.failedNodes : undefined,
        };
      };

      // Chain behind any in-flight save or autosave so they never overlap.
      // Bracket with autosave start/end pushes so the renderer's cell-execution
      // gate treats explicit saves the same as autosaves — both put a
      // pdv.project.save comm on the kernel's shell channel, so cells must
      // wait either way to avoid the queue-stuck symptom.
      //
      // The body also runs inside `runSerializedProjectManifestMutation`
      // so concurrent module IPC handlers (which take that lock around
      // their read-modify-write of project.json) can't land an update
      // between `ProjectManager.save` reading the current manifest and
      // `commitProjectManifest` atomically writing the merged result.
      // Lock order: save-lock (outer) → manifest-write-lock (inner).
      // No deadlock: nothing acquires save-lock while holding the
      // manifest-write-lock (autosave doesn't touch project.json, and
      // module handlers don't take the save-lock).
      return projectManager.runWithSaveLock(async () =>
        runSerializedProjectManifestMutation(saveDir, async () => {
          // Best-effort pushes: a window torn down mid-save must not turn
          // into an "Object has been destroyed" throw — and a throw from the
          // finally leg would mask doSave's real error.
          const win = getMainWindow();
          const safeSend = (channel: string): void => {
            if (!win || win.isDestroyed()) return;
            try {
              win.webContents.send(channel);
            } catch (err) {
              console.warn(`[project:save] push ${channel} failed:`, err);
            }
          };
          safeSend(IPC.push.autosaveStarted);
          try {
            return await doSave();
          } finally {
            safeSend(IPC.push.autosaveEnded);
          }
        }),
      );
    }
  );

  handleIpc(IPC.project.load, async (_event, saveDir: string, options?: { restoreFromAutosave?: boolean }) => {
    const restoreFromAutosave = options?.restoreFromAutosave ?? false;
    const autosaveDir = path.join(saveDir, ".autosave");

    // Copy file-backed node files from save dir into working dir before kernel load.
    let loadFailedPaths: string[] = [];
    let envSyncWarning: string | undefined;
    let juliaVersionCheck: JuliaVersionLoadCheck | undefined;
    const activeKernelId = getActiveKernelId();
    if (activeKernelId) {
      const workingDir = kernelWorkingDirs.get(activeKernelId);
      if (workingDir) {
        // The session keeps its kernel across an open, so its uv environment
        // must be re-pointed at the opened project: copy the project's env
        // files over the previous project's and sync the venv. Without this
        // the kernel can't import the opened project's packages and a later
        // save would clobber the project's pyproject/uv.lock with the stale
        // working-dir copies (§10.5.10).
        const activeEnvMode = getActiveKernelEnvMeta()?.mode;
        if (activeEnvMode === "uv" && syncUvEnvironmentForLoad) {
          try {
            const envSync = await syncUvEnvironmentForLoad(saveDir, workingDir);
            envSyncWarning = envSync.warning;
          } catch (err) {
            console.warn("[ipc-register-project] env sync on load failed:", err);
            envSyncWarning =
              "Failed to update the session environment for this project — " +
              "its packages may be unavailable.";
          }
        } else if (activeEnvMode === "pkg" && syncPkgEnvironmentForLoad) {
          try {
            const envSync = await syncPkgEnvironmentForLoad(saveDir, workingDir);
            envSyncWarning = envSync.warning;
          } catch (err) {
            console.warn("[ipc-register-project] env sync on load failed:", err);
            envSyncWarning =
              "Failed to update the session environment for this project — " +
              "its packages may be unavailable.";
          }
        }
        // Advisory Julia-version assessment (§10.7.5): does the project's
        // Manifest.toml resolution version match the session, and if not,
        // is the matching juliaup channel installed? Never blocks the load.
        if (activeEnvMode === "pkg" && checkJuliaVersionForLoad) {
          try {
            juliaVersionCheck = await checkJuliaVersionForLoad(
              saveDir,
              getActiveKernelEnvMeta()?.juliaVersion
            );
          } catch (err) {
            console.warn("[ipc-register-project] julia version check failed:", err);
          }
        }
        const win = getMainWindow();
        const onProgress = win ? (current: number, total: number) => {
          win.webContents.send(IPC.push.progress, {
            operation: "load",
            phase: "Copying files",
            current,
            total,
          });
        } : undefined;
        // Baseline: copy from the main save dir
        loadFailedPaths = await copyFilesForLoad(saveDir, workingDir, onProgress);
        // Overlay: copy any files the autosave wrote on top. Uses a directory
        // copy rather than tree-index-driven copy because the autosave's
        // tree-index can reference cache-hit canonical UUIDs whose files only
        // exist under <saveDir>/tree/ (already copied above) — those would
        // ENOENT under the prior copyFilesForLoad-based overlay and surface
        // as bogus "missing files" warnings. See ARCHITECTURE.md §8.4.
        if (restoreFromAutosave) {
          await overlayAutosaveTreeFiles(autosaveDir, workingDir);
        }
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

    const loadOptions = restoreFromAutosave
      ? { treeIndexDir: autosaveDir, codeCellsDir: autosaveDir }
      : undefined;
    const { codeCells, postLoadChecksum } = await projectManager.load(saveDir, loadOptions);

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
      envSyncWarning,
      juliaVersionCheck,
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

  handleIpc(IPC.codeCells.load, async (): Promise<CodeCellData | null> => {
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

  handleIpc(IPC.codeCells.save, async (_event, data: unknown): Promise<boolean> => {
    assertCodeCellData(data);
    const filePath = codeCellsFilePath();
    if (!filePath) return false;
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  });

  handleIpc(IPC.project.new, async () => {
    setActiveProjectDir(null);
    setPendingModuleImports([]);
    setPendingModuleSettings({});
    clearModuleHealthWarnings();
    return true;
  });

  handleIpc(
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

  handleIpc(
    IPC.project.peekManifest,
    async (_event, dir: string) => {
      try {
        const manifest = await ProjectManager.readManifest(dir);
        return {
          language: manifest.language,
          interpreterPath: manifest.interpreter_path,
          pdvVersion: manifest.pdv_version,
          projectName: manifest.project_name,
          environment: manifest.environment,
        };
      } catch {
        return { language: "python" as const };
      }
    }
  );
}
