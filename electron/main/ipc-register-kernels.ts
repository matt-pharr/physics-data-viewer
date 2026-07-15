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

import { randomUUID } from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { BrowserWindow } from "electron";
import { handleIpc } from "./ipc-registry";

import { CommRouter } from "./comm-router";
import { QueryRouter } from "./query-router";
import { EnvironmentDetector } from "./environment-detector";
import { IPC, type ActiveEnvironmentInfo, type KernelRestartResult } from "./ipc";
import { KernelManager, type KernelInfo } from "./kernel-manager";
import { initializeKernelSession } from "./kernel-session";
import { executeAndTranscribe, TranscriptWriter } from "./mcp/transcript";
import type { ModuleManager } from "./module-manager";
import { setupProjectModuleNamespaces } from "./module-runtime";
import { copyEnvFilesForLoad, copyFilesForLoad, overlayAutosaveTreeFiles } from "./project-file-sync";
import { ProjectManager } from "./project-manager";
import { autosaveDirFor } from "./autosave-sidecars";
import { instantiateJuliaEnvironment, type JuliaEnvResult } from "./julia-env";
import { materializeUvEnvironment } from "./uv-environment";
import { resolveUvBinary } from "./uv-runner";
import { generatePyproject } from "./pyproject";
import {
  DEFAULT_PYTHON_VERSION,
  SUPPORTED_PYTHON_VERSIONS,
} from "./python-versions";

/**
 * The `kernel:memoryRss` listener currently attached to a KernelManager,
 * tracked so teardown can detach it. The KernelManager outlives windows,
 * so an untracked listener would accumulate once per window re-creation.
 * Mirrors `trackedExecutionStateListener` in `index.ts`.
 */
let trackedMemoryListener:
  | { km: KernelManager; fn: (kernelId: string, rssBytes: number) => void }
  | null = null;

/**
 * Detach the tracked `kernel:memoryRss` listener, if any.
 *
 * Called on re-registration (below) and from `unregisterIpcHandlers()` in
 * `index.ts` so registration and teardown stay symmetric.
 *
 * @returns Nothing.
 */
export function removeKernelMemoryListener(): void {
  if (trackedMemoryListener) {
    trackedMemoryListener.km.removeListener(
      "kernel:memoryRss",
      trackedMemoryListener.fn,
    );
    trackedMemoryListener = null;
  }
}

interface RegisterKernelIpcHandlersOptions {
  win: BrowserWindow;
  kernelManager: KernelManager;
  commRouter: CommRouter;
  queryRouter: QueryRouter;
  projectManager: ProjectManager;
  moduleManager: ModuleManager;
  kernelWorkingDirs: Map<string, string>;
  /**
   * Per-kernel environment metadata (mode, actual interpreter, resolved
   * Python version). This module populates it on start/restart and deletes
   * entries on stop; entries survive crashes so a crash-restart carries the
   * environment over. Read by `environment:activeInfo` and the project save
   * handler (§10.5).
   */
  kernelEnvMeta: Map<string, ActiveEnvironmentInfo>;
  crashHandlers: Map<string, (id: string) => void>;
  resetProjectState: () => void;
  resetKernelState: () => void;
  setActiveKernelId: (id: string | null) => void;
  getActiveKernelId: () => string | null;
  getActiveProjectDir: () => string | null;
  getWorkingDirBase: () => string | undefined;
  /** Default packages seeded into a new uv project's pyproject.toml (§10.5.14). */
  getDefaultPackages: () => string[];
  /** Optional `uv` binary override from config (§10.5.6); undefined = bundled. */
  getUvBinaryPath: () => string | undefined;
  bindActiveProjectModules: (kernelId: string | null) => Promise<void>;
  /**
   * Best-effort tree snapshot taken while the old Jupyter server is still
   * alive, so a restart never loses in-memory work. Returns true when a
   * usable ``.autosave`` snapshot exists afterwards — fresh, or a fallback
   * to the most recent timer autosave when the server is too busy to
   * answer a save request (a hung server is often *why* the user is
   * restarting). Must never throw.
   */
  autosaveBeforeRestart: (kernelId: string) => Promise<boolean>;
  /**
   * Restore an unsaved session's ``.autosave`` snapshot from the preserved
   * old working directory into the freshly started session, then delete
   * the old directory. Same routine the welcome screen's "Recover" uses.
   */
  recoverUnsavedAfterRestart: (orphanDir: string) => Promise<void>;
}

/**
 * Delete the working directory for a kernel and remove its crash handler.
 *
 * @param projectManager - Project manager used for deletion.
 * @param kernelManager  - Kernel manager used to remove event listeners.
 * @param kernelId       - Kernel whose working dir should be cleaned up.
 * @param kernelWorkingDirs - Map of kernel IDs to working directory paths.
 * @param crashHandlers  - Map of kernel IDs to crash handler functions.
 * @param preserveDir    - Keep the directory on disk (still unregisters it
 *   and the crash handler). Used by restart when the directory holds an
 *   unsaved session's ``.autosave`` snapshot that the post-restart
 *   recovery step reads — and, should that step never run, the directory
 *   surfaces on the welcome screen as a recoverable session instead of
 *   being lost.
 */
