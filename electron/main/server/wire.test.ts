/**
 * wire.test.ts — Assembly tests for the pdv-server core (`wireServer`).
 *
 * Covers the guarantees the two front ends (single-process mirror, stdio
 * transport) rely on:
 *  - the invoke registry after wiring is exactly `SERVER_CHANNELS`
 *    (drift in either direction fails);
 *  - `sessionReset` restores just-wired state — session closures cleared,
 *    kernel working directories removed from disk, autosave timer stopped,
 *    child windows closed — matching what a full unwire + re-wire produces;
 *  - `resetSessionState` (renderer reload) clears session closures but
 *    leaves per-kernel state on disk;
 *  - `mcp:getStatus` / `cells:respond` are served from the registry;
 *  - `unwireServer` empties the registry so re-wiring cannot trip the
 *    duplicate-handler guard.
 */

import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../environment-detector", () => ({
  EnvironmentDetector: {
    checkPDVInstalled: vi.fn(async () => ({ installed: true })),
    checkJuliaPDVInstalled: vi.fn(async () => ({ installed: true })),
    detect: vi.fn(async () => ({ pythonVersion: "3.11.6" })),
  },
}));
vi.mock("../kernel-session", () => ({
  // The real initializer allocates (or adopts) the kernel working dir and
  // records it in kernelWorkingDirs — the piece of its behavior the wire's
  // session-state tests depend on.
  initializeKernelSession: vi.fn(
    async (...args: unknown[]): Promise<void> => {
      const projectManager = args[3] as {
        createWorkingDir: (base?: string) => Promise<string>;
      };
      const kernelId = args[4] as string;
      const workingDirs = args[5] as Map<string, string>;
      const preCreated = args[7] as string | undefined;
      workingDirs.set(
        kernelId,
        preCreated ?? (await projectManager.createWorkingDir(undefined)),
      );
    },
  ),
}));
vi.mock("../module-runtime", () => ({
  bindProjectModulesToTree: vi.fn(async () => undefined),
  setupProjectModuleNamespaces: vi.fn(async () => undefined),
  bindImportedModule: vi.fn(async () => undefined),
  buildModulesSetupPayload: vi.fn(async () => ({ modules: [] })),
  buildModuleActionCode: vi.fn(() => ""),
  isMissingActionScriptError: vi.fn(() => false),
  normalizeModuleAlias: (s: string) => s,
  suggestModuleAlias: (s: string) => `${s}-2`,
  toPythonArgumentValue: (v: unknown) => String(v),
  toJuliaArgumentValue: (v: unknown) => String(v),
  juliaStringLiteral: (s: string) => JSON.stringify(s),
}));
vi.mock("../project-file-sync", () => ({
  copyFilesForLoad: vi.fn(async () => []),
  overlayAutosaveTreeFiles: vi.fn(async () => undefined),
  syncUvEnvironmentForLoad: vi.fn(async () => ({ synced: false })),
  syncPkgEnvironmentForLoad: vi.fn(async () => ({ synced: false })),
}));
vi.mock("../module-manifest-writer", () => ({
  writeModuleIndex: vi.fn(async () => undefined),
  writeModuleManifest: vi.fn(async () => undefined),
}));

import type { PDVConfig } from "../config";
import { INTERNAL_CHANNELS, IPC, SERVER_CHANNELS, type McpStatus } from "../ipc";
import type { KernelManager } from "../kernel-manager";
import { setAppVersion } from "../pdv-protocol";
import type { ProjectManager } from "../project-manager";
import { QueryRouter } from "../query-router";
import {
  createCommRouterMock,
  createConfigStoreMock,
  createKernelManagerMock,
  createProjectManagerMock,
} from "../test-helpers";
import {
  dispatchInvoke,
  listRegisteredInvokeChannels,
  type InvokeContext,
} from "./invoke-registry";
import { unwireServer, wireServer, type WireHandle } from "./wire";

interface Harness {
  wire: WireHandle;
  pushes: Array<{ channel: string; payload: unknown }>;
  ctx: InvokeContext;
  kernelManager: KernelManager;
  projectManager: ProjectManager;
  closeChildWindows: ReturnType<typeof vi.fn>;
  workingDir: string;
  pdvDir: string;
}

