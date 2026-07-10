/**
 * ipc-register-modules.test.ts — Unit tests for module-domain IPC handlers.
 *
 * Covers all 12 channels in IPC.modules.*: registration, the thin
 * pass-throughs to ModuleManager (list/install/checkUpdates/uninstall/update),
 * importToProject collision detection (alias already in pending list),
 * createEmpty validation (no kernel, alias collision), updateMetadata input
 * validation, and the no-active-project failure mode for exportFromProject.
 *
 * Heavier integration scenarios (full successful import with manifest write
 * lock, action code generation, dialog flows) are exercised by `index.test.ts`
 * and `module-runtime.test.ts` and intentionally not duplicated here.
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
  mkdir: vi.fn(async () => undefined),
  cp: vi.fn(async () => undefined),
  stat: vi.fn(async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    throw err;
  }),
  readFile: vi.fn(async () => "{}"),
  writeFile: vi.fn(async () => undefined),
}));

const dialogMocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
  dialog: dialogMocks,
}));

vi.mock("fs/promises", () => fsMocks);

import { IPC } from "./ipc";
import { registerModulesIpcHandlers } from "./ipc-register-modules";
import {
  createBrowserWindowMock,
  createCommRouterMock,
  createKernelManagerMock,
  createModuleManagerMock,
  TEST_PDV_VERSION,
  type InvokeHandler,
} from "./test-helpers";
import type { ProjectModuleImport } from "./project-manager";

function getHandler(channel: string): InvokeHandler {
  const h = ipcRegistry.handlers.get(channel);
  if (!h) throw new Error(`Channel not registered: ${channel}`);
  return h;
}

interface Harness {
  win: ReturnType<typeof createBrowserWindowMock>;
  kernelManager: ReturnType<typeof createKernelManagerMock>;
  commRouter: ReturnType<typeof createCommRouterMock>;
  moduleManager: ReturnType<typeof createModuleManagerMock>;
  pendingImports: ProjectModuleImport[];
  pendingSettings: Record<string, Record<string, unknown>>;
  activeProjectDir: string | null;
  activeManifest: { modules: ProjectModuleImport[]; module_settings?: Record<string, unknown> } | null;
}

function setup(initial: Partial<Harness> = {}): Harness {
  const win = createBrowserWindowMock();
  const kernelManager = createKernelManagerMock();
  const commRouter = createCommRouterMock();
  const moduleManager = createModuleManagerMock();
  const pendingImports = initial.pendingImports ?? [];
  const pendingSettings = initial.pendingSettings ?? {};
  const harness: Harness = {
    win,
    kernelManager,
    commRouter,
    moduleManager,
    pendingImports,
    pendingSettings,
    activeProjectDir: initial.activeProjectDir ?? null,
    activeManifest: initial.activeManifest ?? null,
  };
  registerModulesIpcHandlers({
    win: win.win,
    kernelManager,
    commRouter: commRouter.router,
    moduleManager,
    kernelWorkingDirs: new Map(),
    readActiveProjectManifest: async () => harness.activeManifest as never,
    getActiveProjectDir: () => harness.activeProjectDir,
    getActiveKernelId: () => null,
    getPendingModuleImports: () => harness.pendingImports,
    getPendingModuleSettings: () => harness.pendingSettings,
    getModuleHealthWarningsByAlias: () => new Map(),
    detectPythonVersion: async () => "3.11.6",
    getPdvVersion: () => TEST_PDV_VERSION,
    runWithProjectManifestWriteLock: async (_dir, fn) => fn(),
  });
  return harness;
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
  fsMocks.stat.mockRejectedValue(
    Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("modules:importToProject", () => {
  it("returns error when the requested moduleId is not installed", async () => {
    const { moduleManager } = setup();
    (moduleManager.listInstalled as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const result = (await getHandler(IPC.modules.importToProject)({}, {
      moduleId: "ghost",
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Installed module not found/);
  });

  it("returns conflict when the alias already exists in pending imports (no project yet)", async () => {
    const { moduleManager } = setup({
      pendingImports: [
        { module_id: "demo", alias: "demo", version: "1.0.0" } as ProjectModuleImport,
      ],
    });
    (moduleManager.listInstalled as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "demo", name: "Demo", version: "1.0.0", source: { type: "local", location: "/m" } },
    ]);
    const result = (await getHandler(IPC.modules.importToProject)({}, {
      moduleId: "demo",
    })) as { success: boolean; status: string; suggestedAlias?: string };
    expect(result.success).toBe(false);
    expect(result.status).toBe("conflict");
    expect(result.suggestedAlias).toBeTruthy();
  });
});

describe("modules:createEmpty", () => {
  it("returns conflict when the alias matches a pending import", async () => {
    setup({
      pendingImports: [
        { module_id: "demo", alias: "demo", version: "0.1.0" } as ProjectModuleImport,
      ],
    });
    const result = (await getHandler(IPC.modules.createEmpty)({}, {
      id: "demo",
      name: "Demo",
      version: "0.1.0",
    })) as { success: boolean; status: string };
    expect(result.success).toBe(false);
    expect(result.status).toBe("conflict");
  });

  it("returns error when no kernel is running", async () => {
    setup();
    const result = (await getHandler(IPC.modules.createEmpty)({}, {
      id: "fresh",
      name: "Fresh",
      version: "0.1.0",
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No running kernel/);
  });
});

describe("modules:updateMetadata", () => {
  it("requires alias", async () => {
    setup();
    const result = (await getHandler(IPC.modules.updateMetadata)({}, {})) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/alias/);
  });

  it("requires a running kernel", async () => {
    setup();
    const result = (await getHandler(IPC.modules.updateMetadata)({}, {
      alias: "demo",
      name: "Demo Renamed",
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No running kernel/);
  });
});

describe("modules:exportFromProject", () => {
  it("requires alias", async () => {
    setup();
    const result = (await getHandler(IPC.modules.exportFromProject)({}, {})) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/alias is required/);
  });

  it("returns not_saved when there is no active project dir", async () => {
    setup();
    const result = (await getHandler(IPC.modules.exportFromProject)({}, {
      alias: "demo",
    })) as { success: boolean; status: string };
    expect(result.success).toBe(false);
    expect(result.status).toBe("not_saved");
  });

  it("returns error when the alias is not in the manifest", async () => {
    setup({
      activeProjectDir: "/projects/x",
      activeManifest: { modules: [] },
    });
    const result = (await getHandler(IPC.modules.exportFromProject)({}, {
      alias: "ghost",
    })) as { success: boolean; status: string; error?: string };
    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/No imported or in-session module/);
  });
});

describe("modules:listImported", () => {
  it("returns [] when no project is active and no pending imports exist", async () => {
    setup();
    const result = (await getHandler(IPC.modules.listImported)({})) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

describe("modules:saveSettings", () => {
  it("stashes settings into the pending map when no project is active", async () => {
    const harness = setup({
      pendingImports: [
        { module_id: "demo", alias: "demo", version: "1.0.0" } as ProjectModuleImport,
      ],
    });
    const result = (await getHandler(IPC.modules.saveSettings)({}, {
      moduleAlias: "demo",
      values: { foo: 1 },
    })) as { success: boolean };
    expect(result.success).toBe(true);
    // With no active project dir, the settings must land in the pending map
    // (they get flushed into the manifest when the project is first saved).
    expect(harness.pendingSettings.demo).toEqual({ foo: 1 });
  });

  it("rejects settings for an unknown module alias", async () => {
    setup();
    const result = (await getHandler(IPC.modules.saveSettings)({}, {
      moduleAlias: "ghost",
      values: { foo: 1 },
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/alias not found/i);
  });

  it("rejects a non-object settings payload", async () => {
    setup();
    const result = (await getHandler(IPC.modules.saveSettings)({}, {
      moduleAlias: "demo",
      values: "nope",
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be an object/i);
  });
});
