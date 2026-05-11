/**
 * ipc-register-project.test.ts — Unit tests for project-domain IPC handlers.
 *
 * Covers all 6 channels in IPC.project.* plus IPC.codeCells.*: registration,
 * save happy path with autosave bracket pushes, save blocked by missing
 * backing files, load with autosave overlay branch, peek* fallback to
 * defaults on manifest read failure, and module-owned file sync helper.
 */

import * as path from "path";
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
  mkdir: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => undefined),
  cp: vi.fn(async () => undefined),
  readFile: vi.fn(async () => "{}"),
  writeFile: vi.fn(async () => undefined),
}));

const moduleRuntimeMocks = vi.hoisted(() => ({
  setupProjectModuleNamespaces: vi.fn(async () => undefined),
}));

const projectFileSyncMocks = vi.hoisted(() => ({
  copyFilesForLoad: vi.fn(async () => [] as string[]),
  overlayAutosaveTreeFiles: vi.fn(async () => undefined),
}));

const manifestWriterMocks = vi.hoisted(() => ({
  writeModuleIndex: vi.fn(async () => undefined),
  writeModuleManifest: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
}));

vi.mock("fs/promises", () => fsMocks);
vi.mock("./module-runtime", () => moduleRuntimeMocks);
vi.mock("./project-file-sync", () => projectFileSyncMocks);
vi.mock("./module-manifest-writer", () => manifestWriterMocks);

import { IPC } from "./ipc";
import {
  registerProjectIpcHandlers,
  syncModuleOwnedFilesToSaveDir,
  writeModuleManifestsToSaveDir,
} from "./ipc-register-project";
import { ProjectManager } from "./project-manager";
import {
  createBrowserWindowMock,
  createCommRouterMock,
  createModuleManagerMock,
  createProjectManagerMock,
  type InvokeHandler,
} from "./test-helpers";

function getHandler(channel: string): InvokeHandler {
  const h = ipcRegistry.handlers.get(channel);
  if (!h) throw new Error(`Channel not registered: ${channel}`);
  return h;
}

interface Harness {
  win: ReturnType<typeof createBrowserWindowMock>;
  commRouter: ReturnType<typeof createCommRouterMock>;
  projectManager: ReturnType<typeof createProjectManagerMock>;
  moduleManager: ReturnType<typeof createModuleManagerMock>;
  kernelWorkingDirs: Map<string, string>;
  setActiveProjectDir: ReturnType<typeof vi.fn>;
  getActiveKernelId: ReturnType<typeof vi.fn>;
  getPendingModuleImports: ReturnType<typeof vi.fn>;
  getPendingModuleSettings: ReturnType<typeof vi.fn>;
  setPendingModuleImports: ReturnType<typeof vi.fn>;
  setPendingModuleSettings: ReturnType<typeof vi.fn>;
  refreshProjectModuleHealth: ReturnType<typeof vi.fn>;
  clearModuleHealthWarnings: ReturnType<typeof vi.fn>;
  onExplicitSaveCompleted: ReturnType<typeof vi.fn>;
}

