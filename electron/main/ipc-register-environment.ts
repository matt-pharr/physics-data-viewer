/**
 * ipc-register-environment.ts — IPC handlers for the Python environment
 * surface.
 *
 * Registers three related handler groups that previously accreted in
 * `index.ts`:
 *
 * - Environment discovery/installation (`environment:list|check|install|
 *   refresh|activeInfo`) backing the environment selector and the Project
 *   Environment settings tab.
 * - Julia runtime discovery and PDVKernel installation
 *   (`environment:juliaList|juliaCheck|juliaInstall`, ARCHITECTURE.md §10.7)
 *   backing the selector's Julia tab.
 * - Per-project package management for the Packages tab
 *   (`environment:listPackages|addPackage|removePackage|upgradePackage`,
 *   ARCHITECTURE.md §10.5.13 / §10.6.8): declared deps paired with installed
 *   versions, and add/remove/upgrade. Python sessions mutate via uv
 *   subprocesses and then invalidate the kernel's import-finder caches so
 *   newly installed packages import without a restart (§10.5.11); Julia
 *   sessions run `PDVKernel.install/remove/update` inside the kernel
 *   (console-bracketed, mirrored to `envActivity`) — no cache step exists
 *   because Julia needs none.
 * - Reactive missing-module install (`environment:installModule`,
 *   §10.5.12): builds the `pdv.install(...)` code string in the main
 *   process and brackets the run with executeBegin/executeFinish pushes.
 *
 * What this file does NOT do
 * - It does not manage kernel lifecycle or uv environment materialization —
 *   that lives in `ipc-register-kernels.ts` / `uv-environment.ts`.
 * - It does not own the `kernelEnvMeta` map; the caller passes it in.
 */

import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { ConfigStore, PDVConfig } from "./config";
import { EnvironmentDetector } from "./environment-detector";
import {
  checkJuliaRuntime,
  clearJuliaRuntimeCache,
  installPDVKernel,
  listJuliaRuntimes,
  resolveJuliaShim,
} from "./julia-discovery";
import { listJuliaProjectPackages } from "./julia-env";
import { plainStreamText } from "./kernel-error-parser";
import {
  IPC,
  type ActiveEnvironmentInfo,
  type EnvironmentInstallResult,
  type ProjectPackage,
} from "./ipc";
import { handleIpc } from "./ipc-registry";
import type { KernelManager } from "./kernel-manager";
import { executeAndTranscribe, TranscriptWriter } from "./mcp/transcript";
import { parseDependencies, normalizeDistName, specName } from "./pyproject";
import {
  uvAdd,
  uvRemove,
  uvLockUpgrade,
  uvSync,
  uvPipList,
  type UvRunOptions,
} from "./uv-runner";
import { venvPythonPath } from "./uv-environment";

/** Dependencies for {@link registerEnvironmentIpcHandlers}. */
export interface RegisterEnvironmentIpcHandlersOptions {
  /** Main window, used to stream install/uv output pushes. */
  win: BrowserWindow;
  /** Config store for interpreter path and uv binary overrides. */
  configStore: ConfigStore;
  /** Kernel manager for import-cache refresh and installModule execution. */
  kernelManager: KernelManager;
  /** Map of kernel id → kernel working dir (owned by the caller). */
  kernelWorkingDirs: Map<string, string>;
  /** Map of kernel id → environment metadata (owned by the caller). */
  kernelEnvMeta: Map<string, ActiveEnvironmentInfo>;
  /** Accessor for the active kernel id. */
  getActiveKernelId: () => string | null;
  /** Read the full config, applying defaults. */
  readConfig: (store: ConfigStore) => PDVConfig;
}

/** Utilities returned by {@link registerEnvironmentIpcHandlers}. */
export interface EnvironmentController {
  /**
   * Invalidate the active kernel's import-finder caches so packages
   * installed into the venv mid-session import without a restart
   * (ARCHITECTURE.md §10.5.11). No-op when no kernel is active; never
   * throws.
   */
  refreshKernelImportCaches: () => Promise<void>;
}

