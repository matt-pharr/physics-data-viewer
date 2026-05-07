/**
 * ipc-register-module-windows.test.ts — Unit tests for module-window IPC.
 *
 * Verifies that registerModuleWindowIpcHandlers wires every channel in
 * IPC.moduleWindows.* and that executeInMain enforces sender authorization
 * before forwarding code to the main window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcRegistry = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcHandle = vi.fn(
    (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  );
  const ipcRemoveHandler = vi.fn((channel: string) => handlers.delete(channel));
  return { handlers, ipcHandle, ipcRemoveHandler };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
}));

import { IPC } from "./ipc";
import { registerModuleWindowIpcHandlers } from "./ipc-register-module-windows";
import {
  createBrowserWindowMock,
  createModuleWindowManagerMock,
  type InvokeHandler,
} from "./test-helpers";
import type { BrowserWindow } from "electron";
import type { ModuleWindowManager } from "./module-window-manager";

function getHandler(channel: string): InvokeHandler {
  const h = ipcRegistry.handlers.get(channel);
  if (!h) throw new Error(`Channel not registered: ${channel}`);
  return h;
}

interface Harness {
  win: BrowserWindow;
  webContentsSend: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  moduleWindowManager: ModuleWindowManager;
}

function setup(): Harness {
  const { win, webContentsSend, isDestroyed } = createBrowserWindowMock();
  const moduleWindowManager = createModuleWindowManagerMock();
  registerModuleWindowIpcHandlers({ moduleWindowManager, mainWindow: win });
  return { win, webContentsSend, isDestroyed, moduleWindowManager };
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("moduleWindows:open", () => {
  it("returns success:false when the manager throws", async () => {
    const moduleWindowManager = createModuleWindowManagerMock({
      open: vi.fn(async () => {
        throw new Error("module not loaded");
      }),
    });
    const { win } = createBrowserWindowMock();
    registerModuleWindowIpcHandlers({ moduleWindowManager, mainWindow: win });
    const result = await getHandler(IPC.moduleWindows.open)({}, {
      alias: "demo",
      kernelId: "k1",
    });
    expect(result).toEqual({ success: false, error: "module not loaded" });
  });
});

describe("moduleWindows:context", () => {
  it("looks up sender by webContents id", async () => {
    const ctx = { alias: "demo", kernelId: "k1", title: "Demo Window" };
    const moduleWindowManager = createModuleWindowManagerMock({
      getContextForSender: vi.fn(() => ctx),
    });
    const { win } = createBrowserWindowMock();
    registerModuleWindowIpcHandlers({ moduleWindowManager, mainWindow: win });
    const handler = getHandler(IPC.moduleWindows.context);
    const result = await handler({ sender: { id: 42 } });
    expect(moduleWindowManager.getContextForSender).toHaveBeenCalledWith(42);
    expect(result).toBe(ctx);
  });
});

describe("moduleWindows:executeInMain", () => {
  it("forwards code to main window when sender is a known module window", async () => {
    const ctx = { alias: "demo", kernelId: "k1", title: "Demo Window" };
    const moduleWindowManager = createModuleWindowManagerMock({
      getContextForSender: vi.fn(() => ctx),
    });
    const { win, webContentsSend, isDestroyed } = createBrowserWindowMock();
    isDestroyed.mockReturnValue(false);
    registerModuleWindowIpcHandlers({ moduleWindowManager, mainWindow: win });

    await getHandler(IPC.moduleWindows.executeInMain)(
      { sender: { id: 42 } },
      "print('hi')",
    );

    expect(webContentsSend).toHaveBeenCalledWith(
      IPC.push.moduleExecuteRequest,
      "print('hi')",
    );
  });

  it("rejects unknown senders to prevent untrusted code execution", async () => {
    const moduleWindowManager = createModuleWindowManagerMock({
      getContextForSender: vi.fn(() => null),
    });
    const { win, webContentsSend } = createBrowserWindowMock();
    registerModuleWindowIpcHandlers({ moduleWindowManager, mainWindow: win });

    await expect(
      getHandler(IPC.moduleWindows.executeInMain)(
        { sender: { id: 999 } },
        "print('attack')",
      ),
    ).rejects.toThrow(/Unauthorized/);
    expect(webContentsSend).not.toHaveBeenCalled();
  });

  it("does not send to main window when it has been destroyed", async () => {
    const ctx = { alias: "demo", kernelId: "k1", title: "Demo Window" };
    const moduleWindowManager = createModuleWindowManagerMock({
      getContextForSender: vi.fn(() => ctx),
    });
    const { win, webContentsSend, isDestroyed } = createBrowserWindowMock();
    isDestroyed.mockReturnValue(true);
    registerModuleWindowIpcHandlers({ moduleWindowManager, mainWindow: win });

    await getHandler(IPC.moduleWindows.executeInMain)(
      { sender: { id: 1 } },
      "print('skipped')",
    );
    expect(webContentsSend).not.toHaveBeenCalled();
  });
});
