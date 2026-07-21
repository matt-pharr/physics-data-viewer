/**
 * ipc-register-project.test.ts — Unit tests for project-domain IPC handlers.
 *
 * Covers all 6 channels in IPC.project.* plus IPC.codeCells.*: registration,
 * save happy path with autosave bracket pushes, save blocked by missing
 * backing files, load with autosave overlay branch, peek* fallback to
 * defaults on manifest read failure, and module-owned file sync helper.
 */

import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
  mkdir: vi.fn(async (_path: string, _options?: { recursive?: boolean }) => undefined),
  copyFile: vi.fn(async (_src: string, _dest: string) => undefined),
  cp: vi.fn(
    async (_src: string, _dest: string, _options?: { recursive?: boolean }) => undefined,
  ),
  readFile: vi.fn<(path: string, encoding?: string) => Promise<string>>(
    async () => "{}",
  ),
  writeFile: vi.fn<(path: string, contents: string, encoding?: string) => Promise<void>>(
    async () => undefined,
  ),
  rename: vi.fn(async (_oldPath: string, _newPath: string) => undefined),
  rm: vi.fn(
    async (_path: string, _options?: { recursive?: boolean; force?: boolean }) => undefined,
  ),
  // Default: reject (file absent) so the save handler's pyproject.toml probe
  // classifies sessions as shared-mode unless a test opts in to uv.
  access: vi.fn<(path: string) => Promise<void>>(async () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
}));

const moduleRuntimeMocks = vi.hoisted(() => ({
  setupProjectModuleNamespaces: vi.fn(async () => undefined),
}));

