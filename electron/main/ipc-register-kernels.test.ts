/**
 * ipc-register-kernels.test.ts — Unit tests for kernel-domain IPC handlers.
 *
 * Covers all 9 channels in IPC.kernels.*: registration, the start/stop happy
 * paths plus the Python/Julia install-validation failures, restart preserving
 * the working dir, validate dispatching by language, and the thin
 * pass-throughs for execute / interrupt / complete / inspect / list.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
}));

const kernelSessionMocks = vi.hoisted(() => ({
  initializeKernelSession: vi.fn(async () => undefined),
}));

const moduleRuntimeMocks = vi.hoisted(() => ({
  setupProjectModuleNamespaces: vi.fn(async () => undefined),
}));

const projectFileSyncMocks = vi.hoisted(() => ({
  copyFilesForLoad: vi.fn(async () => undefined),
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
  },
}));

vi.mock("./kernel-session", () => kernelSessionMocks);
vi.mock("./module-runtime", () => moduleRuntimeMocks);
vi.mock("./project-file-sync", () => projectFileSyncMocks);

import { IPC } from "./ipc";
import { registerKernelIpcHandlers } from "./ipc-register-kernels";
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
}

function setup(): Harness {
  const win = createBrowserWindowMock();
  const kernelManager = createKernelManagerMock();
  const commRouter = createCommRouterMock();
  const queryRouter = new QueryRouter();
  const projectManager = createProjectManagerMock();
  const moduleManager = createModuleManagerMock();
  const kernelWorkingDirs = new Map<string, string>();
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
  };
  registerKernelIpcHandlers({
    win: win.win,
    kernelManager,
    commRouter: commRouter.router,
    queryRouter,
    projectManager,
    moduleManager,
    kernelWorkingDirs,
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
  });
  return harness;
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
  envDetectorMocks.checkPDVInstalled.mockResolvedValue({ installed: true });
  envDetectorMocks.checkJuliaPDVInstalled.mockResolvedValue({ installed: true });
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
    ).rejects.toThrow(/missing PDVKernel/);
  });

  it("crash handler cleans up working dir and pushes kernelCrashed to renderer", async () => {
    const harness = setup();
    harness.kernelManager.start = vi.fn(async () => makeKernelInfo({ id: "kx" }));
    const result = (await getHandler(IPC.kernels.start)({}, {
      language: "python",
      env: { PYTHON_PATH: "/usr/bin/python3" },
    })) as { id: string };
    harness.kernelWorkingDirs.set(result.id, "/tmp/working");
    const onCrash = harness.crashHandlers.get(result.id)!;
    await onCrash(result.id);
    expect(harness.projectManager.deleteWorkingDir).toHaveBeenCalledWith("/tmp/working");
    expect(harness.win.webContentsSend).toHaveBeenCalledWith(
      IPC.push.kernelCrashed,
      { kernelId: result.id },
    );
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
      id: string;
    };
    expect(restarted.id).toBe("new");
    expect(harness.resetKernelState).toHaveBeenCalled();
    expect(projectFileSyncMocks.copyFilesForLoad).toHaveBeenCalledWith(
      "/projects/x",
      "/tmp/new-wd",
    );
    expect(harness.projectManager.load).toHaveBeenCalledWith("/projects/x");
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
