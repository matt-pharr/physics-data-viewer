/**
 * ipc-register-environment.test.ts — Unit tests for the Packages-tab
 * language routing (§10.5.13 / §10.6.8): Julia pkg-mode sessions list from
 * Project.toml/Manifest.toml and mutate via in-kernel PDVKernel verbs;
 * Python sessions keep the uv subprocess path (+ import-cache refresh).
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcRegistry = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcHandle: vi.fn(
      (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    ipcRemoveHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
});

const envDetectorMocks = vi.hoisted(() => ({
  listEnvironmentInfo: vi.fn(async () => []),
  checkEnvironment: vi.fn(async () => null),
  installPDVFromBundle: vi.fn(async () => ({ success: true, output: "" })),
  clearCache: vi.fn(),
}));

const juliaDiscoveryMocks = vi.hoisted(() => ({
  listJuliaRuntimes: vi.fn(async () => []),
  checkJuliaRuntime: vi.fn(async () => null),
  installPDVKernel: vi.fn(async () => ({ success: true, output: "" })),
  clearJuliaRuntimeCache: vi.fn(),
  resolveJuliaShim: vi.fn((p: string) => p),
}));

const juliaEnvMocks = vi.hoisted(() => ({
  listJuliaProjectPackages: vi.fn(async () => [
    { name: "NPZ", spec: "NPZ", installedVersion: "0.4.3" },
  ]),
}));

const juliaupRunnerMocks = vi.hoisted(() => ({
  juliaupStatus: vi.fn(() => ({
    installed: true,
    juliaupPath: "/home/user/.juliaup/bin/juliaup",
  })),
  juliaupAdd: vi.fn(async () => ({ success: true, output: "added" })),
  installJuliaup: vi.fn(async () => ({ success: true, output: "installed" })),
}));

const uvRunnerMocks = vi.hoisted(() => ({
  uvAdd: vi.fn(async () => ({ success: true, output: "uv added" })),
  uvRemove: vi.fn(async () => ({ success: true, output: "uv removed" })),
  uvLockUpgrade: vi.fn(async () => ({ success: true, output: "locked" })),
  uvSync: vi.fn(async () => ({ success: true, output: "synced" })),
  uvPipList: vi.fn(async () => ({ success: true, output: "[]" })),
}));

const transcriptMocks = vi.hoisted(() => ({
  TranscriptWriter: vi.fn(),
  executeAndTranscribe: vi.fn(
    async (
      _exec: unknown,
      _tw: unknown,
      _kernelId: string,
      _req: unknown,
      onChunk?: (chunk: { executionId: string; type: string; text?: string }) => void,
    ) => {
      onChunk?.({ executionId: "x", type: "stdout", text: "Resolving...\n" });
      return { duration: 5 } as { duration: number; error?: string };
    },
  ),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/pdv-userdata") },
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
}));
vi.mock("./environment-detector", () => ({
  EnvironmentDetector: envDetectorMocks,
}));
vi.mock("./julia-discovery", () => juliaDiscoveryMocks);
vi.mock("./julia-env", () => juliaEnvMocks);
vi.mock("./juliaup-runner", () => juliaupRunnerMocks);
vi.mock("./uv-runner", () => uvRunnerMocks);
vi.mock("./mcp/transcript", () => transcriptMocks);

import { IPC, type ActiveEnvironmentInfo } from "./ipc";
import { registerEnvironmentIpcHandlers } from "./ipc-register-environment";
import type { ConfigStore } from "./config";
import type { KernelManager } from "./kernel-manager";
import {
  createBrowserWindowMock,
  createKernelManagerMock,
  getInvokeHandler,
  makeKernelInfo,
  resetInvokeRegistry,
  type InvokeHandler,
} from "./test-helpers";

function getHandler(channel: string): InvokeHandler {
  return getInvokeHandler(channel);
}

function setup(language: "python" | "julia") {
  const win = createBrowserWindowMock();
  const kernelManager = createKernelManagerMock({
    getKernel: vi.fn(() => makeKernelInfo({ id: "k1", language })),
  } as unknown as Partial<KernelManager>);
  const kernelWorkingDirs = new Map<string, string>([["k1", "/tmp/pdv-wd"]]);
  const kernelEnvMeta = new Map<string, ActiveEnvironmentInfo>();
  registerEnvironmentIpcHandlers({
    push: win.webContentsSend,
    configStore: { getAll: vi.fn(() => ({})) } as unknown as ConfigStore,
    kernelManager,
    kernelWorkingDirs,
    kernelEnvMeta,
    getActiveKernelId: () => "k1",
    readConfig: vi.fn(() => ({}) as never),
  });
  return { win, kernelManager };
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  resetInvokeRegistry();
  vi.clearAllMocks();
  juliaEnvMocks.listJuliaProjectPackages.mockResolvedValue([
    { name: "NPZ", spec: "NPZ", installedVersion: "0.4.3" },
  ]);
  transcriptMocks.executeAndTranscribe.mockImplementation(
    async (_exec, _tw, _kernelId, _req, onChunk) => {
      onChunk?.({ executionId: "x", type: "stdout", text: "Resolving...\n" });
      return { duration: 5 };
    },
  );
});

describe("environment:listPackages routing", () => {
  it("julia sessions list from Project.toml/Manifest.toml", async () => {
    setup("julia");

    const result = await getHandler(IPC.environment.listPackages)({});

    expect(juliaEnvMocks.listJuliaProjectPackages).toHaveBeenCalledWith("/tmp/pdv-wd");
    expect(result).toEqual([{ name: "NPZ", spec: "NPZ", installedVersion: "0.4.3" }]);
    expect(uvRunnerMocks.uvPipList).not.toHaveBeenCalled();
  });

  it("python sessions never touch the julia lister", async () => {
    setup("python");

    await getHandler(IPC.environment.listPackages)({});

    expect(juliaEnvMocks.listJuliaProjectPackages).not.toHaveBeenCalled();
  });
});

describe("environment package mutations — Julia (§10.6.8)", () => {
  it("addPackage runs PDVKernel.install in the kernel, bracketed and mirrored to envActivity", async () => {
    const { win } = setup("julia");

    const result = (await getHandler(IPC.environment.addPackage)({}, [
      "DataFrames",
      "NPZ",
    ])) as { success: boolean; output: string };

    const call = transcriptMocks.executeAndTranscribe.mock.calls[0];
    expect((call[3] as { code: string }).code).toBe(
      'PDVKernel.install("DataFrames", "NPZ")',
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("Resolving...");
    // Console bracket + Packages-tab mirror.
    expect(win.webContentsSend).toHaveBeenCalledWith(
      IPC.push.executeBegin,
      expect.objectContaining({ code: 'PDVKernel.install("DataFrames", "NPZ")' }),
    );
    expect(win.webContentsSend).toHaveBeenCalledWith(
      IPC.push.envActivity,
      { stream: "stdout", data: "Resolving...\n" },
    );
    expect(win.webContentsSend).toHaveBeenCalledWith(
      IPC.push.executeFinish,
      expect.objectContaining({ error: undefined }),
    );
    // No uv, no Python import-cache refresh.
    expect(uvRunnerMocks.uvAdd).not.toHaveBeenCalled();
  });

  it("removePackage and upgradePackage dispatch the matching PDVKernel verbs", async () => {
    setup("julia");

    await getHandler(IPC.environment.removePackage)({}, ["NPZ"]);
    await getHandler(IPC.environment.upgradePackage)({}, ["DataFrames"]);

    const codes = transcriptMocks.executeAndTranscribe.mock.calls.map(
      (c) => (c[3] as { code: string }).code,
    );
    expect(codes).toEqual([
      'PDVKernel.remove("NPZ")',
      'PDVKernel.update("DataFrames")',
    ]);
    expect(uvRunnerMocks.uvRemove).not.toHaveBeenCalled();
    expect(uvRunnerMocks.uvLockUpgrade).not.toHaveBeenCalled();
  });

  it("mirrors ANSI-colored Pkg output to envActivity as plain text (console keeps the raw chunk)", async () => {
    const { win } = setup("julia");
    const colored = "[92m[1mPrecompiling[22m[39m project...\n";
    transcriptMocks.executeAndTranscribe.mockImplementation(
      async (_exec, _tw, _kernelId, _req, onChunk) => {
        onChunk?.({ executionId: "x", type: "stdout", text: colored });
        return { duration: 5 };
      },
    );

    const result = (await getHandler(IPC.environment.addPackage)({}, [
      "DataFrames",
    ])) as { output: string };

    expect(win.webContentsSend).toHaveBeenCalledWith(
      IPC.push.envActivity,
      { stream: "stdout", data: "Precompiling project...\n" },
    );
    // The console's executeOutput push keeps the raw ANSI chunk.
    expect(win.webContentsSend).toHaveBeenCalledWith(
      IPC.push.executeOutput,
      expect.objectContaining({ text: colored }),
    );
    expect(result.output).toBe("Precompiling project...\n");
  });

  it("a kernel-side Pkg error maps to success:false with the error in the output", async () => {
    setup("julia");
    transcriptMocks.executeAndTranscribe.mockResolvedValue({
      duration: 5,
      error: "Unsatisfiable requirements detected",
    });

    const result = (await getHandler(IPC.environment.addPackage)({}, [
      "NoSuchPkg",
    ])) as { success: boolean; output: string };

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unsatisfiable requirements");
  });
});

describe("juliaup version management (§10.7.5)", () => {
  it("juliaupStatus reports the runner's presence check", async () => {
    setup("julia");

    const result = await getHandler(IPC.environment.juliaupStatus)({});

    expect(result).toEqual({
      installed: true,
      juliaupPath: "/home/user/.juliaup/bin/juliaup",
    });
  });

  it("juliaupAdd forwards the channel and streams over installOutput", async () => {
    const { win } = setup("julia");

    const result = (await getHandler(IPC.environment.juliaupAdd)({}, "1.10")) as {
      success: boolean;
    };

    expect(juliaupRunnerMocks.juliaupAdd).toHaveBeenCalledWith("1.10", {
      push: win.webContentsSend,
      pushChannel: IPC.push.installOutput,
    });
    expect(result.success).toBe(true);
  });

  it("juliaupInstall runs the official-installer bootstrap, streamed", async () => {
    const { win } = setup("julia");

    const result = (await getHandler(IPC.environment.juliaupInstall)({})) as {
      success: boolean;
      output: string;
    };

    expect(juliaupRunnerMocks.installJuliaup).toHaveBeenCalledWith({
      push: win.webContentsSend,
      pushChannel: IPC.push.installOutput,
    });
    expect(result).toEqual({ success: true, output: "installed" });
  });
});

describe("environment package mutations — Python path unchanged", () => {
  it("addPackage still runs uv add and refreshes the kernel import caches", async () => {
    const { kernelManager } = setup("python");

    const result = (await getHandler(IPC.environment.addPackage)({}, [
      "scipy>=1.10",
    ])) as { success: boolean };

    expect(uvRunnerMocks.uvAdd).toHaveBeenCalledWith(
      ["scipy>=1.10"],
      expect.objectContaining({ cwd: "/tmp/pdv-wd" }),
    );
    expect(result.success).toBe(true);
    expect(transcriptMocks.executeAndTranscribe).not.toHaveBeenCalled();
    // Import-cache refresh runs importlib in the kernel (§10.5.11).
    expect(
      (kernelManager.execute as Mock).mock.calls.some((c) =>
        String((c[1] as { code?: string })?.code).includes("invalidate_caches"),
      ),
    ).toBe(true);
  });
});
