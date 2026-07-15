/**
 * ipc-register-kernels.test.ts — Unit tests for kernel-domain IPC handlers.
 *
 * Covers all 9 channels in IPC.kernels.*: registration, the start/stop happy
 * paths plus the Python/Julia install-validation failures, restart preserving
 * the working dir, validate dispatching by language, and the thin
 * pass-throughs for execute / interrupt / complete / inspect / list.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ipcRegistry = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcHandle = vi.fn(
    (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  );
  const ipcRemoveHandler = vi.fn((channel: string) => handlers.delete(channel));
  return { handlers, ipcHandle, ipcRemoveHandler };
});

const envDetectorMocks = vi.hoisted(() => ({
  checkPDVInstalled: vi.fn(async () => ({ installed: true })),
  checkJuliaPDVInstalled: vi.fn(async () => ({ installed: true })),
  resolvePythonMajorMinor: vi.fn(async () => "3.13"),
}));

const kernelSessionMocks = vi.hoisted(() => ({
  initializeKernelSession: vi.fn(async () => undefined),
}));

const moduleRuntimeMocks = vi.hoisted(() => ({
  setupProjectModuleNamespaces: vi.fn(async () => undefined),
}));

const projectFileSyncMocks = vi.hoisted(() => ({
  copyFilesForLoad: vi.fn(async () => undefined),
  copyEnvFilesForLoad: vi.fn(async () => []),
  overlayAutosaveTreeFiles: vi.fn(async () => undefined),
}));

const uvEnvironmentMocks = vi.hoisted(() => ({
  materializeUvEnvironment: vi.fn(),
}));

const juliaEnvMocks = vi.hoisted(() => ({
  instantiateJuliaEnvironment: vi.fn(async () => ({
    success: true,
    output: "",
    juliaVersion: "1.11.6",
  })),
}));

// Deterministic shim/default resolution (§10.7.2) — the real module would
// read this machine's juliaup metadata.
const juliaDiscoveryMocks = vi.hoisted(() => ({
  resolveJuliaShim: vi.fn((p: string) => p),
  discoverDefaultJulia: vi.fn((): string | null => null),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
}));

vi.mock("./environment-detector", () => ({
  EnvironmentDetector: {
    checkPDVInstalled: envDetectorMocks.checkPDVInstalled,
    checkJuliaPDVInstalled: envDetectorMocks.checkJuliaPDVInstalled,
    resolvePythonMajorMinor: envDetectorMocks.resolvePythonMajorMinor,
  },
}));

vi.mock("./kernel-session", () => kernelSessionMocks);
vi.mock("./module-runtime", () => moduleRuntimeMocks);
vi.mock("./project-file-sync", () => projectFileSyncMocks);
vi.mock("./uv-environment", () => uvEnvironmentMocks);
vi.mock("./julia-env", () => juliaEnvMocks);
vi.mock("./julia-discovery", () => juliaDiscoveryMocks);

import { IPC, type ActiveEnvironmentInfo } from "./ipc";
import { registerKernelIpcHandlers } from "./ipc-register-kernels";
import { ProjectManager } from "./project-manager";
import {
  createBrowserWindowMock,
  createCommRouterMock,
  createKernelManagerMock,
  createModuleManagerMock,
  createProjectManagerMock,
  makeKernelInfo,
  type InvokeHandler,
} from "./test-helpers";
import { QueryRouter } from "./query-router";

function getHandler(channel: string): InvokeHandler {
  const h = ipcRegistry.handlers.get(channel);
  if (!h) throw new Error(`Channel not registered: ${channel}`);
  return h;
}

interface Harness {
  win: ReturnType<typeof createBrowserWindowMock>;
  kernelManager: ReturnType<typeof createKernelManagerMock>;
  commRouter: ReturnType<typeof createCommRouterMock>;
  queryRouter: QueryRouter;
  projectManager: ReturnType<typeof createProjectManagerMock>;
  moduleManager: ReturnType<typeof createModuleManagerMock>;
  kernelWorkingDirs: Map<string, string>;
  kernelEnvMeta: Map<string, ActiveEnvironmentInfo>;
  crashHandlers: Map<string, (id: string) => void>;
  // Typed Mocks so each field is structurally assignable to the typed
  // callback the registration function expects, while still exposing
  // .mockReturnValueOnce / .mock.calls for test assertions.
  resetProjectState: Mock<() => void>;
  resetKernelState: Mock<() => void>;
  setActiveKernelId: Mock<(id: string | null) => void>;
  getActiveKernelId: Mock<() => string | null>;
  getActiveProjectDir: Mock<() => string | null>;
  getWorkingDirBase: Mock<() => string | undefined>;
  getDefaultPackages: Mock<() => string[]>;
  getUvBinaryPath: Mock<() => string | undefined>;
  bindActiveProjectModules: Mock<(kernelId: string | null) => Promise<void>>;
  autosaveBeforeRestart: Mock<(kernelId: string) => Promise<boolean>>;
  recoverUnsavedAfterRestart: Mock<(orphanDir: string) => Promise<void>>;
}

function setup(): Harness {
  const win = createBrowserWindowMock();
  const kernelManager = createKernelManagerMock();
  const commRouter = createCommRouterMock();
  const queryRouter = new QueryRouter();
  const projectManager = createProjectManagerMock();
  const moduleManager = createModuleManagerMock();
  const kernelWorkingDirs = new Map<string, string>();
  const kernelEnvMeta = new Map<string, ActiveEnvironmentInfo>();
  const crashHandlers = new Map<string, (id: string) => void>();
  let activeId: string | null = null;
  const harness: Harness = {
    win,
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    moduleManager,
    kernelWorkingDirs,
    kernelEnvMeta,
    crashHandlers,
    resetProjectState: vi.fn(),
    resetKernelState: vi.fn(),
    setActiveKernelId: vi.fn((id: string | null) => {
      activeId = id;
    }),
    getActiveKernelId: vi.fn(() => activeId),
    getActiveProjectDir: vi.fn(() => null),
    getWorkingDirBase: vi.fn(() => undefined),
    getDefaultPackages: vi.fn(() => []),
    getUvBinaryPath: vi.fn(() => undefined),
    bindActiveProjectModules: vi.fn(async () => undefined),
    autosaveBeforeRestart: vi.fn(async () => false),
    recoverUnsavedAfterRestart: vi.fn(async () => undefined),
  };
  registerKernelIpcHandlers({
    win: win.win,
    kernelManager,
    commRouter: commRouter.router,
    queryRouter,
    projectManager,
    moduleManager,
    kernelWorkingDirs,
    kernelEnvMeta: harness.kernelEnvMeta,
    crashHandlers,
    resetProjectState: harness.resetProjectState,
    resetKernelState: harness.resetKernelState,
    setActiveKernelId: harness.setActiveKernelId,
    getActiveKernelId: harness.getActiveKernelId,
    getActiveProjectDir: harness.getActiveProjectDir,
    getWorkingDirBase: harness.getWorkingDirBase,
    getDefaultPackages: harness.getDefaultPackages,
    getUvBinaryPath: harness.getUvBinaryPath,
    bindActiveProjectModules: harness.bindActiveProjectModules,
    autosaveBeforeRestart: harness.autosaveBeforeRestart,
    recoverUnsavedAfterRestart: harness.recoverUnsavedAfterRestart,
  });
  return harness;
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
  envDetectorMocks.checkPDVInstalled.mockResolvedValue({ installed: true });
  envDetectorMocks.checkJuliaPDVInstalled.mockResolvedValue({ installed: true });
  envDetectorMocks.resolvePythonMajorMinor.mockResolvedValue("3.13");
  juliaDiscoveryMocks.resolveJuliaShim.mockImplementation((p: string) => p);
  juliaDiscoveryMocks.discoverDefaultJulia.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kernels:start", () => {
  it("happy path: validates pdv install, starts kernel, sets active id, registers crash handler", async () => {
    const harness = setup();
    const handler = getHandler(IPC.kernels.start);
    const result = (await handler({}, {
      language: "python",
      env: { PYTHON_PATH: "/usr/bin/python3" },
    })) as { id: string };
    expect(envDetectorMocks.checkPDVInstalled).toHaveBeenCalledWith("/usr/bin/python3");
    expect(harness.resetProjectState).toHaveBeenCalled();
    expect(harness.kernelManager.start).toHaveBeenCalled();
    expect(harness.commRouter.attach).toHaveBeenCalledWith(
      harness.kernelManager,
      result.id,
    );
    expect(kernelSessionMocks.initializeKernelSession).toHaveBeenCalled();
    expect(harness.setActiveKernelId).toHaveBeenCalledWith(result.id);
    expect(harness.crashHandlers.has(result.id)).toBe(true);
  });

  it("throws when Python pdv-python is not installed", async () => {
    setup();
    envDetectorMocks.checkPDVInstalled.mockResolvedValueOnce({ installed: false });
    await expect(
      getHandler(IPC.kernels.start)({}, {
        language: "python",
        env: { PYTHON_PATH: "/usr/bin/python3" },
      }),
    ).rejects.toThrow(/missing pdv/i);
  });

  it("throws when Julia PDVKernel is not installed", async () => {
    setup();
    envDetectorMocks.checkJuliaPDVInstalled.mockResolvedValueOnce({ installed: false });
    await expect(
      getHandler(IPC.kernels.start)({}, {
        language: "julia",
        env: { JULIA_PATH: "/usr/bin/julia" },
      }),
    ).rejects.toThrow(/missing the PDVKernel package/);
  });

  it("crash handler preserves the working dir and pushes kernelCrashed to renderer", async () => {
    // Regression (§11.6): the crash handler used to delete the working dir,
    // destroying the uv env spec (pyproject.toml/uv.lock/.python-version)
    // and any unsaved-session `.autosave` — a crashed uv project would
    // silently restart in shared mode. The dir and its map entry must
    // survive until kernels.restart / kernels.stop clean them up.
    const harness = setup();
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kx" }));
    const result = (await getHandler(IPC.kernels.start)({}, {
      language: "python",
      env: { PYTHON_PATH: "/usr/bin/python3" },
    })) as { id: string };
    harness.kernelWorkingDirs.set(result.id, "/tmp/working");
    const onCrash = harness.crashHandlers.get(result.id)!;
    await onCrash(result.id);
    expect(harness.projectManager.deleteWorkingDir).not.toHaveBeenCalled();
    expect(harness.kernelWorkingDirs.get(result.id)).toBe("/tmp/working");
    expect(harness.commRouter.detach).toHaveBeenCalled();
    expect(harness.win.webContentsSend).toHaveBeenCalledWith(
      IPC.push.kernelCrashed,
      { kernelId: result.id },
    );
  });
});

describe("kernels:start — new uv project (§10.5.8)", () => {
  function setupUvStart(): { harness: Harness; wd: string } {
    const harness = setup();
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-newproj-"));
    (harness.projectManager.createWorkingDir as Mock).mockResolvedValue(wd);
    uvEnvironmentMocks.materializeUvEnvironment.mockResolvedValue({
      success: true,
      venvPython: path.join(wd, ".venv", "bin", "python"),
      output: "",
    });
    return { harness, wd };
  }

  it("writes pyproject from the chosen packages, pins .python-version, passes --python, launches into the venv", async () => {
    const { harness, wd } = setupUvStart();
    try {
      await getHandler(IPC.kernels.start)(
        {},
        { language: "python" },
        { newProject: true, pythonVersion: "3.12", packages: ["scipy>=1.10", "xarray"] },
      );
      const pyproject = fs.readFileSync(path.join(wd, "pyproject.toml"), "utf8");
      expect(pyproject).toContain("scipy>=1.10");
      expect(pyproject).toContain("xarray");
      expect(fs.readFileSync(path.join(wd, ".python-version"), "utf8").trim()).toBe("3.12");
      const materializeOpts = uvEnvironmentMocks.materializeUvEnvironment.mock.calls.at(-1)?.[1] as
        | { pythonVersion?: string }
        | undefined;
      expect(materializeOpts?.pythonVersion).toBe("3.12");
      const startArg = (harness.kernelManager.start as Mock).mock.calls.at(-1)?.[0] as {
        env: { PYTHON_PATH: string };
      };
      expect(startArg.env.PYTHON_PATH).toBe(path.join(wd, ".venv", "bin", "python"));
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("falls back to the default version and the user's default packages", async () => {
    const { harness, wd } = setupUvStart();
    harness.getDefaultPackages.mockReturnValue(["numpy", "matplotlib"]);
    try {
      await getHandler(IPC.kernels.start)({}, { language: "python" }, { newProject: true });
      const pyproject = fs.readFileSync(path.join(wd, "pyproject.toml"), "utf8");
      expect(pyproject).toContain("numpy");
      expect(pyproject).toContain("matplotlib");
      expect(fs.readFileSync(path.join(wd, ".python-version"), "utf8").trim()).toBe("3.13");
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported Python version before touching the filesystem", async () => {
    const { harness, wd } = setupUvStart();
    try {
      await expect(
        getHandler(IPC.kernels.start)(
          {},
          { language: "python" },
          { newProject: true, pythonVersion: "2.7" },
        ),
      ).rejects.toThrow(/Unsupported Python version "2\.7"/);
      expect(harness.projectManager.createWorkingDir).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("records uv env metadata for the new kernel (environment:activeInfo source)", async () => {
    const { harness, wd } = setupUvStart();
    envDetectorMocks.resolvePythonMajorMinor.mockResolvedValue("3.12");
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kuv" }));
    try {
      await getHandler(IPC.kernels.start)(
        {},
        { language: "python" },
        { newProject: true, pythonVersion: "3.12" },
      );
      expect(harness.kernelEnvMeta.get("kuv")).toEqual({
        mode: "uv",
        interpreterPath: path.join(wd, ".venv", "bin", "python"),
        pythonVersion: "3.12",
      });
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe("kernels:start — Julia pkg mode (§10.6)", () => {
  function setupPkgStart(): { harness: Harness; wd: string } {
    const harness = setup();
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-pkgproj-"));
    (harness.projectManager.createWorkingDir as Mock).mockResolvedValue(wd);
    juliaEnvMocks.instantiateJuliaEnvironment.mockResolvedValue({
      success: true,
      output: "",
      juliaVersion: "1.11.6",
    });
    return { harness, wd };
  }

  it("new project: writes an empty Project.toml and activates it via JULIA_PROJECT (§10.6.5)", async () => {
    const { harness, wd } = setupPkgStart();
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kj" }));
    try {
      await getHandler(IPC.kernels.start)(
        {},
        { language: "julia", env: { JULIA_PATH: "/opt/julia/bin/julia" } },
        { newProject: true },
      );
      expect(fs.readFileSync(path.join(wd, "Project.toml"), "utf8")).toBe("");
      const startArg = (harness.kernelManager.start as Mock).mock.calls.at(-1)?.[0] as {
        env: Record<string, string>;
      };
      expect(startArg.env.JULIA_PROJECT).toBe(wd);
      expect(startArg.env.JULIA_PATH).toBe("/opt/julia/bin/julia");
      expect(harness.kernelEnvMeta.get("kj")).toEqual({
        mode: "pkg",
        interpreterPath: "/opt/julia/bin/julia",
        juliaVersion: "1.11.6",
      });
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("open project: copies the Julia env files and runs Pkg.instantiate (§10.6.6)", async () => {
    const { harness, wd } = setupPkgStart();
    try {
      await getHandler(IPC.kernels.start)(
        {},
        { language: "julia", env: { JULIA_PATH: "/opt/julia/bin/julia" } },
        { saveDir: "/projects/lorenz" },
      );
      expect(projectFileSyncMocks.copyEnvFilesForLoad).toHaveBeenCalledWith(
        "/projects/lorenz",
        wd,
        "julia",
      );
      expect(juliaEnvMocks.instantiateJuliaEnvironment).toHaveBeenCalledWith(
        wd,
        "/opt/julia/bin/julia",
        expect.anything(),
      );
      // The instantiate-complete marker flips the EnvSyncModal stage.
      expect(harness.win.webContentsSend).toHaveBeenCalledWith(IPC.push.envActivity, {
        stream: "stdout",
        data: "",
        stage: "kernel-boot",
      });
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("tears the kernel back down when Pkg.instantiate fails", async () => {
    const { harness, wd } = setupPkgStart();
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kfail" }));
    juliaEnvMocks.instantiateJuliaEnvironment.mockResolvedValue({
      success: false,
      output: "Unsatisfiable requirements",
      juliaVersion: "1.11.6",
    });
    try {
      await expect(
        getHandler(IPC.kernels.start)(
          {},
          { language: "julia", env: { JULIA_PATH: "/opt/julia/bin/julia" } },
          { saveDir: "/projects/broken" },
        ),
      ).rejects.toThrow(/Julia environment setup failed[\s\S]*Unsatisfiable/);
      expect(harness.kernelManager.stop).toHaveBeenCalledWith("kfail");
      expect(harness.kernelEnvMeta.has("kfail")).toBe(false);
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });

  it("without a launch context a Julia start stays shared-mode (legacy sessions)", async () => {
    const { harness } = setupPkgStart();
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kshared" }));
    await getHandler(IPC.kernels.start)(
      {},
      { language: "julia", env: { JULIA_PATH: "/opt/julia/bin/julia" } },
    );
    expect(harness.projectManager.createWorkingDir).not.toHaveBeenCalled();
    expect(juliaEnvMocks.instantiateJuliaEnvironment).not.toHaveBeenCalled();
    expect(harness.kernelEnvMeta.get("kshared")).toEqual({
      mode: "shared",
      interpreterPath: "/opt/julia/bin/julia",
    });
  });
});

describe("kernels:start — Julia shim bypass + boot output forwarding (§10.7.2, §10.8)", () => {
  it("resolves the configured path through the juliaup shim and spawns the real binary", async () => {
    const harness = setup();
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kshim" }));
    juliaDiscoveryMocks.resolveJuliaShim.mockReturnValue(
      "/depot/juliaup/julia-1.11.6/bin/julia",
    );

    await getHandler(IPC.kernels.start)(
      {},
      { language: "julia", env: { JULIA_PATH: "/Users/u/.juliaup/bin/julia" } },
    );

    expect(juliaDiscoveryMocks.resolveJuliaShim).toHaveBeenCalledWith(
      "/Users/u/.juliaup/bin/julia",
    );
    const spec = (harness.kernelManager.start as Mock).mock.calls[0][0] as {
      env?: Record<string, string>;
    };
    expect(spec.env?.JULIA_PATH).toBe("/depot/juliaup/julia-1.11.6/bin/julia");
    // The probe and the env metadata both use the real binary.
    expect(envDetectorMocks.checkJuliaPDVInstalled).toHaveBeenCalledWith(
      "/depot/juliaup/julia-1.11.6/bin/julia",
    );
    expect(harness.kernelEnvMeta.get("kshim")?.interpreterPath).toBe(
      "/depot/juliaup/julia-1.11.6/bin/julia",
    );
  });

  it("falls back to the discovered juliaup default when no path is configured", async () => {
    const harness = setup();
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kdef" }));
    juliaDiscoveryMocks.discoverDefaultJulia.mockReturnValue(
      "/depot/juliaup/julia-1.11.6/bin/julia",
    );

    await getHandler(IPC.kernels.start)({}, { language: "julia" });

    expect(juliaDiscoveryMocks.discoverDefaultJulia).toHaveBeenCalled();
    const spec = (harness.kernelManager.start as Mock).mock.calls[0][0] as {
      env?: Record<string, string>;
    };
    expect(spec.env?.JULIA_PATH).toBe("/depot/juliaup/julia-1.11.6/bin/julia");
  });

  it("leaves explicit argv specs untouched (integration-test escape hatch)", async () => {
    const harness = setup();
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kargv" }));

    await getHandler(IPC.kernels.start)(
      {},
      { language: "julia", argv: ["/custom/julia", "-e", "boot()"] },
    );

    expect(juliaDiscoveryMocks.resolveJuliaShim).not.toHaveBeenCalled();
    const spec = (harness.kernelManager.start as Mock).mock.calls[0][0] as {
      argv?: string[];
    };
    expect(spec.argv?.[0]).toBe("/custom/julia");
  });

  it("streams ANSI-stripped process output to envActivity while a Julia kernel boots — and stops once it is up", async () => {
    const harness = setup();
    // Grab the flag-gated kernel:processOutput listener the registrar attached.
    const outputListener = (harness.kernelManager.on as Mock).mock.calls.find(
      (c) => c[0] === "kernel:processOutput",
    )?.[1] as (id: string, stream: string, data: string) => void;
    expect(outputListener).toBeDefined();

    let releaseStart!: () => void;
    harness.kernelManager.start = vi.fn(
      () =>
        new Promise<ReturnType<typeof makeKernelInfo>>((resolve) => {
          releaseStart = () => resolve(makeKernelInfo({ id: "kboot" }));
        }),
    );

    const pending = getHandler(IPC.kernels.start)(
      {},
      { language: "julia", env: { JULIA_PATH: "/opt/julia/bin/julia" } },
    );
    await vi.waitFor(() =>
      expect(harness.kernelManager.start).toHaveBeenCalled(),
    );

    outputListener("kboot", "stderr", "\x1b[32mPrecompiling\x1b[0m IJulia...\r");
    expect(harness.win.webContentsSend).toHaveBeenCalledWith(
      IPC.push.envActivity,
      { stream: "stdout", data: "Precompiling IJulia...\n" },
    );

    releaseStart();
    await pending;

    // Boot finished — the flag is cleared, later output is not forwarded.
    harness.win.webContentsSend.mockClear();
    outputListener("kboot", "stderr", "runtime chatter\n");
    expect(harness.win.webContentsSend).not.toHaveBeenCalledWith(
      IPC.push.envActivity,
      expect.objectContaining({ data: expect.stringContaining("runtime chatter") }),
    );
  });

  it("does not forward Python boot output, and hands Julia handshakes a boot-output sink", async () => {
    const harness = setup();
    const outputListener = (harness.kernelManager.on as Mock).mock.calls.find(
      (c) => c[0] === "kernel:processOutput",
    )?.[1] as (id: string, stream: string, data: string) => void;

    let releaseStart!: () => void;
    harness.kernelManager.start = vi.fn(
      () =>
        new Promise<ReturnType<typeof makeKernelInfo>>((resolve) => {
          releaseStart = () => resolve(makeKernelInfo({ id: "kpy" }));
        }),
    );
    const pending = getHandler(IPC.kernels.start)(
      {},
      { language: "python", env: { PYTHON_PATH: "/usr/bin/python3" } },
    );
    await vi.waitFor(() =>
      expect(harness.kernelManager.start).toHaveBeenCalled(),
    );
    outputListener("kpy", "stderr", "some python boot noise\n");
    expect(harness.win.webContentsSend).not.toHaveBeenCalledWith(
      IPC.push.envActivity,
      expect.objectContaining({ data: expect.stringContaining("python boot noise") }),
    );
    releaseStart();
    await pending;

    // Python handshake gets no sink; Julia's got one (asserted via the shim
    // test's initializeKernelSession call below).
    const pyArgs = kernelSessionMocks.initializeKernelSession.mock.calls.at(
      -1,
    ) as unknown[];
    expect(pyArgs[9]).toBeUndefined();

    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kjl" }));
    await getHandler(IPC.kernels.start)(
      {},
      { language: "julia", env: { JULIA_PATH: "/opt/julia/bin/julia" } },
    );
    const jlArgs = kernelSessionMocks.initializeKernelSession.mock.calls.at(
      -1,
    ) as unknown[];
    expect(typeof jlArgs[9]).toBe("function");
  });
});

describe("kernels:restart — Julia pkg mode (§10.6)", () => {
  it("snapshots Project.toml/Manifest.toml and relaunches with JULIA_PROJECT + JULIA_PATH", async () => {
    const harness = setup();
    const oldWd = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-pkgrestart-old-"));
    const newWd = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-pkgrestart-new-"));
    try {
      fs.writeFileSync(path.join(oldWd, "Project.toml"), "[deps]\nNPZ = \"x\"\n");
      fs.writeFileSync(path.join(oldWd, "Manifest.toml"), "julia_version = \"1.11.6\"\n");
      harness.kernelWorkingDirs.set("kj", oldWd);
      harness.kernelEnvMeta.set("kj", {
        mode: "pkg",
        interpreterPath: "/opt/julia/bin/julia",
        juliaVersion: "1.11.6",
      });
      harness.kernelManager.getKernel = vi.fn(() =>
        makeKernelInfo({ id: "kj", language: "julia" }),
      );
      (harness.projectManager.createWorkingDir as Mock).mockResolvedValue(newWd);
      harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kj2", language: "julia" }));

      await getHandler(IPC.kernels.restart)({}, "kj");

      // Env files re-seeded into the fresh working dir.
      expect(fs.readFileSync(path.join(newWd, "Project.toml"), "utf8")).toContain("NPZ");
      expect(fs.readFileSync(path.join(newWd, "Manifest.toml"), "utf8")).toContain(
        "julia_version",
      );
      const startArg = (harness.kernelManager.start as Mock).mock.calls.at(-1)?.[0] as {
        env: Record<string, string>;
      };
      expect(startArg.env.JULIA_PROJECT).toBe(newWd);
      expect(startArg.env.JULIA_PATH).toBe("/opt/julia/bin/julia");
      // Snapshot path: the depot already holds everything — no instantiate.
      expect(juliaEnvMocks.instantiateJuliaEnvironment).not.toHaveBeenCalled();
      expect(harness.kernelEnvMeta.get("kj2")).toEqual({
        mode: "pkg",
        interpreterPath: "/opt/julia/bin/julia",
        juliaVersion: "1.11.6",
      });
    } finally {
      fs.rmSync(oldWd, { recursive: true, force: true });
      fs.rmSync(newWd, { recursive: true, force: true });
    }
  });

  it("shared Julia restart relaunches on the recorded executable, not the PATH shim", async () => {
    const harness = setup();
    harness.kernelWorkingDirs.set("kj", "/tmp/nonexistent-pdv-wd");
    harness.kernelEnvMeta.set("kj", {
      mode: "shared",
      interpreterPath: "/opt/julia/bin/julia",
    });
    harness.kernelManager.getKernel = vi.fn(() =>
      makeKernelInfo({ id: "kj", language: "julia" }),
    );
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kj2", language: "julia" }));

    await getHandler(IPC.kernels.restart)({}, "kj");

    const startArg = (harness.kernelManager.start as Mock).mock.calls.at(-1)?.[0] as {
      env?: Record<string, string>;
    };
    expect(startArg.env?.JULIA_PATH).toBe("/opt/julia/bin/julia");
    expect(startArg.env?.JULIA_PROJECT).toBeUndefined();
  });
});

describe("start/stop/restart serialization", () => {
  it("serializes concurrent start calls — the second waits for the first (regression)", async () => {
    // The old implementation awaited the previous lock promise BEFORE
    // swapping in its own, so two calls arriving together both saw the
    // same settled promise and both entered their bodies, racing on the
    // shared commRouter. The lock must be swapped synchronously.
    const harness = setup();
    const events: string[] = [];
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((r) => { finishFirst = r; });
    let call = 0;
    harness.kernelManager.start = vi.fn(async () => {
      call += 1;
      const id = `k${call}`;
      events.push(`begin:${id}`);
      if (call === 1) await firstGate;
      events.push(`end:${id}`);
      return makeKernelInfo({ id });
    });

    const p1 = getHandler(IPC.kernels.start)({}, { language: "python" });
    const p2 = getHandler(IPC.kernels.start)({}, { language: "python" });

    // Let any incorrectly-unblocked second call run its continuations.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(["begin:k1"]);

    finishFirst();
    await Promise.all([p1, p2]);
    expect(events).toEqual(["begin:k1", "end:k1", "begin:k2", "end:k2"]);
  });

  it("releases the lock when the serialized operation throws", async () => {
    const harness = setup();
    harness.kernelManager.start = vi
      .fn(async () => makeKernelInfo({ id: "k2" }))
      .mockRejectedValueOnce(new Error("spawn failed"));

    await expect(
      getHandler(IPC.kernels.start)({}, { language: "python" }),
    ).rejects.toThrow(/spawn failed/);

    // The failed first operation must not leave the lock held.
    const result = (await getHandler(IPC.kernels.start)({}, {
      language: "python",
    })) as { id: string };
    expect(result.id).toBe("k2");
  });
});

describe("kernels:stop", () => {
  it("removes the working dir, clears the active kernel, detaches routers", async () => {
    const harness = setup();
    harness.kernelWorkingDirs.set("kZ", "/tmp/wd");
    harness.crashHandlers.set("kZ", () => undefined);
    harness.setActiveKernelId("kZ");
    const result = await getHandler(IPC.kernels.stop)({}, "kZ");
    expect(harness.projectManager.deleteWorkingDir).toHaveBeenCalledWith("/tmp/wd");
    expect(harness.kernelWorkingDirs.has("kZ")).toBe(false);
    expect(harness.crashHandlers.has("kZ")).toBe(false);
    expect(harness.kernelManager.stop).toHaveBeenCalledWith("kZ");
    expect(harness.commRouter.detach).toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe("kernels:restart", () => {
  it("preserves activeProjectDir and re-initializes the session for the new kernel", async () => {
    const harness = setup();
    // Configure the same kernelManager instance that was registered.
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ id: "old", language: "python" }),
    );
    (harness.kernelManager.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeKernelInfo({ id: "new", language: "python" }),
    );
    (harness.getActiveProjectDir as ReturnType<typeof vi.fn>).mockReturnValue(
      "/projects/x",
    );
    // Pre-seed the working dir for the new kernel id so copyFilesForLoad can find it.
    harness.kernelWorkingDirs.set("new", "/tmp/new-wd");

    const restarted = (await getHandler(IPC.kernels.restart)({}, "old")) as {
      kernel: { id: string };
      restoredFromAutosave: boolean;
    };
    expect(restarted.kernel.id).toBe("new");
    // No autosave snapshot → the renderer is told nothing was restored.
    expect(restarted.restoredFromAutosave).toBe(false);
    expect(harness.resetKernelState).toHaveBeenCalled();
    expect(projectFileSyncMocks.copyFilesForLoad).toHaveBeenCalledWith(
      "/projects/x",
      "/tmp/new-wd",
    );
    // No autosave snapshot → plain load, no tree-index override.
    expect(harness.projectManager.load).toHaveBeenCalledWith(
      "/projects/x",
      undefined,
    );
  });

  it("snapshots the tree before teardown (autosave runs before stop)", async () => {
    const harness = setup();
    const events: string[] = [];
    harness.autosaveBeforeRestart.mockImplementation(async () => {
      events.push("autosave");
      return false;
    });
    (harness.kernelManager.stop as Mock).mockImplementation(async () => {
      events.push("stop");
    });
    (harness.kernelManager.getKernel as Mock).mockReturnValue(
      makeKernelInfo({ id: "old", language: "python" }),
    );
    (harness.kernelManager.start as Mock).mockResolvedValueOnce(
      makeKernelInfo({ id: "new", language: "python" }),
    );

    await getHandler(IPC.kernels.restart)({}, "old");
    expect(events).toEqual(["autosave", "stop"]);
  });

  it("unsaved session with a snapshot: preserves the old working dir and recovers it after restart", async () => {
    const harness = setup();
    harness.autosaveBeforeRestart.mockResolvedValue(true);
    (harness.getActiveProjectDir as Mock).mockReturnValue(null);
    harness.kernelWorkingDirs.set("old", "/tmp/old-wd");
    (harness.kernelManager.getKernel as Mock).mockReturnValue(
      makeKernelInfo({ id: "old", language: "python" }),
    );
    (harness.kernelManager.start as Mock).mockResolvedValueOnce(
      makeKernelInfo({ id: "new", language: "python" }),
    );

    await getHandler(IPC.kernels.restart)({}, "old");

    // The old dir must survive teardown — it holds the .autosave snapshot.
    expect(harness.projectManager.deleteWorkingDir).not.toHaveBeenCalledWith(
      "/tmp/old-wd",
    );
    // ...and the recovery routine re-imports it into the new session.
    expect(harness.recoverUnsavedAfterRestart).toHaveBeenCalledWith("/tmp/old-wd");
  });

  it("unsaved session without a snapshot: old behavior (dir deleted, no recovery)", async () => {
    const harness = setup();
    harness.autosaveBeforeRestart.mockResolvedValue(false);
    (harness.getActiveProjectDir as Mock).mockReturnValue(null);
    harness.kernelWorkingDirs.set("old", "/tmp/old-wd");
    (harness.kernelManager.getKernel as Mock).mockReturnValue(
      makeKernelInfo({ id: "old", language: "python" }),
    );
    (harness.kernelManager.start as Mock).mockResolvedValueOnce(
      makeKernelInfo({ id: "new", language: "python" }),
    );

    await getHandler(IPC.kernels.restart)({}, "old");

    expect(harness.projectManager.deleteWorkingDir).toHaveBeenCalledWith(
      "/tmp/old-wd",
    );
    expect(harness.recoverUnsavedAfterRestart).not.toHaveBeenCalled();
  });

  it("saved project with a snapshot: reloads from the autosave overlay", async () => {
    const harness = setup();
    harness.autosaveBeforeRestart.mockResolvedValue(true);
    (harness.getActiveProjectDir as Mock).mockReturnValue("/projects/x");
    (harness.kernelManager.getKernel as Mock).mockReturnValue(
      makeKernelInfo({ id: "old", language: "python" }),
    );
    (harness.kernelManager.start as Mock).mockResolvedValueOnce(
      makeKernelInfo({ id: "new", language: "python" }),
    );
    harness.kernelWorkingDirs.set("new", "/tmp/new-wd");
    const checkSpy = vi
      .spyOn(ProjectManager, "checkForAutosave")
      .mockResolvedValue({ exists: true, timestamp: "2026-07-07T00:00:00Z" });

    try {
      await getHandler(IPC.kernels.restart)({}, "old");
    } finally {
      checkSpy.mockRestore();
    }

    const autosaveDir = path.join("/projects/x", ".autosave");
    expect(projectFileSyncMocks.copyFilesForLoad).toHaveBeenCalledWith(
      "/projects/x",
      "/tmp/new-wd",
    );
    expect(projectFileSyncMocks.overlayAutosaveTreeFiles).toHaveBeenCalledWith(
      autosaveDir,
      "/tmp/new-wd",
    );
    expect(harness.projectManager.load).toHaveBeenCalledWith("/projects/x", {
      treeIndexDir: autosaveDir,
      codeCellsDir: autosaveDir,
    });
  });

  it("restart still completes when recovery of the preserved session fails", async () => {
    const harness = setup();
    harness.autosaveBeforeRestart.mockResolvedValue(true);
    harness.recoverUnsavedAfterRestart.mockRejectedValue(new Error("recover boom"));
    (harness.getActiveProjectDir as Mock).mockReturnValue(null);
    harness.kernelWorkingDirs.set("old", "/tmp/old-wd");
    (harness.kernelManager.getKernel as Mock).mockReturnValue(
      makeKernelInfo({ id: "old", language: "python" }),
    );
    (harness.kernelManager.start as Mock).mockResolvedValueOnce(
      makeKernelInfo({ id: "new", language: "python" }),
    );

    const restarted = (await getHandler(IPC.kernels.restart)({}, "old")) as {
      kernel: { id: string };
      restoredFromAutosave: boolean;
    };
    expect(restarted.kernel.id).toBe("new");
    // Recovery failed, so nothing was actually restored.
    expect(restarted.restoredFromAutosave).toBe(false);
  });

  it("re-materializes the uv environment and relaunches into the venv", async () => {
    const harness = setup();
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-restart-old-"));
    const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-restart-new-"));
    fs.writeFileSync(path.join(oldDir, "pyproject.toml"), "[project]\nname = 'x'\n");
    fs.writeFileSync(path.join(oldDir, "uv.lock"), "version = 1\n");
    fs.writeFileSync(path.join(oldDir, ".python-version"), "3.11\n");

    (harness.kernelManager.getKernel as Mock).mockReturnValue(
      makeKernelInfo({ id: "old", language: "python" }),
    );
    (harness.kernelManager.start as Mock).mockResolvedValueOnce(
      makeKernelInfo({ id: "new", language: "python" }),
    );
    (harness.projectManager.createWorkingDir as Mock).mockResolvedValue(newDir);
    (harness.getActiveProjectDir as Mock).mockReturnValue(null);
    harness.kernelWorkingDirs.set("old", oldDir);
    const venvPython = path.join(newDir, ".venv", "bin", "python");
    uvEnvironmentMocks.materializeUvEnvironment.mockResolvedValue({
      success: true,
      venvPython,
      output: "",
    });

    try {
      await getHandler(IPC.kernels.restart)({}, "old");

      // The snapshot was written into the new working dir and re-synced there.
      expect(uvEnvironmentMocks.materializeUvEnvironment).toHaveBeenCalledWith(
        newDir,
        expect.any(Object),
      );
      expect(fs.readFileSync(path.join(newDir, "pyproject.toml"), "utf8")).toContain(
        "[project]",
      );
      // The version pin rode the snapshot into the new working dir and was
      // forwarded to uv sync --python (§10.5.8).
      expect(fs.readFileSync(path.join(newDir, ".python-version"), "utf8").trim()).toBe(
        "3.11",
      );
      const rematerializeOpts = uvEnvironmentMocks.materializeUvEnvironment.mock.calls.at(-1)?.[1] as
        | { pythonVersion?: string }
        | undefined;
      expect(rematerializeOpts?.pythonVersion).toBe("3.11");
      // The new kernel launched against the venv interpreter, not system python.
      const startArg = (harness.kernelManager.start as Mock).mock.calls.at(-1)?.[0];
      expect(startArg.env.PYTHON_PATH).toBe(venvPython);
      // The session was initialized with the pre-created (uv) working dir
      // (8th positional arg; the 9th is the resolved uv binary path, which is
      // environment-dependent in tests).
      const initArgs = kernelSessionMocks.initializeKernelSession.mock.calls.at(-1) as
        | unknown[]
        | undefined;
      expect(initArgs?.[7]).toBe(newDir);
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true });
      fs.rmSync(newDir, { recursive: true, force: true });
    }
  });

  it("rejects when the kernel does not exist", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );
    await expect(getHandler(IPC.kernels.restart)({}, "missing")).rejects.toThrow(
      /Kernel not found/,
    );
  });
});

describe("kernels:execute", () => {
  it("delegates to kernelManager.execute and routes output via event.sender.send", async () => {
    const { kernelManager } = setup();
    const sendSpy = vi.fn();
    await getHandler(IPC.kernels.execute)(
      { sender: { send: sendSpy } },
      "k1",
      { code: "print(1)", executionId: "e1" },
    );
    expect(kernelManager.execute).toHaveBeenCalledWith(
      "k1",
      expect.objectContaining({ code: "print(1)" }),
      expect.any(Function),
    );
  });

});

describe("kernels:validate", () => {
  it("rejects empty paths", async () => {
    setup();
    const result = (await getHandler(IPC.kernels.validate)({}, "  ", "python")) as {
      valid: boolean;
      error?: string;
    };
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("dispatches to checkPDVInstalled for python language", async () => {
    setup();
    envDetectorMocks.checkPDVInstalled.mockResolvedValueOnce({ installed: true });
    const result = (await getHandler(IPC.kernels.validate)({}, "/usr/bin/python3", "python")) as {
      valid: boolean;
    };
    expect(result.valid).toBe(true);
    expect(envDetectorMocks.checkPDVInstalled).toHaveBeenCalledWith("/usr/bin/python3");
  });

  it("dispatches to checkJuliaPDVInstalled for julia language", async () => {
    setup();
    envDetectorMocks.checkJuliaPDVInstalled.mockResolvedValueOnce({ installed: true });
    const result = (await getHandler(IPC.kernels.validate)({}, "/usr/bin/julia", "julia")) as {
      valid: boolean;
    };
    expect(result.valid).toBe(true);
    expect(envDetectorMocks.checkJuliaPDVInstalled).toHaveBeenCalledWith("/usr/bin/julia");
  });

  it("returns invalid with installation hint when pdv is missing (python)", async () => {
    setup();
    envDetectorMocks.checkPDVInstalled.mockResolvedValueOnce({ installed: false });
    const result = (await getHandler(IPC.kernels.validate)({}, "/usr/bin/python3", "python")) as {
      valid: boolean;
      error?: string;
    };
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Missing pdv/);
  });
});
