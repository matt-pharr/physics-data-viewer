/**
 * ipc-register-remote-session.test.ts — moving the session onto a host.
 *
 * The swap is the moment remote mode becomes real, and its failure modes are
 * about what the user is left holding. Every test here is written from that
 * angle: after this call, is the user working, and where?
 */

import * as fs from "fs";
import * as net from "net";
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

import { IPC } from "./ipc";
import { removeAllIpcHandlers } from "./ipc-registry";
import { registerRemoteIpcHandlers } from "./ipc-register-remote";
import { RemoteServerHandle } from "./shell/remote-server";

/** Invoke a registered handler the way ipcMain would. */
async function invokeIpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcRegistry.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler({}, ...args);
}
import { SessionHost } from "./server/session-host";
import { resolveSessionPaths, type SessionPaths } from "./server/session-paths";
import type { RemoteConnectionManager } from "./remote/remote-connection";
import { SessionRouter } from "./shell/session-router";
import type { ServerHandle } from "./shell/server-supervisor";

const SESSION = "12345678-1111-2222-3333-444455556666";

let workDir: string;
let paths: SessionPaths;
let host: SessionHost;
let router: SessionRouter;
let localHandle: ServerHandle & { shutdownCalls: number };
const sockets: net.Socket[] = [];

/** A stand-in for the local server the session starts on. */
function makeLocalHandle(): ServerHandle & { shutdownCalls: number } {
  return {
    kind: "local",
    shutdownCalls: 0,
    start: async () => undefined,
    shutdown: async function (this: { shutdownCalls: number }) {
      this.shutdownCalls += 1;
    },
    invoke: async () => undefined,
    sessionReset: async () => undefined,
    setBridgeHandlers: () => undefined,
    clearBridgeHandlers: () => undefined,
  } as ServerHandle & { shutdownCalls: number };
}

/** A connection manager that reports a live, prepared connection. */
function connectedManager(over: Partial<RemoteConnectionManager> = {}): RemoteConnectionManager {
  return {
    control: { host: "testhost", controlPath: "/tmp/ignored.sock" },
    serverCommand: "/opt/pdv/pdv-server",
    listHosts: async () => [],
    connect: async () => ({ ok: true, failure: null, message: "" }),
    respond: () => undefined,
    cancel: () => undefined,
    disconnect: async () => undefined,
    getStatus: () => ({ phase: "connected", host: "testhost", attemptId: null }),
    ...over,
  } as unknown as RemoteConnectionManager;
}

const sendSpy = vi.fn<(channel: string, payload: unknown) => void>();
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: sendSpy },
} as unknown as Parameters<typeof registerRemoteIpcHandlers>[0]["win"];

beforeEach(async () => {
  removeAllIpcHandlers();
  sendSpy.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-swap-"));
  paths = resolveSessionPaths({
    sessionId: SESSION,
    root: path.join(workDir, "root"),
    env: {},
    uid: process.getuid?.() ?? 0,
    tmpDir: workDir,
    hostname: "test-node",
  });
  host = new SessionHost({ paths, sessionId: SESSION, version: "9.9.9-test" });
  await host.listen();
  localHandle = makeLocalHandle();
  router = new SessionRouter(localHandle);
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await host.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  removeAllIpcHandlers();
  vi.restoreAllMocks();
});

/** Register the handlers with a channel factory pointed at the live host. */
function register(over: Partial<Parameters<typeof registerRemoteIpcHandlers>[0]> = {}): void {
  registerRemoteIpcHandlers({
    win: fakeWindow,
    controlDir: path.join(workDir, "ctl"),
    manager: connectedManager(),
    router,
    sessionId: SESSION,
    openChannel: (() => {
      const socket = net.connect(paths.sockPath);
      socket.on("error", () => undefined);
      sockets.push(socket);
      return {
        readable: socket,
        writable: socket,
        child: undefined as never,
        dispose: () => socket.destroy(),
      };
    }) as unknown as Parameters<typeof registerRemoteIpcHandlers>[0]["openChannel"],
    ...over,
  });
}

