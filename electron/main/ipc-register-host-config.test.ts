/**
 * ipc-register-host-config.test.ts — the Remote Hosts tab's IPC surface.
 *
 * The interesting properties are the pairings: a save must land in BOTH
 * stores (settings file + script file), a load must read them back as one
 * payload, and the dry-run channel must refuse to run anywhere except the
 * host the user is actually connected to — testing a script against the
 * wrong cluster would report another machine's modules as this one's.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
  app: { getVersion: () => "9.9.9-test" },
}));

import type {
  RemoteHostConfigPayload,
  RemoteSetupTestResult,
} from "./ipc";
import { IPC } from "./ipc";
import { registerRemoteIpcHandlers } from "./ipc-register-remote";
import { removeAllIpcHandlers } from "./ipc-registry";
import { RemoteHostStore } from "./remote/host-config";
import type { RemoteConnectionManager } from "./remote/remote-connection";
import type { runSetupScriptTest } from "./remote/setup-script-test";

/** Invoke a registered handler the way ipcMain would. */
async function invokeIpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcRegistry.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler({}, ...args);
}

/** A connection manager fixed in a given phase. */
function managerIn(
  phase: "idle" | "connected",
  host: string | null = null,
): RemoteConnectionManager {
  return {
    control:
      phase === "connected" ? { host, controlPath: "/tmp/ignored.sock" } : null,
    serverCommand: null,
    listHosts: async () => [],
    connect: async () => ({ ok: true, failure: null, message: "" }),
    respond: () => undefined,
    cancel: () => undefined,
    disconnect: async () => undefined,
    getStatus: () => ({ phase, host, attemptId: null }),
  } as unknown as RemoteConnectionManager;
}

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
} as unknown as Parameters<typeof registerRemoteIpcHandlers>[0]["win"];

let workDir: string;
let hostStore: RemoteHostStore;
let setupScriptDir: string;

function register(over: Partial<Parameters<typeof registerRemoteIpcHandlers>[0]> = {}): void {
  registerRemoteIpcHandlers({
    win: fakeWindow,
    controlDir: path.join(workDir, "ctl"),
    manager: managerIn("idle"),
    setupScriptDir,
    hostStore,
    ...over,
  });
}

beforeEach(() => {
  removeAllIpcHandlers();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-hostcfg-ipc-"));
  setupScriptDir = path.join(workDir, "remote-setup");
  hostStore = new RemoteHostStore(workDir);
});

afterEach(() => {
  removeAllIpcHandlers();
  fs.rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("remote:getHostConfig / setHostConfig", () => {
  it("round-trips settings and script through both stores", async () => {
    register();
    await invokeIpc(IPC.remote.setHostConfig, "flux", {
      settings: {
        workingDirBase: "/scratch/local/m",
        launch: { mode: "slurm", account: "proj" },
      },
      setupScript: "module load python\n",
    });

    const payload = (await invokeIpc(
      IPC.remote.getHostConfig,
      "flux",
    )) as RemoteHostConfigPayload;
    expect(payload.settings).toEqual({
      workingDirBase: "/scratch/local/m",
      launch: { mode: "slurm", account: "proj" },
    });
    expect(payload.setupScript).toBe("module load python\n");
    expect(payload.sessionNode).toBeNull();

    // The script really landed as the file the shipping path reads.
    expect(
      fs.readFileSync(path.join(setupScriptDir, "flux.sh"), "utf8"),
    ).toBe("module load python\n");
  });

  it("returns an empty payload for an unconfigured host", async () => {
    register();
    const payload = (await invokeIpc(
      IPC.remote.getHostConfig,
      "nowhere",
    )) as RemoteHostConfigPayload;
    expect(payload).toEqual({ settings: {}, setupScript: "", sessionNode: null });
  });

  it("a blank script removes the master copy", async () => {
    register();
    await invokeIpc(IPC.remote.setHostConfig, "feyn", {
      settings: {},
      setupScript: "module load julia\n",
    });
    expect(fs.existsSync(path.join(setupScriptDir, "feyn.sh"))).toBe(true);

    await invokeIpc(IPC.remote.setHostConfig, "feyn", {
      settings: {},
      setupScript: "   \n",
    });
    expect(fs.existsSync(path.join(setupScriptDir, "feyn.sh"))).toBe(false);
  });

  it("keeps the recorded session node out of the editable settings", async () => {
    register();
    hostStore.setSessionNode("flux", "flux-login1.pppl.gov");
    const payload = (await invokeIpc(
      IPC.remote.getHostConfig,
      "flux",
    )) as RemoteHostConfigPayload;
    expect(payload.sessionNode).toBe("flux-login1.pppl.gov");
    expect(payload.settings).toEqual({});

    // A tab save (which never carries sessionNode) must not clear the pin.
    await invokeIpc(IPC.remote.setHostConfig, "flux", {
      settings: { workingDirBase: "/scratch" },
      setupScript: "",
    });
    expect(hostStore.get("flux").sessionNode).toBe("flux-login1.pppl.gov");
  });

  it("declines a write with no host rather than writing under ''", async () => {
    register();
    await expect(
      invokeIpc(IPC.remote.setHostConfig, "  ", { settings: {}, setupScript: "" }),
    ).rejects.toThrow(/host/i);
  });
});

describe("remote:listConfiguredHosts", () => {
  it("unions the settings store with hand-written script files", async () => {
    register();
    hostStore.setSettings("flux", { workingDirBase: "/scratch" });
    // A host configured the pre-tab way: a script file and nothing else.
    fs.mkdirSync(setupScriptDir, { recursive: true });
    fs.writeFileSync(path.join(setupScriptDir, "feyn.sh"), "module load x\n");

    expect(await invokeIpc(IPC.remote.listConfiguredHosts)).toEqual([
      "feyn",
      "flux",
    ]);
  });

  it("lists a host only once when both surfaces know it", async () => {
    register();
    await invokeIpc(IPC.remote.setHostConfig, "flux", {
      settings: { workingDirBase: "/scratch" },
      setupScript: "module load python\n",
    });
    expect(await invokeIpc(IPC.remote.listConfiguredHosts)).toEqual(["flux"]);
  });
});

describe("remote:testSetupScript", () => {
  it("declines when not connected", async () => {
    register({ manager: managerIn("idle") });
    const result = (await invokeIpc(
      IPC.remote.testSetupScript,
      "flux",
      "module load python\n",
    )) as RemoteSetupTestResult;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Connect to flux first");
  });

  it("declines when connected to a different host", async () => {
    register({ manager: managerIn("connected", "feyn") });
    const result = (await invokeIpc(
      IPC.remote.testSetupScript,
      "flux",
      "module load python\n",
    )) as RemoteSetupTestResult;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Connect to flux first");
  });

  it("runs the candidate content against the connected host", async () => {
    const seen: Array<{ host: string; content: string }> = [];
    const fakeRun: typeof runSetupScriptTest = async (options) => {
      seen.push({ host: options.control.host, content: options.content });
      return { ok: true, exitCode: 0, output: "", before: [], after: [] };
    };
    register({ manager: managerIn("connected", "flux"), runScriptTest: fakeRun });

    const result = (await invokeIpc(
      IPC.remote.testSetupScript,
      "flux",
      "module load python\n",
    )) as RemoteSetupTestResult;
    expect(result.ok).toBe(true);
    // The EDITOR's content, not the saved file — the whole point of Test is
    // trying an edit before committing to it.
    expect(seen).toEqual([{ host: "flux", content: "module load python\n" }]);
  });
});
