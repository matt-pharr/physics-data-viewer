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
import { EnvironmentDetector } from "./environment-detector";
import { IPC, type KernelValidateResult } from "./ipc";
import { KernelManager, type KernelInfo } from "./kernel-manager";
import { initializeKernelSession } from "./kernel-session";
import type { ModuleManager } from "./module-manager";
import { buildModulesSetupPayload } from "./module-runtime";
import { PDVMessageType } from "./pdv-protocol";
import { ProjectManager, type ProjectModuleImport } from "./project-manager";

interface RegisterKernelIpcHandlersOptions {
  win: BrowserWindow;
  kernelManager: KernelManager;
  commRouter: CommRouter;
  projectManager: ProjectManager;
  moduleManager: ModuleManager;
  kernelWorkingDirs: Map<string, string>;
  crashHandlers: Map<string, (id: string) => void>;
  resetProjectState: () => void;
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
    projectManager,
    moduleManager,
    kernelWorkingDirs,
    crashHandlers,
    resetProjectState,
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
    const payload = await buildModulesSetupPayload(moduleManager, manifest.modules, workingDir);
    if (payload.modules.length > 0) {
      await commRouter.request(PDVMessageType.MODULES_SETUP, payload);
    }
  }

  ipcMain.handle(IPC.kernels.list, async () => {
    return kernelManager.list();
  });

  ipcMain.handle(IPC.kernels.start, async (_event, spec) => {
    const requestedSpec = spec as Parameters<KernelManager["start"]>[0];
    const pythonPath =
      requestedSpec?.env?.PYTHON_PATH ??
      (Array.isArray(requestedSpec?.argv) ? requestedSpec.argv[0] : undefined);
    if ((requestedSpec?.language ?? "python") === "python" && pythonPath) {
      const installStatus = await EnvironmentDetector.checkPDVInstalled(pythonPath);
      if (!installStatus.installed) {
        throw new Error(
          `Selected Python runtime is missing pdv_kernel. Install it with: cd pdv-python && ${pythonPath} -m pip install -e ".[dev]"`
        );
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
    await initializeKernelSession(
      kernelManager,
      commRouter,
      projectManager,
      kernel.id,
      kernelWorkingDirs
    );
    setActiveKernelId(kernel.id);
    await setupModuleNamespaces(kernel.id);
    await bindActiveProjectModules(kernel.id);

    const onCrash = async (crashedId: string): Promise<void> => {
      if (crashedId !== kernel.id) return;
      await cleanupKernelWorkingDir(projectManager, kernelManager, crashedId, kernelWorkingDirs, crashHandlers);
      if (getActiveKernelId() === crashedId) setActiveKernelId(null);
      win.webContents.send(IPC.push.kernelStatus, { kernelId: crashedId, status: "dead" });
    };
    crashHandlers.set(kernel.id, onCrash);
    kernelManager.on("kernel:crashed", onCrash);

    return kernel;
  });

  ipcMain.handle(IPC.kernels.stop, async (_event, kernelId: string) => {
    await cleanupKernelWorkingDir(projectManager, kernelManager, kernelId, kernelWorkingDirs, crashHandlers);
    await kernelManager.stop(kernelId);
    if (getActiveKernelId() === kernelId) {
      setActiveKernelId(null);
    }
    commRouter.detach();
    return true;
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
    // Restart clears the tree — reset in-memory project state so stale
    // pending imports and project dir don't persist into the new session.
    resetProjectState();

    const restartable = kernelManager as KernelManager & {
      restart?: (id: string) => Promise<KernelInfo>;
    };
    if (restartable.restart) {
      await cleanupKernelWorkingDir(projectManager, kernelManager, kernelId, kernelWorkingDirs, crashHandlers);
      const restarted = await restartable.restart(kernelId);
      commRouter.attach(kernelManager, restarted.id);
      await initializeKernelSession(
        kernelManager,
        commRouter,
        projectManager,
        restarted.id,
        kernelWorkingDirs
      );
      setActiveKernelId(restarted.id);
      await setupModuleNamespaces(restarted.id);
      await bindActiveProjectModules(restarted.id);
      return restarted;
    }
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
    await initializeKernelSession(
      kernelManager,
      commRouter,
      projectManager,
      restarted.id,
      kernelWorkingDirs
    );
    setActiveKernelId(restarted.id);
    await setupModuleNamespaces(restarted.id);
    await bindActiveProjectModules(restarted.id);
    return restarted;
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
      const validatable = kernelManager as KernelManager & {
        validate?: (
          execPath: string,
          lang: "python" | "julia"
        ) => Promise<KernelValidateResult>;
      };
      if (validatable.validate) {
        return validatable.validate(executablePath, language);
      }
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
      }
      return { valid: true };
    }
  );
}
