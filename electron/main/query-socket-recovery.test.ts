/**
 * query-socket-recovery.test.ts — Query socket recovers after a timeout.
 *
 * Regression coverage for the query-channel wedge: a ZMQ REQ socket
 * enforces a strict send → receive alternation, so after one timed-out
 * ``receive()`` the outstanding request left every subsequent ``send()``
 * failing — one slow query permanently degraded tree/namespace queries
 * to the comm-router fallback until the Jupyter server was restarted.
 * ``sendQueryRequest`` now replaces the socket after a failure.
 *
 * Uses real ZeroMQ sockets (no Python subprocess, unlike the @slow
 * kernel-manager suites): the test binds a ROUTER peer that deliberately
 * ignores the first request (forcing the client timeout) and answers
 * later ones — which only ever reach it if the wedged socket was
 * replaced.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as zmq from "zeromq";
import { KernelManager } from "./kernel-manager";

/** Minimal slice of ManagedKernel that the query path touches. */
interface FakeManaged {
  querySocket: zmq.Request;
  queryQueue: Promise<unknown>;
  shuttingDown: boolean;
  connectionInfo: { transport: string; ip: string; query_port: number };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* already closed */
    }
  }
});

/** Bind a ROUTER that ignores the first request and echoes an ok-reply to the rest. */
async function startRouterPeer(): Promise<{ port: number }> {
  const router = new zmq.Router();
  await router.bind("tcp://127.0.0.1:0");
  cleanups.push(() => router.close());
  const endpoint = router.lastEndpoint;
  if (!endpoint) throw new Error("router did not report its endpoint");
  const port = Number(endpoint.split(":").pop());

  void (async () => {
    let n = 0;
    try {
      for await (const frames of router) {
        n += 1;
        if (n === 1) continue; // stall: never answer the first request
        const [identity, delimiter] = frames;
        await router.send([
          identity,
          delimiter,
          Buffer.from(JSON.stringify({ ok: true, request: n })),
        ]);
      }
    } catch {
      /* router closed at test teardown */
    }
  })();

  return { port };
}

/** Wire a KernelManager with a forged managed entry pointing at `port`. */
function makeManagerWithQuerySocket(port: number): {
  manager: KernelManager;
  managed: FakeManaged;
} {
  const manager = new KernelManager();
  const querySocket = new zmq.Request();
  querySocket.linger = 0;
  // Short timeout so the wedge-inducing first request fails fast in-test.
  (querySocket as unknown as { receiveTimeout: number }).receiveTimeout = 300;
  querySocket.connect(`tcp://127.0.0.1:${port}`);
  cleanups.push(() => querySocket.close());

  const managed: FakeManaged = {
    querySocket,
    queryQueue: Promise.resolve(),
    shuttingDown: false,
    connectionInfo: { transport: "tcp", ip: "127.0.0.1", query_port: port },
  };
  (manager as unknown as { kernels: Map<string, FakeManaged> }).kernels.set(
    "q1",
    managed,
  );
  cleanups.push(() => managed.querySocket.close());
  return { manager, managed };
}

describe("query socket recovery", () => {
  it("demonstrates the wedge: a raw REQ socket cannot send again after a timeout", async () => {
    const { port } = await startRouterPeer();
    const req = new zmq.Request();
    req.linger = 0;
    (req as unknown as { receiveTimeout: number; sendTimeout: number }).receiveTimeout = 300;
    (req as unknown as { receiveTimeout: number; sendTimeout: number }).sendTimeout = 300;
    req.connect(`tcp://127.0.0.1:${port}`);
    cleanups.push(() => req.close());

    await req.send("first");
    await expect(req.receive()).rejects.toThrow(); // times out
    // The REQ state machine still has the first request outstanding.
    await expect(req.send("second")).rejects.toThrow();
  });

  it("sendQueryRequest recovers after a timeout by replacing the socket (regression)", async () => {
    const { port } = await startRouterPeer();
    const { manager, managed } = makeManagerWithQuerySocket(port);
    const originalSocket = managed.querySocket;

    // First query: the peer stalls, so this rejects on the receive timeout.
    await expect(
      manager.sendQueryRequest("q1", { type: "ping", seq: 1 }),
    ).rejects.toThrow();

    // The wedged socket must have been swapped for a fresh one...
    expect(managed.querySocket).not.toBe(originalSocket);

    // ...and the next query must go through end-to-end. Without the
    // replacement, this send() fails immediately (see the wedge test).
    const reply = await manager.sendQueryRequest("q1", { type: "ping", seq: 2 });
    expect(reply).toMatchObject({ ok: true });
  });

  it("does not replace the socket while the kernel is shutting down", async () => {
    const { port } = await startRouterPeer();
    const { manager, managed } = makeManagerWithQuerySocket(port);
    managed.shuttingDown = true;
    const originalSocket = managed.querySocket;

    await expect(
      manager.sendQueryRequest("q1", { type: "ping", seq: 1 }),
    ).rejects.toThrow();
    expect(managed.querySocket).toBe(originalSocket);
  });
});
