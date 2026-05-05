/**
 * index.test.ts — Step 5 IPC handler tests.
 *
 * Verifies that `registerIpcHandlers()` wires the required IPC surface to
 * KernelManager/CommRouter dependencies and forwards push notifications to the
 * renderer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import os from "os";
import path from "path";

import { registerIpcHandlers, registerCommPushForwarding, unregisterIpcHandlers } from "./index";
import {
  IPC,
  type NamespaceVariable,
  type PDVConfig,
  type TreeNode,
} from "./ipc";
import { PDVMessageType, getAppVersion, setAppVersion, type PDVMessage } from "./pdv-protocol";
import type { KernelInfo, KernelManager } from "./kernel-manager";
import type { CommRouter } from "./comm-router";
import { QueryRouter } from "./query-router";
import type { ProjectManager } from "./project-manager";
import type { ConfigStore } from "./config";
import { EnvironmentDetector } from "./environment-detector";

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  const ipcHandle = vi.fn((channel: string, handler: InvokeHandler) => {
    handlers.set(channel, handler);
  });
  const ipcRemoveHandler = vi.fn((channel: string) => {
    handlers.delete(channel);
  });
  const spawn = vi.fn(() => ({
    unref: vi.fn(),
  }));
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _options: { timeout?: number } | ((err: Error | null, stdout: string, stderr: string) => void),
      callback?: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      const cb =
        typeof _options === "function"
          ? _options
          : callback;
      cb?.(null, "Python 3.11.6\n", "");
    }
  );
  const fsMkdir = vi.fn(async () => undefined);
  const fsStat = vi.fn(async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    throw err;
  });
  const fsWriteFile = vi.fn(async () => undefined);
  const fsReadFile = vi.fn(async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    throw err;
  });
  const fsCopyFile = vi.fn(async () => undefined);
  const fsCp = vi.fn(async () => undefined);
  const fsRm = vi.fn(async () => undefined);
  const fsReaddir = vi.fn(async () => []);
  const dialogShowOpenDialog = vi.fn();
  const dialogShowMessageBox = vi.fn(async () => ({ response: 0 }));
  const shellOpenPath = vi.fn(async () => "");
  const moduleManagerListInstalled = vi.fn(async () => []);
  const moduleManagerInstall = vi.fn(async () => ({
    success: true,
    status: "installed",
    module: {
      id: "demo-module",
      name: "Demo Module",
      version: "1.0.0",
      source: { type: "local", location: "/tmp/demo-module" },
    },
  }));
  const moduleManagerCheckUpdates = vi.fn(async (moduleId: string) => ({
    moduleId,
    status: "not_implemented",
    message: "Remote update checks are not implemented yet.",
  }));
  const moduleManagerEvaluateHealth = vi.fn(async () => []);
  const moduleManagerResolveActionScripts = vi.fn(async () => [
    {
      actionId: "run-action",
      actionLabel: "Run",
      name: "run",
      scriptPath: "/tmp/demo-module/scripts/run.py",
      inputIds: ["threshold"],
    },
  ]);
  const moduleManagerGetModuleInputs = vi.fn(async () => [
    { id: "threshold", label: "Threshold", type: "int", default: "5" },
  ]);
  const moduleManagerGetModuleGuiInfo = vi.fn(async () => ({
    hasGui: true,
    gui: undefined,
  }));
  const moduleManagerGetModuleInstallPath = vi.fn(async () => null);
  const moduleManagerGetGlobalStorePath = vi.fn((moduleId: string) => `/tmp/pdv-global/modules/packages/${moduleId}`);
  const moduleManagerRegisterInGlobalStore = vi.fn(async (moduleDir: string) => ({
    id: "toy",
    name: "Toy",
    version: "0.1.0",
    source: { type: "local" as const, location: moduleDir },
    installPath: moduleDir,
  }));
  const moduleManagerGetModuleSetupInfo = vi.fn(async () => ({
    entryPoint: undefined,
  }));
  const moduleManagerIsV4Module = vi.fn(async () => true);
  const moduleManagerReadModuleIndex = vi.fn(async () => []);
  const moduleManagerGetModuleDependencies = vi.fn(async () => []);
  const moduleManagerResolveModuleDir = vi.fn(async () => null);
  const moduleManagerUninstall = vi.fn(async () => ({ success: true }));
  const moduleManagerUpdate = vi.fn(async () => ({ success: true, status: "installed" }));
  return {
    handlers,
    ipcHandle,
    ipcRemoveHandler,
    spawn,
    execFile,
    fsMkdir,
    fsStat,
    fsWriteFile,
    fsReadFile,
    fsCopyFile,
    fsCp,
    fsRm,
    fsReaddir,
    dialogShowOpenDialog,
    dialogShowMessageBox,
    shellOpenPath,
    moduleManagerListInstalled,
    moduleManagerInstall,
    moduleManagerCheckUpdates,
    moduleManagerEvaluateHealth,
    moduleManagerResolveActionScripts,
    moduleManagerGetModuleInputs,
    moduleManagerGetModuleGuiInfo,
    moduleManagerGetModuleInstallPath,
    moduleManagerGetGlobalStorePath,
    moduleManagerRegisterInGlobalStore,
    moduleManagerGetModuleSetupInfo,
    moduleManagerIsV4Module,
    moduleManagerReadModuleIndex,
    moduleManagerGetModuleDependencies,
    moduleManagerResolveModuleDir,
    moduleManagerUninstall,
    moduleManagerUpdate,
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: mocks.ipcHandle,
    removeHandler: mocks.ipcRemoveHandler,
  },
  dialog: {
    showOpenDialog: mocks.dialogShowOpenDialog,
    showMessageBox: mocks.dialogShowMessageBox,
  },
  shell: {
    openPath: mocks.shellOpenPath,
  },
  app: {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    getVersion: () => (require("../package.json") as { version: string }).version,
  },
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));

vi.mock("fs/promises", () => ({
  mkdir: mocks.fsMkdir,
  stat: mocks.fsStat,
  writeFile: mocks.fsWriteFile,
  readFile: mocks.fsReadFile,
  copyFile: mocks.fsCopyFile,
  cp: mocks.fsCp,
  rm: mocks.fsRm,
  readdir: mocks.fsReaddir,
}));

vi.mock("./module-manager", () => ({
  ModuleManager: vi.fn().mockImplementation(() => ({
    listInstalled: mocks.moduleManagerListInstalled,
    install: mocks.moduleManagerInstall,
    checkUpdates: mocks.moduleManagerCheckUpdates,
    evaluateHealth: mocks.moduleManagerEvaluateHealth,
    resolveActionScripts: mocks.moduleManagerResolveActionScripts,
    getModuleInputs: mocks.moduleManagerGetModuleInputs,
    getModuleGuiInfo: mocks.moduleManagerGetModuleGuiInfo,
    getModuleInstallPath: mocks.moduleManagerGetModuleInstallPath,
    getGlobalStorePath: mocks.moduleManagerGetGlobalStorePath,
    registerInGlobalStore: mocks.moduleManagerRegisterInGlobalStore,
    getModuleSetupInfo: mocks.moduleManagerGetModuleSetupInfo,
    isV4Module: mocks.moduleManagerIsV4Module,
    readModuleIndex: mocks.moduleManagerReadModuleIndex,
    getModuleDependencies: mocks.moduleManagerGetModuleDependencies,
    resolveModuleDir: mocks.moduleManagerResolveModuleDir,
    uninstall: mocks.moduleManagerUninstall,
    update: mocks.moduleManagerUpdate,
  })),
}));

function getHandler(channel: string): InvokeHandler {
  const handler = mocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`IPC handler not found: ${channel}`);
  }
  return handler;
}

function makeKernelInfo(): KernelInfo {
  return {
    id: "kernel-1",
    name: "python3",
    language: "python",
    status: "idle",
  };
}

function makeMessage(payload: Record<string, unknown>): PDVMessage {
  return {
    pdv_version: getAppVersion(),
    msg_id: "msg-1",
    in_reply_to: "req-1",
    type: "response",
    status: "ok",
    payload,
  };
}

function setup() {
  const webContentsSend = vi.fn();
  const win = {
    webContents: { send: webContentsSend },
    on: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
  } as unknown as BrowserWindow;

  const kernelManager = {
    list: vi.fn(() => []),
    start: vi.fn(async () => makeKernelInfo()),
    stop: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ result: 2 })),
    interrupt: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({
      matches: ["import"],
      cursor_start: 0,
      cursor_end: 6,
    })),
    inspect: vi.fn(async () => ({
      found: true,
      data: { "text/plain": "doc" },
    })),
    ping: vi.fn(async () => undefined),
    getKernel: vi.fn(() => makeKernelInfo()),
    getQueryPort: vi.fn(() => 12345),
    shutdownAll: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as KernelManager;

  const pushHandlers = new Map<string, Array<(message: PDVMessage) => void>>();
  const commRouter = {
    request: vi.fn(async () => makeMessage({})),
    onPush: vi.fn((type: string, handler: (message: PDVMessage) => void) => {
      const existing = pushHandlers.get(type) ?? [];
      existing.push(handler);
      pushHandlers.set(type, existing);
      if (type === PDVMessageType.READY) {
        handler(makeMessage({}));
      }
    }),
    offPush: vi.fn((type: string, handler: (message: PDVMessage) => void) => {
      const existing = pushHandlers.get(type) ?? [];
      pushHandlers.set(
        type,
        existing.filter((entry) => entry !== handler)
      );
    }),
    attach: vi.fn(),
    detach: vi.fn(),
  } as unknown as CommRouter;

  const projectManager = {
    save: vi.fn(async () => ({
      checksum: "abc123",
      nodeCount: 0,
      moduleOwnedFiles: [],
      moduleManifests: [],
      missingFiles: [],
    })),
    load: vi.fn(async (_saveDir: string, onBeforePush?: () => Promise<void>) => {
      if (onBeforePush) await onBeforePush();
      return [];
    }),
    createWorkingDir: vi.fn(async () => "/tmp/pdv-test"),
    deleteWorkingDir: vi.fn(async () => undefined),
    clearCachedKernelResults: vi.fn(),
    startAutosaveTimer: vi.fn(),
    stopAutosaveTimer: vi.fn(),
    resetAutosaveTimer: vi.fn(),
    markAutosaveCacheDirty: vi.fn(),
    setAutosavePending: vi.fn(),
    consumeAutosavePending: vi.fn(() => false),
    autosave: vi.fn(async () => null),
  } as unknown as ProjectManager;

  const configState: PDVConfig = {
    showPrivateVariables: false,
    showModuleVariables: false,
    showCallableVariables: false,
  };
  const configStore = {
    getAll: vi.fn(() => ({ ...configState })),
    set: vi.fn((key: string, value: unknown) => {
      (configState as unknown as Record<string, unknown>)[key] = value;
    }),
  } as unknown as ConfigStore;

  const queryRouter = new QueryRouter();
  registerIpcHandlers(win, kernelManager, commRouter, queryRouter, projectManager, configStore, os.tmpdir());

  return {
    webContentsSend,
    kernelManager,
    commRouter,
    projectManager,
    configStore,
  };
}

describe("Step 5 IPC handlers", () => {
  beforeEach(() => {
    setAppVersion("0.0.7");
    mocks.handlers.clear();
    vi.clearAllMocks();
    unregisterIpcHandlers();
    delete process.env.EDITOR;
  });

  it("kernels:start returns a KernelInfo with expected shape", async () => {
    const { kernelManager } = setup();
    const start = getHandler(IPC.kernels.start);

    const result = (await start(
      {},
      { language: "python" }
    )) as KernelInfo;

    expect(kernelManager.start).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      language: "python",
      status: "idle",
    });
  });

  it("tree:list sends pdv.tree.list and returns response nodes", async () => {
    const { commRouter } = setup();
    const nodes: TreeNode[] = [
      {
        path: "x",
        key: "x",
        parent_path: null,
        type: "scalar",
        has_children: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ];

    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage({ nodes })
    );

    const list = getHandler(IPC.tree.list);
    const result = (await list({}, "kernel-1", "")) as TreeNode[];

    expect(commRouter.request).toHaveBeenCalledWith(PDVMessageType.TREE_LIST, {
      path: "",
    });
    expect(result).toEqual(nodes);
  });

  it("tree:list returns [] when the kernel is not running", async () => {
    const { kernelManager, commRouter } = setup();
    (kernelManager.getKernel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined
    );

    const list = getHandler(IPC.tree.list);
    const result = (await list({}, "missing-kernel", "")) as TreeNode[];

    expect(result).toEqual([]);
    expect(commRouter.request).not.toHaveBeenCalled();
  });

  it("tree:get sends pdv.tree.get and returns payload", async () => {
    const { commRouter } = setup();
    const payload = { value: 42 };
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage(payload)
    );

    const get = getHandler(IPC.tree.get);
    const result = (await get({}, "kernel-1", "x")) as Record<string, unknown>;

    expect(commRouter.request).toHaveBeenCalledWith(PDVMessageType.TREE_GET, {
      path: "x",
    });
    expect(result).toEqual(payload);
  });

  it("namespace:query sends pdv.namespace.query and returns variables", async () => {
    const { commRouter } = setup();
    const variables: NamespaceVariable[] = [{
      name: "x",
      kind: "scalar",
      type: "int",
      preview: "42",
      path: [],
      expression: "x",
    }];
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage({ variables })
    );

    const query = getHandler(IPC.namespace.query);
    const result = (await query({}, "kernel-1", {
      includePrivate: false,
      includeModules: false,
      includeCallables: true,
    })) as NamespaceVariable[];

    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.NAMESPACE_QUERY,
      {
        include_private: false,
        include_modules: false,
        include_callables: true,
      }
    );
    expect(result).toEqual(variables);
  });

  it("namespace:inspect sends pdv.namespace.inspect and returns child rows", async () => {
    const { commRouter } = setup();
    const payload = {
      children: [{
        name: "[0]",
        kind: "scalar",
        type: "int",
        preview: "1",
        path: [{ kind: "index", value: 0 }],
        expression: "arr[0]",
      }],
      truncated: false,
      total_children: 1,
    };
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage(payload)
    );

    const inspect = getHandler(IPC.namespace.inspect);
    const result = await inspect({}, "kernel-1", {
      rootName: "arr",
      path: [],
    });

    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.NAMESPACE_INSPECT,
      {
        root_name: "arr",
        path: [],
      }
    );
    expect(result).toEqual({
      children: [{
        name: "[0]",
        kind: "scalar",
        type: "int",
        preview: "1",
        path: [{ kind: "index", value: 0 }],
        expression: "arr[0]",
      }],
      truncated: false,
      totalChildren: 1,
    });
  });

  it("script:edit spawns the configured external editor process", async () => {
    const { configStore, commRouter } = setup();
    (configStore.getAll as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      showPrivateVariables: false,
      showModuleVariables: false,
      showCallableVariables: false,
      editorCommand: "code",
    });
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      { payload: { path: "/tmp/script.py", file_path: "/tmp/script.py" } }
    );

    const edit = getHandler(IPC.script.edit);
    await edit({}, "kernel-1", "/tmp/script.py");

    expect(mocks.spawn).toHaveBeenCalledWith(
      "code",
      ["/tmp/script.py"],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
      })
    );
  });

  if (process.platform === "darwin") {
    it("script:edit launches terminal editors through Terminal.app on macOS", async () => {
      const { configStore, commRouter } = setup();
      (configStore.getAll as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        pythonEditorCmd: "nvim {}",
      });
      (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        { payload: { path: "/tmp/script.py", file_path: "/tmp/script.py" } }
      );

      const edit = getHandler(IPC.script.edit);
      await edit({}, "kernel-1", "/tmp/script.py");

      expect(mocks.spawn).toHaveBeenCalledWith(
        "osascript",
        expect.arrayContaining([
          "-e",
          expect.stringContaining(`tell application "Terminal" to do script`),
        ]),
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
        })
      );
      expect(mocks.spawn).toHaveBeenCalledWith(
        "osascript",
        expect.arrayContaining([expect.stringContaining("'nvim' '/tmp/script.py'")]),
        expect.any(Object)
      );
    });
  }

  it("config:get returns current config object", async () => {
    const { configStore } = setup();
    (configStore.getAll as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      showPrivateVariables: true,
      showModuleVariables: false,
      showCallableVariables: true,
      autoRefreshNamespace: false,
      theme: "dark",
    } satisfies PDVConfig);

    const getConfig = getHandler(IPC.config.get);
    const result = (await getConfig({},)) as PDVConfig;

    expect(result).toEqual({
      showPrivateVariables: true,
      showModuleVariables: false,
      showCallableVariables: true,
      autoRefreshNamespace: false,
      theme: "dark",
    });
  });

  it("config:set merges partial updates and returns merged config", async () => {
    const { configStore } = setup();
    const configState: PDVConfig = {
      showPrivateVariables: false,
      showModuleVariables: false,
      showCallableVariables: false,
      autoRefreshNamespace: false,
      theme: "light",
    };
    (configStore.getAll as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ ...configState })
    );
    (configStore.set as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string, value: unknown) => {
        (configState as unknown as Record<string, unknown>)[key] = value;
      }
    );

    const setConfig = getHandler(IPC.config.set);
    const result = (await setConfig({}, {
      theme: "dark",
      showPrivateVariables: true,
    })) as PDVConfig;

    expect(configStore.set).toHaveBeenCalledWith("theme", "dark");
    expect(configStore.set).toHaveBeenCalledWith("showPrivateVariables", true);
    expect(result).toEqual({
      showPrivateVariables: true,
      showModuleVariables: false,
      showCallableVariables: false,
      autoRefreshNamespace: false,
      theme: "dark",
    });
  });

  it("forwards pdv.tree.changed pushes to renderer via webContents.send", () => {
    const { commRouter, webContentsSend } = setup();
    registerCommPushForwarding(
      { webContents: { send: webContentsSend } } as unknown as BrowserWindow,
      commRouter,
      { cacheKernelSaveResults: vi.fn() } as unknown as ProjectManager,
    );

    const onPushCalls = (commRouter.onPush as unknown as ReturnType<typeof vi.fn>)
      .mock.calls;
    const treeCall = onPushCalls.find(([type]) => type === PDVMessageType.TREE_CHANGED);
    const treeHandler = treeCall?.[1] as ((message: PDVMessage) => void) | undefined;
    if (!treeHandler) {
      throw new Error("pdv.tree.changed push handler was not registered");
    }

    treeHandler(
      makeMessage({
        changed_paths: ["x"],
        change_type: "updated",
      })
    );

    expect(webContentsSend).toHaveBeenCalledWith(IPC.push.treeChanged, {
      changed_paths: ["x"],
      change_type: "updated",
    });
  });

  it("forwards pdv.project.loaded pushes to renderer via webContents.send", () => {
    const { commRouter, webContentsSend } = setup();

    const onPushCalls = (commRouter.onPush as unknown as ReturnType<typeof vi.fn>)
      .mock.calls;
    const projectCall = onPushCalls.find(
      ([type]) => type === PDVMessageType.PROJECT_LOADED
    );
    const projectHandler = projectCall?.[1] as
      | ((message: PDVMessage) => void)
      | undefined;
    if (!projectHandler) {
      throw new Error("pdv.project.loaded push handler was not registered");
    }

    projectHandler(makeMessage({ project_path: "/tmp/project" }));

    expect(webContentsSend).toHaveBeenCalledWith(IPC.push.projectLoaded, {
      project_path: "/tmp/project",
    });
  });

  it("kernels:stop awaits shutdown and returns true", async () => {
    const { kernelManager } = setup();
    const stop = getHandler(IPC.kernels.stop);
    const result = await stop({}, "kernel-1");
    expect(kernelManager.stop).toHaveBeenCalledWith("kernel-1");
    expect(result).toBe(true);
  });

  it("script:run fires pdv.module.reload_libs preflight for module-owned scripts", async () => {
    const { kernelManager, commRouter } = setup();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockClear();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { reloaded: [], errors: {} },
    });

    const run = getHandler(IPC.script.run);
    await run({}, "kernel-1", {
      treePath: "n_pendulum.scripts.solve",
      params: {},
      executionId: "exec-reload-1",
      origin: "test",
    });

    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.MODULE_RELOAD_LIBS,
      { alias: "n_pendulum" },
    );
    expect(kernelManager.execute).toHaveBeenCalled();
  });

  it("script:run skips reload_libs preflight for non-nested scripts", async () => {
    const { commRouter } = setup();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockClear();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { result: null },
    });

    const run = getHandler(IPC.script.run);
    await run({}, "kernel-1", {
      treePath: "my_script",
      params: {},
      executionId: "exec-reload-2",
      origin: "test",
    });

    const calls = (commRouter.request as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const reloadCalls = calls.filter((c: unknown[]) => c[0] === PDVMessageType.MODULE_RELOAD_LIBS);
    expect(reloadCalls).toHaveLength(0);
  });

  it("script:run swallows reload_libs errors and still runs the script", async () => {
    const { kernelManager, commRouter } = setup();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockClear();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (type: string) => {
        if (type === PDVMessageType.MODULE_RELOAD_LIBS) {
          throw new Error("reload exploded");
        }
        return { payload: {} };
      }
    );

    const run = getHandler(IPC.script.run);
    await expect(
      run({}, "kernel-1", {
        treePath: "n_pendulum.scripts.solve",
        params: {},
        executionId: "exec-reload-3",
        origin: "test",
      })
    ).resolves.toBeDefined();
    expect(kernelManager.execute).toHaveBeenCalled();
  });

  it("kernels:execute delegates to KernelManager.execute", async () => {
    const { kernelManager } = setup();
    const execute = getHandler(IPC.kernels.execute);
    const result = await execute({}, "kernel-1", { code: "1+1" });
    expect(kernelManager.execute).toHaveBeenCalledWith("kernel-1", { code: "1+1" }, expect.any(Function));
    expect(result).toEqual({ result: 2 });
  });

  it("kernels:interrupt delegates to KernelManager.interrupt and returns true", async () => {
    const { kernelManager } = setup();
    const interrupt = getHandler(IPC.kernels.interrupt);
    const result = await interrupt({}, "kernel-1");
    expect(kernelManager.interrupt).toHaveBeenCalledWith("kernel-1");
    expect(result).toBe(true);
  });

  it("kernels:restart falls back to stop+start when restart() is absent", async () => {
    const { kernelManager } = setup();
    const restart = getHandler(IPC.kernels.restart);
    const result = (await restart({}, "kernel-1")) as KernelInfo;
    expect(kernelManager.stop).toHaveBeenCalledWith("kernel-1");
    expect(kernelManager.start).toHaveBeenCalled();
    expect(result).toMatchObject({ id: expect.any(String), status: "idle" });
  });

  it("kernels:complete delegates to KernelManager.complete", async () => {
    const { kernelManager } = setup();
    const complete = getHandler(IPC.kernels.complete);
    const result = (await complete({}, "kernel-1", "import ", 7)) as {
      matches: string[];
      cursor_start: number;
      cursor_end: number;
    };
    expect(kernelManager.complete).toHaveBeenCalledWith("kernel-1", "import ", 7);
    expect(result).toEqual({
      matches: ["import"],
      cursor_start: 0,
      cursor_end: 6,
    });
  });

  it("kernels:inspect delegates to KernelManager.inspect", async () => {
    const { kernelManager } = setup();
    const inspect = getHandler(IPC.kernels.inspect);
    const result = (await inspect({}, "kernel-1", "x", 0)) as {
      found: boolean;
      data?: Record<string, string>;
    };
    expect(kernelManager.inspect).toHaveBeenCalledWith("kernel-1", "x", 0);
    expect(result).toEqual({ found: true, data: { "text/plain": "doc" } });
  });

  it("kernels:validate returns valid when pdv is installed", async () => {
    const { kernelManager: _ } = setup();
    vi.spyOn(EnvironmentDetector, "checkPDVInstalled").mockResolvedValueOnce({
      installed: true,
      version: "1.0.0",
      compatible: true,
    });
    const validate = getHandler(IPC.kernels.validate);
    const result = (await validate({}, "/usr/bin/python3", "python")) as {
      valid: boolean;
    };
    expect(result).toEqual({ valid: true });
  });

  it("kernels:validate returns invalid for empty path", async () => {
    const { kernelManager: _ } = setup();
    const validate = getHandler(IPC.kernels.validate);
    const result = (await validate({}, "  ", "python")) as {
      valid: boolean;
      error: string;
    };
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("kernels:validate returns invalid when pdv is missing", async () => {
    const { kernelManager: _ } = setup();
    vi.spyOn(EnvironmentDetector, "checkPDVInstalled").mockResolvedValueOnce({
      installed: false,
      version: null,
      compatible: false,
    });

    const validate = getHandler(IPC.kernels.validate);
    const result = (await validate({}, "/usr/bin/python3", "python")) as {
      valid: boolean;
      error?: string;
    };

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing pdv");
  });

  it("tree:createScript sends correct payload to kernel and returns scriptPath", async () => {
    const { commRouter } = setup();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage({})
    );

    const createScript = getHandler(IPC.tree.createScript);
    const result = (await createScript({}, "kernel-1", "scripts", "analysis")) as {
      success: boolean;
      scriptPath: string;
    };

    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.SCRIPT_REGISTER,
      expect.objectContaining({
        parent_path: "scripts",
        name: "analysis",
        uuid: expect.stringMatching(/^[0-9a-f]{12}$/),
        filename: "analysis.py",
        language: "python",
      })
    );
    expect(result.success).toBe(true);
    expect(result.scriptPath).toBeTruthy();
  });

  it("tree:createScript inside a module subtree sets source_rel_path + module_id", async () => {
    const { commRouter } = setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    // Register a pending in-session module so the handler's
    // getKnownModuleAliases helper sees "toy" as a known alias.
    await (getHandler(IPC.modules.createEmpty) as unknown as (
      e: Record<string, never>,
      req: { id: string; name: string; version: string },
    ) => Promise<unknown>)({}, { id: "toy", name: "Toy", version: "0.1.0" });
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockClear();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage({})
    );

    const createScript = getHandler(IPC.tree.createScript);
    await createScript({}, "kernel-1", "toy.scripts", "hello");

    const scriptRegisterCalls = (commRouter.request as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === PDVMessageType.SCRIPT_REGISTER);
    expect(scriptRegisterCalls.length).toBeGreaterThanOrEqual(1);
    const payload = scriptRegisterCalls[scriptRegisterCalls.length - 1][1];
    expect(payload).toEqual(
      expect.objectContaining({
        parent_path: "toy.scripts",
        name: "hello",
        module_id: "toy",
        source_rel_path: "scripts/hello.py",
        uuid: expect.stringMatching(/^[0-9a-f]{12}$/),
        filename: "hello.py",
      }),
    );
  });

  it("tree:createLib writes a .py lib inside a module and registers with source_rel_path", async () => {
    const { commRouter } = setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    await (getHandler(IPC.modules.createEmpty) as unknown as (
      e: Record<string, never>,
      req: { id: string; name: string; version: string },
    ) => Promise<unknown>)({}, { id: "toy", name: "Toy", version: "0.1.0" });
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockClear();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage({})
    );

    const createLib = getHandler(IPC.tree.createLib);
    const result = (await createLib({}, "kernel-1", "toy.lib", "helpers")) as {
      success: boolean;
      libPath?: string;
      treePath?: string;
    };

    expect(result.success).toBe(true);
    expect(result.libPath).toMatch(/helpers\.py$/);
    expect(result.treePath).toBe("toy.lib.helpers");

    const fileRegisterCalls = (commRouter.request as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === PDVMessageType.FILE_REGISTER);
    expect(fileRegisterCalls.length).toBeGreaterThanOrEqual(1);
    const payload = fileRegisterCalls[fileRegisterCalls.length - 1][1];
    expect(payload).toEqual(
      expect.objectContaining({
        tree_path: "toy.lib",
        filename: "helpers.py",
        uuid: expect.stringMatching(/^[0-9a-f]{12}$/),
        node_type: "lib",
        module_id: "toy",
        source_rel_path: "lib/helpers.py",
      }),
    );
  });

  it("tree:createLib creates standalone libs outside modules without module_id", async () => {
    const { commRouter } = setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage({})
    );

    const createLib = getHandler(IPC.tree.createLib);
    const result = (await createLib({}, "kernel-1", "free_floating", "helpers")) as {
      success: boolean;
      libPath?: string;
      treePath?: string;
    };
    expect(result.success).toBe(true);
    expect(result.treePath).toBe("free_floating.helpers");

    const fileRegisterCalls = (commRouter.request as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === PDVMessageType.FILE_REGISTER);
    expect(fileRegisterCalls.length).toBeGreaterThanOrEqual(1);
    const payload = fileRegisterCalls[fileRegisterCalls.length - 1][1];
    expect(payload).toEqual(
      expect.objectContaining({
        tree_path: "free_floating",
        filename: "helpers.py",
        node_type: "lib",
      }),
    );
    expect(payload.module_id).toBeUndefined();
    expect(payload.source_rel_path).toBeUndefined();
  });

  it("tree:createNote sends correct payload to kernel and returns notePath", async () => {
    const { commRouter } = setup();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage({})
    );

    const createNote = getHandler(IPC.tree.createNote);
    const result = (await createNote({}, "kernel-1", "notes", "derivation")) as {
      success: boolean;
      notePath: string;
    };

    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.NOTE_REGISTER,
      expect.objectContaining({
        parent_path: "notes",
        name: "derivation",
        uuid: expect.stringMatching(/^[0-9a-f]{12}$/),
        filename: "derivation.md",
      })
    );
    expect(result.success).toBe(true);
    expect(result.notePath).toBeTruthy();
  });

  it("files:pickExecutable returns selected file path", async () => {
    setup();
    mocks.dialogShowOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/usr/bin/python3"],
    });
    const pickExecutable = getHandler(IPC.files.pickExecutable);
    const result = await pickExecutable({});
    expect(result).toBe("/usr/bin/python3");
  });

  it("files:pickDirectory returns null on cancel", async () => {
    setup();
    mocks.dialogShowOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    const pickDirectory = getHandler(IPC.files.pickDirectory);
    const result = await pickDirectory({});
    expect(result).toBeNull();
  });

  it("files:pickFile returns selected file path", async () => {
    setup();
    mocks.dialogShowOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/config.toml"],
    });
    const pickFile = getHandler(IPC.files.pickFile);
    const result = await pickFile({});
    expect(result).toBe("/tmp/config.toml");
  });

  it("project:save delegates to ProjectManager.save", async () => {
    const { projectManager } = setup();
    const save = getHandler(IPC.project.save);
    const cells = { tabs: [], activeTabId: 1 };
    const result = await save({}, "/tmp/project", cells);
    expect(projectManager.save).toHaveBeenCalledWith("/tmp/project", cells, {
      language: "python",
      interpreterPath: undefined,
    });
    expect(result).toEqual({ checksum: "abc123", nodeCount: 0 });
  });

  it("project:save mirrors module-owned files into saveDir/modules/<id>/<source_rel_path>", async () => {
    const { projectManager } = setup();
    (projectManager.save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      checksum: "abc123",
      nodeCount: 1,
      moduleOwnedFiles: [
        {
          module_id: "my_mod",
          source_rel_path: "scripts/run.py",
          workdir_path: "/tmp/pdv-test/my_mod/scripts/run.py",
        },
        {
          module_id: "my_mod",
          source_rel_path: "lib/helpers.py",
          workdir_path: "/tmp/pdv-test/my_mod/lib/helpers.py",
        },
      ],
      missingFiles: [],
    });
    const save = getHandler(IPC.project.save);
    await save({}, "/tmp/project", { tabs: [], activeTabId: 1 });

    const scriptsDest = path.join("/tmp/project", "modules", "my_mod", "scripts/run.py");
    const libDest = path.join("/tmp/project", "modules", "my_mod", "lib/helpers.py");
    expect(mocks.fsMkdir).toHaveBeenCalledWith(path.dirname(scriptsDest), { recursive: true });
    expect(mocks.fsMkdir).toHaveBeenCalledWith(path.dirname(libDest), { recursive: true });
    expect(mocks.fsCopyFile).toHaveBeenCalledWith(
      path.resolve("/tmp/pdv-test/my_mod/scripts/run.py"),
      path.resolve(scriptsDest),
    );
    expect(mocks.fsCopyFile).toHaveBeenCalledWith(
      path.resolve("/tmp/pdv-test/my_mod/lib/helpers.py"),
      path.resolve(libDest),
    );
  });

  it("project:save writes pdv-module.json + module-index.json per module", async () => {
    const { projectManager } = setup();
    (projectManager.save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      checksum: "abc",
      nodeCount: 5,
      moduleOwnedFiles: [],
      moduleManifests: [
        {
          module_id: "toy",
          name: "Toy",
          version: "0.1.0",
          description: "smoke",
          language: "python",
          entries: [
            {
              id: "scripts",
              path: "scripts",
              key: "scripts",
              parent_path: "",
              type: "folder",
              storage: { backend: "none", format: "none" },
              metadata: { preview: "folder" },
            },
          ],
        },
      ],
      missingFiles: [],
    });
    const save = getHandler(IPC.project.save);
    await save({}, "/tmp/project", { tabs: [], activeTabId: 1 });

    const manifestWrites = (mocks.fsWriteFile as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => String(c[0]).includes("modules/toy/"));
    const paths = manifestWrites.map((c) => String((c as unknown[])[0]));
    expect(paths.some((p) => p.endsWith("pdv-module.json"))).toBe(true);
    expect(paths.some((p) => p.endsWith("module-index.json"))).toBe(true);
    const manifestBody = String(
      (manifestWrites.find((c) => String((c as unknown[])[0]).endsWith("pdv-module.json")) as unknown[])[1],
    );
    expect(manifestBody).toContain('"schema_version": "4"');
    expect(manifestBody).toContain('"id": "toy"');
    expect(manifestBody).toContain('"description": "smoke"');
  });

  it("project:save swallows ENOENT from missing working-dir files during sync", async () => {
    const { projectManager } = setup();
    (projectManager.save as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      checksum: "abc123",
      nodeCount: 1,
      moduleOwnedFiles: [
        {
          module_id: "my_mod",
          source_rel_path: "scripts/gone.py",
          workdir_path: "/tmp/pdv-test/my_mod/scripts/gone.py",
        },
      ],
      missingFiles: [],
    });
    (mocks.fsCopyFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Promise.reject(err);
    });
    const save = getHandler(IPC.project.save);
    // Handler must not throw when a module-owned file disappeared mid-save.
    await expect(save({}, "/tmp/project", { tabs: [], activeTabId: 1 })).resolves.toBeDefined();
  });

  it("project:load delegates to ProjectManager.load", async () => {
    const { projectManager } = setup();
    (projectManager.load as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      codeCells: [{ id: "box1" }],
      postLoadChecksum: null,
    });
    const load = getHandler(IPC.project.load);
    const result = await load({}, "/tmp/project");
    expect(projectManager.load).toHaveBeenCalledWith("/tmp/project", undefined);
    expect(result).toEqual({
      codeCells: [{ id: "box1" }],
      checksum: null,
      checksumValid: null,
      nodeCount: null,
      savedPdvVersion: "0.0.7",
      projectName: null,
    });
  });

  it("themes:get returns empty list initially, themes:save persists", async () => {
    setup();
    const get = getHandler(IPC.themes.get);
    expect(await get({})).toEqual([]);

    const save = getHandler(IPC.themes.save);
    await save({}, { name: "dark", colors: {} });

    const afterSave = await get({});
    expect(afterSave).toEqual([{ name: "dark", colors: {} }]);
  });

  it("menu:getModel returns the Linux-integrated top-level menus", async () => {
    setup();
    const getModel = getHandler(IPC.menu.getModel);

    const result = await getModel({});

    expect(result).toEqual([
      { id: "file", label: "File" },
      { id: "edit", label: "Edit" },
      { id: "view", label: "View" },
      { id: "window", label: "Window" },
      { id: "help", label: "Help" },
    ]);
  });

  it("chrome:getInfo returns platform-specific title-bar metadata", async () => {
    const { kernelManager } = setup();
    expect(kernelManager).toBeDefined();
    const getInfo = getHandler(IPC.chrome.getInfo);

    const result = await getInfo({});

    const platform =
      process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : "windows";
    expect(result).toEqual({
      platform,
      showCustomTitleBar: platform === "macos" || platform === "linux",
      showMenuBar: platform === "linux",
      showWindowControls: platform === "linux",
      isMaximized: false,
    });
  });

  it("codeCells:load returns null when no active kernel", async () => {
    // As of audit #5, code-cell persistence is scoped to the active
    // kernel's working directory rather than a global ~/.PDV/state file.
    // With no kernel started in this test harness, load must return null
    // (no file to read) and the handler must not throw.
    setup();
    const load = getHandler(IPC.codeCells.load);
    expect(await load({})).toBeNull();
  });

  it("modules:listInstalled delegates to ModuleManager.listInstalled", async () => {
    setup();
    const listInstalled = getHandler(IPC.modules.listInstalled);
    const result = await listInstalled({});
    expect(result).toEqual([]);
    expect(mocks.moduleManagerListInstalled).toHaveBeenCalledOnce();
  });

  it("modules:install delegates to ModuleManager.install", async () => {
    setup();
    const install = getHandler(IPC.modules.install);
    const request = {
      source: {
        type: "github",
        location: "https://github.com/example/pdv-module",
      },
    };
    const result = (await install({}, request)) as {
      success: boolean;
      status: string;
      module?: { id: string };
    };
    expect(result.success).toBe(true);
    expect(result.status).toBe("installed");
    expect(result.module?.id).toBe("demo-module");
    expect(mocks.moduleManagerInstall).toHaveBeenCalledWith(request);
  });

  it("modules:importToProject returns conflict when alias already exists", async () => {
    setup();
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");

    (mocks.moduleManagerListInstalled as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "demo-module",
        name: "Demo Module",
        version: "1.0.0",
        source: { type: "local", location: "/tmp/demo-module" },
      },
    ]);
    mocks.fsReadFile.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          {
            module_id: "demo-module",
            alias: "demo-module",
            version: "1.0.0",
          },
        ],
        module_settings: {},
      })
    );

    const importToProject = getHandler(IPC.modules.importToProject);
    const result = (await importToProject({}, {
      moduleId: "demo-module",
    })) as { success: boolean; status: string; suggestedAlias?: string };

    expect(result.success).toBe(false);
    expect(result.status).toBe("conflict");
    expect(result.suggestedAlias).toBe("demo-module_1");
  });

  it("modules:importToProject persists manifest on successful import", async () => {
    const { commRouter, webContentsSend } = setup();
    (mocks.moduleManagerEvaluateHealth as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { code: "dependency_unverified", message: "Dependency requirement not auto-validated: numpy >=1.26" },
    ]);
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");

    (mocks.moduleManagerListInstalled as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "demo-module",
        name: "Demo Module",
        version: "1.0.0",
        revision: "abc123",
        source: { type: "local", location: "/tmp/demo-module" },
      },
    ]);
    mocks.fsReadFile.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [],
        module_settings: {},
      })
    );
    (mocks.moduleManagerResolveModuleDir as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue("/tmp/demo-module");
    (mocks.moduleManagerReadModuleIndex as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        {
          id: "scripts.run",
          path: "scripts.run",
          key: "run",
          parent_path: "scripts",
          type: "script",
          has_children: false,
          lazy: false,
          storage: {
            backend: "local_file",
            relative_path: "scripts/run.py",
            format: "py_script",
          },
          metadata: { language: "python" },
        },
      ]);

    const importToProject = getHandler(IPC.modules.importToProject);
    const result = (await importToProject({}, {
      moduleId: "demo-module",
    })) as {
      success: boolean;
      status: string;
      alias?: string;
      warnings?: Array<{ code: string; message: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.status).toBe("imported");
    expect(result.alias).toBe("demo-module");
    expect(result.warnings).toEqual([
      { code: "dependency_unverified", message: "Dependency requirement not auto-validated: numpy >=1.26" },
    ]);
    expect(mocks.fsWriteFile).toHaveBeenCalledWith(
      "/tmp/project/project.json",
      expect.stringContaining('"module_id": "demo-module"'),
      "utf8"
    );
    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.MODULE_REGISTER,
      expect.objectContaining({
        path: "demo-module",
        module_id: "demo-module",
        name: "Demo Module",
        version: "1.0.0",
        module_index: expect.arrayContaining([
          expect.objectContaining({
            id: "scripts.run",
            uuid: expect.stringMatching(/^[0-9a-f]{12}$/),
            storage: expect.objectContaining({
              backend: "local_file",
              uuid: expect.stringMatching(/^[0-9a-f]{12}$/),
              filename: "run.py",
            }),
          }),
        ]),
      })
    );
    expect(webContentsSend).toHaveBeenCalledWith(
      IPC.push.treeChanged,
      expect.objectContaining({
        changed_paths: ["demo-module"],
        change_type: "updated",
      })
    );
  });

  it("modules:createEmpty seeds workdir + calls MODULE_CREATE_EMPTY comm", async () => {
    const { commRouter } = setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    // No active project dir — exercise the in-memory pending-imports branch.
    (mocks.fsReadFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockClear();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { path: "toy" },
    });

    const create = getHandler(IPC.modules.createEmpty);
    const result = (await create({}, {
      id: "toy",
      name: "Toy",
      version: "0.1.0",
      description: "a toy",
      language: "python",
    })) as { success: boolean; status?: string; alias?: string };

    expect(result.success).toBe(true);
    expect(result.alias).toBe("toy");
    // No alias-based scaffolding — UUID dirs are created when individual
    // nodes (scripts, libs, etc.) are added via tree:create* handlers.
    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.MODULE_CREATE_EMPTY,
      expect.objectContaining({
        id: "toy",
        name: "Toy",
        version: "0.1.0",
        description: "a toy",
        language: "python",
      }),
    );
    // A MODULES_SETUP must follow MODULE_CREATE_EMPTY so the kernel walker
    // establishes sys.path for the fresh in-session module. The payload
    // must identify the module by alias only — no pre-computed lib_dir.
    const requestCalls = (
      commRouter.request as unknown as ReturnType<typeof vi.fn>
    ).mock.calls;
    const createIdx = requestCalls.findIndex(
      ([type]) => type === PDVMessageType.MODULE_CREATE_EMPTY,
    );
    const setupIdx = requestCalls.findIndex(
      ([type]) => type === PDVMessageType.MODULES_SETUP,
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeGreaterThan(createIdx);
    expect(requestCalls[setupIdx][1]).toEqual({
      modules: [{ alias: "toy" }],
    });
  });

  it("modules:createEmpty returns conflict when the alias already exists", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");
    // Pre-populate the manifest with an existing "toy" module so the
    // create handler's collision check fires.
    mocks.fsReadFile.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [{ module_id: "toy", alias: "toy", version: "0.1.0" }],
        module_settings: {},
      }),
    );

    const create = getHandler(IPC.modules.createEmpty);
    const result = (await create({}, {
      id: "toy",
      name: "Toy",
      version: "0.1.0",
    })) as { success: boolean; status?: string; suggestedAlias?: string };

    expect(result.success).toBe(false);
    expect(result.status).toBe("conflict");
    expect(result.suggestedAlias).toBe("toy_1");
  });

  it("modules:exportFromProject copies saveDir/modules/<id> to the global store", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");
    mocks.fsReadFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          {
            module_id: "toy",
            alias: "toy",
            version: "0.1.0",
            origin: "in_session",
          },
        ],
        module_settings: {},
      }),
    );
    // First fs.stat resolves the source dir successfully; second (for the
    // destination) throws ENOENT so the handler skips the overwrite prompt.
    (mocks.fsStat as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

    const exportFromProject = getHandler(IPC.modules.exportFromProject);
    const result = (await exportFromProject({}, { alias: "toy" })) as {
      success: boolean;
      status?: string;
      destination?: string;
    };

    expect(result.success).toBe(true);
    expect(result.status).toBe("exported");
    expect(result.destination).toBe("/tmp/pdv-global/modules/packages/toy");
    expect(mocks.fsCp).toHaveBeenCalledWith(
      "/tmp/project/modules/toy",
      "/tmp/pdv-global/modules/packages/toy",
      { recursive: true, force: true },
    );
    // The freshly-copied directory must be registered in the global-store
    // index so listInstalled picks it up on the next call — otherwise the
    // Import dialog won't see what the user just exported.
    expect(mocks.moduleManagerRegisterInGlobalStore).toHaveBeenCalledWith(
      "/tmp/pdv-global/modules/packages/toy",
    );
    // No confirm prompt when the destination didn't exist.
    expect(mocks.dialogShowMessageBox).not.toHaveBeenCalled();
  });

  it("modules:exportFromProject prompts to overwrite when global store already has the module", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");
    mocks.fsReadFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          { module_id: "toy", alias: "toy", version: "0.1.0" },
        ],
        module_settings: {},
      }),
    );
    (mocks.fsStat as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ isDirectory: () => true }) // source exists
      .mockResolvedValueOnce({ isDirectory: () => true }); // destination exists
    (mocks.dialogShowMessageBox as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ response: 0 }); // user picks "Overwrite"

    const exportFromProject = getHandler(IPC.modules.exportFromProject);
    const result = (await exportFromProject({}, { alias: "toy" })) as {
      success: boolean;
      status?: string;
    };

    expect(mocks.dialogShowMessageBox).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.status).toBe("exported");
    expect(mocks.fsCp).toHaveBeenCalled();
  });

  it("modules:exportFromProject returns cancelled when the user declines overwrite", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");
    mocks.fsReadFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [{ module_id: "toy", alias: "toy", version: "0.1.0" }],
        module_settings: {},
      }),
    );
    (mocks.fsStat as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true });
    (mocks.dialogShowMessageBox as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ response: 1 }); // user cancels
    (mocks.fsCp as unknown as ReturnType<typeof vi.fn>).mockClear();

    const exportFromProject = getHandler(IPC.modules.exportFromProject);
    const result = (await exportFromProject({}, { alias: "toy" })) as {
      success: boolean;
      status?: string;
    };

    expect(result.success).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(mocks.fsCp).not.toHaveBeenCalled();
  });

  it("modules:exportFromProject rejects when no project directory is active", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    // Intentionally skip project:load so activeProjectDir stays null.

    const exportFromProject = getHandler(IPC.modules.exportFromProject);
    const result = (await exportFromProject({}, { alias: "toy" })) as {
      success: boolean;
      status?: string;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.status).toBe("not_saved");
  });

  it("modules:updateMetadata forwards to MODULE_UPDATE comm", async () => {
    const { commRouter } = setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockClear();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        alias: "toy",
        name: "Toy (renamed)",
        version: "0.2.0",
        description: "new",
      },
    });

    const update = getHandler(IPC.modules.updateMetadata);
    const result = (await update({}, {
      alias: "toy",
      name: "Toy (renamed)",
      version: "0.2.0",
      description: "new",
    })) as { success: boolean; version?: string };

    expect(result.success).toBe(true);
    expect(result.version).toBe("0.2.0");
    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.MODULE_UPDATE,
      expect.objectContaining({ alias: "toy", version: "0.2.0" }),
    );
  });

  it("modules:listImported returns project imports with installed names", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");

    (mocks.moduleManagerListInstalled as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "demo-module",
        name: "Demo Module",
        version: "1.0.0",
        source: { type: "local", location: "/tmp/demo-module" },
      },
    ]);
    mocks.fsReadFile.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          {
            module_id: "demo-module",
            alias: "demo-module",
            version: "1.0.0",
            revision: "abc123",
          },
        ],
        module_settings: {
          "demo-module": {
            "run-action": { threshold: 7 },
          },
        },
      })
    );

    const listImported = getHandler(IPC.modules.listImported);
    const result = (await listImported({})) as Array<{
      moduleId: string;
      name: string;
      alias: string;
      version: string;
      revision?: string;
      actions: Array<{ id: string; label: string; scriptName: string }>;
      settings: Record<string, unknown>;
      warnings: Array<{ code: string; message: string }>;
    }>;

    expect(result).toEqual([
      {
        moduleId: "demo-module",
        name: "Demo Module",
        alias: "demo-module",
        version: "1.0.0",
        revision: "abc123",
        hasGui: true,
        inputs: [{ id: "threshold", label: "Threshold", type: "int", default: "5" }],
        actions: [{ id: "run-action", label: "Run", scriptName: "run", inputIds: ["threshold"] }],
        settings: {
          "run-action": { threshold: 7 },
        },
        warnings: [],
      },
    ]);
  });

  it("modules:listImported includes action tab metadata when provided", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    // listImported calls resolveActionScripts — provide the tab metadata.
    (mocks.moduleManagerResolveActionScripts as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        {
          actionId: "run-action",
          actionLabel: "Run",
          name: "run",
          scriptPath: "/tmp/demo-module/scripts/run.py",
          inputIds: ["threshold"],
          actionTab: "Run",
        },
      ]);
    mocks.fsReadFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          {
            module_id: "demo-module",
            alias: "demo-module",
            version: "1.0.0",
          },
        ],
        module_settings: {},
      })
    );
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");

    const listImported = getHandler(IPC.modules.listImported);
    const result = (await listImported({})) as Array<{
      actions: Array<{ id: string; label: string; scriptName: string; inputIds?: string[]; tab?: string }>;
    }>;

    expect(result[0]?.actions).toEqual([
      { id: "run-action", label: "Run", scriptName: "run", inputIds: ["threshold"], tab: "Run" },
    ]);
  });

  it("modules:listImported surfaces missing-script warnings without throwing", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });
    // evaluateHealth is called during refreshProjectModuleHealth (load).
    // listImported reads health warnings from memory (moduleHealthWarningsByAlias).
    (mocks.moduleManagerEvaluateHealth as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { code: "missing_action_script", message: "Action script not found: scripts/run.py" },
      ]);
    // listImported calls resolveActionScripts — needs to fail with MissingActionScriptError.
    (mocks.moduleManagerResolveActionScripts as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new Error("Module action script does not exist: scripts/run.py (demo-module)")
      );
    mocks.fsReadFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          {
            module_id: "demo-module",
            alias: "demo-module",
            version: "1.0.0",
          },
        ],
        module_settings: {},
      })
    );
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");

    const listImported = getHandler(IPC.modules.listImported);
    const result = (await listImported({})) as Array<{
      actions: Array<{ id: string; label: string; scriptName: string }>;
      warnings: Array<{ code: string; message: string }>;
    }>;

    expect(result[0]?.actions).toEqual([]);
    expect(result[0]?.warnings).toEqual([
      { code: "missing_action_script", message: "Action script not found: scripts/run.py" },
    ]);
  });

  it("modules:saveSettings persists module settings for imported alias", async () => {
    setup();
    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");
    const manifestJson = JSON.stringify({
      schema_version: "1.1",
      saved_at: "2026-01-01T00:00:00.000Z",
      pdv_version: getAppVersion(),
      tree_checksum: "",
      modules: [
        {
          module_id: "demo-module",
          alias: "demo-module",
          version: "1.0.0",
        },
      ],
      module_settings: {},
    });
    // Two reads: readActiveProjectManifest + re-read inside runWithProjectManifestWriteLock
    mocks.fsReadFile.mockResolvedValueOnce(manifestJson);
    mocks.fsReadFile.mockResolvedValueOnce(manifestJson);

    const saveSettings = getHandler(IPC.modules.saveSettings);
    const result = (await saveSettings({}, {
      moduleAlias: "demo-module",
      values: {
        "run-action": { threshold: 9 },
      },
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mocks.fsWriteFile).toHaveBeenCalledWith(
      "/tmp/project/project.json",
      expect.stringContaining('"threshold": 9'),
      "utf8"
    );
  });

  it("serializes manifest writes for concurrent import and settings updates", async () => {
    setup();
    let manifestState = {
      schema_version: "1.1",
      saved_at: "2026-01-01T00:00:00.000Z",
      pdv_version: getAppVersion(),
      tree_checksum: "",
      modules: [
        {
          module_id: "demo-module",
          alias: "demo-module",
          version: "1.0.0",
        },
      ],
      module_settings: {},
    };
    mocks.fsReadFile.mockImplementation(async (filePath: string) => {
      const normalized = String(filePath);
      if (normalized.endsWith("tree-index.json")) {
        const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        throw err;
      }
      if (normalized.endsWith("project.json")) {
        return JSON.stringify(manifestState);
      }
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    });
    mocks.fsWriteFile.mockImplementation(async (filePath: string, content: string) => {
      if (String(filePath).endsWith("project.json")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        manifestState = JSON.parse(content);
      }
    });
    (mocks.moduleManagerListInstalled as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "new-module",
        name: "New Module",
        version: "1.0.0",
        source: { type: "local", location: "/tmp/new-module" },
      },
    ]);

    const projectLoad = getHandler(IPC.project.load);
    await projectLoad({}, "/tmp/project");

    const importToProject = getHandler(IPC.modules.importToProject);
    const saveSettings = getHandler(IPC.modules.saveSettings);
    const [importResult, saveResult] = await Promise.all([
      importToProject({}, { moduleId: "new-module" }) as Promise<{ success: boolean }>,
      saveSettings({}, {
        moduleAlias: "demo-module",
        values: {
          "run-action": { threshold: 9 },
        },
      }) as Promise<{ success: boolean }>,
    ]);

    expect(importResult.success).toBe(true);
    expect(saveResult.success).toBe(true);
    expect(manifestState.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: "demo-module" }),
        expect.objectContaining({ alias: "new-module" }),
      ])
    );
    expect(manifestState.module_settings).toEqual(
      expect.objectContaining({
        "demo-module": {
          "run-action": { threshold: 9 },
        },
      })
    );
  });

  it("modules:runAction returns execution code for imported module action", async () => {
    setup();
    mocks.fsReadFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          {
            module_id: "demo-module",
            alias: "demo-module",
            version: "1.0.0",
          },
        ],
        module_settings: {},
      })
    );
    const start = getHandler(IPC.kernels.start);
    const kernel = (await start({}, { language: "python" })) as { id: string };
    const load = getHandler(IPC.project.load);
    await load({}, "/tmp/project");

    const runAction = getHandler(IPC.modules.runAction);
    const result = (await runAction({}, {
      kernelId: kernel.id,
      moduleAlias: "demo-module",
      actionId: "run-action",
      inputValues: { threshold: "5" },
    })) as { success: boolean; status: string; executionCode?: string };

    expect(result.success).toBe(true);
    expect(result.status).toBe("queued");
    expect(result.executionCode).toBe(
      'pdv_tree["demo-module.scripts.run"].run(threshold=5)'
    );
  });

  it("modules:runAction quotes unsafe string input values", async () => {
    setup();
    mocks.fsReadFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          {
            module_id: "demo-module",
            alias: "demo-module",
            version: "1.0.0",
          },
        ],
        module_settings: {},
      })
    );
    const start = getHandler(IPC.kernels.start);
    const kernel = (await start({}, { language: "python" })) as { id: string };
    const load = getHandler(IPC.project.load);
    await load({}, "/tmp/project");

    const runAction = getHandler(IPC.modules.runAction);
    const result = (await runAction({}, {
      kernelId: kernel.id,
      moduleAlias: "demo-module",
      actionId: "run-action",
      inputValues: { threshold: "5); __import__('os').system('evil')#" },
    })) as { success: boolean; status: string; executionCode?: string };

    expect(result.success).toBe(true);
    expect(result.status).toBe("queued");
    expect(result.executionCode).toBe(
      `pdv_tree["demo-module.scripts.run"].run(threshold='5); __import__(\\'os\\').system(\\'evil\\')#')`
    );
  });

  it("kernels:start fails fast when selected runtime lacks pdv", async () => {
    const { kernelManager } = setup();
    vi.spyOn(EnvironmentDetector, "checkPDVInstalled").mockResolvedValueOnce({
      installed: false,
      version: null,
      compatible: false,
    });

    const start = getHandler(IPC.kernels.start);
    await expect(
      start({}, { language: "python", env: { PYTHON_PATH: "/usr/bin/python3" } })
    ).rejects.toThrow("missing pdv");
    expect(kernelManager.start).not.toHaveBeenCalled();
  });

  it("project:load no longer calls bindActiveProjectModules", async () => {
    setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });

    // tree-index.json read (from copyFilesForLoad) → no file-backed nodes in test project
    mocks.fsReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    // project.json read (from ProjectManager.readManifest inside refreshProjectModuleHealth)
    mocks.fsReadFile.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: getAppVersion(),
        tree_checksum: "",
        modules: [
          {
            module_id: "demo-module",
            alias: "diagnosticA",
            version: "1.0.0",
          },
        ],
        module_settings: {},
      })
    );

    const load = getHandler(IPC.project.load);
    await load({}, "/tmp/project");

    // resolveActionScripts should NOT be called during load
    // (module binding is now handled by setupModuleNamespaces via pdv.modules.setup comm)
    expect(mocks.moduleManagerResolveActionScripts).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Autosave IPC handlers
  // -------------------------------------------------------------------------

  it("autosave:clear delegates to ProjectManager.clearAutosave with the given dir", async () => {
    const { projectManager } = setup();
    const clear = getHandler(IPC.autosave.clear);

    await clear({}, "/tmp/some-project");

    // ProjectManager.clearAutosave is a static method that fs.rms <dir>/.autosave/
    // and the handler also marks the per-instance cache dirty.
    expect(mocks.fsRm).toHaveBeenCalledWith(
      path.join("/tmp/some-project", ".autosave"),
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(projectManager.markAutosaveCacheDirty).toHaveBeenCalledOnce();
  });

  it("autosave:check returns exists=false when tree-index.json is absent", async () => {
    setup();
    const check = getHandler(IPC.autosave.check);

    // fsStat default mock throws ENOENT, so the static checkForAutosave
    // returns { exists: false }.
    const result = await check({}, "/tmp/no-autosave");
    expect(result).toEqual({ exists: false });
  });

  it("autosave:scanWorkingDirs returns [] for an empty workingDirBase", async () => {
    setup();
    const scan = getHandler(IPC.autosave.scanWorkingDirs);
    // fsReaddir defaults to [] — no subdirectories under the base.
    const result = await scan({});
    expect(result).toEqual([]);
  });

  it("autosave:scanWorkingDirs surfaces orphans whose .autosave/tree-index.json exists", async () => {
    setup();
    const scan = getHandler(IPC.autosave.scanWorkingDirs);

    // Two subdirectories at the base; only `pdv-A` has a valid tree-index.
    mocks.fsReaddir.mockResolvedValueOnce([
      { name: "pdv-A", isDirectory: () => true } as unknown as never,
      { name: "pdv-B", isDirectory: () => true } as unknown as never,
      { name: "stray.txt", isDirectory: () => false } as unknown as never,
    ]);
    // checkForAutosave -> fs.stat(<dir>/.autosave/tree-index.json)
    // First call (pdv-A): success. Second call (pdv-B): ENOENT.
    mocks.fsStat.mockResolvedValueOnce({
      mtime: new Date("2026-05-04T12:00:00.000Z"),
    } as unknown as never);
    mocks.fsStat.mockImplementationOnce(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = (await scan({})) as { dir: string; timestamp: string }[];
    expect(result).toHaveLength(1);
    expect(result[0].dir).toMatch(/pdv-A$/);
    expect(result[0].timestamp).toBe("2026-05-04T12:00:00.000Z");
  });

  it("autosave:deleteOrphan removes the orphan dir recursively", async () => {
    setup();
    const deleteOrphan = getHandler(IPC.autosave.deleteOrphan);

    await deleteOrphan({}, "/tmp/orphan-session");

    expect(mocks.fsRm).toHaveBeenCalledWith(
      "/tmp/orphan-session",
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("autosave:recoverUnsaved throws when no kernel is active", async () => {
    setup();
    const recover = getHandler(IPC.autosave.recoverUnsaved);
    // No kernels.start has been awaited, so activeKernelId is null.
    await expect(recover({}, "/tmp/orphan")).rejects.toThrow(/no active kernel/i);
  });

  it("autosave:run returns { saved: false } when there is no working dir", async () => {
    setup();
    const run = getHandler(IPC.autosave.run);
    // No kernel started, no project loaded — handler must short-circuit.
    const result = await run({}, { tabs: [], activeTabId: 1 });
    expect(result).toEqual({ saved: false });
  });

  it("autosave:deleteOrphan refuses to remove the active session's working dir", async () => {
    const { kernelManager } = setup();
    const start = getHandler(IPC.kernels.start);
    const kernel = (await start({}, { language: "python" })) as KernelInfo;
    void kernelManager; // satisfy lint

    // Look up the working dir the kernel was assigned (the test mock uses
    // /tmp/pdv-test consistently — see ProjectManager.createWorkingDir mock).
    const deleteOrphan = getHandler(IPC.autosave.deleteOrphan);
    await expect(deleteOrphan({}, "/tmp/pdv-test")).rejects.toThrow(
      /active session/i,
    );
    expect(mocks.fsRm).not.toHaveBeenCalledWith(
      "/tmp/pdv-test",
      expect.anything(),
    );
    expect(kernel.id).toBeTruthy();
  });

  it("autosave:scanWorkingDirs filters out the active session's working dir", async () => {
    const { configStore } = setup();
    // Pin workingDirBase to /tmp so it matches the mock createWorkingDir
    // result ("/tmp/pdv-test"); without this they live in different roots
    // and the filter has nothing to filter.
    (configStore.set as unknown as ReturnType<typeof vi.fn>)("workingDirBase", "/tmp");

    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });

    // Two orphans on disk — one matches the active working dir, one doesn't.
    mocks.fsReaddir.mockResolvedValueOnce([
      { name: "pdv-test", isDirectory: () => true } as unknown as never,
      { name: "pdv-stale", isDirectory: () => true } as unknown as never,
    ]);
    // checkForAutosave -> fs.stat for each: both have valid tree-index.json.
    mocks.fsStat.mockResolvedValueOnce({
      mtime: new Date("2026-05-04T12:00:00.000Z"),
    } as unknown as never);
    mocks.fsStat.mockResolvedValueOnce({
      mtime: new Date("2026-05-04T13:00:00.000Z"),
    } as unknown as never);

    const scan = getHandler(IPC.autosave.scanWorkingDirs);
    const result = (await scan({})) as { dir: string; timestamp: string }[];

    // /tmp/pdv-test is the active working dir so it must be hidden from
    // the welcome screen. /tmp/pdv-stale stays.
    const dirs = result.map((r) => r.dir);
    expect(dirs).not.toContain("/tmp/pdv-test");
    expect(dirs).toContain("/tmp/pdv-stale");
  });

  it("unregisterIpcHandlers detaches the kernel:executionState listener", () => {
    const { kernelManager } = setup();
    // setup() calls registerIpcHandlers which attaches the listener.
    const onMock = kernelManager.on as unknown as ReturnType<typeof vi.fn>;
    const onCalls = onMock.mock.calls.filter(
      (c: unknown[]) => c[0] === "kernel:executionState",
    );
    expect(onCalls.length).toBe(1);
    const attachedListener = onCalls[0][1];

    unregisterIpcHandlers();

    const removeMock = kernelManager.removeListener as unknown as ReturnType<typeof vi.fn>;
    expect(removeMock).toHaveBeenCalledWith(
      "kernel:executionState",
      attachedListener,
    );
  });
});
