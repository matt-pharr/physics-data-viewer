/**
 * ipc-register-kernels.ts — Register kernel lifecycle IPC handlers.
 *
 * Responsibilities:
 * - Register `window.pdv.kernels.*` IPC channels (list/start/stop/execute/etc.).
 * - Coordinate kernel start, restart, and stop flows.
 * - Manage crash handler registration and working directory cleanup.
 *
 * Non-responsibilities:
 * - Tree/namespace/script IPC handlers.
 * - Project save/load/new IPC handlers.
 * - Module IPC handlers.
 * - Push forwarding.
 */

import { BrowserWindow, ipcMain } from "electron";

import { CommRouter } from "./comm-router";
import { QueryRouter } from "./query-router";
import { EnvironmentDetector } from "./environment-detector";
import { IPC } from "./ipc";
import { KernelManager, type KernelInfo } from "./kernel-manager";
import { initializeKernelSession } from "./kernel-session";
import type { ModuleManager } from "./module-manager";
import { buildModulesSetupPayload } from "./module-runtime";
import { PDVMessageType } from "./pdv-protocol";
import { copyFilesForLoad } from "./project-file-sync";
import { ProjectManager } from "./project-manager";

interface RegisterKernelIpcHandlersOptions {
  win: BrowserWindow;
  kernelManager: KernelManager;
  commRouter: CommRouter;
  queryRouter: QueryRouter;
  projectManager: ProjectManager;
  moduleManager: ModuleManager;
  kernelWorkingDirs: Map<string, string>;
  crashHandlers: Map<string, (id: string) => void>;
  resetProjectState: () => void;
  resetKernelState: () => void;
  setActiveKernelId: (id: string | null) => void;
  getActiveKernelId: () => string | null;
  getActiveProjectDir: () => string | null;
  bindActiveProjectModules: (kernelId: string | null) => Promise<void>;
}

/**
 * Delete the working directory for a kernel and remove its crash handler.
 *
 * @param projectManager - Project manager used for deletion.
 * @param kernelManager  - Kernel manager used to remove event listeners.
 * @param kernelId       - Kernel whose working dir should be cleaned up.
 * @param kernelWorkingDirs - Map of kernel IDs to working directory paths.
 * @param crashHandlers  - Map of kernel IDs to crash handler functions.
 */
async function cleanupKernelWorkingDir(
  projectManager: ProjectManager,
  kernelManager: KernelManager,
  kernelId: string,
  kernelWorkingDirs: Map<string, string>,
  crashHandlers: Map<string, (id: string) => void>
): Promise<void> {
  const oldDir = kernelWorkingDirs.get(kernelId);
  if (oldDir) {
    await projectManager.deleteWorkingDir(oldDir);
    kernelWorkingDirs.delete(kernelId);
  }
  const handler = crashHandlers.get(kernelId);
  if (handler) {
    kernelManager.removeListener("kernel:crashed", handler);
    crashHandlers.delete(kernelId);
  }
}

/**
 * Register kernel-domain IPC handlers under `IPC.kernels.*`.
 *
 * @param options - Dependencies, shared state accessors, and callbacks.
 * @returns Nothing.
 * @throws {Error} Propagates kernel lifecycle errors to renderer callers.
 */