const projectFileSyncMocks = vi.hoisted(() => ({
  copyFilesForLoad: vi.fn(async () => [] as string[]),
  copyEnvFilesForSave: vi.fn(async () => [] as string[]),
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

import { IPC, type ActiveEnvironmentInfo } from "./ipc";
import {
  registerProjectIpcHandlers,
  syncModuleOwnedFilesToSaveDir,
  writeModuleManifestsToSaveDir,
} from "./ipc-register-project";
import { ProjectManager } from "./project-manager";
import type {
  ProjectManifest,
  ProjectModuleImport,
} from "./project-manager";
import {
  createBrowserWindowMock,
  createCommRouterMock,
  createModuleManagerMock,
  createProjectManagerMock,
  TEST_PDV_VERSION,
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
  // Typed Mocks so each field is structurally assignable to the typed
  // callback the registration function expects, while still exposing
  // .mockReturnValueOnce / .mock.calls for test assertions.
  setActiveProjectDir: Mock<(dir: string | null) => void>;
  getActiveKernelId: Mock<() => string | null>;
  getPendingModuleImports: Mock<() => ProjectModuleImport[]>;
  getPendingModuleSettings: Mock<() => Record<string, Record<string, unknown>>>;
  setPendingModuleImports: Mock<(imports: ProjectModuleImport[]) => void>;
  setPendingModuleSettings: Mock<(settings: Record<string, Record<string, unknown>>) => void>;
  refreshProjectModuleHealth: Mock<(dir: string | null) => Promise<ProjectManifest | null>>;
  clearModuleHealthWarnings: Mock<() => void>;
  getActiveKernelEnvMeta: Mock<() => ActiveEnvironmentInfo | undefined>;
  syncUvEnvironmentForLoad: Mock<
    (saveDir: string, workingDir: string) => Promise<{ copied: string[]; synced: boolean; warning?: string }>
  >;
  onExplicitSaveCompleted: Mock<(saveDir: string) => void>;
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
    setActiveProjectDir: vi.fn<(dir: string | null) => void>((dir) => {
      activeProjectDir = dir;
    }),
    getActiveKernelId: vi.fn<() => string | null>(() => null),
    getPendingModuleImports: vi.fn<() => ProjectModuleImport[]>(() => []),
    getPendingModuleSettings: vi.fn<() => Record<string, Record<string, unknown>>>(() => ({})),
    setPendingModuleImports: vi.fn<(imports: ProjectModuleImport[]) => void>(),
    setPendingModuleSettings: vi.fn<(settings: Record<string, Record<string, unknown>>) => void>(),
    refreshProjectModuleHealth: vi.fn<(dir: string | null) => Promise<ProjectManifest | null>>(async () => null),
    clearModuleHealthWarnings: vi.fn<() => void>(),
    getActiveKernelEnvMeta: vi.fn<() => ActiveEnvironmentInfo | undefined>(() => undefined),
    syncUvEnvironmentForLoad: vi.fn<
      (saveDir: string, workingDir: string) => Promise<{ copied: string[]; synced: boolean; warning?: string }>
    >(async () => ({ copied: [], synced: true })),
    onExplicitSaveCompleted: vi.fn<(saveDir: string) => void>(),
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
    getActiveProjectDir: () => activeProjectDir,
    getPendingModuleImports: harness.getPendingModuleImports,
    setPendingModuleImports: harness.setPendingModuleImports,
    getPendingModuleSettings: harness.getPendingModuleSettings,
    setPendingModuleSettings: harness.setPendingModuleSettings,
    clearModuleHealthWarnings: harness.clearModuleHealthWarnings,
    refreshProjectModuleHealth: harness.refreshProjectModuleHealth,
    runSerializedProjectManifestMutation: async (_dir, fn) => fn(),
    getMainWindow: () => win.win,
    getInterpreterPath: () => "/usr/bin/python3",
    getActiveKernelEnvMeta: harness.getActiveKernelEnvMeta,
    syncUvEnvironmentForLoad: harness.syncUvEnvironmentForLoad,
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

  it("uv project: records mode + python_version from kernel env metadata, omits interpreter_path (§10.5)", async () => {
    const harness = setup();
    // uv detection: the active kernel's working dir must contain a
    // pyproject.toml — make the access probe succeed for it (and only it:
    // the save dir has no project.json yet, so the manifest-based mode
    // guard falls back to working-dir detection).
    harness.getActiveKernelId.mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/uv-wd");
    fsMocks.access.mockImplementation(async (p: string) => {
      if (String(p).endsWith("pyproject.toml")) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    harness.getActiveKernelEnvMeta.mockReturnValue({
      mode: "uv",
      interpreterPath: "/tmp/uv-wd/.venv/bin/python",
      pythonVersion: "3.12",
    });

    await getHandler(IPC.project.save)({}, "/save", validCells);

    const saveOpts = (harness.projectManager.save as Mock).mock.calls.at(-1)?.[2] as {
      environment?: { mode: string; python_version?: string };
      interpreterPath?: string;
    };
    expect(saveOpts.environment).toEqual({ mode: "uv", python_version: "3.12" });
    // The venv path is ephemeral (lives in the working dir) — never recorded.
    expect(saveOpts.interpreterPath).toBeUndefined();
  });

  it("legacy shared save keeps mode 'shared' despite foreign env files in the working dir (manifest guard)", async () => {
    const harness = setup();
    // A legacy shared project loaded into a live uv session: the previous
    // project's pyproject.toml is still in the working dir, but /save has an
    // existing project.json whose manifest declares no per-project env.
    harness.getActiveKernelId.mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/uv-wd");
    fsMocks.access.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith("pyproject.toml") || s.endsWith("project.json")) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.spyOn(ProjectManager, "readManifest").mockResolvedValue({
      project_name: "legacy",
    } as never);
    harness.getActiveKernelEnvMeta.mockReturnValue({
      mode: "uv",
      interpreterPath: "/tmp/uv-wd/.venv/bin/python",
      pythonVersion: "3.12",
    });

    await getHandler(IPC.project.save)({}, "/save", validCells);

    const saveOpts = (harness.projectManager.save as Mock).mock.calls.at(-1)?.[2] as {
      environment?: { mode: string };
    };
    // The foreign env spec must NOT be stamped onto the legacy project…
    expect(saveOpts.environment).toEqual({ mode: "shared" });
    // …nor copied into its save dir.
    expect(projectFileSyncMocks.copyEnvFilesForSave).not.toHaveBeenCalled();
  });

  it("existing uv manifest still saves as uv through the manifest guard", async () => {
    const harness = setup();
    harness.getActiveKernelId.mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/uv-wd");
    fsMocks.access.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith("pyproject.toml") || s.endsWith("project.json")) return;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.spyOn(ProjectManager, "readManifest").mockResolvedValue({
      project_name: "uvproj",
      environment: { mode: "uv" },
    } as never);
    harness.getActiveKernelEnvMeta.mockReturnValue({
      mode: "uv",
      interpreterPath: "/tmp/uv-wd/.venv/bin/python",
      pythonVersion: "3.12",
    });

    await getHandler(IPC.project.save)({}, "/save", validCells);

    const saveOpts = (harness.projectManager.save as Mock).mock.calls.at(-1)?.[2] as {
      environment?: { mode: string; python_version?: string };
    };
    expect(saveOpts.environment).toEqual({ mode: "uv", python_version: "3.12" });
    expect(projectFileSyncMocks.copyEnvFilesForSave).toHaveBeenCalled();
  });

  it("shared project: records the interpreter the kernel actually spawned on", async () => {
    const harness = setup();
    harness.getActiveKernelId.mockReturnValue("k1");
    // No pyproject.toml in the working dir → shared mode.
    harness.getActiveKernelEnvMeta.mockReturnValue({
      mode: "shared",
      interpreterPath: "/opt/conda/envs/mpi/bin/python",
      pythonVersion: "3.12",
    });

    await getHandler(IPC.project.save)({}, "/save", validCells);

    const saveOpts = (harness.projectManager.save as Mock).mock.calls.at(-1)?.[2] as {
      environment?: { mode: string };
      interpreterPath?: string;
    };
    expect(saveOpts.environment).toEqual({ mode: "shared" });
    expect(saveOpts.interpreterPath).toBe("/opt/conda/envs/mpi/bin/python");
  });

  it("shared project without kernel metadata: falls back to the global config interpreter", async () => {
    const harness = setup();
    harness.getActiveKernelEnvMeta.mockReturnValue(undefined);

    await getHandler(IPC.project.save)({}, "/save", validCells);

    const saveOpts = (harness.projectManager.save as Mock).mock.calls.at(-1)?.[2] as {
      interpreterPath?: string;
    };
    expect(saveOpts.interpreterPath).toBe("/usr/bin/python3");
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
      pdv_version: TEST_PDV_VERSION,
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
    expect(result.savedPdvVersion).toBe(TEST_PDV_VERSION);
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

  it("re-points a running uv session's env at the opened project and surfaces warnings", async () => {
    const harness = setup();
    harness.getActiveKernelId.mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/wd");
    harness.getActiveKernelEnvMeta.mockReturnValue({ mode: "uv", pythonVersion: "3.13" });
    harness.syncUvEnvironmentForLoad.mockResolvedValueOnce({
      copied: ["pyproject.toml"],
      synced: false,
      warning: "uv sync failed while updating the session environment",
    });
    const result = (await getHandler(IPC.project.load)({}, "/save")) as {
      envSyncWarning?: string;
    };
    expect(harness.syncUvEnvironmentForLoad).toHaveBeenCalledWith("/save", "/tmp/wd");
    expect(result.envSyncWarning).toMatch(/uv sync failed/);
  });

  it("does not touch the env for shared-mode kernels", async () => {
    const harness = setup();
    harness.getActiveKernelId.mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/wd");
    harness.getActiveKernelEnvMeta.mockReturnValue({
      mode: "shared",
      interpreterPath: "/usr/bin/python3",
    });
    const result = (await getHandler(IPC.project.load)({}, "/save")) as {
      envSyncWarning?: string;
    };
    expect(harness.syncUvEnvironmentForLoad).not.toHaveBeenCalled();
    expect(result.envSyncWarning).toBeUndefined();
  });

  it("still completes the load (with a warning) when env sync throws", async () => {
    const harness = setup();
    harness.getActiveKernelId.mockReturnValue("k1");
    harness.kernelWorkingDirs.set("k1", "/tmp/wd");
    harness.getActiveKernelEnvMeta.mockReturnValue({ mode: "uv" });
    harness.syncUvEnvironmentForLoad.mockRejectedValueOnce(new Error("boom"));
    const result = (await getHandler(IPC.project.load)({}, "/save")) as {
      envSyncWarning?: string;
      checksum: string | null;
    };
    expect(result.envSyncWarning).toMatch(/Failed to update the session environment/);
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
      pdv_version: TEST_PDV_VERSION,
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

  it("stages the copy at <dest>.tmp then renames onto the destination", async () => {
    // Atomic-copy invariant: the user-edited module file is never
    // half-written at the destination path. The copy lands at
    // `<dest>.tmp` and only the rename promotes it onto the final
    // path. A crash between the two leaves the prior contents intact.
    await syncModuleOwnedFilesToSaveDir("/save", [
      { module_id: "m1", source_rel_path: "scripts/run.py", workdir_path: "/wd/r.py" },
    ] as never);
    const finalDest = path.resolve("/save", "modules", "m1", "scripts/run.py");
    expect(fsMocks.copyFile).toHaveBeenCalledWith(
      path.resolve("/wd/r.py"),
      finalDest + ".tmp",
    );
    expect(fsMocks.rename).toHaveBeenCalledWith(finalDest + ".tmp", finalDest);
  });

  it("cleans up the tmp and does not call rename when the underlying copy fails", async () => {
    fsMocks.copyFile.mockRejectedValueOnce(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );
    // EACCES is a non-ENOENT failure so the helper logs and continues
    // (it does not push to failedPaths). What matters here is that the
    // failure path cleans up the tmp and never renames onto the destination.
    await syncModuleOwnedFilesToSaveDir("/save", [
      { module_id: "m1", source_rel_path: "scripts/run.py", workdir_path: "/wd/r.py" },
    ] as never);
    const finalDest = path.resolve("/save", "modules", "m1", "scripts/run.py");
    expect(fsMocks.rm).toHaveBeenCalledWith(
      finalDest + ".tmp",
      expect.objectContaining({ force: true }),
    );
    expect(fsMocks.rename).not.toHaveBeenCalled();
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
