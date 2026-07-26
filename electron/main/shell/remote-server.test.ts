/**
 * remote-server.test.ts — the remote handle against a real session daemon.
 *
 * The channel is a real Unix socket to a real `SessionHost`, so a "drop" is
 * an actual destroyed socket and a reconnect is an actual new attach. The
 * behaviour under test — work surviving a connection, and a mutation whose
 * fate is unknown being reported as such — cannot be observed against a
 * mocked transport, because the mock is exactly what decides the answer.
 */

import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleInvoke, removeAllInvokeHandlers } from "../server/invoke-registry";
import { RPC_CHANNELS } from "../transport/protocol";
import { SessionHost } from "../server/session-host";
import { resolveSessionPaths, type SessionPaths } from "../server/session-paths";
import { RemoteServerHandle, RpcRequestLostError } from "./remote-server";

const SESSION = "99998888-7777-6666-5555-444433332222";

let workDir: string;
let paths: SessionPaths;
let host: SessionHost;
let handle: RemoteServerHandle | null = null;
const openSockets: net.Socket[] = [];

beforeEach(async () => {
  removeAllInvokeHandlers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-remote-"));
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
});

afterEach(async () => {
  await handle?.disconnect();
  handle = null;
  for (const s of openSockets.splice(0)) s.destroy();
  await host.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  removeAllInvokeHandlers();
  vi.restoreAllMocks();
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Build a handle whose channel is a socket to the live session host. */
function makeHandle(
  over: Partial<ConstructorParameters<typeof RemoteServerHandle>[0]> = {},
): RemoteServerHandle {
  return new RemoteServerHandle({
    sessionId: SESSION,
    openChannel: async () => {
      const socket = net.connect(paths.sockPath);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return { readable: socket, writable: socket, dispose: () => socket.destroy() };
    },
    reconnectDelaysMs: [20, 20, 20],
    ...over,
  });
}

/** Drop the handle's current channel, as a dead ssh channel would. */
function dropChannel(): void {
  for (const s of openSockets) s.destroy();
}

describe("RemoteServerHandle", () => {
  it("attaches and reports itself as remote", async () => {
    handle = makeHandle();
    await handle.start();

    expect(handle.kind).toBe("remote");
    expect(handle.connectionState).toBe("connected");
  });

  it("serves invokes through the session", async () => {
    handleInvoke("tree:list", () => [{ name: "alpha" }]);
    handle = makeHandle();
    await handle.start();

    await expect(handle.invoke("tree:list")).resolves.toEqual([
      { name: "alpha" },
    ]);
  });

  it("forwards pushes to the bridge", async () => {
    const pushes: Array<{ event: string; payload: unknown }> = [];
    handle = makeHandle();
    handle.setBridgeHandlers({
      onPush: (event, payload) => pushes.push({ event, payload }),
      confirm: async () => 0,
      closeChildWindows: () => undefined,
    });
    await handle.start();

    host.push("push:kernel", { status: "busy" });
    await delay(50);

    expect(pushes).toEqual([
      { event: "push:kernel", payload: { status: "busy" } },
    ]);
  });

  describe("reconnect", () => {
    it("reattaches after the channel dies and replays what was missed", async () => {
      const pushes: string[] = [];
      handle = makeHandle();
      handle.setBridgeHandlers({
        onPush: (event) => pushes.push(event),
        confirm: async () => 0,
        closeChildWindows: () => undefined,
      });
      await handle.start();

      host.push("push:before", {});
      await delay(50);
      expect(pushes).toEqual(["push:before"]);

      dropChannel();
      await delay(30);
      // Work continues on the daemon with nobody watching.
      host.push("push:during-1", {});
      host.push("push:during-2", {});

      await delay(300);

      expect(handle.connectionState).toBe("connected");
      // Delivered exactly once each, in order, with nothing repeated.
      expect(pushes).toEqual(["push:before", "push:during-1", "push:during-2"]);
    });

    it("keeps a slow invoke alive across a drop", async () => {
      // The case the whole design exists for: a script that finishes while
      // the laptop is shut must still resolve, not fail.
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      handleInvoke("script:run", async () => {
        await blocked;
        return { rows: 7 };
      });

      handle = makeHandle();
      await handle.start();
      const running = handle.invoke("script:run");
      await delay(30);

      dropChannel();
      await delay(30);
      release?.();
      await delay(300);

      await expect(running).resolves.toEqual({ rows: 7 });
    });
  });

  describe("unknown outcomes", () => {
    it("reports a lost mutation distinguishably instead of retrying it", async () => {
      // Re-issuing a mutation whose fate is unknown could run the same
      // script twice against one kernel, both writing to the Tree. The
      // renderer needs to be able to say "check the Tree".
      handleInvoke("project:save", () => new Promise(() => undefined));
      handle = makeHandle({ reconnectDelaysMs: [], parkedTtlMs: 0 });
      await handle.start();

      const pending = handle.invoke("project:save");
      await delay(20);
      dropChannel();

      await expect(pending).rejects.toBeInstanceOf(RpcRequestLostError);
      await expect(pending).rejects.toThrow(/check the Tree/i);
    });

    it("names the channel whose outcome is unknown", async () => {
      handleInvoke("kernels:restart", () => new Promise(() => undefined));
      handle = makeHandle({ reconnectDelaysMs: [], parkedTtlMs: 0 });
      await handle.start();

      const pending = handle.invoke("kernels:restart");
      await delay(20);
      dropChannel();

      const err = (await pending.catch((e: unknown) => e)) as RpcRequestLostError;
      expect(err.channel).toBe("kernels:restart");
    });
  });

  describe("supersede", () => {
    it("stops chasing a session another client took over", async () => {
      const states: string[] = [];
      handle = makeHandle({ onState: (s) => states.push(s) });
      await handle.start();

      // A second client attaches and displaces the first.
      const second = makeHandle();
      await second.start();
      await delay(300);

      expect(handle.connectionState).toBe("disconnected");
      // Never went into a reconnect loop: two laptops chasing one session
      // would ping-pong it forever.
      expect(states).not.toContain("reconnecting");
      await second.disconnect();
    });
  });

  describe("lifecycle", () => {
    it("disconnect leaves the session running", async () => {
      handle = makeHandle();
      await handle.start();
      await handle.disconnect();

      expect(handle.connectionState).toBe("disconnected");
      // The daemon is still there — this is "close the laptop".
      expect(fs.existsSync(paths.sockPath)).toBe(true);
    });

    it("rejects invokes once disconnected", async () => {
      handle = makeHandle();
      await handle.start();
      await handle.disconnect();

      await expect(handle.invoke("tree:list")).rejects.toThrow(/not connected/);
    });

    it("answers a native confirm and replies to the session", async () => {
      // A confirm nobody answers blocks the handler awaiting it for the
      // life of the session, so the reply must always be sent — including
      // when there is no window and the dialog's own cancel choice stands in.
      const replies: unknown[] = [];
      const confirmHost = new SessionHost({
        paths: { ...paths, sockPath: path.join(workDir, "confirm.sock") },
        sessionId: SESSION,
        version: "9.9.9-test",
        onConfirmResponse: (payload) => replies.push(payload),
      });
      await confirmHost.listen();

      handle = new RemoteServerHandle({
        sessionId: SESSION,
        openChannel: async () => {
          const socket = net.connect(path.join(workDir, "confirm.sock"));
          openSockets.push(socket);
          await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          });
          return {
            readable: socket,
            writable: socket,
            dispose: () => socket.destroy(),
          };
        },
      });
      handle.setBridgeHandlers({
        onPush: () => undefined,
        confirm: async () => 1,
        closeChildWindows: () => undefined,
      });
      await handle.start();

      confirmHost.push(RPC_CHANNELS.confirmRequest, {
        requestId: "c1",
        options: { message: "Overwrite?", buttons: ["Cancel", "OK"], cancelId: 0 },
      });
      await delay(120);

      expect(replies).toEqual([{ requestId: "c1", response: 1 }]);
      await handle.disconnect();
      handle = null;
      await confirmHost.close();
    });
  });
});