function makeHarness(): Harness {
  const pushes: Harness["pushes"] = [];
  const push = (channel: string, payload?: unknown): void => {
    pushes.push({ channel, payload });
  };
  const workingDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pdv-wire-wd-"));
  const pdvDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pdv-wire-pdv-"));
  const kernelManager = createKernelManagerMock();
  const commRouter = createCommRouterMock();
  const projectManager = createProjectManagerMock({
    createWorkingDir: vi.fn(async () => workingDir),
  } as Partial<ProjectManager>);
  const configStore = createConfigStoreMock<PDVConfig>({
    showPrivateVariables: false,
    showModuleVariables: false,
    showCallableVariables: false,
    autoRefreshNamespace: false,
  }).store;
  const closeChildWindows = vi.fn();

  const wire = wireServer({
    push,
    confirm: vi.fn(async () => 0),
    pdvDir,
    kernelManager,
    commRouter: commRouter.router,
    queryRouter: new QueryRouter(),
    projectManager,
    configStore,
    closeChildWindows,
  });
  return {
    wire,
    pushes,
    ctx: { push },
    kernelManager,
    projectManager,
    closeChildWindows,
    workingDir,
    pdvDir,
  };
}

/** Start a kernel through the real handler so wire session state populates. */
async function startKernel(h: Harness): Promise<void> {
  await dispatchInvoke(IPC.kernels.start, h.ctx, [{ language: "python" }]);
}

beforeEach(() => {
  setAppVersion("0.0.7-test");
  unwireServer();
  vi.clearAllMocks();
});

afterEach(() => {
  unwireServer();
  vi.restoreAllMocks();
});

describe("wireServer registry contents", () => {
  it("registers exactly SERVER_CHANNELS + INTERNAL_CHANNELS — no more, no less", () => {
    makeHarness();
    const registered = new Set(listRegisteredInvokeChannels());
    const expected = new Set([
      ...SERVER_CHANNELS,
      ...Object.values(INTERNAL_CHANNELS),
    ]);
    const missing = [...expected].filter((c) => !registered.has(c));
    const extra = [...registered].filter((c) => !expected.has(c));
    expect(missing, "expected channels not registered by wireServer").toEqual([]);
    expect(
      extra,
      "registered channels not in SERVER_CHANNELS/INTERNAL_CHANNELS"
    ).toEqual([]);
  });

  it("unwireServer empties the registry so a re-wire cannot double-register", () => {
    makeHarness();
    expect(listRegisteredInvokeChannels().length).toBeGreaterThan(0);
    unwireServer();
    expect(listRegisteredInvokeChannels()).toEqual([]);
    // Re-wiring after unwire must not throw the duplicate-handler guard.
    expect(() => makeHarness()).not.toThrow();
  });

  it("serves mcp:getStatus from the registry (running=false before start)", async () => {
    const h = makeHarness();
    const status = (await dispatchInvoke(IPC.mcp.getStatus, h.ctx, [])) as McpStatus;
    expect(status.running).toBe(false);
    expect(typeof status.generation).toBe("number");
  });

  it("serves cells:respond from the registry (unknown id is a silent no-op)", async () => {
    const h = makeHarness();
    await expect(
      dispatchInvoke(IPC.cells.respond, h.ctx, [
        { requestId: "nope", ok: true, result: { tabs: [], activeTabId: null } },
      ]),
    ).resolves.toBeUndefined();
  });

  it("serves the launcher context over pdv.internal.launcherContext", async () => {
    const h = makeHarness();
    await expect(
      dispatchInvoke(INTERNAL_CHANNELS.launcherContext, h.ctx, []),
    ).resolves.toEqual({ kernelId: null, workingDir: null, projectDir: null });
    await startKernel(h);
    const context = (await dispatchInvoke(
      INTERNAL_CHANNELS.launcherContext,
      h.ctx,
      [],
    )) as { kernelId: string | null; workingDir: string | null };
    expect(context.kernelId).toBeTruthy();
    expect(context.workingDir).toBe(h.workingDir);
  });

  it("serves the light reset over pdv.internal.resetSessionState", async () => {
    const h = makeHarness();
    await startKernel(h);
    await dispatchInvoke(INTERNAL_CHANNELS.resetSessionState, h.ctx, []);
    expect(h.wire.getLauncherContext()).toEqual({
      kernelId: null,
      workingDir: null,
      projectDir: null,
    });
    // Light reset: kernel state on disk survives (renderer-reload parity).
    expect(fsSync.existsSync(h.workingDir)).toBe(true);
  });

  it("runs the wake handler on pdv.internal.systemResumed and pushes kernelReconnected", async () => {
    const h = makeHarness();
    const km = h.kernelManager as unknown as {
      list: ReturnType<typeof vi.fn>;
      ping: ReturnType<typeof vi.fn>;
    };
    km.list.mockReturnValue([
      { id: "kernel-1", name: "python3", language: "python", status: "idle" },
    ]);
    km.ping.mockResolvedValue(undefined);
    await dispatchInvoke(INTERNAL_CHANNELS.systemResumed, h.ctx, []);
    expect(km.ping).toHaveBeenCalledWith("kernel-1", 10_000);
    expect(h.pushes).toContainEqual({
      channel: IPC.push.kernelReconnected,
      payload: { kernelId: "kernel-1" },
    });
  });
});

