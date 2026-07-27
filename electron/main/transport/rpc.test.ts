/**
 * rpc.test.ts — End-to-end tests of RpcClient ⇄ RpcServer over
 * PassThrough stream pairs (no child process; the wire is real).
 *
 * Covers the transport contract the extracted pdv-server depends on:
 * hello handshake, correlation under interleave, concurrent dispatch,
 * error-shape parity with the in-process invoke path, push seq
 * monotonicity, giant payload round-trip, teardown rejection of pending
 * invokes, ping liveness/timeout, and the reserved-channel behaviors
 * (ping/shutdown/sessionReset, reserved pushes hidden from onPush).
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleInvoke,
  removeAllInvokeHandlers,
  type InvokeContext,
} from "../server/invoke-registry";
import {
  RPC_CHANNELS,
  RPC_PROTOCOL_MIN,
  RPC_PROTOCOL_VERSION,
} from "./protocol";
import { PushJournal } from "./push-journal";
import { RpcClient, type RpcClientOptions } from "./rpc-client";
import { RpcServer, type RpcServerOptions } from "./rpc-server";

/** One connected client/server pair over PassThrough streams. */
interface Pair {
  client: RpcClient;
  server: RpcServer;
  pushes: Array<{ event: string; payload: unknown; seq: number }>;
  reserved: Array<{ event: string; payload: unknown; seq: number }>;
  /** Client → server stream (destroy to simulate a dead connection). */
  c2s: PassThrough;
  /** Server → client stream. */
  s2c: PassThrough;
}

function createPair(
  serverOpts: Partial<RpcServerOptions> = {},
  clientOpts: Partial<RpcClientOptions> = {}
): Pair {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const pushes: Pair["pushes"] = [];
  const reserved: Pair["reserved"] = [];
  const server = new RpcServer(c2s, s2c, {
    version: "9.9.9-test",
    ...serverOpts,
  });
  const client = new RpcClient(s2c, c2s, {
    onPush: (event, payload, seq) => pushes.push({ event, payload, seq }),
    onReservedPush: (event, payload, seq) =>
      reserved.push({ event, payload, seq }),
    ...clientOpts,
  });
  server.start();
  return { client, server, pushes, reserved, c2s, s2c };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record request ids as they go over the wire.
 *
 * Ids are epoch-prefixed and deliberately unguessable from outside, so a
 * test that needs one reads it from the stream rather than assuming a
 * counter — which is also what stops these tests from silently pinning the
 * id format.
 */
function recordRequestIds(c2s: PassThrough): string[] {
  const ids: string[] = [];
  c2s.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id?: string; channel?: string };
        if (msg.id && msg.channel) ids.push(msg.id);
      } catch {
        // Partial frame; the next chunk completes it.
      }
    }
  });
  return ids;
}

