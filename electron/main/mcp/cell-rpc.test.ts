/**
 * cell-rpc.test.ts — Unit tests for the main-side cell-state RPC client.
 *
 * Verifies the request/response/timeout shape of the renderer round-trip used
 * by the MCP cell tools (ARCHITECTURE.md §15.8) without spinning up a real
 * BrowserWindow — the WebContents `send` is stubbed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const ipcRegistry = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >(),
  handle: vi.fn(
    (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcRegistry.handlers.set(channel, handler);
    },
  ),
  removeHandler: vi.fn((channel: string) => ipcRegistry.handlers.delete(channel)),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.handle,
    removeHandler: ipcRegistry.removeHandler,
  },
}));

import type { BrowserWindow } from "electron";

import { IPC } from "../ipc";
import { CellRpcClient } from "./cell-rpc";

interface FakeWindowState {
  sent: Array<{ channel: string; payload: unknown }>;
  win: BrowserWindow;
}

/** Build a stub BrowserWindow whose `webContents.send` records all calls. */
function makeFakeWindow(): FakeWindowState {
  const sent: FakeWindowState["sent"] = [];
  const win = {
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
  } as unknown as BrowserWindow;
  return { sent, win };
}

/** Synchronously invoke the registered `cells:respond` handler. */
function invokeRespond(payload: unknown): void {
  const handler = ipcRegistry.handlers.get(IPC.cells.respond);
  if (!handler) throw new Error("cells:respond handler not registered");
  handler({}, payload);
}

describe("CellRpcClient", () => {
  afterEach(() => {
    ipcRegistry.handlers.clear();
    vi.clearAllMocks();
  });

  it("registers an `ipcMain.handle` on start and removes it on stop", () => {
    const { win } = makeFakeWindow();
    const client = new CellRpcClient(() => win);
    client.start();
    expect(ipcRegistry.handle).toHaveBeenCalledWith(
      IPC.cells.respond,
      expect.any(Function),
    );
    client.stop();
    expect(ipcRegistry.removeHandler).toHaveBeenCalledWith(IPC.cells.respond);
  });

  it("list() pushes a request and resolves on the matching response", async () => {
    const { sent, win } = makeFakeWindow();
    const client = new CellRpcClient(() => win);
    client.start();

    const promise = client.list();
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(IPC.push.cellsRequest);
    const req = sent[0].payload as { requestId: string; op: string };
    expect(req.op).toBe("list");
    expect(typeof req.requestId).toBe("string");

    invokeRespond({
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
    const { sent, win } = makeFakeWindow();
    const client = new CellRpcClient(() => win);
    client.start();

    const promise = client.read(7);
    const req = sent[0].payload as { requestId: string; op: string; tabId?: number };
    expect(req.op).toBe("read");
    expect(req.tabId).toBe(7);

    invokeRespond({
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
    const { sent, win } = makeFakeWindow();
    const client = new CellRpcClient(() => win);
    client.start();

    const promise = client.read(99);
    const req = sent[0].payload as { requestId: string };
    invokeRespond({ requestId: req.requestId, ok: false, error: "No tab 99" });

    await expect(promise).rejects.toThrow(/No tab 99/);
    client.stop();
  });

  it("write(payload) is one-way (no response awaited)", () => {
    const { sent, win } = makeFakeWindow();
    const client = new CellRpcClient(() => win);
    client.start();
    client.write({ tabId: 2, code: "x = 1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(IPC.push.cellWrite);
    expect(sent[0].payload).toEqual({ tabId: 2, code: "x = 1" });
    client.stop();
  });

  it("rejects late after the configured timeout and does not leak pending state", async () => {
    vi.useFakeTimers();
    try {
      const { win } = makeFakeWindow();
      const client = new CellRpcClient(() => win);
      client.start();
      const promise = client.list();
      promise.catch(() => undefined); // prevent unhandled-rejection during fast-forward
      vi.advanceTimersByTime(11_000);
      await expect(promise).rejects.toThrow(/timed out/);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws synchronously when no renderer window is available", async () => {
    const client = new CellRpcClient(() => null);
    client.start();
    await expect(client.list()).rejects.toThrow(/no renderer window/);
    expect(() => client.write({ tabId: 1, code: "x" })).toThrow(
      /no renderer window/,
    );
    client.stop();
  });
});
