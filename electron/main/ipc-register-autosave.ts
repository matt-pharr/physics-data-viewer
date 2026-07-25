/**
 * ipc-register-autosave.ts — Autosave IPC handlers and snapshot machinery.
 *
 * Registers the `autosave:*` channels (run, clear, check, scanWorkingDirs,
 * recoverUnsaved, deleteOrphan) and owns the shared snapshot routines:
 *
 * - `performAutosave` — core tree + sidecar snapshot under the save lock.
 * - `triggerAutosave` — timer/idle entry point; defers while the kernel is
 *   busy (the deferred save fires from the caller's execution-state
 *   listener).
 * - `autosaveBeforeRestart` — bounded pre-restart snapshot with the
 *   dead/busy-kernel liveness gate (ARCHITECTURE.md §11.6).
 * - `recoverUnsavedSession` — restore an orphaned working dir's `.autosave`
 *   into the active session (welcome-screen Recover and post-restart
 *   recovery share this path).
 *
 * These are returned to the caller as an {@link AutosaveController} so
 * `registerKernelIpcHandlers` (restart flow) and the execution-state
 * listener can invoke them.
 *
 * What this file does NOT do
 * - It does not own the autosave *timer* — `ProjectManager` runs it; the
 *   caller starts/stops it on kernel switch and settings changes.
 * - It does not track active project/kernel state; accessors are injected.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { mirrorAutosaveSidecars, autosaveDirFor } from "./autosave-sidecars";
import type { CommRouter } from "./comm-router";
import { ConfigStore, PDVConfig } from "./config";
import { IPC, type CodeCellData } from "./ipc";
import type { KernelManager } from "./kernel-manager";
import type { ModuleManager } from "./module-manager";
import { setupProjectModuleNamespaces } from "./module-runtime";
import { getAppVersion } from "./pdv-protocol";
import { copyFilesForLoad } from "./project-file-sync";
import { ProjectManager, type ProjectModuleImport } from "./project-manager";
import { handleInvoke, type PushSender } from "./server/invoke-registry";

/** Dependencies for {@link registerAutosaveIpcHandlers}. */
export interface RegisterAutosaveIpcHandlersOptions {
  /** Renderer-push sender, used for autosave gating and progress pushes. */
  push: PushSender;
  kernelManager: KernelManager;
  commRouter: CommRouter;
  projectManager: ProjectManager;
  moduleManager: ModuleManager;
  configStore: ConfigStore;
  /** Map of kernel id → kernel working dir (owned by the caller). */
  kernelWorkingDirs: Map<string, string>;
  /** Read the full config, applying defaults. */
  readConfig: (store: ConfigStore) => PDVConfig;
  /** Accessor for the active kernel id. */
  getActiveKernelId: () => string | null;
  /** Accessor for the active project save dir (null when unsaved). */
  getActiveProjectDir: () => string | null;
  /** Snapshot of in-memory module imports pending the first save. */
  getPendingModuleImports: () => ProjectModuleImport[];
  /** Snapshot of in-memory module settings pending the first save. */
  getPendingModuleSettings: () => Record<string, Record<string, unknown>>;
  /**
   * Replace the caller's pending-module state (used by recovery to restore
   * the manifest's module imports into the unsaved session).
   */
  setPendingModuleState: (
    imports: ProjectModuleImport[],
    settings: Record<string, Record<string, unknown>>,
  ) => void;
}

/** Result of {@link AutosaveController.recoverUnsavedSession}. */
export interface RecoverUnsavedResult {
  /** Recovered code cells, or null when the snapshot carried none. */
  codeCells: CodeCellData | null;
  /** Always null — recovery restores an *unsaved* session. */
  projectName: null;
  /** Tree files that could not be copied from the orphan, if any. */
  missingFiles?: string[];
}

