/**
 * ipc-registry.test.ts — Unit tests for the self-recording IPC registry.
 *
 * The mock `ipcMain` here reproduces real Electron semantics faithfully —
 * `handle()` THROWS on a duplicate registration (the coverage meta-test's
 * mock silently overwrites, which is exactly how the original
 * REGISTERED_CHANNELS drift bug stayed invisible to tests). The core
 * regression: a full register → removeAll → register cycle must not
 * throw, because that is the macOS close-window → activate → re-create
 * path that used to crash on the 17 channels missing from the
 * hand-maintained list.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => {
  const handlers = new Map<string, unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: unknown) => {
        if (handlers.has(channel)) {
          // Real Electron behavior.
          throw new Error(
            `Attempted to register a second handler for '${channel}'`,
          );
        }
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
});

vi.mock("electron", () => ({ ipcMain: ipcMock.ipcMain }));

import {
  handleIpc,
  listRegisteredIpcChannels,
  removeAllIpcHandlers,
} from "./ipc-registry";

afterEach(() => {
  removeAllIpcHandlers();
  ipcMock.handlers.clear();
  vi.clearAllMocks();
});

describe("handleIpc", () => {
  it("registers with ipcMain and records the channel", () => {
    const handler = vi.fn();
    handleIpc("test:one", handler);
    expect(ipcMock.ipcMain.handle).toHaveBeenCalledWith(
      "test:one",
      expect.any(Function),
    );
    expect(listRegisteredIpcChannels()).toEqual(["test:one"]);
  });

  it("preserves Electron's throw on duplicate registration", () => {
    handleIpc("test:dup", vi.fn());
    expect(() => handleIpc("test:dup", vi.fn())).toThrow(/second handler/);
    // The failed registration must not be double-recorded.
    expect(listRegisteredIpcChannels()).toEqual(["test:dup"]);
  });

  it("passes arguments through and returns the handler's result", async () => {
    handleIpc("test:echo", async (_event, a: number, b: number) => a + b);
    const wrapped = ipcMock.handlers.get("test:echo") as (
      event: unknown,
      ...args: unknown[]
    ) => Promise<unknown>;
    await expect(wrapped({}, 2, 3)).resolves.toBe(5);
  });

  it("logs failures with the channel name and rethrows Error instances as-is", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("kernel exploded");
    handleIpc("test:boom", async () => {
      throw boom;
    });
    const wrapped = ipcMock.handlers.get("test:boom") as (
      event: unknown,
    ) => Promise<unknown>;
    await expect(wrapped({})).rejects.toBe(boom);
    expect(logSpy).toHaveBeenCalledWith("[ipc] test:boom failed:", boom);
    logSpy.mockRestore();
  });

  it("normalizes non-Error throws to Error instances", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    handleIpc("test:string-throw", async () => {
      throw "raw string failure";
    });
    const wrapped = ipcMock.handlers.get("test:string-throw") as (
      event: unknown,
    ) => Promise<unknown>;
    await expect(wrapped({})).rejects.toThrow("raw string failure");
    await expect(wrapped({})).rejects.toBeInstanceOf(Error);
    logSpy.mockRestore();
  });
});

describe("removeAllIpcHandlers", () => {
  it("removes exactly the recorded channels and clears the record", () => {
    handleIpc("test:a", vi.fn());
    handleIpc("test:b", vi.fn());
    removeAllIpcHandlers();
    expect(ipcMock.ipcMain.removeHandler).toHaveBeenCalledWith("test:a");
    expect(ipcMock.ipcMain.removeHandler).toHaveBeenCalledWith("test:b");
    expect(listRegisteredIpcChannels()).toEqual([]);
  });

  it("register → removeAll → register does not throw (macOS reopen regression)", () => {
    // With the hand-maintained channel list, any channel registered but
    // missing from the list survived unregisterIpcHandlers() and threw
    // "second handler" when the window was re-created. With the registry,
    // teardown is derived from the registrations, so the cycle is safe
    // for every channel by construction.
    const channels = ["test:x", "test:y", "test:z"];
    for (const c of channels) handleIpc(c, vi.fn());
    removeAllIpcHandlers();
    expect(() => {
      for (const c of channels) handleIpc(c, vi.fn());
    }).not.toThrow();
    expect(listRegisteredIpcChannels()).toEqual(channels);
  });
});