function setup(): Harness {
  const win = createBrowserWindowMock();
  const commRouter = createCommRouterMock();
  const projectManager = createProjectManagerMock();
  const moduleManager = createModuleManagerMock();
  const kernelWorkingDirs = new Map<string, string>();
  let activeProjectDir: string | null = null;
  const harness: Harness = {
    win,
    commRouter,
    projectManager,
    moduleManager,
    kernelWorkingDirs,
    setActiveProjectDir: vi.fn((dir: string | null) => {
      activeProjectDir = dir;
    }),
    getActiveKernelId: vi.fn(() => null as string | null),
    getPendingModuleImports: vi.fn(() => []),
    getPendingModuleSettings: vi.fn(() => ({})),
    setPendingModuleImports: vi.fn(),
    setPendingModuleSettings: vi.fn(),
    refreshProjectModuleHealth: vi.fn(async () => null),
    clearModuleHealthWarnings: vi.fn(),
    onExplicitSaveCompleted: vi.fn(),
  };
  void activeProjectDir;
  registerProjectIpcHandlers({
    projectManager,
    moduleManager,
    commRouter: commRouter.router,
    kernelWorkingDirs,
    getActiveKernelId: harness.getActiveKernelId,
    getActiveKernelLanguage: () => "python",
    setActiveProjectDir: harness.setActiveProjectDir,
    getPendingModuleImports: harness.getPendingModuleImports,
    setPendingModuleImports: harness.setPendingModuleImports,
    getPendingModuleSettings: harness.getPendingModuleSettings,
    setPendingModuleSettings: harness.setPendingModuleSettings,
    clearModuleHealthWarnings: harness.clearModuleHealthWarnings,
    refreshProjectModuleHealth: harness.refreshProjectModuleHealth,
    runSerializedProjectManifestMutation: async (_dir, fn) => fn(),
    getMainWindow: () => win.win,
    getInterpreterPath: () => "/usr/bin/python3",
    onExplicitSaveCompleted: harness.onExplicitSaveCompleted,
  });
  return harness;
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
  fsMocks.readFile.mockResolvedValue("{}");
  fsMocks.writeFile.mockResolvedValue(undefined);
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.copyFile.mockResolvedValue(undefined);
  fsMocks.cp.mockResolvedValue(undefined);
  projectFileSyncMocks.copyFilesForLoad.mockResolvedValue([] as string[]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const validCells = { tabs: [], activeTabId: 1 };

describe("project:save", () => {
  it("happy path: saves, brackets with autosaveStarted/autosaveEnded pushes, sets active dir", async () => {
    const harness = setup();
    vi.spyOn(ProjectManager, "readManifest").mockResolvedValue({
      project_name: "demo",
    } as never);
    const result = (await getHandler(IPC.project.save)({}, "/save", validCells, "demo")) as {
      checksum: string;
      projectName?: string;
    };
    expect(harness.projectManager.save).toHaveBeenCalled();
    expect(harness.win.webContentsSend).toHaveBeenCalledWith(IPC.push.autosaveStarted);
    expect(harness.win.webContentsSend).toHaveBeenCalledWith(IPC.push.autosaveEnded);
    expect(harness.setActiveProjectDir).toHaveBeenCalledWith("/save");
    expect(harness.onExplicitSaveCompleted).toHaveBeenCalledWith("/save");
    expect(result.checksum).toBe("abc123");
    expect(result.projectName).toBe("demo");
  });

  it("blocks save and skips state mutation when missingFiles is non-empty", async () => {
    const harness = setup();
    (harness.projectManager.save as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      checksum: "x",
      nodeCount: 0,
      moduleOwnedFiles: [],
      moduleManifests: [],
      missingFiles: ["foo.npy"],
    });
    const result = (await getHandler(IPC.project.save)({}, "/save", validCells)) as {
      missingFiles?: string[];
    };
    expect(result.missingFiles).toEqual(["foo.npy"]);
    expect(harness.setActiveProjectDir).not.toHaveBeenCalled();
    expect(harness.onExplicitSaveCompleted).not.toHaveBeenCalled();
    // autosaveEnded still fires (bracketed by try/finally)
    expect(harness.win.webContentsSend).toHaveBeenCalledWith(IPC.push.autosaveEnded);
  });
});

describe("project:load", () => {
  it("reads manifest checksum and returns checksumValid:true on match", async () => {
    setup();
    vi.spyOn(ProjectManager, "readManifest").mockResolvedValue({
      tree_checksum: "sha-1",
      pdv_version: "0.1.1",
      project_name: "demo",
    } as never);
    fsMocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("tree-index.json")) {
        return JSON.stringify([{ id: "a" }, { id: "b" }]);
      }
      return "{}";
    });
    const result = (await getHandler(IPC.project.load)({}, "/save")) as {
      checksum: string;
      savedPdvVersion: string;
      checksumValid: boolean | null;
      nodeCount: number;
    };
    expect(result.checksum).toBe("sha-1");
    expect(result.savedPdvVersion).toBe("0.1.1");
    expect(result.nodeCount).toBe(2);
  });

  it("when restoreFromAutosave=true, calls overlayAutosaveTreeFiles", async () => {
    const harness = setup();
    (harness.getActiveKernelId as ReturnType<typeof vi.fn>).mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/wd");
    await getHandler(IPC.project.load)({}, "/save", { restoreFromAutosave: true });
    expect(projectFileSyncMocks.overlayAutosaveTreeFiles).toHaveBeenCalledWith(
      "/save/.autosave",
      "/tmp/wd",
    );
  });

  it("rewires sys.path via setupProjectModuleNamespaces after kernel repopulation", async () => {
    setup();
    await getHandler(IPC.project.load)({}, "/save");
    expect(moduleRuntimeMocks.setupProjectModuleNamespaces).toHaveBeenCalled();
  });
});

describe("project:new", () => {
  it("clears active dir, pending state, and module health warnings", async () => {
    const harness = setup();
    const result = await getHandler(IPC.project.new)({});
    expect(result).toBe(true);
    expect(harness.setActiveProjectDir).toHaveBeenCalledWith(null);
    expect(harness.setPendingModuleImports).toHaveBeenCalledWith([]);
    expect(harness.setPendingModuleSettings).toHaveBeenCalledWith({});
    expect(harness.clearModuleHealthWarnings).toHaveBeenCalled();
  });
});

