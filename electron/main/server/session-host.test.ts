/**
 * session-host.test.ts — attach, replay and supersede over real Unix sockets.
 *
 * Real sockets rather than PassThrough pairs: the point of the daemon is
 * that it survives connections closing, and a stream pair cannot express a
 * client going away and a new one arriving on the same endpoint. No ssh and
 * no daemonization are involved — those are the caller's job.
 */

import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RPC_CHANNELS, RPC_PROTOCOL_VERSION } from "../transport/protocol";
import { RpcClient } from "../transport/rpc-client";
import type { RpcAttachRequest, RpcAttachResult } from "../transport/protocol";
import { SessionHost } from "./session-host";
import { resolveSessionPaths, type SessionPaths } from "./session-paths";

const SESSION = "11112222-3333-4444-5555-666677778888";
const VERSION = "9.9.9-test";

let workDir: string;
let paths: SessionPaths;
let host: SessionHost;
const clients: RpcClient[] = [];
const sockets: net.Socket[] = [];

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-host-"));
  paths = resolveSessionPaths({
    sessionId: SESSION,
    root: path.join(workDir, "root"),
    env: {},
    uid: process.getuid?.() ?? 0,
    tmpDir: workDir,
    hostname: "test-node",
  });
  host = new SessionHost({ paths, sessionId: SESSION, version: VERSION });
  await host.listen();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of sockets.splice(0)) s.destroy();
  await host.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Connect a client to the session socket. */
function connect(): {
  client: RpcClient;
  pushes: Array<{ event: string; seq: number }>;
  reserved: Array<{ event: string; payload: unknown }>;
} {
  const socket = net.connect(paths.sockPath);
  sockets.push(socket);
  const pushes: Array<{ event: string; seq: number }> = [];
  const reserved: Array<{ event: string; payload: unknown }> = [];
  const client = new RpcClient(socket, socket, {
    onPush: (event, _payload, seq) => pushes.push({ event, seq }),
    onReservedPush: (event, payload) => reserved.push({ event, payload }),
  });
  clients.push(client);
  return { client, pushes, reserved };
}

