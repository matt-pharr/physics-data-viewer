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
      socket.on("error", () => undefined);
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
    it("a stale attach adopts the new epoch's cursor — pushes flow, no resync storm", async () => {
      // The daemon restarted (idle cap, crash): new epoch, seq restarts
      // near zero. Keeping the OLD epoch's high-water cursor made every
      // subsequent push read as a sequence gap — a full resync (with its
      // data-loss console marker) per push, forever, until app restart.
      const staleReasons: string[] = [];
      const pushes: string[] = [];
      handle = makeHandle({
        onStale: (reason) => staleReasons.push(reason),
        reconnectDelaysMs: [],
      });
      handle.setBridgeHandlers({
        onPush: (event) => pushes.push(event),
        confirm: async () => 0,
        closeChildWindows: () => undefined,
      });
      await handle.start();
      // Drive the old epoch's seq well past zero.
      for (let i = 0; i < 5; i++) host.push(`old:${i}`, {});
      await vi.waitFor(() => expect(pushes.length).toBe(5));

      // The daemon dies and is recreated: fresh epoch, fresh journal.
      dropChannel();
      await host.close();
      await vi.waitFor(() => {
        expect(handle!.connectionState).toBe("auth-required");
      });
      host = new SessionHost({ paths, sessionId: SESSION, version: "9.9.9-test" });
      await host.listen();

      await handle.retryNow();
      expect(handle.connectionState).toBe("connected");
      expect(staleReasons).toContain("epoch-mismatch");

      // Live pushes from the new epoch must DELIVER — and not one
      // sequence-gap resync per push.
      staleReasons.length = 0;
      pushes.length = 0;
      host.push("new:0", {});
      host.push("new:1", {});
      await vi.waitFor(() => expect(pushes).toEqual(["new:0", "new:1"]));
      expect(staleReasons).toEqual([]);
    });

    it("a channel that dies mid-attach FAILS the connect instead of hanging it", async () => {
      // The park policy exists for session invokes a reattach reconciles —
      // but this client IS the attach attempt. Parking its own attach left
      // connect() awaiting forever: startSession never resolved, and a
      // reconnect-loop iteration wedged with `reconnecting` stuck true,
      // suppressing every future recovery.
      const disposed: number[] = [];
      handle = makeHandle({
        openChannel: async () => {
          const socket = net.connect(paths.sockPath);
          socket.on("error", () => undefined);
          openSockets.push(socket);
          await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          });
          // The daemon's hello is the first data; kill the channel right
          // after it, so the attach request goes into a dead socket.
          socket.once("data", () => {
            setImmediate(() => socket.destroy());
          });
          return {
            readable: socket,
            writable: socket,
            dispose: () => {
              disposed.push(1);
              socket.destroy();
            },
          };
        },
        reconnectDelaysMs: [],
      });

      await expect(handle.start()).rejects.toThrow(/closed during the attach/);
      // The failure wrapper tore the half-wired channel down: the ssh
      // channel process is not leaked and no stale client lingers.
      expect(disposed.length).toBeGreaterThan(0);
    });

    it("a late close event from a replaced channel does not restart the loop", async () => {
      // Stream close events arrive on later ticks. After a reconnect, the
      // OLD socket's close must not be read as the NEW connection dying —
      // without the identity guards it triggered another loop that tore
      // down the healthy connection.
      let opens = 0;
      const laggards: net.Socket[] = [];
      handle = makeHandle({
        openChannel: async () => {
          opens += 1;
          const socket = net.connect(paths.sockPath);
          socket.on("error", () => undefined);
          openSockets.push(socket);
          laggards.push(socket);
          await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          });
          return { readable: socket, writable: socket, dispose: () => socket.destroy() };
        },
        reconnectDelaysMs: [10],
      });
      await handle.start();
      expect(opens).toBe(1);

      // Kill the first channel; the loop reattaches on the second.
      laggards[0].destroy();
      await vi.waitFor(() => {
        expect(handle!.connectionState).toBe("connected");
        expect(opens).toBe(2);
      });

      // Give any straggling close events from the first socket time to
      // land. A third openChannel call would mean the guards failed.
      await delay(150);
      expect(opens).toBe(2);
      expect(handle.connectionState).toBe("connected");
    });

    it("retryNow while the automatic loop runs neither dials nor lies about state", async () => {
      // Pinning the current contract: retryNow defers to an in-flight
      // reconnect loop (no competing dial), and the caller can see from
      // connectionState that nothing is attached yet. If this behavior is
      // ever made to throw instead, this test should change WITH the
      // registrar's startSession recovery branch.
      let opens = 0;
      let gate: null | (() => void) = null;
      const takeGate = (): (() => void) => {
        const g = gate;
        gate = null;
        if (!g) throw new Error("gate not armed");
        return g;
      };
      handle = makeHandle({
        openChannel: async () => {
          opens += 1;
          // Park the loop's dial until the test releases it.
          await new Promise<void>((resolve) => {
            gate = resolve;
          });
          throw new Error("released only to fail");
        },
        reconnectDelaysMs: [1],
      });
      // Start fails immediately via the gated open (release the first one).
      const started = handle.start();
      await vi.waitFor(() => expect(gate).not.toBeNull());
      takeGate()();
      await expect(started).rejects.toThrow(/released only to fail/);

      // Enter the loop by simulating a lost connection.
      handle["onConnectionLost"]();
      await vi.waitFor(() => expect(gate).not.toBeNull());
      const dialsBefore = opens;

      await handle.retryNow();
      expect(opens).toBe(dialsBefore); // no competing dial
      expect(handle.connectionState).toBe("reconnecting"); // and no false "connected"

      // Unwedge the parked loop dial so the test tears down cleanly.
      if (gate !== null) takeGate()();
      await delay(20);
    });

    it("retryNow recovers a session from auth-required", async () => {
      // The state the automatic backoff deliberately parks in (nobody wants
      // an unasked-for Duo push loop) used to be terminal — any outage
      // longer than the schedule needed an app restart. retryNow is the
      // user-driven way back.
      handleInvoke("tree:list", () => ["alive"]);
      let channelBroken = false;
      const workingOpen = async () => {
        if (channelBroken) throw new Error("ssh: connection refused");
        const socket = net.connect(paths.sockPath);
        socket.on("error", () => undefined);
        openSockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        return { readable: socket, writable: socket, dispose: () => socket.destroy() };
      };
      handle = makeHandle({
        openChannel: workingOpen,
        reconnectDelaysMs: [10],
      });
      await handle.start();

      // The outage outlasts the whole backoff schedule.
      channelBroken = true;
      dropChannel();
      await vi.waitFor(() => {
        expect(handle!.connectionState).toBe("auth-required");
      });

      // A failed retry stays recoverable rather than wedging...
      await expect(handle.retryNow()).rejects.toThrow(/connection refused/);
      expect(handle.connectionState).toBe("auth-required");

      // ...and once the network is back (the user re-authenticated), the
      // same session resumes and serves invokes again.
      channelBroken = false;
      await handle.retryNow();
      expect(handle.connectionState).toBe("connected");
      await expect(handle.invoke("tree:list")).resolves.toEqual(["alive"]);
    });

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
          socket.on("error", () => undefined);
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
