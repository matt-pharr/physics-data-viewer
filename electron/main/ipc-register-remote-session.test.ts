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

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: () => undefined },
} as unknown as Parameters<typeof registerRemoteIpcHandlers>[0]["win"];

beforeEach(async () => {
  removeAllIpcHandlers();
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
