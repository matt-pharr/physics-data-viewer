/**
 * ipc-register-coverage.test.ts — Channel coverage meta-test.
 *
 * Walks every leaf string in `IPC` (excluding `push.*` channels, which are
 * main → renderer pushes that don't get an `ipcMain.handle()` registration)
 * and asserts that calling the corresponding `register*IpcHandlers()`
 * function registers a handler for it.
 *
 * Catches: "I added a new IPC channel constant but forgot to register it",
 * which would otherwise only fail at runtime when the renderer first calls
 * the new channel.
 *
 * NOT covered here: `autosave.*` and `environment.*` channels, which are
 * still registered inline in `electron/main/index.ts` rather than via a
 * dedicated `register*IpcHandlers()` function. Those are exercised by
 * `index.test.ts`.
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
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => "{}"),
  copyFile: vi.fn(async () => undefined),
  cp: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
  access: vi.fn(async () => undefined),
}));

const fsSyncMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(() => undefined),
  readdirSync: vi.fn(() => [] as string[]),
  readFileSync: vi.fn(() => ""),
}));

const dialogMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
  dialog: dialogMocks,
  shell: { openPath: vi.fn(async () => "") },
  app: { getVersion: () => "0.0.0-test", quit: vi.fn() },
}));
vi.mock("fs/promises", () => fsMocks);
vi.mock("fs", () => fsSyncMocks);
vi.mock("./menu", () => ({
  getTopLevelMenuModel: vi.fn(() => []),
  popupTopLevelMenu: vi.fn(() => true),
  updateMenuEnabled: vi.fn(),
  updateRecentProjectsMenu: vi.fn(),
}));
vi.mock("./auto-updater", () => ({
  initAutoUpdater: vi.fn(),
  checkForUpdates: vi.fn(async () => undefined),
  downloadUpdate: vi.fn(async () => undefined),
  installUpdate: vi.fn(),
  openReleasesPage: vi.fn(async () => undefined),
  getUpdateStatus: vi.fn(() => null),
}));
vi.mock("./app", () => ({
  isQuitting: vi.fn(() => false),
  isQuitRequestPending: vi.fn(() => false),
  clearQuitRequestPending: vi.fn(),
}));
vi.mock("./environment-detector", () => ({
  EnvironmentDetector: {
    checkPDVInstalled: vi.fn(async () => ({ installed: true })),
    checkJuliaPDVInstalled: vi.fn(async () => ({ installed: true })),
  },
}));
vi.mock("./kernel-session", () => ({
  initializeKernelSession: vi.fn(async () => undefined),
}));
vi.mock("./module-runtime", () => ({
  setupProjectModuleNamespaces: vi.fn(async () => undefined),
  bindImportedModule: vi.fn(async () => undefined),
  buildModulesSetupPayload: vi.fn(async () => ({ modules: [] })),
  buildModuleActionCode: vi.fn(() => ""),
  isMissingActionScriptError: vi.fn(() => false),
  normalizeModuleAlias: (s: string) => s,
  suggestModuleAlias: (s: string) => `${s}-2`,
  toPythonArgumentValue: (v: unknown) => String(v),
  toJuliaArgumentValue: (v: unknown) => String(v),
}));
vi.mock("./project-file-sync", () => ({
  copyFilesForLoad: vi.fn(async () => []),
  overlayAutosaveTreeFiles: vi.fn(async () => undefined),
}));
vi.mock("./module-manifest-writer", () => ({
  writeModuleIndex: vi.fn(async () => undefined),
  writeModuleManifest: vi.fn(async () => undefined),
}));

import { IPC } from "./ipc";
import { registerKernelIpcHandlers } from "./ipc-register-kernels";
import { registerTreeNamespaceScriptIpcHandlers } from "./ipc-register-tree-namespace-script";
import { registerModulesIpcHandlers } from "./ipc-register-modules";
import { registerProjectIpcHandlers } from "./ipc-register-project";
import { registerAppStateIpcHandlers } from "./ipc-register-app-state";
import { registerModuleWindowIpcHandlers } from "./ipc-register-module-windows";
import { registerGuiEditorIpcHandlers } from "./ipc-register-gui-editor";
import {
  createBrowserWindowMock,
  createCommRouterMock,
  createConfigStoreMock,
  createGuiEditorWindowManagerMock,
  createGuiViewerWindowManagerMock,
  createKernelManagerMock,
  createModuleManagerMock,
  createModuleWindowManagerMock,
  createProjectManagerMock,
} from "./test-helpers";
import { QueryRouter } from "./query-router";
import type { PDVConfig } from "./config";

/**
 * Walk every leaf string in IPC, excluding the `push.*` namespace.
 * Returns flat list of channel names like ["kernels:list", "kernels:start", ...].
 */
function listExpectedHandlerChannels(): string[] {
  const result: string[] = [];
  for (const [namespace, channels] of Object.entries(IPC)) {
    if (namespace === "push") continue;
    for (const value of Object.values(channels)) {
      if (typeof value === "string") result.push(value);
    }
  }
  return result;
}