export function registerKernelIpcHandlers(
  options: RegisterKernelIpcHandlersOptions
): void {
  const {
    win,
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    moduleManager,
    kernelWorkingDirs,
    crashHandlers,
    resetProjectState,
    resetKernelState,
    setActiveKernelId,
    getActiveKernelId,
    getActiveProjectDir,
    bindActiveProjectModules,
  } = options;

  /**
   * Send pdv.modules.setup to the kernel so lib file paths are added to
   * sys.path and entry points are executed.
   */
  async function setupModuleNamespaces(kernelId: string): Promise<void> {
    const projectDir = getActiveProjectDir();
    if (!projectDir) return;
    let manifest: Awaited<ReturnType<typeof ProjectManager.readManifest>>;
    try {
      manifest = await ProjectManager.readManifest(projectDir);
    } catch {
      return;
    }
    if (!manifest.modules || manifest.modules.length === 0) return;
    const workingDir = kernelWorkingDirs.get(kernelId);
    const payload = await buildModulesSetupPayload(moduleManager, manifest.modules, workingDir, projectDir);
    if (payload.modules.length > 0) {
      await commRouter.request(PDVMessageType.MODULES_SETUP, payload);
    }
  }

  // Serialize kernel start/restart so concurrent calls cannot race on
  // the shared commRouter (which causes "CommRouter detached" rejections).
  let startMutex: Promise<unknown> = Promise.resolve();

  /**
   * Wait for the previous mutex-serialized operation to settle. Errors from
   * the prior operation are logged (with the operation name) but NOT
   * propagated, so the next operation can still run on a serialized turn.
   * Without this log, prior failures would silently disappear via
   * `previous.catch(() => {})`.
   */
  async function awaitPreviousMutex(operation: string): Promise<void> {
    try {
      await startMutex;
    } catch (err) {
      console.warn(
        `[ipc-register-kernels] Prior kernel-mutex operation rejected before ${operation}:`,
        err
      );
    }
  }

  ipcMain.handle(IPC.kernels.list, async () => {
    return kernelManager.list();
  });

  ipcMain.handle(IPC.kernels.start, async (_event, spec) => {
    await awaitPreviousMutex("kernels.start");
    let release!: () => void;
    startMutex = new Promise<void>((r) => { release = r; });
    try {
    const requestedSpec = spec as Parameters<KernelManager["start"]>[0];
    const pythonPath =
      requestedSpec?.env?.PYTHON_PATH ??
      (Array.isArray(requestedSpec?.argv) ? requestedSpec.argv[0] : undefined);
    const requestedLanguage = requestedSpec?.language ?? "python";
    if (requestedLanguage === "python" && pythonPath) {
      const installStatus = await EnvironmentDetector.checkPDVInstalled(pythonPath);
      if (!installStatus.installed) {
        throw new Error(
          `Selected Python runtime is missing pdv_kernel. Install it with: cd pdv-python && ${pythonPath} -m pip install -e ".[dev]"`
        );
      }
    } else if (requestedLanguage === "julia") {
      const juliaPath = requestedSpec?.env?.JULIA_PATH ??
        (Array.isArray(requestedSpec?.argv) ? requestedSpec.argv[0] : undefined);
      if (juliaPath) {
        const installStatus = await EnvironmentDetector.checkJuliaPDVInstalled(juliaPath);
        if (!installStatus.installed) {
          throw new Error(
            `Selected Julia runtime is missing PDVKernel. Install it with: cd pdv-julia && julia --project=. -e 'using Pkg; Pkg.instantiate()'`
          );
        }
      }
    }
    // Starting a new kernel always means a new session — clear any in-memory
    // project state from a previous session (pending imports, active project
    // dir, health warnings) so they don't carry over.
    resetProjectState();

    const kernel = await kernelManager.start(
      requestedSpec
    );
    commRouter.attach(kernelManager, kernel.id);
    queryRouter.detach();
    await initializeKernelSession(
      kernelManager,
      commRouter,
      queryRouter,
      projectManager,
      kernel.id,
      kernelWorkingDirs
    );
    setActiveKernelId(kernel.id);
    await setupModuleNamespaces(kernel.id);
    await bindActiveProjectModules(kernel.id);

    const onCrash = async (crashedId: string): Promise<void> => {
      if (crashedId !== kernel.id) return;
      commRouter.detach();
      queryRouter.detach();
      await cleanupKernelWorkingDir(projectManager, kernelManager, crashedId, kernelWorkingDirs, crashHandlers);
      if (getActiveKernelId() === crashedId) setActiveKernelId(null);
      win.webContents.send(IPC.push.kernelCrashed, { kernelId: crashedId });
    };
    crashHandlers.set(kernel.id, onCrash);
    kernelManager.on("kernel:crashed", onCrash);

    return kernel;
    } finally {
      release();
    }
  });

  ipcMain.handle(IPC.kernels.stop, async (_event, kernelId: string) => {
    await awaitPreviousMutex("kernels.stop");
    let release!: () => void;
    startMutex = new Promise<void>((r) => { release = r; });
    try {
      await cleanupKernelWorkingDir(projectManager, kernelManager, kernelId, kernelWorkingDirs, crashHandlers);
      await kernelManager.stop(kernelId);
      if (getActiveKernelId() === kernelId) {
        setActiveKernelId(null);
      }
      commRouter.detach();
      queryRouter.detach();
      return true;
    } finally {
      release();
    }
  });

  ipcMain.handle(IPC.kernels.execute, async (event, kernelId, request) => {
    return kernelManager.execute(
      kernelId as string,
      request as Parameters<KernelManager["execute"]>[1],
      (chunk) => event.sender.send(IPC.push.executeOutput, chunk)
    );
  });

  ipcMain.handle(IPC.kernels.interrupt, async (_event, kernelId: string) => {
    await kernelManager.interrupt(kernelId);
    return true;
  });

  ipcMain.handle(IPC.kernels.restart, async (_event, kernelId: string) => {
    await awaitPreviousMutex("kernels.restart");
    let release!: () => void;
    startMutex = new Promise<void>((r) => { release = r; });
    try {
    // Restart preserves activeProjectDir — only reset kernel-scoped state.
    resetKernelState();

    /**
     * Perform the kernel restart (stop + start).
     * Returns the restarted KernelInfo.
     */
    async function doRestart(): Promise<KernelInfo> {
      const current = kernelManager.getKernel(kernelId);
      if (!current) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      await cleanupKernelWorkingDir(projectManager, kernelManager, kernelId, kernelWorkingDirs, crashHandlers);
      await kernelManager.stop(kernelId);
      const restarted = await kernelManager.start({
        name: current.name,
        language: current.language,
      });
      commRouter.attach(kernelManager, restarted.id);
      queryRouter.detach();
      await initializeKernelSession(
        kernelManager,
        commRouter,
        queryRouter,
        projectManager,
        restarted.id,
        kernelWorkingDirs
      );
      return restarted;
    }

    const restarted = await doRestart();
    setActiveKernelId(restarted.id);

    // If a project was active, auto-reload it into the new kernel.
    const activeProjectDir = getActiveProjectDir();
    if (activeProjectDir) {
      win.webContents.send(IPC.push.projectReloading, { status: "reloading" });
      try {
        const newWorkingDir = kernelWorkingDirs.get(restarted.id);
        if (newWorkingDir) {
          await copyFilesForLoad(activeProjectDir, newWorkingDir);
        }
        await projectManager.load(activeProjectDir);
        await setupModuleNamespaces(restarted.id);
      } finally {
        win.webContents.send(IPC.push.projectReloading, { status: "ready" });
      }
    } else {
      await setupModuleNamespaces(restarted.id);
    }
    await bindActiveProjectModules(restarted.id);

    return restarted;
    } finally {
      release();
    }
  });

  ipcMain.handle(
    IPC.kernels.complete,
    async (_event, kernelId: string, code: string, cursorPos: number) => {
      return kernelManager.complete(kernelId, code, cursorPos);
    }
  );

  ipcMain.handle(
    IPC.kernels.inspect,
    async (_event, kernelId: string, code: string, cursorPos: number) => {
      return kernelManager.inspect(kernelId, code, cursorPos);
    }
  );

  ipcMain.handle(
    IPC.kernels.validate,
    async (_event, executablePath: string, language: "python" | "julia") => {
      if (!executablePath.trim()) {
        return { valid: false, error: "Executable path is required" };
      }
      if (language === "python") {
        const installStatus = await EnvironmentDetector.checkPDVInstalled(
          executablePath.trim()
        );
        if (!installStatus.installed) {
          return {
            valid: false,
            error:
              'Missing pdv_kernel. Install it with: cd pdv-python && <python> -m pip install -e ".[dev]"',
          };
        }
      } else if (language === "julia") {
        const installStatus = await EnvironmentDetector.checkJuliaPDVInstalled(
          executablePath.trim()
        );
        if (!installStatus.installed) {
          return {
            valid: false,
            error:
              'Missing PDVKernel.jl. Install it with: cd pdv-julia && julia --project=. -e \'using Pkg; Pkg.instantiate()\'',
          };
        }
      }
      return { valid: true };
    }
  );
}