/** Send an attach invoke with sensible defaults. */
async function attach(
  client: RpcClient,
  over: Partial<RpcAttachRequest> = {},
): Promise<RpcAttachResult> {
  return (await client.invoke(RPC_CHANNELS.attach, [
    {
      sessionEpoch: null,
      lastSeq: -1,
      pendingRequests: [],
      protocol: RPC_PROTOCOL_VERSION,
      ...over,
    },
  ])) as RpcAttachResult;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionHost", () => {
  it("serves a session id and epoch in the hello", async () => {
    const { client } = connect();
    const hello = await client.waitForHello(2000);

    expect(hello.session).toBe(SESSION);
    expect(hello.sessionEpoch).toBe(host.journal.sessionEpoch);
  });

  it("creates the socket private to the user", () => {
    expect(fs.statSync(paths.sockPath).mode & 0o077).toBe(0);
  });

  it("tells a cold client to resync", async () => {
    const { client } = connect();
    await client.waitForHello(2000);

    const result = await attach(client);
    expect(result.status).toBe("stale");
    if (result.status !== "stale") return;
    expect(result.reason).toBe("no-cursor");
  });

  describe("push gating", () => {
    it("withholds pushes until the client attaches, then replays them", async () => {
      const { client, pushes } = connect();
      await client.waitForHello(2000);

      // A kernel streaming output in the window between hello and attach.
      host.journal.append("push:early", { n: 1 });
      await delay(20);
      expect(pushes).toEqual([]);

      const result = await attach(client, {
        sessionEpoch: host.journal.sessionEpoch,
        lastSeq: -1,
      });
      await delay(20);

      expect(result.status).toBe("ok");
      // Delivered exactly once, at its real seq — not renumbered, not lost.
      expect(pushes).toEqual([{ event: "push:early", seq: 0 }]);
    });

    it("delivers live pushes through the attached connection", async () => {
      const { client, pushes } = connect();
      await client.waitForHello(2000);
      await attach(client, { sessionEpoch: host.journal.sessionEpoch });
      await delay(20);

      host.push("push:live", { n: 7 });
      await delay(30);

      expect(pushes).toEqual([{ event: "push:live", seq: 0 }]);
    });

    it("journals a push that happens while nobody is attached", async () => {
      // The kernel is still running with the laptop shut. Dropping its
      // output because the socket is empty would lose exactly the work this
      // daemon exists to protect.
      host.push("push:offline", { n: 1 });
      expect(host.journal.lastSeq).toBe(0);

      const { client, pushes } = connect();
      await client.waitForHello(2000);
      await attach(client, {
        sessionEpoch: host.journal.sessionEpoch,
        lastSeq: -1,
      });
      await delay(30);

      expect(pushes).toEqual([{ event: "push:offline", seq: 0 }]);
    });

    it("drops a connection that never attaches", async () => {
      const shortHost = new SessionHost({
        paths: { ...paths, sockPath: path.join(workDir, "short.sock") },
        sessionId: SESSION,
        version: VERSION,
        attachDeadlineMs: 60,
      });
      await shortHost.listen();
      const socket = net.connect(path.join(workDir, "short.sock"));
      sockets.push(socket);

      await delay(200);
      expect(shortHost.connectionCount).toBe(0);
      await shortHost.close();
    });
  });

  describe("reattach", () => {
    it("replays exactly what a reconnecting client missed", async () => {
      const first = connect();
      await first.client.waitForHello(2000);
      await attach(first.client, { sessionEpoch: host.journal.sessionEpoch });
      await delay(20);

      host.journal.append("push:a", {});
      const seenUpTo = host.journal.lastSeq;
      first.client.close();
      sockets.pop()?.destroy();
      await delay(20);

      // Work continues on the daemon while nobody is listening.
      host.journal.append("push:b", {});
      host.journal.append("push:c", {});

      const second = connect();
      await second.client.waitForHello(2000);
      const result = await attach(second.client, {
        sessionEpoch: host.journal.sessionEpoch,
        lastSeq: seenUpTo,
      });
      await delay(30);

      expect(result.status).toBe("ok");
      expect(second.pushes.map((p) => p.event)).toEqual(["push:b", "push:c"]);
    });

    it("keeps numbering across connections", async () => {
      const first = connect();
      await first.client.waitForHello(2000);
      await attach(first.client, { sessionEpoch: host.journal.sessionEpoch });
      host.journal.append("push:a", {});
      first.client.close();
      await delay(20);

      const second = connect();
      const hello = await second.client.waitForHello(2000);
      // Same session, same epoch — the daemon did not restart.
      expect(hello.sessionEpoch).toBe(host.journal.sessionEpoch);
      host.journal.append("push:b", {});
      expect(host.journal.lastSeq).toBe(1);
    });
  });

  describe("supersede", () => {
    it("displaces the older connection when a newer one attaches", async () => {
      const first = connect();
      await first.client.waitForHello(2000);
      await attach(first.client, { sessionEpoch: host.journal.sessionEpoch });
      await delay(20);

      const second = connect();
      await second.client.waitForHello(2000);
      await attach(second.client, { sessionEpoch: host.journal.sessionEpoch });
      await delay(50);

      const notice = first.reserved.find(
        (r) => r.event === RPC_CHANNELS.superseded,
      );
      expect(notice).toBeDefined();
      // Carries who displaced it: an auto-reconnect against a *different*
      // client would ping-pong the session between two laptops forever.
      expect(notice?.payload).toMatchObject({ bySameClientId: false });
    });

    it("closes the displaced connection after the notice", async () => {
      const first = connect();
      await first.client.waitForHello(2000);
      await attach(first.client, { sessionEpoch: host.journal.sessionEpoch });
      await delay(20);

      const second = connect();
      await second.client.waitForHello(2000);
      await attach(second.client, { sessionEpoch: host.journal.sessionEpoch });
      await delay(400);

      expect(host.connectionCount).toBe(1);
    });
  });

  it("survives its last client leaving", async () => {
    const { client } = connect();
    await client.waitForHello(2000);
    await attach(client, { sessionEpoch: host.journal.sessionEpoch });
    host.journal.append("push:a", {});
    client.close();
    sockets.pop()?.destroy();
    await delay(30);

    // The daemon and its state are still here — that is the whole point.
    expect(host.connectionCount).toBe(0);
    expect(host.journal.lastSeq).toBe(0);
    expect(fs.existsSync(paths.sockPath)).toBe(true);
  });
});