/**
 * Channels that are NOT registered by any of the 7 `ipc-register-*` files
 * (instead, they are registered inline in `electron/main/index.ts`).
 * Track them here so the meta-test only asserts on what the dedicated
 * register functions own.
 */
const CHANNELS_REGISTERED_IN_INDEX = [
  ...Object.values(IPC.autosave),
  ...Object.values(IPC.environment),
];

function setupAll(): void {
  const win = createBrowserWindowMock();
  const kernelManager = createKernelManagerMock();
  const commRouter = createCommRouterMock();
  const queryRouter = new QueryRouter();
  const projectManager = createProjectManagerMock();
  const moduleManager = createModuleManagerMock();
  const config = createConfigStoreMock<PDVConfig>({
    showPrivateVariables: false,
    showModuleVariables: false,
    showCallableVariables: false,
    autoRefreshNamespace: false,
  });
  const kernelWorkingDirs = new Map<string, string>();
  const crashHandlers = new Map<string, (id: string) => void>();

  registerKernelIpcHandlers({
    win: win.win,
    kernelManager,
    commRouter: commRouter.router,
    queryRouter,
    projectManager,
    moduleManager,
    kernelWorkingDirs,
    crashHandlers,
    resetProjectState: vi.fn(),
    resetKernelState: vi.fn(),
    setActiveKernelId: vi.fn(),
    getActiveKernelId: () => null,
    getActiveProjectDir: () => null,
    getWorkingDirBase: () => undefined,
    bindActiveProjectModules: vi.fn(async () => undefined),
  });
  registerTreeNamespaceScriptIpcHandlers({
    kernelManager,
    commRouter: commRouter.router,
    queryRouter,
    projectManager,
    configStore: config.store,
    kernelWorkingDirs,
    getKnownModuleAliases: async () => new Set(),
    readConfig: (s) => s.getAll() as PDVConfig,
    toNamespaceQueryPayload: () => ({}),
    toNamespaceInspectPayload: () => ({}),
    sanitizeScriptName: (n: string) => n,
    ensureScriptFile: async () => undefined,
    ensureLibFile: async () => undefined,
    buildEditorSpawn: () => ({ file: "", args: [] }),
    resolveEditorSpawn: () => ({ file: "", args: [] }),
  });
  registerModulesIpcHandlers({
    win: win.win,
    kernelManager,
    commRouter: commRouter.router,
    moduleManager,
    kernelWorkingDirs,
    readActiveProjectManifest: async () => null,
    getActiveProjectDir: () => null,
    getActiveKernelId: () => null,
    getPendingModuleImports: () => [],
    getPendingModuleSettings: () => ({}),
    getModuleHealthWarningsByAlias: () => new Map(),
    detectPythonVersion: async () => "3.11.6",
    getPdvVersion: () => "0.1.1",
    runWithProjectManifestWriteLock: async (_dir, fn) => fn(),
  });
  registerProjectIpcHandlers({
    projectManager,
    moduleManager,
    commRouter: commRouter.router,
    kernelWorkingDirs,
    getActiveKernelId: () => null,
    getActiveKernelLanguage: () => "python",
    setActiveProjectDir: vi.fn(),
    getPendingModuleImports: () => [],
    setPendingModuleImports: vi.fn(),
    getPendingModuleSettings: () => ({}),
    setPendingModuleSettings: vi.fn(),
    clearModuleHealthWarnings: vi.fn(),
    refreshProjectModuleHealth: async () => null,
    runSerializedProjectManifestMutation: async (_dir, fn) => fn(),
    getMainWindow: () => win.win,
    getInterpreterPath: () => "/usr/bin/python3",
  });
  registerAppStateIpcHandlers({
    win: win.win,
    configStore: config.store,
    readConfig: (s) => s.getAll() as PDVConfig,
    themesDir: "/tmp/themes",
    stateDir: "/tmp/state",
    setAllowClose: vi.fn(),
  });
  registerModuleWindowIpcHandlers({
    moduleWindowManager: createModuleWindowManagerMock(),
    mainWindow: win.win,
  });
  registerGuiEditorIpcHandlers({
    guiEditorWindowManager: createGuiEditorWindowManagerMock(),
    guiViewerWindowManager: createGuiViewerWindowManagerMock(),
    commRouter: commRouter.router,
  });
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IPC channel coverage", () => {
  it("every channel in IPC (except push, autosave, environment) gets a registered handler", () => {
    setupAll();
    const expected = listExpectedHandlerChannels().filter(
      (channel) => !CHANNELS_REGISTERED_IN_INDEX.includes(channel as never),
    );
    const missing = expected.filter((channel) => !ipcRegistry.handlers.has(channel));
    expect(missing).toEqual([]);
  });

  it("the autosave + environment channels exist as constants but are intentionally not covered here", () => {
    expect(CHANNELS_REGISTERED_IN_INDEX.length).toBeGreaterThan(0);
    for (const channel of CHANNELS_REGISTERED_IN_INDEX) {
      expect(typeof channel).toBe("string");
    }
  });
});