/**
 * Register all `environment:*` IPC handlers.
 *
 * @param options - Dependency bag (window, stores, kernel accessors).
 * @returns The {@link EnvironmentController} so other registrars (project
 *   load's env sync) can reuse the import-cache refresh. Handlers are
 *   unregistered globally via `removeAllIpcHandlers`.
 * @throws {Error} Never throws synchronously; individual handlers propagate
 *   errors to their renderer callers.
 */
export function registerEnvironmentIpcHandlers(
  options: RegisterEnvironmentIpcHandlersOptions,
): EnvironmentController {
  const {
    win,
    configStore,
    kernelManager,
    kernelWorkingDirs,
    kernelEnvMeta,
    getActiveKernelId,
    readConfig,
  } = options;

  // --- Discovery / installation -------------------------------------------

  handleIpc(IPC.environment.activeInfo, async () => {
    const kernelId = getActiveKernelId();
    return kernelId ? (kernelEnvMeta.get(kernelId) ?? null) : null;
  });

  handleIpc(IPC.environment.list, async () => {
    const config = configStore.getAll();
    return EnvironmentDetector.listEnvironmentInfo(config.pythonPath);
  });

  handleIpc(IPC.environment.check, async (_event, pythonPath: string) => {
    return EnvironmentDetector.checkEnvironment(pythonPath);
  });

  handleIpc(IPC.environment.install, async (_event, pythonPath: string) => {
    return EnvironmentDetector.installPDVFromBundle(pythonPath, win, IPC.push.installOutput);
  });

  handleIpc(IPC.environment.refresh, async () => {
    EnvironmentDetector.clearCache();
    const config = configStore.getAll();
    return EnvironmentDetector.listEnvironmentInfo(config.pythonPath);
  });

  // --- Julia runtime discovery / installation (§10.7) ----------------------
  // The selector's Refresh reuses juliaList after clearing the cache, so no
  // separate refresh channel exists: the renderer calls juliaList again.

  handleIpc(IPC.environment.juliaList, async () => {
    clearJuliaRuntimeCache();
    return listJuliaRuntimes(configStore.getAll().juliaPath);
  });

  handleIpc(IPC.environment.juliaCheck, async (_event, juliaPath: string) => {
    return checkJuliaRuntime(juliaPath);
  });

  handleIpc(IPC.environment.juliaInstall, async (_event, juliaPath: string) => {
    return installPDVKernel(resolveJuliaShim(juliaPath), {
      stagingDir: path.join(app.getPath("userData"), "pdv-julia"),
      win,
      pushChannel: IPC.push.installOutput,
    });
  });

  // --- Packages tab (ARCHITECTURE.md §10.5.13 / §10.6.8) --------------------

  const pkgRunOptions = (): UvRunOptions => {
    const activeKernelId = getActiveKernelId();
    return {
      cwd: activeKernelId ? kernelWorkingDirs.get(activeKernelId) : undefined,
      win,
      pushChannel: IPC.push.envActivity,
      binaryPath: readConfig(configStore).uv?.binaryPath,
    };
  };

  /** Language of the active kernel, or null when no kernel is running. */
  const activeKernelLanguage = (): "python" | "julia" | null => {
    const activeKernelId = getActiveKernelId();
    if (!activeKernelId) return null;
    return kernelManager.getKernel(activeKernelId)?.language ?? null;
  };

  /**
   * Run a Packages-tab Pkg operation inside the active Julia kernel
   * (§10.6.8): `PDVKernel.install`/`remove`/`update` mutate the project's
   * `Project.toml`/`Manifest.toml` and the live session together, and the
   * kernel's own execution queue serializes the operation against running
   * cells. The run is bracketed with executeBegin/executeFinish pushes so
   * the console logs it (same as §10.5.12 reactive installs), and its
   * stream output is mirrored over `envActivity` so the Packages tab's
   * output pane shows it live.
   *
   * @param code - The `PDVKernel.<verb>(...)` invocation to execute.
   * @param label - Console origin label (e.g. `"Add DataFrames"`).
   * @returns Install-style result; a kernel-side Pkg error resolves with
   *   `success: false` and the error appended to the output.
   */
  const runJuliaPkgOp = async (
    code: string,
    label: string,
  ): Promise<EnvironmentInstallResult> => {
    const kernelId = getActiveKernelId();
    if (!kernelId) {
      return { success: false, output: "No active kernel." };
    }
    const workingDir = kernelWorkingDirs.get(kernelId);
    const transcript = workingDir ? new TranscriptWriter(workingDir) : null;
    const executionId = randomUUID();
    const origin = { kind: "unknown" as const, label };
    const start = Date.now();
    const send = (channel: string, payload: unknown): void => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    };
    const chunks: string[] = [];
    send(IPC.push.executeBegin, { executionId, code, origin, timestamp: start });
    try {
      const result = await executeAndTranscribe(
        kernelManager.execute.bind(kernelManager),
        transcript,
        kernelId,
        { code, executionId, origin },
        (chunk) => {
          send(IPC.push.executeOutput, chunk);
          if ((chunk.type === "stdout" || chunk.type === "stderr") && chunk.text) {
            // The console gets the raw chunk (it renders ANSI); the tab's
            // <pre> pane gets plain text (§10.8's standard normalization).
            const plain = plainStreamText(chunk.text);
            if (plain) {
              chunks.push(plain);
              send(IPC.push.envActivity, { stream: chunk.type, data: plain });
            }
          }
        },
      );
      send(IPC.push.executeFinish, {
        executionId,
        duration: result.duration ?? Date.now() - start,
        error: result.error,
        errorDetails: result.errorDetails,
      });
      return {
        success: !result.error,
        output: chunks.join("") + (result.error ? `\n${result.error}` : ""),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(IPC.push.executeFinish, {
        executionId,
        duration: Date.now() - start,
        error: message,
      });
      return { success: false, output: chunks.join("") + `\n${message}` };
    }
  };

  /** Quote package names as a Julia argument list (`"A", "B"`). */
  const juliaArgList = (names: string[]): string =>
    names.map((n) => JSON.stringify(n)).join(", ");

  const refreshKernelImportCaches = async (): Promise<void> => {
    const activeKernelId = getActiveKernelId();
    if (!activeKernelId) return;
    try {
      await kernelManager.execute(activeKernelId, {
        code: "import importlib; importlib.invalidate_caches()",
        silent: true,
      });
    } catch (err) {
      console.warn("[env] failed to refresh kernel import caches:", err);
    }
  };

  handleIpc(IPC.environment.listPackages, async (): Promise<ProjectPackage[]> => {
    const activeKernelId = getActiveKernelId();
    if (!activeKernelId) return [];
    const workingDir = kernelWorkingDirs.get(activeKernelId);
    if (!workingDir) return [];
    // Julia pkg-mode projects (§10.6.8): deps from Project.toml/Manifest.toml.
    if (activeKernelLanguage() === "julia") {
      return listJuliaProjectPackages(workingDir);
    }
    let pyprojectText: string;
    try {
      pyprojectText = await fs.readFile(path.join(workingDir, "pyproject.toml"), "utf8");
    } catch {
      return [];
    }
    const specs = await parseDependencies(pyprojectText);
    const venvPython = venvPythonPath(workingDir);
    const pipResult = await uvPipList(venvPython, {
      cwd: workingDir,
      binaryPath: readConfig(configStore).uv?.binaryPath,
    });
    const installed = new Map<string, string>();
    if (pipResult.success) {
      try {
        const list = JSON.parse(pipResult.output) as Array<{ name?: string; version?: string }>;
        for (const p of list) {
          if (p.name && p.version) installed.set(normalizeDistName(p.name), p.version);
        }
      } catch {
        // uv may emit warnings before the JSON; degrade gracefully.
      }
    }
    return specs.map((spec) => {
      const name = specName(spec);
      return { spec, name, installedVersion: installed.get(name) };
    });
  });

  // Mutations: Julia sessions run Pkg inside the kernel (§10.6.8 — no
  // import-cache refresh needed, Julia has none); Python sessions go
  // through uv subprocesses (§10.5.13).

  handleIpc(
    IPC.environment.addPackage,
    async (_event, specs: string[]): Promise<EnvironmentInstallResult> => {
      if (activeKernelLanguage() === "julia") {
        return runJuliaPkgOp(
          `PDVKernel.install(${juliaArgList(specs)})`,
          `Add ${specs.join(", ")}`,
        );
      }
      const result = await uvAdd(specs, pkgRunOptions());
      if (result.success) await refreshKernelImportCaches();
      return { success: result.success, output: result.output };
    }
  );

  handleIpc(
    IPC.environment.removePackage,
    async (_event, names: string[]): Promise<EnvironmentInstallResult> => {
      if (activeKernelLanguage() === "julia") {
        return runJuliaPkgOp(
          `PDVKernel.remove(${juliaArgList(names)})`,
          `Remove ${names.join(", ")}`,
        );
      }
      const result = await uvRemove(names, pkgRunOptions());
      if (result.success) await refreshKernelImportCaches();
      return { success: result.success, output: result.output };
    }
  );

  handleIpc(
    IPC.environment.upgradePackage,
    async (_event, names: string[]): Promise<EnvironmentInstallResult> => {
      if (activeKernelLanguage() === "julia") {
        return runJuliaPkgOp(
          `PDVKernel.update(${juliaArgList(names)})`,
          `Update ${names.join(", ")}`,
        );
      }
      const opts = pkgRunOptions();
      const lock = await uvLockUpgrade(names, opts);
      if (!lock.success) return { success: false, output: lock.output };
      // In-place sync under a live kernel: --inexact keeps pdv-python
      // (installed outside the lock) from being uninstalled.
      const sync = await uvSync({ ...opts, inexact: true });
      if (sync.success) await refreshKernelImportCaches();
      return { success: sync.success, output: lock.output + sync.output };
    }
  );

  // --- Reactive missing-module install (§10.5.12) --------------------------
  // The renderer sends only the module name; the code string is built here
  // and the run is bracketed with executeBegin/executeFinish pushes so the
  // console seeds a log entry and streams the install output live — same
  // pattern as MCP agent runs.

  handleIpc(
    IPC.environment.installModule,
    async (_event, kernelId: string, moduleName: string): Promise<void> => {
      const kernel = kernelManager.getKernel(kernelId);
      if (!kernel) {
        throw new Error(`Kernel not found: ${kernelId}`);
      }
      // Language-appropriate install invocation (§2.4, §10.5.12): Julia
      // kernels delegate to Pkg via PDVKernel.install.
      const code =
        kernel.language === "julia"
          ? `PDVKernel.install(${JSON.stringify(moduleName)})`
          : `pdv.install(${JSON.stringify(moduleName)})`;
      const origin = { kind: "unknown" as const, label: `Install ${moduleName}` };
      const workingDir = kernelWorkingDirs.get(kernelId);
      const transcript = workingDir ? new TranscriptWriter(workingDir) : null;
      const executionId = randomUUID();
      const start = Date.now();
      const send = (channel: string, payload: unknown): void => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      };
      send(IPC.push.executeBegin, { executionId, code, origin, timestamp: start });
      try {
        const result = await executeAndTranscribe(
          kernelManager.execute.bind(kernelManager),
          transcript,
          kernelId,
          { code, executionId, origin },
          (chunk) => send(IPC.push.executeOutput, chunk),
        );
        send(IPC.push.executeFinish, {
          executionId,
          duration: result.duration ?? Date.now() - start,
          error: result.error,
          errorDetails: result.errorDetails,
        });
      } catch (err) {
        send(IPC.push.executeFinish, {
          executionId,
          duration: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  );

  return { refreshKernelImportCaches };
}