describe("remote:startSession", () => {
  it("swaps the session onto the host", async () => {
    register();
    const result = await invokeIpc(IPC.remote.startSession);

    expect(result).toMatchObject({ ok: true, sessionId: SESSION });
    expect(router.kind).toBe("remote");
  });

  it("shuts the local server down rather than abandoning it", async () => {
    // It holds a kernel and a working directory on this machine; leaving it
    // running would strand both.
    register();
    await invokeIpc(IPC.remote.startSession);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(localHandle.shutdownCalls).toBe(1);
  });

  it("leaves the local session working when the attach fails", async () => {
    // The failure that matters most: the user must be left with a working
    // session, not with neither.
    register({
      openChannel: (() => {
        const socket = net.connect(path.join(workDir, "nothing-here.sock"));
        socket.on("error", () => undefined);
        sockets.push(socket);
        return {
          readable: socket,
          writable: socket,
          child: undefined as never,
          dispose: () => socket.destroy(),
        };
      }) as never,
    });

    const result = (await invokeIpc(IPC.remote.startSession)) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(router.kind).toBe("local");
    expect(localHandle.shutdownCalls).toBe(0);
  });

  it("refuses when no host is connected", async () => {
    register({
      manager: connectedManager({
        control: null,
        serverCommand: null,
      } as Partial<RemoteConnectionManager>),
    });

    const result = (await invokeIpc(IPC.remote.startSession)) as {
      ok: boolean;
      message: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Connect to a host/);
    expect(router.kind).toBe("local");
  });

  it("refuses a second swap on a window already running remotely", async () => {
    register();
    await invokeIpc(IPC.remote.startSession);
    const second = (await invokeIpc(IPC.remote.startSession)) as {
      ok: boolean;
      message: string;
    };

    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already runs a remote session/);
  });

  it("refuses when the build cannot move sessions", async () => {
    registerRemoteIpcHandlers({
      win: fakeWindow,
      controlDir: path.join(workDir, "ctl"),
      manager: connectedManager(),
    });

    const result = (await invokeIpc(IPC.remote.startSession)) as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});

describe("returning to a local session", () => {
  /** Rebuild the shared daemon with a shutdown spy wired in. */
  async function rebuildHostWithShutdownSpy(): Promise<ReturnType<typeof vi.fn>> {
    const onShutdown = vi.fn();
    await host.close();
    host = new SessionHost({
      paths,
      sessionId: SESSION,
      version: "9.9.9-test",
      onShutdown,
    });
    await host.listen();
    return onShutdown;
  }

  it("endSession swaps onto a fresh local server, then shuts the daemon down", async () => {
    const onShutdown = await rebuildHostWithShutdownSpy();
    const fresh = makeLocalHandle();
    register({ createLocalServer: async () => fresh });
    await invokeIpc(IPC.remote.startSession);
    expect(router.kind).toBe("remote");

    const result = (await invokeIpc(IPC.remote.endSession)) as { ok: boolean };

    expect(result.ok).toBe(true);
    // The window is working locally again...
    expect(router.active).toBe(fresh);
    // ...and the daemon was told to stop (fire-and-forget ack).
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledOnce();
    });
  });

  it("declines endSession when the local server cannot start, keeping the remote session", async () => {
    const onShutdown = await rebuildHostWithShutdownSpy();
    register({
      createLocalServer: async () => {
        throw new Error("spawn failed");
      },
    });
    await invokeIpc(IPC.remote.startSession);

    const result = (await invokeIpc(IPC.remote.endSession)) as {
      ok: boolean;
      message: string;
    };

    // Better a declined action than a window with no server behind it.
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not start a local session/);
    expect(router.kind).toBe("remote");
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it("disconnect while remote returns to local and leaves the daemon running", async () => {
    const onShutdown = await rebuildHostWithShutdownSpy();
    const fresh = makeLocalHandle();
    register({ createLocalServer: async () => fresh });
    await invokeIpc(IPC.remote.startSession);

    await invokeIpc(IPC.remote.disconnect);

    // The window works locally; the session on the host was NOT ended —
    // that is the difference between Disconnect and Shut Down.
    expect(router.active).toBe(fresh);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it("endSession on a local window is declined", async () => {
    register({ createLocalServer: async () => makeLocalHandle() });
    const result = (await invokeIpc(IPC.remote.endSession)) as {
      ok: boolean;
      message: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not running a remote session/);
  });
});

describe("unreachable-session guards and recovery", () => {
  /** The last sessionState payloads the renderer was sent. */
  function sessionStatePushes(): Array<Record<string, unknown>> {
    return sendSpy.mock.calls
      .filter(([channel]) => channel === IPC.push.sessionState)
      .map(([, payload]) => payload as Record<string, unknown>);
  }

  it("declines Shut Down while the session is unreachable", async () => {
    // The shutdown invoke rides the channel; on a dead one it silently
    // does nothing — reporting success would leave the daemon running on
    // a login node while the user believes it ended.
    register({ createLocalServer: async () => makeLocalHandle() });
    await invokeIpc(IPC.remote.startSession);

    // Kill the daemon under the handle and wait until the handle notices.
    await host.close();
    await vi.waitFor(() => {
      const states = sessionStatePushes();
      expect(states.at(-1)?.state).not.toBe("connected");
    });

    const result = (await invokeIpc(IPC.remote.endSession)) as {
      ok: boolean;
      message: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unreachable/);
    expect(router.kind).toBe("remote");
  });

  it("startSession recovers with a fresh handle when the old one cannot reattach", async () => {
    register({ createLocalServer: async () => makeLocalHandle() });
    await invokeIpc(IPC.remote.startSession);

    // A second client supersedes this one: its handle stops chasing the
    // session and can never reattach — yet "reconnect" must still work.
    const paths2 = paths;
    const second = new RemoteServerHandle({
      sessionId: SESSION,
      openChannel: async () => {
        const socket = net.connect(paths2.sockPath);
        socket.on("error", () => undefined);
        sockets.push(socket);
        return { readable: socket, writable: socket, dispose: () => socket.destroy() };
      },
    });
    await second.start();
    await vi.waitFor(() => {
      expect(sessionStatePushes().at(-1)?.state).toBe("disconnected");
    });
    await second.disconnect();

    const result = (await invokeIpc(IPC.remote.startSession)) as { ok: boolean };
    expect(result.ok).toBe(true);
    // The window really is served again: an invoke round-trips.
    await expect(router.invoke("nonexistent:channel")).rejects.toThrow(/No handler/);
  });

  it("a retired handle's farewell never overwrites the local session state", async () => {
    // endSession's swap pushes {local, connected}; the retired handle's own
    // disconnect used to fire a {remote, disconnected} push AFTER it,
    // leaving the renderer showing a lost remote session while the window
    // ran locally.
    register({ createLocalServer: async () => makeLocalHandle() });
    await invokeIpc(IPC.remote.startSession);
    const result = (await invokeIpc(IPC.remote.endSession)) as { ok: boolean };
    expect(result.ok).toBe(true);

    // Give any late callbacks time to land, then check the LAST word.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const states = sessionStatePushes();
    expect(states.at(-1)).toMatchObject({ kind: "local", state: "connected" });
  });
});

describe("setup-script shipping at session start", () => {
  it("ships the script before the swap, with the connection's identity", async () => {
    const routerKindAtShip: string[] = [];
    const ship = vi.fn(
      async (_opts: { host: string; sessionId: string; setupScriptDir: string }) => {
        routerKindAtShip.push(router.kind);
        return { ok: true as const, shipped: true };
      },
    );
    register({
      setupScriptDir: path.join(workDir, "remote-setup"),
      shipScript: ship as unknown as Parameters<typeof registerRemoteIpcHandlers>[0]["shipScript"],
    });

    const result = (await invokeIpc(IPC.remote.startSession)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(ship).toHaveBeenCalledTimes(1);
    expect(ship.mock.calls[0][0]).toMatchObject({
      host: "testhost",
      sessionId: SESSION,
      setupScriptDir: path.join(workDir, "remote-setup"),
    });
    // Shipped BEFORE the daemon attach/swap: a script arriving after
    // --create would silently not apply until the next session.
    expect(routerKindAtShip).toEqual(["local"]);
    expect(router.kind).toBe("remote");
  });

  it("a failed ship declines the start and leaves the local session untouched", async () => {
    const ship = vi.fn(async () => ({
      ok: false as const,
      message: "The setup script for testhost could not be delivered.",
    }));
    register({
      setupScriptDir: path.join(workDir, "remote-setup"),
      shipScript: ship as unknown as Parameters<typeof registerRemoteIpcHandlers>[0]["shipScript"],
    });

    const result = (await invokeIpc(IPC.remote.startSession)) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("setup script");
    expect(router.kind).toBe("local");
    expect(localHandle.shutdownCalls).toBe(0);
  });

  it("skips shipping entirely when no setupScriptDir is configured", async () => {
    const ship = vi.fn(async () => ({ ok: true as const, shipped: true }));
    register({
      shipScript: ship as unknown as Parameters<typeof registerRemoteIpcHandlers>[0]["shipScript"],
    });
    const result = (await invokeIpc(IPC.remote.startSession)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(ship).not.toHaveBeenCalled();
  });
});
