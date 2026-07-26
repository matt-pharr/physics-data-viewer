/**
 * rpc-client-reconnect.test.ts — the client-side pieces a survivable
 * connection needs: parked invokes, a seeded cursor, live gap detection,
 * and request ids that cannot collide across attaches.
 *
 * Every option here is defaulted off, so the first test pins that local mode
 * keeps today's behaviour — the rest of this file describes the remote path
 * only.
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RpcClient, type RpcClientOptions } from "./rpc-client";
import { RpcServer } from "./rpc-server";

function createPair(clientOpts: Partial<RpcClientOptions> = {}): {
  client: RpcClient;
  server: RpcServer;
  c2s: PassThrough;
  s2c: PassThrough;
} {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const server = new RpcServer(c2s, s2c, {
    version: "9.9.9-test",
    dispatch: async () => new Promise(() => undefined), // never settles
  });
  const client = new RpcClient(s2c, c2s, {
    onPush: () => undefined,
    ...clientOpts,
  });
  server.start();
  return { client, server, c2s, s2c };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("pending policy", () => {
  it("rejects in-flight invokes by default (local mode is unchanged)", async () => {
    const { client } = createPair();
    const pending = client.invoke("slow:thing");
    client.close("server stream ended");

    await expect(pending).rejects.toThrow("server stream ended");
  });

  it("parks in-flight invokes when asked, rather than failing them", async () => {
    // A script.run that was running when the channel dropped is still
    // running on the daemon. Rejecting it would report completed work as
    // failed — the whole reason remote mode needs this policy.
    const { client } = createPair({ pendingPolicy: "park" });
    const pending = client.invoke("script:run");
    await delay(10);
    client.close("connection dropped");

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await delay(20);

    expect(settled).toBe(false);
    expect(client.parkedIds).toHaveLength(1);
  });

  it("resolves a parked invoke from the session's retained result", async () => {
    const { client } = createPair({ pendingPolicy: "park" });
    const pending = client.invoke("script:run");
    await delay(10);
    client.close("connection dropped");

    const [id] = client.parkedIds;
    expect(client.settleParked(id, { rows: 3 })).toBe(true);
    await expect(pending).resolves.toEqual({ rows: 3 });
    expect(client.parkedIds).toEqual([]);
  });

  it("fails a parked invoke the session could not account for", async () => {
    const { client } = createPair({ pendingPolicy: "park" });
    const pending = client.invoke("project:save");
    await delay(10);
    client.close("connection dropped");

    const [id] = client.parkedIds;
    client.rejectParkedId(id, new Error("result unknown — check the Tree"));
    await expect(pending).rejects.toThrow(/check the Tree/);
  });

  it("settles every parked invoke loudly when the reconnect is given up", async () => {
    // Leaving them parked forever hangs the renderer on a spinner with no
    // error and no way back.
    const { client } = createPair({ pendingPolicy: "park" });
    const a = client.invoke("a:one");
    const b = client.invoke("b:two");
    await delay(10);
    client.close("connection dropped");

    expect(client.rejectParked(new Error("could not reconnect"))).toBe(2);
    await expect(a).rejects.toThrow("could not reconnect");
    await expect(b).rejects.toThrow("could not reconnect");
  });

  it("reports parked ids for the attach handshake", async () => {
    const { client } = createPair({ pendingPolicy: "park" });
    client.invoke("a:one");
    client.invoke("b:two");
    await delay(10);
    client.close("dropped");

    expect(client.parkedIds).toHaveLength(2);
  });
});

describe("request ids", () => {
  it("cannot collide across connections", async () => {
    // Ids are per-connection monotonic integers that restart at 1, so
    // without a per-connection prefix a parked id from the old connection
    // would collide with a fresh one and settle the wrong promise.
    const first = createPair({ pendingPolicy: "park" });
    first.client.invoke("a:one");
    await delay(10);
    first.client.close("dropped");

    const second = createPair({ pendingPolicy: "park" });
    second.client.invoke("a:one");
    await delay(10);
    second.client.close("dropped");

    expect(first.client.parkedIds[0]).not.toBe(second.client.parkedIds[0]);
  });
});

describe("sequence tracking", () => {
  it("starts at −1 with no seed", () => {
    const { client } = createPair();
    expect(client.lastSeq).toBe(-1);
    client.close();
  });

  it("resumes from a seeded cursor across a reconnect", () => {
    const { client } = createPair({ initialLastSeq: 41 });
    expect(client.lastSeq).toBe(41);
    client.close();
  });

  it("reports a gap on the very next frame", async () => {
    const gaps: Array<{ expected: number; received: number }> = [];
    const { client, server } = createPair({
      initialLastSeq: 4,
      onSequenceGap: (expected, received) => gaps.push({ expected, received }),
    });
    await delay(10);

    // The replay handshake is meant to make this unreachable; if it happens
    // the client must notice immediately rather than drift.
    server.journal.append("push:a", {});
    server.push("push:b", {});
    await delay(20);

    expect(gaps[0]).toEqual({ expected: 5, received: 1 });
    client.close();
  });

  it("stays silent when frames are contiguous", async () => {
    const gaps: number[] = [];
    const { client, server } = createPair({
      onSequenceGap: (expected) => gaps.push(expected),
    });
    await delay(10);

    server.push("push:a", {});
    server.push("push:b", {});
    server.push("push:c", {});
    await delay(20);

    expect(gaps).toEqual([]);
    client.close();
  });

  it("ignores unsequenced frames entirely", async () => {
    const gaps: number[] = [];
    const { client, server } = createPair({
      initialLastSeq: 7,
      onSequenceGap: (expected) => gaps.push(expected),
      onReservedPush: () => undefined,
    });
    await delay(10);

    // hello already arrived unsequenced; a supersede notice is another.
    server.writeUnsequenced("pdv.rpc.superseded", { bySameClientId: true });
    await delay(20);

    expect(gaps).toEqual([]);
    expect(client.lastSeq).toBe(7);
    client.close();
  });
});