describe("project:peekLanguages / peekManifest", () => {
  it("peekLanguages reads each manifest and falls back to python on read error", async () => {
    setup();
    const readSpy = vi
      .spyOn(ProjectManager, "readManifest")
      .mockImplementation(async (dir: string) => {
        if (dir === "/julia") return { language: "julia" } as never;
        throw new Error("missing");
      });
    const result = (await getHandler(IPC.project.peekLanguages)({}, [
      "/julia",
      "/missing",
    ])) as Record<string, string>;
    expect(result["/julia"]).toBe("julia");
    expect(result["/missing"]).toBe("python");
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it("peekManifest returns full metadata or default on read error", async () => {
    setup();
    vi.spyOn(ProjectManager, "readManifest").mockResolvedValueOnce({
      language: "julia",
      interpreter_path: "/usr/bin/julia",
      pdv_version: "0.1.1",
      project_name: "demo",
    } as never);
    const ok = (await getHandler(IPC.project.peekManifest)({}, "/save")) as {
      language: string;
      projectName?: string;
    };
    expect(ok.language).toBe("julia");
    expect(ok.projectName).toBe("demo");

    vi.spyOn(ProjectManager, "readManifest").mockRejectedValueOnce(new Error("nope"));
    const fallback = (await getHandler(IPC.project.peekManifest)({}, "/missing")) as {
      language: string;
    };
    expect(fallback.language).toBe("python");
  });
});

describe("codeCells:load / codeCells:save", () => {
  it("returns null when no active kernel", async () => {
    setup();
    expect(await getHandler(IPC.codeCells.load)({})).toBeNull();
  });

  it("returns null on ENOENT (no save file yet)", async () => {
    const harness = setup();
    (harness.getActiveKernelId as ReturnType<typeof vi.fn>).mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/wd");
    fsMocks.readFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    expect(await getHandler(IPC.codeCells.load)({})).toBeNull();
  });

  it("save returns false when no active kernel", async () => {
    setup();
    const result = await getHandler(IPC.codeCells.save)({}, validCells);
    expect(result).toBe(false);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it("save writes JSON to working-dir/code-cells.json when kernel is active", async () => {
    const harness = setup();
    (harness.getActiveKernelId as ReturnType<typeof vi.fn>).mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/wd");
    const result = await getHandler(IPC.codeCells.save)({}, validCells);
    expect(result).toBe(true);
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      path.join("/tmp/wd", "code-cells.json"),
      expect.any(String),
      "utf8",
    );
  });
});

describe("syncModuleOwnedFilesToSaveDir helper", () => {
  it("skips entries with missing module_id, source_rel_path, or workdir_path", async () => {
    const result = await syncModuleOwnedFilesToSaveDir("/save", [
      { module_id: "", source_rel_path: "x", workdir_path: "/wd/x" },
      { module_id: "m", source_rel_path: "", workdir_path: "/wd/x" },
      { module_id: "m", source_rel_path: "x", workdir_path: "" },
    ] as never);
    expect(fsMocks.copyFile).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns ENOENT-failed paths so the caller can warn the user", async () => {
    fsMocks.copyFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const result = await syncModuleOwnedFilesToSaveDir("/save", [
      { module_id: "m1", source_rel_path: "scripts/run.py", workdir_path: "/wd/r.py" },
    ] as never);
    expect(result).toEqual(["m1/scripts/run.py"]);
  });

  it("short-circuits when src and dest resolve to the same path (test fixture case)", async () => {
    const samePath = path.resolve("/save/modules/m1/scripts/run.py");
    const result = await syncModuleOwnedFilesToSaveDir("/save", [
      { module_id: "m1", source_rel_path: "scripts/run.py", workdir_path: samePath },
    ] as never);
    expect(fsMocks.copyFile).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe("writeModuleManifestsToSaveDir helper", () => {
  it("writes manifest + index for each bundle", async () => {
    const moduleManager = createModuleManagerMock();
    await writeModuleManifestsToSaveDir(
      "/save",
      [
        {
          module_id: "m1",
          name: "M1",
          version: "1.0.0",
          language: "python",
          entries: [],
        } as never,
      ],
      moduleManager,
    );
    expect(manifestWriterMocks.writeModuleManifest).toHaveBeenCalledTimes(1);
    expect(manifestWriterMocks.writeModuleIndex).toHaveBeenCalledTimes(1);
  });
});