/** Snapshot routines shared with the kernel registrar and idle listener. */
export interface AutosaveController {
  /**
   * Timer/idle autosave entry point. Defers (via
   * `projectManager.setAutosavePending`) while the kernel is executing.
   */
  triggerAutosave(): void;
  /**
   * Core autosave routine, shared by the renderer-triggered `autosave:run`
   * handler and the pre-restart snapshot. Saves the tree into
   * `<baseDir>/.autosave` and mirrors the manifest/module sidecars needed
   * for recovery.
   *
   * @param codeCells - Code-cell state to bundle with the snapshot.
   * @param opts - `timeoutMs` bounds the kernel comm request.
   * @returns `{ saved: false }` when there is nowhere to save or the
   *   kernel-side save failed.
   */
  performAutosave(
    codeCells: CodeCellData,
    opts?: { timeoutMs?: number },
  ): Promise<{ saved: boolean }>;
  /**
   * Pre-restart snapshot. Attempts a fresh autosave only when the kernel
   * process is alive AND idle (a crashed kernel reports stale-idle); falls
   * back to reporting whether the last timer autosave exists.
   *
   * @param kernelId - The kernel session being restarted.
   * @returns True when `<baseDir>/.autosave` holds a usable snapshot.
   */
  autosaveBeforeRestart(kernelId: string): Promise<boolean>;
  /**
   * Restore an unsaved session's `.autosave` snapshot from `orphanDir` into
   * the active session's working dir, load the tree/cells from it, and
   * delete the orphan.
   *
   * @param orphanDir - Working directory of the orphaned session.
   * @throws {Error} When there is no active kernel session to recover into,
   *   or the orphan dir is the active working dir.
   */
  recoverUnsavedSession(orphanDir: string): Promise<RecoverUnsavedResult>;
}

/**
 * Register all `autosave:*` IPC handlers and build the shared snapshot
 * routines.
 *
 * @param options - Dependency bag (managers, window, state accessors).
 * @returns The {@link AutosaveController} for the caller to wire into the
 *   kernel registrar and the execution-state idle listener.
 * @throws {Error} Never throws synchronously; individual handlers propagate
 *   errors to their renderer callers.
 */
