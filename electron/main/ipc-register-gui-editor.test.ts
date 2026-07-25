/**
 * ipc-register-gui-editor.test.ts — Unit tests for the GUI editor window
 * IPC handlers (`open` / `openViewer` / `context`).
 *
 * Manifest file I/O (`guiEditor.read`/`save`) is a server concern — see
 * `ipc-register-gui-files.test.ts`.
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
import { registerGuiEditorIpcHandlers } from "./ipc-register-gui-editor";
import {
  createGuiEditorWindowManagerMock,
  createGuiViewerWindowManagerMock,
  type InvokeHandler,
} from "./test-helpers";
import type { GuiEditorWindowManager } from "./gui-editor-window-manager";
import type { GuiViewerWindowManager } from "./gui-viewer-window-manager";

function getHandler(channel: string): InvokeHandler {
  const h = ipcRegistry.handlers.get(channel);
  if (!h) throw new Error(`Channel not registered: ${channel}`);
  return h;
}

interface Harness {
  guiEditorWindowManager: GuiEditorWindowManager;
  guiViewerWindowManager: GuiViewerWindowManager;
}

function setup(overrides: Partial<Harness> = {}): Harness {
  const guiEditorWindowManager =
    overrides.guiEditorWindowManager ?? createGuiEditorWindowManagerMock();
  const guiViewerWindowManager =
    overrides.guiViewerWindowManager ?? createGuiViewerWindowManagerMock();
  registerGuiEditorIpcHandlers({
    guiEditorWindowManager,
    guiViewerWindowManager,
  });
  return { guiEditorWindowManager, guiViewerWindowManager };
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guiEditor:open / openViewer", () => {
  it("returns success:false when open throws", async () => {
    const guiEditorWindowManager = createGuiEditorWindowManagerMock({
      open: vi.fn(async () => {
        throw new Error("can't render");
      }),
    });
    setup({ guiEditorWindowManager });
    const result = await getHandler(IPC.guiEditor.open)({}, {
      treePath: "x",
      kernelId: "k1",
    });
    expect(result).toEqual({ success: false, error: "can't render" });
  });
});

describe("guiEditor:context", () => {
  it("falls back to the viewer manager when editor manager has no match", async () => {
    const editorContext = null;
    const viewerContext = { treePath: "ui.viewer", kernelId: "k1" };
    const guiEditorWindowManager = createGuiEditorWindowManagerMock({
      getContextForSender: vi.fn(() => editorContext),
    });
    const guiViewerWindowManager = createGuiViewerWindowManagerMock({
      getContextForSender: vi.fn(() => viewerContext),
    });
    setup({ guiEditorWindowManager, guiViewerWindowManager });

    const result = await getHandler(IPC.guiEditor.context)({ sender: { id: 7 } });
    expect(result).toBe(viewerContext);
  });
});