async function cleanupKernelWorkingDir(
  projectManager: ProjectManager,
  kernelManager: KernelManager,
  kernelId: string,
  kernelWorkingDirs: Map<string, string>,
  crashHandlers: Map<string, (id: string) => void>,
  preserveDir = false
): Promise<void> {
  const oldDir = kernelWorkingDirs.get(kernelId);
  if (oldDir) {
    if (!preserveDir) {
      await projectManager.deleteWorkingDir(oldDir);
    }
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
    kernelEnvMeta,
    crashHandlers,
    resetProjectState,
    resetKernelState,
    setActiveKernelId,
    getActiveKernelId,
    getActiveProjectDir,
    getWorkingDirBase,
    getDefaultPackages,
    getUvBinaryPath,
    bindActiveProjectModules,
    autosaveBeforeRestart,
    recoverUnsavedAfterRestart,
  } = options;

  /**
   * Send `pdv.modules.setup` to the kernel so PDVLib parent dirs in the
   * active project's modules are wired into `sys.path`. Reads the manifest
   * at call time via {@link setupProjectModuleNamespaces}.
   */
  async function setupModuleNamespaces(_kernelId: string): Promise<void> {
    await setupProjectModuleNamespaces(commRouter, moduleManager, getActiveProjectDir());
  }

  /**
   * Materialize a uv-mode project's environment before its kernel spawns.
   *
   * Creates the kernel working directory, copies in `pyproject.toml` /
   * `uv.lock` from the save directory, runs `uv sync`, and installs
   * `pdv-python` into the venv (ARCHITECTURE.md §10.5.9). The venv lives
   * inside the working directory, so this must complete before the kernel
   * process is spawned against the venv interpreter.
   *
   * @param uv - uv context: an existing project's `saveDir` to copy env
   *   files from, `newProject` to seed a fresh `pyproject.toml` (from
   *   `packages`, falling back to the user's default packages, pinned to
   *   `pythonVersion` or the default), or an `envSnapshot` of file contents
   *   captured before the source working dir was torn down (restart, §11.6).
   * @returns The pre-created working directory and the venv interpreter path.
   * @throws {Error} When uv environment setup fails. The partially-created
   *   working directory is removed before the error propagates.
   */
  async function startUvEnvironment(
    uv: {
      saveDir?: string;
      newProject?: boolean;
      pythonVersion?: string;
      packages?: string[];
      envSnapshot?: { pyproject: string; uvLock?: string; pythonVersionPin?: string };
    }
  ): Promise<{ workingDir: string; venvPython: string; uvBinary: string | undefined }> {
    // The resolved uv binary travels to the kernel in pdv.init so pdv.install()
    // can run `uv add` directly (§10.5.11). Non-null here — materialize would
    // have thrown UvBinaryNotFoundError otherwise.
    const uvBinary = resolveUvBinary(getUvBinaryPath()) ?? undefined;
    const workingDir = await projectManager.createWorkingDir(getWorkingDirBase());
    try {
      let pythonVersion: string | undefined;
      if (uv.envSnapshot) {
        // Restart: re-create the env from the snapshot taken before the old
        // working dir was deleted, so freshly-installed packages survive.
        await fs.writeFile(
          path.join(workingDir, "pyproject.toml"),
          uv.envSnapshot.pyproject,
          "utf8"
        );
        if (uv.envSnapshot.uvLock !== undefined) {
          await fs.writeFile(path.join(workingDir, "uv.lock"), uv.envSnapshot.uvLock, "utf8");
        }
        if (uv.envSnapshot.pythonVersionPin !== undefined) {
          await fs.writeFile(
            path.join(workingDir, ".python-version"),
            uv.envSnapshot.pythonVersionPin,
            "utf8"
          );
          pythonVersion = uv.envSnapshot.pythonVersionPin.trim() || undefined;
        }
      } else if (uv.saveDir) {
        // Opening an existing uv project: copy its env files in.
        await copyEnvFilesForLoad(uv.saveDir, workingDir);
        const manifest = await ProjectManager.readManifest(uv.saveDir);
        pythonVersion = manifest.environment?.python_version;
      } else {
        // New uv project: generate a pyproject.toml from the packages chosen
        // in the New Project dialog (falling back to the user's defaults) and
        // pin the chosen Python version. The pin is written as uv's native
        // `.python-version` file so it round-trips through save/open/restart
        // via ENV_FILES (§10.5.10) without touching the manifest schema.
        const toml = generatePyproject({
          dependencies: uv.packages ?? getDefaultPackages(),
        });
        await fs.writeFile(path.join(workingDir, "pyproject.toml"), toml, "utf8");
        pythonVersion = uv.pythonVersion ?? DEFAULT_PYTHON_VERSION;
        await fs.writeFile(
          path.join(workingDir, ".python-version"),
          `${pythonVersion}\n`,
          "utf8"
        );
      }
      const result = await materializeUvEnvironment(workingDir, {
        pythonVersion,
        win,
        pushChannel: IPC.push.envActivity,
        binaryPath: getUvBinaryPath(),
      });
      if (!result.success || !result.venvPython) {
        const step = result.failedStep ? ` (${result.failedStep})` : "";
        throw new Error(`uv environment setup failed${step}:\n${result.output}`);
      }
      return { workingDir, venvPython: result.venvPython, uvBinary };
    } catch (err) {
      await projectManager.deleteWorkingDir(workingDir).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Prepare a pkg-mode Julia project's environment before its kernel spawns
   * (ARCHITECTURE.md §10.6).
   *
   * Creates the kernel working directory and seeds its env files —
   * `Project.toml`/`Manifest.toml` copied from the save directory (open), an
   * empty `Project.toml` (new project, §10.6.5), or the contents snapshotted
   * before a restart tore the old working dir down. For opens and new
   * projects it also kicks off `Pkg.instantiate` as a background subprocess
   * (streamed over `envActivity`) that the caller awaits **after** the kernel
   * boot — the two deliberately overlap, because the kernel's own boot only
   * needs IJulia and PDVKernel from the default environment (§10.6.6).
   * Restarts skip the instantiate: the depot already holds everything the
   * live session just used, and the Julia version carries over in the old
   * kernel's environment metadata.
   *
   * @param pkg - pkg context: an existing project's `saveDir`, `newProject`,
   *   or an `envSnapshot` of file contents captured before restart (§11.6).
   * @param juliaPath - Julia executable for the instantiate subprocess.
   * @returns The pre-created working directory, the pending instantiate
   *   result (undefined when no instantiate is needed), and an abort handle
   *   for it (used when the kernel boot fails first).
   * @throws {Error} When the working directory cannot be created/seeded. The
   *   partially-created working directory is removed before the error
   *   propagates.
   */
  async function startPkgEnvironment(
    pkg: {
      saveDir?: string;
      newProject?: boolean;
      envSnapshot?: { projectToml: string; manifestToml?: string };
    },
    juliaPath: string
  ): Promise<{
    workingDir: string;
    instantiate?: Promise<JuliaEnvResult>;
    abortInstantiate: () => void;
  }> {
    const workingDir = await projectManager.createWorkingDir(getWorkingDirBase());
    try {
      let needsInstantiate = false;
      if (pkg.envSnapshot) {
        // Restart: re-create the env files snapshotted before the old
        // working dir was deleted, so packages installed since load survive.
        // The depot already holds them — no instantiate needed.
        await fs.writeFile(
          path.join(workingDir, "Project.toml"),
          pkg.envSnapshot.projectToml,
          "utf8"
        );
        if (pkg.envSnapshot.manifestToml !== undefined) {
          await fs.writeFile(
            path.join(workingDir, "Manifest.toml"),
            pkg.envSnapshot.manifestToml,
            "utf8"
          );
        }
      } else if (pkg.saveDir) {
        // Opening an existing pkg project: copy its env files in and
        // instantiate against the manifest (§10.6.6).
        await copyEnvFilesForLoad(pkg.saveDir, workingDir, "julia");
        needsInstantiate = true;
      } else {
        // New pkg project: an empty Project.toml makes the working dir a
        // textbook (empty) Julia project; Pkg.add fills it in (§10.6.5).
        // The instantiate is a no-op resolve here, run anyway because its
        // VERSION print is what stamps `julia_version` into the manifest
        // on first save.
        await fs.writeFile(path.join(workingDir, "Project.toml"), "", "utf8");
        needsInstantiate = true;
      }

      const controller = new AbortController();
      const instantiate = needsInstantiate
        ? instantiateJuliaEnvironment(workingDir, juliaPath, {
            win,
            pushChannel: IPC.push.envActivity,
            signal: controller.signal,
          })
        : undefined;
      return {
        workingDir,
        instantiate,
        abortInstantiate: () => controller.abort(),
      };
    } catch (err) {
      await projectManager.deleteWorkingDir(workingDir).catch(() => undefined);
      throw err;
    }
  }

  // Forward periodic kernel-memory snapshots to the renderer. Registered once
  // for this window/manager pair (the payload carries `kernelId` so a single
  // listener serves any number of kernels). Tracked so re-registration (e.g.
  // macOS window re-creation) detaches the previous window's listener from
  // the long-lived KernelManager instead of stacking a duplicate that pushes
  // to a destroyed webContents.
  removeKernelMemoryListener();
  const memoryListener = (kernelId: string, rssBytes: number): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC.push.kernelMemory, {
      kernelId,
      rssBytes,
      timestamp: Date.now(),
    });
  };
  kernelManager.on("kernel:memoryRss", memoryListener);
  trackedMemoryListener = { km: kernelManager, fn: memoryListener };

  // Serialize start/stop/restart of the Jupyter server process so concurrent
  // calls cannot race on the shared commRouter (which causes "CommRouter
  // detached" rejections).
  let startMutex: Promise<unknown> = Promise.resolve();

  /**
   * Run ``fn`` while holding the start/stop/restart serialization lock.
   *
   * The queue promise is swapped in **synchronously** — before any await —
   * so every concurrent caller observes the previous holder's promise and
   * chains behind it. (The previous implementation awaited the old promise
   * first and swapped afterwards; two calls arriving together both saw the
   * same settled promise and both proceeded, defeating the serialization.)
   * Same pattern as ``ProjectManager.runWithSaveLock``.
   *
   * The lock promise is resolved in ``finally`` and never rejects; the
   * catch below only fires if a future refactor changes that, so a prior
   * failure still can't silently vanish.
   *
   * @param operation - Label for the warn log (e.g. ``"kernels.start"``).
   * @param fn - Operation to run exclusively.
   * @returns The value returned by ``fn``.
   * @throws Whatever ``fn`` throws — after releasing the lock.
   */
  async function withStartLock<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prior = startMutex;
    let release!: () => void;
    startMutex = new Promise<void>((r) => { release = r; });
    await prior.catch((err) => {
      console.warn(
        `[ipc-register-kernels] Prior serialized operation rejected before ${operation}:`,
        err
      );
    });
    try {
      return await fn();
    } finally {
      release();
    }
  }

  handleIpc(IPC.kernels.list, async () => {
    return kernelManager.list();
  });

  handleIpc(IPC.kernels.start, async (_event, spec, uvContext) => {
    return withStartLock("kernels.start", async () => {
    let requestedSpec = spec as Parameters<KernelManager["start"]>[0];
    const requestedLanguage = requestedSpec?.language ?? "python";
    const uv = uvContext as
      | { saveDir?: string; newProject?: boolean; pythonVersion?: string; packages?: string[] }
      | undefined;
    if (uv?.pythonVersion && !SUPPORTED_PYTHON_VERSIONS.includes(uv.pythonVersion)) {
      throw new Error(
        `Unsupported Python version "${uv.pythonVersion}". Supported: ${SUPPORTED_PYTHON_VERSIONS.join(", ")}.`
      );
    }

    // Starting a new kernel always means a new session — clear any in-memory
    // project state from a previous session (pending imports, active project
    // dir, health warnings) so they don't carry over.
    resetProjectState();

    // uv-mode boot: the project venv lives inside the kernel working
    // directory, so it must be created and materialized BEFORE the kernel
    // process spawns against the venv interpreter (ARCHITECTURE.md §10.5.9).
    // The materialize step installs pdv-python into the venv, so the
    // shared-mode pdv-install check below is skipped for uv kernels.
    let preCreatedWorkingDir: string | undefined;
    let uvBinaryForInit: string | undefined;
    // pkg-mode Julia launches run Pkg.instantiate concurrently with the
    // kernel boot (§10.6.6); the pending result is awaited after the session
    // handshake, and the abort handle kills the subprocess if the boot fails.
    let pkgInstantiate: Promise<JuliaEnvResult> | undefined;
    let pkgAbortInstantiate: (() => void) | undefined;
    // Environment metadata recorded under the new kernel's id once it has
    // started (§10.5): mode, the interpreter it actually spawned on, and
    // the resolved Python version. Authoritative at project-save time.
    let envMeta: ActiveEnvironmentInfo = { mode: "shared" };
    if (uv && requestedLanguage === "python") {
      const uvEnv = await startUvEnvironment(uv);
      preCreatedWorkingDir = uvEnv.workingDir;
      uvBinaryForInit = uvEnv.uvBinary;
      requestedSpec = {
        ...(requestedSpec ?? {}),
        language: "python",
        argv: undefined,
        env: { ...(requestedSpec?.env ?? {}), PYTHON_PATH: uvEnv.venvPython },
      };
      envMeta = {
        mode: "uv",
        interpreterPath: uvEnv.venvPython,
        pythonVersion:
          (await EnvironmentDetector.resolvePythonMajorMinor(uvEnv.venvPython)) ??
          uv.pythonVersion,
      };
      // The environment is materialized — everything from here is kernel
      // boot. Tell the EnvSyncModal so it can retitle to "Starting
      // ipykernel…" (empty data: this is a stage marker, not output).
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.push.envActivity, {
          stream: "stdout",
          data: "",
          stage: "kernel-boot",
        });
      }
    } else if (requestedLanguage === "python") {
      const pythonPath =
        requestedSpec?.env?.PYTHON_PATH ??
        (Array.isArray(requestedSpec?.argv) ? requestedSpec.argv[0] : undefined);
      if (pythonPath) {
        const installStatus = await EnvironmentDetector.checkPDVInstalled(pythonPath);
        if (!installStatus.installed) {
          throw new Error(
            `Selected Python runtime is missing pdv. Install it with: cd pdv-python && ${pythonPath} -m pip install -e ".[dev]"`
          );
        }
        envMeta = {
          mode: "shared",
          interpreterPath: pythonPath,
          pythonVersion:
            await EnvironmentDetector.resolvePythonMajorMinor(pythonPath),
        };
      }
    } else if (requestedLanguage === "julia") {
      const juliaPath = requestedSpec?.env?.JULIA_PATH ??
        (Array.isArray(requestedSpec?.argv) ? requestedSpec.argv[0] : undefined);
      if (juliaPath) {
        const installStatus = await EnvironmentDetector.checkJuliaPDVInstalled(juliaPath);
        if (!installStatus.installed) {
          throw new Error(
            "Selected Julia runtime is missing the PDVKernel package. It must be " +
              "installed into that Julia environment before PDV can use it. " +
              "(Julia support is experimental and not yet packaged for install.)"
          );
        }
        envMeta = { mode: "shared", interpreterPath: juliaPath };
      }
      if (uv) {
        // pkg-mode boot (§10.6): pre-create the working dir with the
        // project's Project.toml/Manifest.toml and activate it natively via
        // JULIA_PROJECT on the kernel process. IJulia/PDVKernel keep
        // resolving from the default environment through Julia's stacked
        // LOAD_PATH (§10.6.1), so — unlike uv — the kernel boot needs
        // nothing from the instantiate and the two run concurrently.
        const pkgEnv = await startPkgEnvironment(uv, juliaPath ?? "julia");
        preCreatedWorkingDir = pkgEnv.workingDir;
        pkgAbortInstantiate = pkgEnv.abortInstantiate;
        // Flip the EnvSyncModal to its kernel-boot stage the moment the
        // instantiate finishes — the kernel boot it overlapped may still be
        // running (empty data: a stage marker, not output).
        pkgInstantiate = pkgEnv.instantiate?.then((res) => {
          if (res.success && !win.isDestroyed()) {
            win.webContents.send(IPC.push.envActivity, {
              stream: "stdout",
              data: "",
              stage: "kernel-boot",
            });
          }
          return res;
        });
        requestedSpec = {
          ...(requestedSpec ?? {}),
          language: "julia",
          env: { ...(requestedSpec?.env ?? {}), JULIA_PROJECT: pkgEnv.workingDir },
        };
        envMeta = { mode: "pkg", interpreterPath: juliaPath };
      }
    }

    let kernel: KernelInfo;
    try {
      kernel = await kernelManager.start(requestedSpec);
      kernelEnvMeta.set(kernel.id, envMeta);
      commRouter.attach(kernelManager, kernel.id);
      queryRouter.detach();
      await initializeKernelSession(
        kernelManager,
        commRouter,
        queryRouter,
        projectManager,
        kernel.id,
        kernelWorkingDirs,
        getWorkingDirBase(),
        preCreatedWorkingDir,
        uvBinaryForInit,
      );
    } catch (err) {
      // Don't leave a concurrent Pkg.instantiate running against a session
      // that will never exist.
      pkgAbortInstantiate?.();
      throw err;
    }

    // pkg-mode launches: the instantiate overlapped the boot; the session is
    // not ready until it succeeds (§10.6.6). On failure the kernel is torn
    // back down so the renderer's failed overlay offers a clean Retry.
    if (pkgInstantiate) {
      const inst = await pkgInstantiate;
      if (inst.juliaVersion) {
        envMeta.juliaVersion = inst.juliaVersion;
      }
      if (!inst.success) {
        kernelEnvMeta.delete(kernel.id);
        await cleanupKernelWorkingDir(
          projectManager,
          kernelManager,
          kernel.id,
          kernelWorkingDirs,
          crashHandlers,
        );
        await kernelManager.stop(kernel.id).catch(() => undefined);
        throw new Error(`Julia environment setup failed (Pkg.instantiate):\n${inst.output}`);
      }
    }
    setActiveKernelId(kernel.id);
    await setupModuleNamespaces(kernel.id);
    await bindActiveProjectModules(kernel.id);

    // Forward "orphan" display_data — figures the kernel emits outside any
    // in-flight execution — to the console as a synthetic entry. The main
    // producer is a double-click plot handler (`pdv.handler.invoke` runs over
    // the comm channel, so its display_data is parented to a stale execute
    // msg and `execute()`'s per-execution collector never sees it). Python's
    // native matplotlib windows sidestep iopub entirely, but Julia's inline
    // Makie displays (and Python's Agg fallback) land here.
    kernelManager.onIopubMessage(kernel.id, (jupMsg) => {
      if (jupMsg.header.msg_type !== "display_data") return;
      const parentId = String(jupMsg.parent_header?.msg_id ?? "");
      if (kernelManager.isExecutionActive(parentId)) return;
      const data = jupMsg.content?.data as Record<string, unknown> | undefined;
      const png = data?.["image/png"];
      const svg = data?.["image/svg+xml"];
      const image =
        typeof png === "string"
          ? { mime: "image/png", data: png }
          : typeof svg === "string"
            ? { mime: "image/svg+xml", data: svg }
            : null;
      if (!image || win.isDestroyed()) return;
      // Reuse the executeBegin/Output/Finish contract so the renderer needs
      // no new channel: the begin push seeds a console entry, the image chunk
      // attaches to it, and the finish push closes it out.
      const executionId = `display-${randomUUID()}`;
      const origin = { kind: "unknown" as const, label: "Plot" };
      const timestamp = Date.now();
      win.webContents.send(IPC.push.executeBegin, { executionId, code: "", origin, timestamp });
      win.webContents.send(IPC.push.executeOutput, { executionId, type: "image", image });
      win.webContents.send(IPC.push.executeFinish, { executionId, duration: 0 });
    });

    const onCrash = async (crashedId: string): Promise<void> => {
      if (crashedId !== kernel.id) return;
      commRouter.detach();
      queryRouter.detach();
      // Deliberately do NOT delete the working directory or its map entry
      // here: it holds the uv env spec (pyproject.toml/uv.lock/
      // .python-version) the restart handler snapshots to rebuild the venv,
      // and any `.autosave` of an unsaved session. `kernels.restart` and
      // `kernels.stop` clean it up; if the user quits instead, the stale
      // `session.lock` surfaces it on the welcome screen as a recoverable
      // session (§11.6).
      if (getActiveKernelId() === crashedId) setActiveKernelId(null);
      win.webContents.send(IPC.push.kernelCrashed, { kernelId: crashedId });
    };
    crashHandlers.set(kernel.id, onCrash);
    kernelManager.on("kernel:crashed", onCrash);

    return kernel;
    });
  });

  handleIpc(IPC.kernels.stop, async (_event, kernelId: string) => {
    return withStartLock("kernels.stop", async () => {
      await cleanupKernelWorkingDir(projectManager, kernelManager, kernelId, kernelWorkingDirs, crashHandlers);
      kernelEnvMeta.delete(kernelId);
      projectManager.clearCachedKernelResults();
      await kernelManager.stop(kernelId);
      if (getActiveKernelId() === kernelId) {
        setActiveKernelId(null);
      }
      commRouter.detach();
      queryRouter.detach();
      return true;
    });
  });

  handleIpc(IPC.kernels.execute, async (event, kernelId, request) => {
    const id = kernelId as string;
    const workingDir = kernelWorkingDirs.get(id);
    const transcript = workingDir ? new TranscriptWriter(workingDir) : null;
    return executeAndTranscribe(
      kernelManager.execute.bind(kernelManager),
      transcript,
      id,
      request as Parameters<KernelManager["execute"]>[1],
      (chunk) => event.sender.send(IPC.push.executeOutput, chunk),
      // The console gets every chunk via the executeOutput push above;
      // returning them again in the result double-prints when the push
      // loses the race against the invoke resolution.
      { keepStreamsInResult: false },
    );
  });

  handleIpc(IPC.kernels.interrupt, async (_event, kernelId: string) => {
    await kernelManager.interrupt(kernelId);
    return true;
  });

  handleIpc(IPC.kernels.restart, async (_event, kernelId: string) => {
    return withStartLock("kernels.restart", async () => {
    // Snapshot the tree while the old server is still alive so a restart
    // never loses in-memory work — for saved projects the snapshot lands
    // in <projectDir>/.autosave and is restored by the reload below; for
    // unsaved sessions it lands in <workingDir>/.autosave and is restored
    // via the same routine the welcome screen's "Recover" uses.
    let hasSnapshot = false;
    try {
      hasSnapshot = await autosaveBeforeRestart(kernelId);
    } catch (err) {
      console.warn("[ipc-register-kernels] pre-restart autosave failed:", err);
    }
    const projectDirBeforeRestart = getActiveProjectDir();
    const oldWorkingDir = kernelWorkingDirs.get(kernelId);
    // Unsaved session with a snapshot: keep the old working dir on disk
    // through the teardown — the snapshot lives inside it.
    const preserveOldDir = !projectDirBeforeRestart && hasSnapshot && !!oldWorkingDir;

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

      // Snapshot the uv env spec BEFORE the old working dir is deleted, so a
      // uv kernel relaunches into its project venv rather than system python
      // (ARCHITECTURE.md §10.5.9, §11.6). The snapshot carries any packages
      // installed since load (e.g. via pdv.install, §10.5.11).
      const oldWorkingDir = kernelWorkingDirs.get(kernelId);
      let envSnapshot:
        | { pyproject: string; uvLock?: string; pythonVersionPin?: string }
        | undefined;
      if (current.language === "python" && oldWorkingDir) {
        try {
          const pyproject = await fs.readFile(
            path.join(oldWorkingDir, "pyproject.toml"),
            "utf8"
          );
          let uvLock: string | undefined;
          try {
            uvLock = await fs.readFile(path.join(oldWorkingDir, "uv.lock"), "utf8");
          } catch {
            /* lock may not exist yet */
          }
          let pythonVersionPin: string | undefined;
          try {
            pythonVersionPin = await fs.readFile(
              path.join(oldWorkingDir, ".python-version"),
              "utf8"
            );
          } catch {
            /* pin may not exist (pre-pin project) */
          }
          envSnapshot = { pyproject, uvLock, pythonVersionPin };
        } catch {
          /* no pyproject.toml -> shared-mode kernel */
        }
      }

      // Julia analog (§10.6): snapshot Project.toml/Manifest.toml so a
      // pkg-mode kernel relaunches with its project environment active,
      // carrying any packages installed since load (PDVKernel.install).
      let juliaEnvSnapshot:
        | { projectToml: string; manifestToml?: string }
        | undefined;
      if (current.language === "julia" && oldWorkingDir) {
        try {
          const projectToml = await fs.readFile(
            path.join(oldWorkingDir, "Project.toml"),
            "utf8"
          );
          let manifestToml: string | undefined;
          try {
            manifestToml = await fs.readFile(
              path.join(oldWorkingDir, "Manifest.toml"),
              "utf8"
            );
          } catch {
            /* manifest may not exist yet (nothing installed) */
          }
          juliaEnvSnapshot = { projectToml, manifestToml };
        } catch {
          /* no Project.toml -> shared-mode (legacy) julia kernel */
        }
      }

      // Hardening: if the old working dir (or its env files) is gone but the
      // saved project is a uv project, rebuild the env from the save dir
      // instead of silently falling back to a shared-mode start.
      let uvSaveDirFallback: string | undefined;
      if (!envSnapshot && current.language === "python") {
        const projectDir = getActiveProjectDir();
        if (projectDir) {
          const hasPyproject = await fs
            .access(path.join(projectDir, "pyproject.toml"))
            .then(() => true)
            .catch(() => false);
          if (hasPyproject) uvSaveDirFallback = projectDir;
        }
      }

      // Same hardening for pkg-mode Julia projects (§10.6.6).
      let pkgSaveDirFallback: string | undefined;
      if (!juliaEnvSnapshot && current.language === "julia") {
        const projectDir = getActiveProjectDir();
        if (projectDir) {
          const hasProjectToml = await fs
            .access(path.join(projectDir, "Project.toml"))
            .then(() => true)
            .catch(() => false);
          if (hasProjectToml) pkgSaveDirFallback = projectDir;
        }
      }

      await cleanupKernelWorkingDir(
        projectManager,
        kernelManager,
        kernelId,
        kernelWorkingDirs,
        crashHandlers,
        preserveOldDir
      );
      await kernelManager.stop(kernelId);

      // Carry the old kernel's environment metadata to the new one — the
      // restart re-materializes the same environment, so mode/interpreter/
      // version are unchanged (the uv branch refreshes the venv path).
      const oldEnvMeta = kernelEnvMeta.get(kernelId);
      kernelEnvMeta.delete(kernelId);

      let preCreatedWorkingDir: string | undefined;
      let uvBinaryForInit: string | undefined;
      let restarted: KernelInfo;
      if (envSnapshot || uvSaveDirFallback) {
        const uvEnv = await startUvEnvironment(
          envSnapshot ? { envSnapshot } : { saveDir: uvSaveDirFallback }
        );
        preCreatedWorkingDir = uvEnv.workingDir;
        uvBinaryForInit = uvEnv.uvBinary;
        restarted = await kernelManager.start({
          name: current.name,
          language: current.language,
          env: { PYTHON_PATH: uvEnv.venvPython },
        });
        kernelEnvMeta.set(restarted.id, {
          mode: "uv",
          interpreterPath: uvEnv.venvPython,
          pythonVersion:
            (await EnvironmentDetector.resolvePythonMajorMinor(uvEnv.venvPython)) ??
            oldEnvMeta?.pythonVersion,
        });
      } else if (juliaEnvSnapshot || pkgSaveDirFallback) {
        // pkg-mode Julia restart (§10.6): re-seed the env files into a fresh
        // working dir and relaunch with JULIA_PROJECT pointing at it. The
        // snapshot path needs no instantiate (the depot already holds what
        // the live session used); the save-dir fallback spawns one, awaited
        // below as best-effort.
        const pkgEnv = await startPkgEnvironment(
          juliaEnvSnapshot
            ? { envSnapshot: juliaEnvSnapshot }
            : { saveDir: pkgSaveDirFallback },
          oldEnvMeta?.interpreterPath ?? "julia"
        );
        preCreatedWorkingDir = pkgEnv.workingDir;
        restarted = await kernelManager.start({
          name: current.name,
          language: current.language,
          env: {
            ...(oldEnvMeta?.interpreterPath
              ? { JULIA_PATH: oldEnvMeta.interpreterPath }
              : {}),
            JULIA_PROJECT: pkgEnv.workingDir,
          },
        });
        const newMeta: ActiveEnvironmentInfo = {
          mode: "pkg",
          interpreterPath: oldEnvMeta?.interpreterPath,
          juliaVersion: oldEnvMeta?.juliaVersion,
        };
        kernelEnvMeta.set(restarted.id, newMeta);
        if (pkgEnv.instantiate) {
          const inst = await pkgEnv.instantiate;
          if (inst.juliaVersion) newMeta.juliaVersion = inst.juliaVersion;
          if (!inst.success) {
            // Non-fatal on restart: the session comes back on whatever the
            // depot already holds; missing packages surface on first use.
            console.warn(
              "[ipc-register-kernels] Pkg.instantiate failed during restart:",
              inst.output
            );
          }
        }
      } else {
        restarted = await kernelManager.start({
          name: current.name,
          language: current.language,
          // A shared Julia restart must relaunch on the same executable —
          // omitting JULIA_PATH would fall back to the PATH `julia` shim.
          env:
            current.language === "julia" && oldEnvMeta?.interpreterPath
              ? { JULIA_PATH: oldEnvMeta.interpreterPath }
              : undefined,
        });
        kernelEnvMeta.set(restarted.id, oldEnvMeta ?? { mode: "shared" });
      }
      commRouter.attach(kernelManager, restarted.id);
      queryRouter.detach();
      await initializeKernelSession(
        kernelManager,
        commRouter,
        queryRouter,
        projectManager,
        restarted.id,
        kernelWorkingDirs,
        getWorkingDirBase(),
        preCreatedWorkingDir,
        uvBinaryForInit
      );
      return restarted;
    }

    const restarted = await doRestart();
    setActiveKernelId(restarted.id);

    // Whether the session's state was actually reloaded from an autosave
    // snapshot — returned to the renderer so it can tell the user what
    // came back (restored work vs. a fresh session).
    let restoredFromAutosave = false;

    // If a project was active, auto-reload it into the new kernel — from
    // the pre-restart .autosave snapshot when one exists, so unsaved
    // changes survive the restart (same overlay + tree-index override
    // recipe as the project-open recovery path in ipc-register-project).
    const activeProjectDir = getActiveProjectDir();
    if (activeProjectDir) {
      win.webContents.send(IPC.push.projectReloading, { status: "reloading" });
      try {
        const autosaveDir = autosaveDirFor(activeProjectDir);
        const restoreFromAutosave =
          hasSnapshot &&
          (await ProjectManager.checkForAutosave(activeProjectDir)).exists;
        const newWorkingDir = kernelWorkingDirs.get(restarted.id);
        if (newWorkingDir) {
          await copyFilesForLoad(activeProjectDir, newWorkingDir);
          if (restoreFromAutosave) {
            await overlayAutosaveTreeFiles(autosaveDir, newWorkingDir);
          }
        }
        await projectManager.load(
          activeProjectDir,
          restoreFromAutosave
            ? { treeIndexDir: autosaveDir, codeCellsDir: autosaveDir }
            : undefined
        );
        restoredFromAutosave = restoreFromAutosave;
        await setupModuleNamespaces(restarted.id);
      } finally {
        win.webContents.send(IPC.push.projectReloading, { status: "ready" });
      }
    } else {
      await setupModuleNamespaces(restarted.id);
      // Unsaved session: restore the preserved snapshot into the new
      // session. Failure is non-fatal — the old dir stays on disk and the
      // welcome screen offers it as a recoverable session next launch.
      if (preserveOldDir && oldWorkingDir) {
        win.webContents.send(IPC.push.projectReloading, { status: "reloading" });
        try {
          await recoverUnsavedAfterRestart(oldWorkingDir);
          restoredFromAutosave = true;
        } catch (err) {
          console.warn(
            "[ipc-register-kernels] post-restart recovery failed; the old session remains recoverable from the welcome screen:",
            err
          );
        } finally {
          win.webContents.send(IPC.push.projectReloading, { status: "ready" });
        }
      }
    }
    await bindActiveProjectModules(restarted.id);

    return { kernel: restarted, restoredFromAutosave } satisfies KernelRestartResult;
    });
  });

  handleIpc(
    IPC.kernels.complete,
    async (_event, kernelId: string, code: string, cursorPos: number) => {
      return kernelManager.complete(kernelId, code, cursorPos);
    }
  );

  handleIpc(
    IPC.kernels.inspect,
    async (_event, kernelId: string, code: string, cursorPos: number) => {
      return kernelManager.inspect(kernelId, code, cursorPos);
    }
  );

  handleIpc(
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
              'Missing pdv. Install it with: cd pdv-python && <python> -m pip install -e ".[dev]"',
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
              "Missing the PDVKernel Julia package — it must be installed into " +
              "this Julia environment. (Julia support is experimental and not " +
              "yet packaged for install.)",
          };
        }
      }
      return { valid: true };
    }
  );
}
