/**
 * app-quit.test.ts — what quitting does to the session's server.
 *
 * One branch, two very different outcomes: a LOCAL server is shut down
 * (its kernel dies with this machine anyway), a REMOTE session is only
 * disconnected — the daemon and its kernel surviving Cmd+Q is the entire
 * remote-mode promise, and the daemon now honors shutdown invokes, so
 * getting this branch wrong gracefully kills a 20-hour cluster run.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/pdv-test"),
    getVersion: vi.fn(() => "0.0.0-test"),
    isPackaged: false,
    on: vi.fn(),
    exit: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {},
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
  dialog: {},
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { closingForQuit } from "./app";
import { RemoteServerHandle } from "./shell/remote-server";
import { SessionRouter } from "./shell/session-router";
import type { ServerHandle } from "./shell/server-supervisor";

function makeLocalHandle(): ServerHandle & { shutdownCalls: number } {
  const handle = {
    kind: "local" as const,
    shutdownCalls: 0,
    start: async () => undefined,
    shutdown: async function (this: { shutdownCalls: number }) {
      this.shutdownCalls += 1;
    },
    invoke: async () => undefined,
    sessionReset: async () => undefined,
    setBridgeHandlers: () => undefined,
    clearBridgeHandlers: () => undefined,
  };
  return handle as ServerHandle & { shutdownCalls: number };
}

describe("closingForQuit", () => {
  it("disconnects — never shuts down — a remote session behind the router", async () => {
    const remote = new RemoteServerHandle({
      sessionId: "s",
      openChannel: async () => {
        throw new Error("not needed");
      },
    });
    const shutdownSpy = vi.spyOn(remote, "shutdown");
    const disconnectSpy = vi.spyOn(remote, "disconnect");
    const router = new SessionRouter(remote);

    await closingForQuit(router);

    expect(disconnectSpy).toHaveBeenCalledOnce();
    expect(shutdownSpy).not.toHaveBeenCalled();
  });

  it("shuts a local server down, behind the router and bare", async () => {
    const behindRouter = makeLocalHandle();
    await closingForQuit(new SessionRouter(behindRouter));
    expect(behindRouter.shutdownCalls).toBe(1);

    const bare = makeLocalHandle();
    await closingForQuit(bare);
    expect(bare.shutdownCalls).toBe(1);
  });
});
