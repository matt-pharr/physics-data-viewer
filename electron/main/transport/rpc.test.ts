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
import { RPC_CHANNELS, RPC_PROTOCOL_VERSION } from "./protocol";
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

describe("RpcClient ⇄ RpcServer", () => {
  beforeEach(() => {
    removeAllInvokeHandlers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    removeAllInvokeHandlers();
    vi.restoreAllMocks();
  });

  it("delivers the hello push (seq 0) with version, pid, and protocol", async () => {
    const { client } = createPair();
    const hello = await client.waitForHello(1000);
    expect(hello).toEqual({
      version: "9.9.9-test",
      pid: process.pid,
      protocol: RPC_PROTOCOL_VERSION,
      session: null,
    });
    // Hello is reserved: it must not reach the renderer-push callback.
    expect(client.lastSeq).toBe(0);
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
      { event: "push:chunk", payload: { part: 1 }, seq: 1 },
      { event: "push:chunk", payload: { part: 2 }, seq: 2 },
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
    expect(pushes.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(ping.seq).toBe(3);
    expect(client.lastSeq).toBe(3);
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
        seq: 1,
      },
    ]);
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