export function registerAutosaveIpcHandlers(
  options: RegisterAutosaveIpcHandlersOptions,
): AutosaveController {
  const {
    push,
    kernelManager,
    commRouter,
    projectManager,
    moduleManager,
    configStore,
    kernelWorkingDirs,
    readConfig,
    getActiveKernelId,
    getActiveProjectDir,
    getPendingModuleImports,
    getPendingModuleSettings,
    setPendingModuleState,
  } = options;

  function triggerAutosave(): void {
    const activeKernelId = getActiveKernelId();
    if (!activeKernelId) return;
    const state = kernelManager.getExecutionState(activeKernelId);
    if (state !== "idle") {
      console.log("[autosave] kernel busy, deferring until idle");
      projectManager.setAutosavePending();
      return;
    }
    push(IPC.push.autosaveTrigger);
  }

  async function performAutosave(
    codeCells: CodeCellData,
    opts?: { timeoutMs?: number },
  ): Promise<{ saved: boolean }> {
    const activeKernelId = getActiveKernelId();
    const activeProjectDir = getActiveProjectDir();
    const baseDir = activeProjectDir || kernelWorkingDirs.get(activeKernelId ?? "");
    if (!baseDir) {
      console.warn(
        "[autosave] skipped: no active project dir or kernel working dir",
      );
      return { saved: false };
    }

    // Snapshot the in-memory module-import state up front. The autosave is
    // about to await a kernel comm + several disk writes; if a `modules:*`
    // IPC mutates the pending imports mid-flight the synthesized manifest
    // could be torn. (Also belt-and-suspenders against the save-lock below.)
    const importsSnapshot = [...getPendingModuleImports()];
    const settingsSnapshot = { ...getPendingModuleSettings() };
    const language: "python" | "julia" = activeKernelId
      ? (kernelManager.getKernel(activeKernelId)?.language ?? "python")
      : "python";

    return projectManager.runWithSaveLock(async () => {
      // Bracket the kernel comm with start/end pushes so the renderer can
      // gate cell execution. An execute_request queued behind a
      // pdv.project.save in ipykernel's shell channel can hang in ways
      // that aren't worth root-causing here — easier to keep them off the
      // wire entirely until the save returns.
      push(IPC.push.autosaveStarted);
      try {
        const autosaveDir = autosaveDirFor(baseDir);
        const result = await projectManager.autosave(autosaveDir, codeCells, opts);
        if (result === null) return { saved: false };

        await mirrorAutosaveSidecars(
          autosaveDir,
          result,
          {
            activeProjectDir,
            pendingImports: importsSnapshot,
            pendingSettings: settingsSnapshot,
            language,
            pdvVersion: getAppVersion(),
          },
          moduleManager,
        );

        return { saved: true };
      } finally {
        push(IPC.push.autosaveEnded);
      }
    });
  }

  async function autosaveBeforeRestart(kernelId: string): Promise<boolean> {
    const workingDir = kernelWorkingDirs.get(kernelId);
    const baseDir = getActiveProjectDir() || workingDir;
    if (!baseDir) return false;

    const proc = kernelManager.getKernelProcessState(kernelId);
    const dead =
      !proc ||
      proc.exitCode !== null ||
      proc.killed ||
      kernelManager.getKernel(kernelId)?.status === "dead";
    if (!dead && kernelManager.getExecutionState(kernelId) === "idle") {
      let codeCells: CodeCellData = { tabs: [], activeTabId: 1 };
      if (workingDir) {
        try {
          codeCells = JSON.parse(
            await fs.readFile(path.join(workingDir, "code-cells.json"), "utf8"),
          ) as CodeCellData;
        } catch {
          /* no cells mirrored yet — snapshot the tree with empty cells */
        }
      }
      const result = await performAutosave(codeCells, { timeoutMs: 5000 });
      if (result.saved) return true;
    } else {
      console.warn(
        dead
          ? "[autosave] pre-restart snapshot skipped: server process is dead; falling back to the last timer autosave"
          : "[autosave] pre-restart snapshot skipped: server not idle; falling back to the last timer autosave",
      );
    }
    return (await ProjectManager.checkForAutosave(baseDir)).exists;
  }

  async function recoverUnsavedSession(orphanDir: string): Promise<RecoverUnsavedResult> {
    const activeKernelId = getActiveKernelId();
    if (!activeKernelId) {
      throw new Error("Cannot recover unsaved session: no active kernel");
    }
    const workingDir = kernelWorkingDirs.get(activeKernelId);
    if (!workingDir) {
      throw new Error("Cannot recover unsaved session: active kernel has no working dir");
    }
    if (workingDir === orphanDir) {
      throw new Error("Cannot recover unsaved session: orphan dir is the active working dir");
    }

    const orphanAutosaveDir = path.join(orphanDir, ".autosave");
    const onProgress = (current: number, total: number) => {
      push(IPC.push.progress, {
        operation: "load",
        phase: "Copying files",
        current,
        total,
      });
    };

    const missingFiles = await copyFilesForLoad(orphanAutosaveDir, workingDir, onProgress);
    if (missingFiles.length > 0) {
      console.warn(
        `[autosave:recoverUnsaved] ${missingFiles.length} file(s) could not be copied from orphan autosave:`,
        missingFiles,
      );
    }

    // Copy the manifest snapshot + module mirror so module namespace setup
    // (both the kernel-side _early_module_setup and the main-side
    // setupProjectModuleNamespaces below) finds the bindings the user had
    // before the crash. copyFilesForLoad only handles UUID tree files, so
    // these are explicit. Each copy is best-effort: an autosave produced
    // before this change ships won't have these files, and recovery should
    // still proceed with whatever it can salvage.
    const orphanProjectJson = path.join(orphanAutosaveDir, "project.json");
    const orphanModulesDir = path.join(orphanAutosaveDir, "modules");
    try {
      await fs.copyFile(orphanProjectJson, path.join(workingDir, "project.json"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.warn("[autosave:recoverUnsaved] copy project.json failed", err);
      }
    }
    try {
      await fs.cp(orphanModulesDir, path.join(workingDir, "modules"), {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.warn("[autosave:recoverUnsaved] copy modules dir failed", err);
      }
    }

    // Preserve project-environment files from the orphan's working dir
    // (pkg: Project.toml/Manifest.toml; uv: pyproject.toml/uv.lock/
    // .python-version). The orphan is the ONLY copy for an unsaved session —
    // without this, deleting the orphan below permanently demoted the
    // recovered project to shared mode (PR #347 review M2). With the files
    // in the new working dir, Save As stamps the right mode and a kernel
    // restart re-activates the environment.
    const envFiles = [
      "Project.toml",
      "Manifest.toml",
      "pyproject.toml",
      "uv.lock",
      ".python-version",
    ];
    let envCopyFailed = false;
    for (const envFile of envFiles) {
      try {
        await fs.copyFile(path.join(orphanDir, envFile), path.join(workingDir, envFile));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          envCopyFailed = true;
          console.warn(`[autosave:recoverUnsaved] copy ${envFile} failed`, err);
        }
      }
    }

    // Restore in-memory pending-imports state from the recovered manifest so
    // a future Save As writes the modules into the new save dir's manifest.
    try {
      const recovered = await ProjectManager.readManifest(workingDir);
      setPendingModuleState([...recovered.modules], { ...recovered.module_settings });
    } catch {
      // No manifest in the orphan (older autosave format) — nothing to restore.
    }

    // Load the tree and code cells from the orphan's .autosave/. The kernel's
    // save_dir is set to the new working dir; activeProjectDir stays null so
    // the project remains in the unsaved state.
    const { codeCells } = await projectManager.load(workingDir, {
      treeIndexDir: orphanAutosaveDir,
      codeCellsDir: orphanAutosaveDir,
    });

    // Mirror code-cells.json into the new working dir so the per-session
    // autosave loop has an up-to-date baseline.
    if (codeCells != null) {
      try {
        await fs.writeFile(
          path.join(workingDir, "code-cells.json"),
          JSON.stringify(codeCells, null, 2),
          "utf8",
        );
      } catch (err) {
        console.warn("[autosave:recoverUnsaved] mirror code-cells failed", err);
      }
    }

    // Wire any module namespaces that the recovered tree references. Pass
    // the working dir as the project root since there is no save dir yet.
    await setupProjectModuleNamespaces(commRouter, moduleManager, workingDir);

    // Remove the orphan now that the recovery has succeeded — but never
    // while an environment file failed to copy out: the orphan holds the
    // only copy, and losing Project.toml/pyproject.toml silently demotes
    // the project to shared mode (PR #347 review M2).
    if (envCopyFailed) {
      console.warn(
        "[autosave:recoverUnsaved] keeping orphan dir: environment file copy failed",
        orphanDir,
      );
    } else {
      try {
        await fs.rm(orphanDir, { recursive: true, force: true });
      } catch (err) {
        console.warn("[autosave:recoverUnsaved] failed to remove orphan dir", err);
      }
    }

    return {
      // `projectManager.load` types codeCells as unknown; the on-disk shape
      // is the renderer's own mirrored CodeCellData.
      codeCells: (codeCells ?? null) as CodeCellData | null,
      projectName: null,
      missingFiles: missingFiles.length > 0 ? missingFiles : undefined,
    };
  }

  handleInvoke(IPC.autosave.run, async (_ctx, codeCells: unknown) => {
    return performAutosave(codeCells as CodeCellData);
  });

  handleInvoke(IPC.autosave.clear, async (_ctx, dir?: string) => {
    const target =
      dir || getActiveProjectDir() || kernelWorkingDirs.get(getActiveKernelId() ?? "");
    if (target) {
      // Order matters: clear the kernel-side cache *before* deleting the
      // `.autosave/` dir on disk. If an autosave timer were to fire between
      // these two awaits, a populated cache + missing `.autosave/` is the
      // exact stale-entry condition we're trying to avoid. Clearing the
      // cache first means any racing autosave starts from a clean slate.
      // markAutosaveCacheDirty() is the in-band fallback if the comm fails.
      await projectManager.clearAutosaveCache();
      projectManager.markAutosaveCacheDirty();
      await ProjectManager.clearAutosave(target);
    }
  });

  handleInvoke(IPC.autosave.check, async (_ctx, dir: string) => {
    return ProjectManager.checkForAutosave(dir);
  });

  handleInvoke(IPC.autosave.scanWorkingDirs, async () => {
    const config = readConfig(configStore);
    const base = config.workingDirBase || path.join(os.homedir(), ".PDV", "working");
    const results = await ProjectManager.scanForAutosaves(base);
    // Hide the active session's own working dir so the welcome screen never
    // offers it as recoverable. (Reachable via File → New Project, which
    // shows the welcome screen mid-session without restarting the kernel.)
    const activeKernelId = getActiveKernelId();
    const activeWorkingDir = activeKernelId ? kernelWorkingDirs.get(activeKernelId) : undefined;
    return activeWorkingDir
      ? results.filter((r) => r.dir !== activeWorkingDir)
      : results;
  });

  handleInvoke(IPC.autosave.recoverUnsaved, async (_ctx, orphanDir: string) => {
    return recoverUnsavedSession(orphanDir);
  });

  handleInvoke(IPC.autosave.deleteOrphan, async (_ctx, orphanDir: string) => {
    // Defense in depth: the renderer-side scan already filters this out, but
    // never let a bug or stale list cause us to rm -rf the live working dir.
    const activeKernelId = getActiveKernelId();
    const activeWorkingDir = activeKernelId ? kernelWorkingDirs.get(activeKernelId) : undefined;
    if (activeWorkingDir && orphanDir === activeWorkingDir) {
      throw new Error("Cannot discard the active session's working directory");
    }
    await fs.rm(orphanDir, { recursive: true, force: true });
  });

  return { triggerAutosave, performAutosave, autosaveBeforeRestart, recoverUnsavedSession };
}
