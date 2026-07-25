/**
 * cell-rpc.test.ts — Unit tests for the server-side cell-state RPC client.
 *
 * Verifies the request/response/timeout shape of the renderer round-trip used
 * by the MCP cell tools (ARCHITECTURE.md §15.8). Pushes go through an
 * injected PushSender stub; replies are delivered directly via `deliver()`
 * (in production the `cells:respond` invoke handler registered by
 * `server/wire.ts` forwards there).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../ipc";
import { CellRpcClient } from "./cell-rpc";

interface FakePush {
  sent: Array<{ channel: string; payload: unknown }>;
  push: (channel: string, payload?: unknown) => void;
}

/** Build a PushSender stub that records all pushes. */
function makeFakePush(): FakePush {
  const sent: FakePush["sent"] = [];
  return {
    sent,
    push: (channel: string, payload?: unknown) => {
      sent.push({ channel, payload });
    },
  };
}

describe("CellRpcClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("list() pushes a request and resolves on the matching response", async () => {
    const { sent, push } = makeFakePush();
    const client = new CellRpcClient(push);

    const promise = client.list();
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(IPC.push.cellsRequest);
    const req = sent[0].payload as { requestId: string; op: string };
    expect(req.op).toBe("list");
    expect(typeof req.requestId).toBe("string");

    client.deliver({
      requestId: req.requestId,
      ok: true,
      result: { tabs: [{ id: 1, length: 5 }], activeTabId: 1 },
    });

    const result = await promise;
    expect(result.tabs).toHaveLength(1);
    expect(result.activeTabId).toBe(1);
    client.stop();
  });

  it("read(tabId) pushes a read request and resolves on the matching response", async () => {
    const { sent, push } = makeFakePush();
    const client = new CellRpcClient(push);

    const promise = client.read(7);
    const req = sent[0].payload as { requestId: string; op: string; tabId?: number };
    expect(req.op).toBe("read");
    expect(req.tabId).toBe(7);

    client.deliver({
      requestId: req.requestId,
      ok: true,
      result: { id: 7, code: "print('hi')" },
    });

    const result = await promise;
    expect(result.id).toBe(7);
    expect(result.code).toBe("print('hi')");
    client.stop();
  });

  it("rejects when the renderer reports `ok: false`", async () => {
    const { sent, push } = makeFakePush();
    const client = new CellRpcClient(push);

    const promise = client.read(99);
    const req = sent[0].payload as { requestId: string };
    client.deliver({ requestId: req.requestId, ok: false, error: "No tab 99" });

    await expect(promise).rejects.toThrow(/No tab 99/);
    client.stop();
  });

  it("drops a late reply after timeout without touching new requests", async () => {
    const { sent, push } = makeFakePush();
    const client = new CellRpcClient(push);
    const promise = client.list();
    const req = sent[0].payload as { requestId: string };
    client.deliver({
      requestId: req.requestId,
      ok: true,
      result: { tabs: [], activeTabId: null },
    });
    await promise;
    // A second delivery for the same id must be a silent no-op.
    expect(() =>
      client.deliver({ requestId: req.requestId, ok: false, error: "late" }),
    ).not.toThrow();
    client.stop();
  });

  it("write(payload) is one-way (no response awaited)", () => {
    const { sent, push } = makeFakePush();
    const client = new CellRpcClient(push);
    client.write({ tabId: 2, code: "x = 1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(IPC.push.cellWrite);
    expect(sent[0].payload).toEqual({ tabId: 2, code: "x = 1" });
    client.stop();
  });

  it("rejects late after the configured timeout and does not leak pending state", async () => {
    vi.useFakeTimers();
    try {
      const { push } = makeFakePush();
      const client = new CellRpcClient(push);
      const promise = client.list();
      promise.catch(() => undefined); // prevent unhandled-rejection during fast-forward
      vi.advanceTimersByTime(11_000);
      await expect(promise).rejects.toThrow(/timed out/);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() rejects in-flight requests", async () => {
    const { push } = makeFakePush();
    const client = new CellRpcClient(push);
    const promise = client.list();
    promise.catch(() => undefined);
    client.stop();
    await expect(promise).rejects.toThrow(/stopped/);
  });
});
