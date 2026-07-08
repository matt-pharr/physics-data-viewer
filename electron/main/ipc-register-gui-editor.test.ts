/**
 * ipc-register-gui-editor.test.ts — Unit tests for GUI editor IPC handlers.
 *
 * Verifies channel registration plus the file-resolution + JSON IO logic in
 * `read` and `save`, both of which delegate path resolution to commRouter.
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

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string, _encoding?: string) => '{"version": 1}'),
  writeFile: vi.fn(async (_path: string, _contents: string, _encoding?: string) => undefined),
}));

// `save` delegates to atomicWriteFile (tmp + rename) so a crash can't
// tear the .gui.json manifest; mock at that seam rather than raw fs.
const atomicWriteMocks = vi.hoisted(() => ({
  atomicWriteFile: vi.fn(async (_path: string, _contents: string | Buffer) => undefined),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
}));

vi.mock("fs/promises", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}));

vi.mock("./atomic-write", () => ({
  atomicWriteFile: atomicWriteMocks.atomicWriteFile,
}));

import { IPC } from "./ipc";
import { registerGuiEditorIpcHandlers } from "./ipc-register-gui-editor";
import {
  createCommRouterMock,
  createGuiEditorWindowManagerMock,
  createGuiViewerWindowManagerMock,
  makeOkResponse,
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
  commRouter: ReturnType<typeof createCommRouterMock>;
}

function setup(overrides: Partial<Harness> = {}): Harness {
  const commRouter = overrides.commRouter ?? createCommRouterMock();
  const guiEditorWindowManager =
    overrides.guiEditorWindowManager ?? createGuiEditorWindowManagerMock();
  const guiViewerWindowManager =
    overrides.guiViewerWindowManager ?? createGuiViewerWindowManagerMock();
  registerGuiEditorIpcHandlers({
    guiEditorWindowManager,
    guiViewerWindowManager,
    commRouter: commRouter.router,
  });
  return { commRouter, guiEditorWindowManager, guiViewerWindowManager };
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
  fsMocks.readFile.mockResolvedValue('{"version": 1}');
  fsMocks.writeFile.mockResolvedValue(undefined);
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

describe("guiEditor:read", () => {
  it("resolves file path via comm and parses JSON", async () => {
    const commRouter = createCommRouterMock();
    commRouter.request.mockResolvedValueOnce(
      makeOkResponse({ file_path: "/tmp/working/ui.gui.json" }),
    );
    fsMocks.readFile.mockResolvedValueOnce('{"version": 2, "name": "main"}');
    setup({ commRouter });

    const result = await getHandler(IPC.guiEditor.read)({}, "ui.dashboard");
    expect(commRouter.request).toHaveBeenCalledWith("pdv.tree.resolve_file", {
      path: "ui.dashboard",
    });
    expect(fsMocks.readFile).toHaveBeenCalledWith("/tmp/working/ui.gui.json", "utf-8");
    expect(result).toEqual({
      success: true,
      manifest: { version: 2, name: "main" },
    });
  });

  it("returns success:false when path resolution returns no file_path", async () => {
    const commRouter = createCommRouterMock();
    commRouter.request.mockResolvedValueOnce(makeOkResponse({}));
    setup({ commRouter });

    const result = (await getHandler(IPC.guiEditor.read)({}, "ui.missing")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to resolve file path/);
  });

  it("returns success:false on JSON parse error", async () => {
    const commRouter = createCommRouterMock();
    commRouter.request.mockResolvedValueOnce(
      makeOkResponse({ file_path: "/tmp/working/ui.gui.json" }),
    );
    fsMocks.readFile.mockResolvedValueOnce("{ not json");
    setup({ commRouter });

    const result = (await getHandler(IPC.guiEditor.read)({}, "ui.dashboard")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("guiEditor:save", () => {
  it("resolves path and writes pretty-printed JSON", async () => {
    const commRouter = createCommRouterMock();
    commRouter.request.mockResolvedValueOnce(
      makeOkResponse({ file_path: "/tmp/working/ui.gui.json" }),
    );
    setup({ commRouter });

    const manifest = { version: 1, widgets: [] };
    const result = await getHandler(IPC.guiEditor.save)({}, {
      treePath: "ui.dashboard",
      kernelId: "k1",
      manifest,
    });

    expect(atomicWriteMocks.atomicWriteFile).toHaveBeenCalledTimes(1);
    const [filePath, contents] = atomicWriteMocks.atomicWriteFile.mock.calls[0];
    expect(filePath).toBe("/tmp/working/ui.gui.json");
    expect(contents).toBe(JSON.stringify(manifest, null, 2) + "\n");
    expect(result).toEqual({ success: true });
  });

  it("surfaces fs write errors as success:false", async () => {
    const commRouter = createCommRouterMock();
    commRouter.request.mockResolvedValueOnce(
      makeOkResponse({ file_path: "/tmp/working/ui.gui.json" }),
    );
    atomicWriteMocks.atomicWriteFile.mockRejectedValueOnce(new Error("EACCES"));
    setup({ commRouter });

    const result = (await getHandler(IPC.guiEditor.save)({}, {
      treePath: "ui.dashboard",
      kernelId: "k1",
      manifest: {},
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/EACCES/);
  });
});