describe("RpcClient ⇄ RpcServer", () => {
  beforeEach(() => {
    removeAllInvokeHandlers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    removeAllInvokeHandlers();
    vi.restoreAllMocks();
  });

  it("delivers the hello push unsequenced, with version, pid, and protocol range", async () => {
    const { client, server } = createPair();
    const hello = await client.waitForHello(1000);
    expect(hello).toEqual({
      version: "9.9.9-test",
      pid: process.pid,
      protocol: RPC_PROTOCOL_VERSION,
      protocolMin: RPC_PROTOCOL_MIN,
      session: null,
      sessionEpoch: server.journal.sessionEpoch,
    });
    // Hello is per-connection but seq belongs to the session, so hello must
    // not consume one: the client's cursor stays at −1 until a real push.
    expect(client.lastSeq).toBe(-1);
    expect(server.journal.lastSeq).toBe(-1);
  });

  it("times out waitForHello when no hello arrives", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcClient(s2c, c2s, { onPush: () => undefined });
    await expect(client.waitForHello(30)).rejects.toThrow(
      /hello not received within 30 ms/
    );
    client.close();
  });

  it("rejects a parked waitForHello with the close reason, not the timeout", async () => {
    // A server that dies before saying hello (missing bundle, bad env,
    // throw during wiring) must surface that immediately. Dropping the
    // waiter instead left the caller stalled until the 10 s deadline and
    // then reported a misleading timeout.
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcClient(s2c, c2s, { onPush: () => undefined });
    const parked = client.waitForHello(30_000);
    client.close("pdv-server exited (code 1, signal null)");
    await expect(parked).rejects.toThrow(
      "pdv-server exited (code 1, signal null)"
    );
  });

  it("rejects a parked waitForHello when the server stream ends", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcClient(s2c, c2s, { onPush: () => undefined });
    const parked = client.waitForHello(30_000);
    s2c.end();
    await expect(parked).rejects.toThrow("server stream ended");
  });

  it("correlates interleaved responses and dispatches concurrently", async () => {
    const settled: string[] = [];
    const dispatch = async (channel: string): Promise<unknown> => {
      if (channel === "slow") {
        await delay(40);
        settled.push("slow");
        return "slow-result";
      }
      settled.push("fast");
      return "fast-result";
    };
    const { client } = createPair({ dispatch });

    const slow = client.invoke("slow");
    const fast = client.invoke("fast");
    await expect(fast).resolves.toBe("fast-result");
    // The fast invoke settled while the slow one was still running: a slow
    // handler does not serialize the connection.
    expect(settled).toEqual(["fast"]);
    await expect(slow).resolves.toBe("slow-result");
    expect(settled).toEqual(["fast", "slow"]);
  });

  it("round-trips errors with message, name, and stack intact", async () => {
    const boom = new Error("kernel exploded");
    boom.name = "KernelBoomError";
    const { client } = createPair({
      dispatch: async () => {
        throw boom;
      },
    });
    const rejection = (await client
      .invoke("kernels:start")
      .then(() => {
        throw new Error("invoke unexpectedly resolved");
      })
      .catch((e: unknown) => e)) as Error;
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe("kernel exploded");
    expect(rejection.name).toBe("KernelBoomError");
    expect(rejection.stack).toBe(boom.stack);
  });

  it("serves the real invoke registry, including ctx.push with seq stamping", async () => {
    handleInvoke("test:echo", (_ctx: InvokeContext, value: unknown) => ({
      echoed: value,
    }));
    handleInvoke("test:stream", (ctx: InvokeContext) => {
      ctx.push("push:chunk", { part: 1 });
      ctx.push("push:chunk", { part: 2 });
      return "done";
    });
    const { client, pushes } = createPair();
    await client.waitForHello(1000);

    await expect(client.invoke("test:echo", [{ a: 1 }])).resolves.toEqual({
      echoed: { a: 1 },
    });
    await expect(client.invoke("test:stream")).resolves.toBe("done");
    expect(pushes).toEqual([
      { event: "push:chunk", payload: { part: 1 }, seq: 0 },
      { event: "push:chunk", payload: { part: 2 }, seq: 1 },
    ]);
  });

  it("preserves the renderer-visible unknown-channel error message", async () => {
    const { client } = createPair();
    await expect(client.invoke("no:such:channel")).rejects.toThrow(
      "No handler registered for 'no:such:channel'"
    );
  });

  it("resolves undefined for handlers that return nothing", async () => {
    handleInvoke("test:void", () => undefined);
    const { client } = createPair();
    await expect(client.invoke("test:void")).resolves.toBeUndefined();
  });

  it("stamps pushes with a monotonic seq and reports it via ping", async () => {
    const { client, server, pushes } = createPair();
    await client.waitForHello(1000);
    server.push("push:a", 1);
    server.push("push:b", 2);
    server.push("push:c", 3);
    const ping = (await client.invoke(RPC_CHANNELS.ping)) as {
      ts: number;
      seq: number;
    };
    // The session's first real push is seq 0 — hello no longer consumes it.
    expect(pushes.map((p) => p.seq)).toEqual([0, 1, 2]);
    expect(ping.seq).toBe(2);
    expect(client.lastSeq).toBe(2);
    expect(typeof ping.ts).toBe("number");
  });

  it("round-trips a giant base64-style payload", async () => {
    const blob = "A".repeat(4 * 1024 * 1024);
    const { client } = createPair({
      dispatch: async (_channel, _ctx, args) => args[0],
    });
    const result = (await client.invoke("plots:echo", [{ blob }])) as {
      blob: string;
    };
    expect(result.blob).toHaveLength(blob.length);
    expect(result.blob).toBe(blob);
  }, 20_000);

  it("rejects pending invokes when the server stream ends", async () => {
    const { client, s2c } = createPair({
      dispatch: () => new Promise(() => undefined), // never settles
    });
    await client.waitForHello(1000);
    const pending = client.invoke("kernels:start");
    s2c.end();
    await expect(pending).rejects.toThrow("server stream ended");
    // Once closed, new invokes fail fast.
    await expect(client.invoke("anything")).rejects.toThrow(
      "RPC connection closed"
    );
  });

  it("rejects pending invokes on explicit close and reports the reason", async () => {
    const onClose = vi.fn();
    const { client } = createPair(
      { dispatch: () => new Promise(() => undefined) },
      { onClose }
    );
    const pending = client.invoke("kernels:start");
    client.close("shell shutting down");
    await expect(pending).rejects.toThrow("shell shutting down");
    expect(onClose).toHaveBeenCalledWith("shell shutting down");
    client.close(); // idempotent
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("acks shutdown, then runs the shutdown hook", async () => {
    const order: string[] = [];
    const { client } = createPair({
      onShutdown: () => {
        order.push("hook");
      },
    });
    await client.invoke(RPC_CHANNELS.shutdown);
    order.push("ack");
    await delay(10);
    // The ack reached the client before the hook ran (nextTick beats
    // setImmediate), so a hook that exits the process cannot eat the ack.
    expect(order).toEqual(["ack", "hook"]);
  });

  it("awaits the sessionReset hook before acking", async () => {
    let resetDone = false;
    const { client } = createPair({
      onSessionReset: async () => {
        await delay(20);
        resetDone = true;
      },
    });
    await client.invoke(RPC_CHANNELS.sessionReset);
    expect(resetDone).toBe(true);
  });

  it("hands confirmResponse invokes to onConfirmResponse and acks", async () => {
    const delivered: unknown[] = [];
    const { client } = createPair({
      onConfirmResponse: (payload) => delivered.push(payload),
    });
    await expect(
      client.invoke(RPC_CHANNELS.confirmResponse, [
        { requestId: "7", response: 1 },
      ])
    ).resolves.toBeUndefined();
    expect(delivered).toEqual([{ requestId: "7", response: 1 }]);
  });

  it("routes reserved pushes to onReservedPush, never onPush", async () => {
    const { client, server, pushes, reserved } = createPair();
    await client.waitForHello(1000);
    server.push(RPC_CHANNELS.confirmRequest, { id: 1, message: "sure?" });
    await delay(10);
    expect(pushes).toEqual([]);
    expect(reserved).toEqual([
      {
        event: RPC_CHANNELS.confirmRequest,
        payload: { id: 1, message: "sure?" },
        // Sequenced like any other push: a parked confirm is session state
        // and must survive a reconnect, so it is journalled.
        seq: 0,
      },
    ]);
  });

  describe("session-owned push seq", () => {
    it("continues numbering across connections that share a journal", async () => {
      // The point of the whole design: a session outlives the connection
      // carrying it, so a second connection must not restart at 0 — a client
      // reattaching at seq 1 would otherwise be handed a different push
      // wearing seq 2 and never notice.
      const journal = new PushJournal();

      const first = createPair({ journal });
      await first.client.waitForHello(1000);
      first.server.push("push:a", 1);
      first.server.push("push:b", 2);
      await delay(10);
      expect(first.pushes.map((p) => p.seq)).toEqual([0, 1]);
      first.client.close();

      const second = createPair({ journal });
      await second.client.waitForHello(1000);
      second.server.push("push:c", 3);
      await delay(10);
      expect(second.pushes.map((p) => p.seq)).toEqual([2]);
      second.client.close();
    });

    it("advertises the same session epoch to every connection", async () => {
      const journal = new PushJournal();
      const first = createPair({ journal });
      const second = createPair({ journal });

      const helloA = await first.client.waitForHello(1000);
      const helloB = await second.client.waitForHello(1000);

      expect(helloA.sessionEpoch).toBe(journal.sessionEpoch);
      expect(helloB.sessionEpoch).toBe(journal.sessionEpoch);
      first.client.close();
      second.client.close();
    });

    it("retains pushes for replay, addressed by the client's cursor", async () => {
      const journal = new PushJournal();
      const { client, server } = createPair({ journal });
      await client.waitForHello(1000);
      server.push("push:a", 1);
      server.push("push:b", 2);
      await delay(10);

      // What a client that saw seq 0 and dropped would be sent on reattach.
      const missed = journal.framesSince(client.lastSeq - 1);
      expect(missed).toHaveLength(1);
      expect(JSON.parse(String(missed?.[0])).event).toBe("push:b");
      client.close();
    });

    it("refuses to send a session-state push unsequenced", () => {
      const { client, server } = createPair();
      expect(() =>
        // Cast past the compile-time guard to prove the runtime one holds:
        // the type alone would not stop a channel computed at runtime.
        server.writeUnsequenced(
          RPC_CHANNELS.confirmRequest as never,
          { requestId: "1" },
        ),
      ).toThrow(/only hello\/attachError\/superseded/);
      client.close();
    });

    it("does not let an unsequenced frame rewind the client's cursor", async () => {
      const { client, server, reserved } = createPair();
      await client.waitForHello(1000);
      server.push("push:a", 1);
      server.push("push:b", 2);
      await delay(10);
      expect(client.lastSeq).toBe(1);

      // A supersede notice arrives on a connection that is mid-session. If
      // its seq −1 were recorded, the next reattach would ask to replay the
      // whole session — or be told it cannot be, forcing a needless resync.
      server.writeUnsequenced(RPC_CHANNELS.superseded, { bySameClientId: true });
      await delay(10);

      expect(client.lastSeq).toBe(1);
      expect(reserved.at(-1)?.event).toBe(RPC_CHANNELS.superseded);
      client.close();
    });
  });

  describe("retained settlements", () => {
    it("retains every settlement it writes", async () => {
      const { client, server } = createPair();
      handleInvoke("test:ok", () => ({ done: true }));
      await client.waitForHello(1000);
      await client.invoke("test:ok");

      // The client's id generator is private, but there has been exactly one
      // invoke, so the store holds exactly one settlement.
      expect(server.responses.size).toBe(1);
      client.close();
    });

    it("classifies an id three ways, not two", async () => {
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      handleInvoke("test:slow", async () => {
        await blocked;
        return "finished";
      });
      handleInvoke("test:fast", () => "quick");

      const { client, server, c2s } = createPair();
      const ids = recordRequestIds(c2s);
      await client.waitForHello(1000);

      const slow = client.invoke("test:slow");
      await client.invoke("test:fast");
      await delay(10);

      const [slowId, fastId] = ids;
      expect(server.reconcile(slowId)).toBe("in-flight");
      expect(server.reconcile(fastId)).toBe("completed");
      // Treating this as "not in-flight ⇒ failed" would reject work that
      // actually completed — the failure mode three states exist to avoid.
      expect(server.reconcile("never-issued")).toBe("unknown");

      release?.();
      await expect(slow).resolves.toBe("finished");
      expect(server.reconcile(slowId)).toBe("completed");
      client.close();
    });

    it("retains a settlement produced after the connection dropped", async () => {
      // The whole reason the store exists: a script that finishes while the
      // laptop is asleep has still really run.
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      handleInvoke("test:slow", async () => {
        await blocked;
        return { rows: 3 };
      });

      const { client, server, s2c, c2s } = createPair();
      const ids = recordRequestIds(c2s);
      await client.waitForHello(1000);
      const pending = client.invoke("test:slow");
      await delay(10);

      // Kill the connection out from under the running handler.
      s2c.destroy();
      client.close("connection dropped");
      await expect(pending).rejects.toThrow(/connection dropped/);

      release?.();
      await delay(20);

      const [slowId] = ids;
      expect(server.reconcile(slowId)).toBe("completed");
      expect(JSON.parse(String(server.responses.get(slowId)?.frame))).toEqual({
        id: slowId,
        result: { rows: 3 },
      });
    });
  });

  describe("ping liveness (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("declares the server unresponsive after maxMisses unanswered pings", async () => {
      const onUnresponsive = vi.fn();
      // No server on the other end: pings are never answered.
      const c2s = new PassThrough();
      const s2c = new PassThrough();
      const client = new RpcClient(s2c, c2s, {
        onPush: () => undefined,
        onUnresponsive,
        pingIntervalMs: 100,
        pingMaxMisses: 3,
      });
      client.startPing();
      // Ticks at 100/200/300 send pings 1–3; the tick at 400 sees three
      // outstanding and declares unresponsiveness.
      await vi.advanceTimersByTimeAsync(350);
      expect(onUnresponsive).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(onUnresponsive).toHaveBeenCalledOnce();
      // Pinging stopped: no re-declaration on further ticks.
      await vi.advanceTimersByTimeAsync(1000);
      expect(onUnresponsive).toHaveBeenCalledOnce();
      client.close();
    });

    it("stays healthy while the server answers pings", async () => {
      const onUnresponsive = vi.fn();
      const { client } = createPair(
        {},
        { onUnresponsive, pingIntervalMs: 100, pingMaxMisses: 3 }
      );
      client.startPing();
      await vi.advanceTimersByTimeAsync(2000);
      expect(onUnresponsive).not.toHaveBeenCalled();
      client.close();
    });
  });
});