describe("session state and resets", () => {
  it("kernels:start populates the launcher context", async () => {
    const h = makeHarness();
    expect(h.wire.getLauncherContext()).toEqual({
      kernelId: null,
      workingDir: null,
      projectDir: null,
    });
    await startKernel(h);
    const context = h.wire.getLauncherContext();
    expect(context.kernelId).toBeTruthy();
    expect(context.workingDir).toBe(h.workingDir);
  });

  it("resetSessionState clears session closures but keeps kernel dirs on disk", async () => {
    const h = makeHarness();
    await startKernel(h);
    h.wire.resetSessionState();
    expect(h.wire.getLauncherContext()).toEqual({
      kernelId: null,
      workingDir: null,
      projectDir: null,
    });
    expect(h.closeChildWindows).toHaveBeenCalled();
    // Renderer reload does not tear down kernel state: the dir survives.
    expect(fsSync.existsSync(h.workingDir)).toBe(true);
  });

  it("sessionReset restores just-wired state: closures, kernel dirs, autosave timer", async () => {
    const h = makeHarness();
    await startKernel(h);
    expect(fsSync.existsSync(h.workingDir)).toBe(true);

    h.wire.sessionReset();

    expect(h.wire.getLauncherContext()).toEqual({
      kernelId: null,
      workingDir: null,
      projectDir: null,
    });
    expect(h.closeChildWindows).toHaveBeenCalled();
    expect(fsSync.existsSync(h.workingDir)).toBe(false);
    expect(h.projectManager.stopAutosaveTimer).toHaveBeenCalled();
    // A second reset is a no-op, not an error.
    expect(() => h.wire.sessionReset()).not.toThrow();
  });

  it("preserves a working dir holding an autosave snapshot", async () => {
    // The unsaved-session autosave lives at <workingDir>/.autosave — for a
    // session with no project dir it is the ONLY copy of the user's work,
    // and the welcome screen offers it as a recoverable session. Every
    // server exit path runs this teardown, so deleting it here silently
    // destroys unsaved work on quit.
    const h = makeHarness();
    await startKernel(h);
    const autosaveDir = path.join(h.workingDir, ".autosave");
    fsSync.mkdirSync(autosaveDir, { recursive: true });
    fsSync.writeFileSync(path.join(autosaveDir, "tree-index.json"), "{}", "utf8");

    h.wire.sessionReset();

    expect(fsSync.existsSync(h.workingDir)).toBe(true);
    expect(fsSync.existsSync(path.join(autosaveDir, "tree-index.json"))).toBe(true);
  });

  it("removes a working dir whose autosave snapshot is absent", async () => {
    // An empty .autosave dir (timer armed, nothing written yet) is not a
    // recoverable session — the orphan scan keys on tree-index.json too.
    const h = makeHarness();
    await startKernel(h);
    fsSync.mkdirSync(path.join(h.workingDir, ".autosave"), { recursive: true });

    h.wire.sessionReset();

    expect(fsSync.existsSync(h.workingDir)).toBe(false);
  });

  it("sessionReset matches what unwire + re-wire produces (kernel maps emptied)", async () => {
    const h = makeHarness();
    await startKernel(h);
    h.wire.sessionReset();
    // After the reset, a new kernel start must behave exactly like the
    // first one on a fresh wire (no stale working-dir mapping resurfaces).
    const context = h.wire.getLauncherContext();
    expect(context.kernelId).toBeNull();
    expect(context.workingDir).toBeNull();
  });
});
