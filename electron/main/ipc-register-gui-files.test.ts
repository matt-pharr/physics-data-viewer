/**
 * ipc-register-gui-files.test.ts — Unit tests for the GUI manifest file
 * I/O handlers (`guiEditor.read` / `guiEditor.save`).
 *
 * Drives the real invoke registry; path resolution is verified against a
 * comm-router mock and writes against the atomic-write seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string, _encoding?: string) => '{"version": 1}'),
  writeFile: vi.fn(async (_path: string, _contents: string, _encoding?: string) => undefined),
}));

// `save` delegates to atomicWriteFile (tmp + rename) so a crash can't
// tear the .gui.json manifest; mock at that seam rather than raw fs.
const atomicWriteMocks = vi.hoisted(() => ({
  atomicWriteFile: vi.fn(async (_path: string, _contents: string | Buffer) => undefined),
}));

vi.mock("fs/promises", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}));

vi.mock("./atomic-write", () => ({
  atomicWriteFile: atomicWriteMocks.atomicWriteFile,
}));

import { IPC } from "./ipc";
import { registerGuiFilesIpcHandlers } from "./ipc-register-gui-files";
import {
  createCommRouterMock,
  getInvokeHandler,
  makeOkResponse,
  resetInvokeRegistry,
} from "./test-helpers";

function setup(commRouter: ReturnType<typeof createCommRouterMock>): void {
  registerGuiFilesIpcHandlers({ commRouter: commRouter.router });
}

beforeEach(() => {
  resetInvokeRegistry();
  vi.clearAllMocks();
  fsMocks.readFile.mockResolvedValue('{"version": 1}');
  fsMocks.writeFile.mockResolvedValue(undefined);
});

afterEach(() => {
  resetInvokeRegistry();
  vi.restoreAllMocks();
});

describe("guiEditor:read", () => {
  it("resolves file path via comm and parses JSON", async () => {
    const commRouter = createCommRouterMock();
    commRouter.request.mockResolvedValueOnce(
      makeOkResponse({ file_path: "/tmp/working/ui.gui.json" }),
    );
    fsMocks.readFile.mockResolvedValueOnce('{"version": 2, "name": "main"}');
    setup(commRouter);

    const result = await getInvokeHandler(IPC.guiEditor.read)({}, "ui.dashboard");
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
    setup(commRouter);

    const result = (await getInvokeHandler(IPC.guiEditor.read)({}, "ui.missing")) as {
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
    setup(commRouter);

    const result = (await getInvokeHandler(IPC.guiEditor.read)({}, "ui.dashboard")) as {
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
    setup(commRouter);

    const manifest = { version: 1, widgets: [] };
    const result = await getInvokeHandler(IPC.guiEditor.save)({}, {
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
    setup(commRouter);

    const result = (await getInvokeHandler(IPC.guiEditor.save)({}, {
      treePath: "ui.dashboard",
      kernelId: "k1",
      manifest: {},
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/EACCES/);
  });
});
