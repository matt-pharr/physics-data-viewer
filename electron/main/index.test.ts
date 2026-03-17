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

import { registerIpcHandlers, registerPushForwarding, unregisterIpcHandlers } from "./index";
import {
  IPC,
  type NamespaceVariable,
  type PDVConfig,
  type TreeNode,
} from "./ipc";
import { PDVMessageType, PDV_PROTOCOL_VERSION, type PDVMessage } from "./pdv-protocol";
import type { KernelInfo, KernelManager } from "./kernel-manager";
import type { CommRouter } from "./comm-router";
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
  const dialogShowOpenDialog = vi.fn();
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
    dialogShowOpenDialog,
    moduleManagerListInstalled,
    moduleManagerInstall,
    moduleManagerCheckUpdates,
    moduleManagerEvaluateHealth,
    moduleManagerResolveActionScripts,
    moduleManagerGetModuleInputs,
    moduleManagerGetModuleGuiInfo,
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: mocks.ipcHandle,
    removeHandler: mocks.ipcRemoveHandler,
  },
  dialog: {
    showOpenDialog: mocks.dialogShowOpenDialog,
  },
  app: {
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
    pdv_version: PDV_PROTOCOL_VERSION,
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
    getKernel: vi.fn(() => makeKernelInfo()),
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
    save: vi.fn(async () => undefined),
    load: vi.fn(async (_saveDir: string, onBeforePush?: () => Promise<void>) => {
      if (onBeforePush) await onBeforePush();
      return [];
    }),
    createWorkingDir: vi.fn(async () => "/tmp/pdv-test"),
    deleteWorkingDir: vi.fn(async () => undefined),
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

  registerIpcHandlers(win, kernelManager, commRouter, projectManager, configStore, os.tmpdir());

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
        lazy: false,
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
    const variables: NamespaceVariable[] = [{ name: "x", type: "int", preview: "42" }];
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

  it("script:edit spawns the configured external editor process", async () => {
    const { configStore } = setup();
    (configStore.getAll as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      showPrivateVariables: false,
      showModuleVariables: false,
      showCallableVariables: false,
      editorCommand: "code",
    });

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
      const { configStore } = setup();
      (configStore.getAll as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        showPrivateVariables: false,
        showModuleVariables: false,
        showCallableVariables: false,
        pythonEditorCmd: "nvim {}",
      });

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
      theme: "dark",
    } satisfies PDVConfig);

    const getConfig = getHandler(IPC.config.get);
    const result = (await getConfig({},)) as PDVConfig;

    expect(result).toEqual({
      showPrivateVariables: true,
      showModuleVariables: false,
      showCallableVariables: true,
      theme: "dark",
    });
  });

  it("config:set merges partial updates and returns merged config", async () => {
    const { configStore } = setup();
    const configState: PDVConfig = {
      showPrivateVariables: false,
      showModuleVariables: false,
      showCallableVariables: false,
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
      theme: "dark",
    });
  });

  it("forwards pdv.tree.changed pushes to renderer via webContents.send", () => {
    const { commRouter, webContentsSend } = setup();
    registerPushForwarding(
      { webContents: { send: webContentsSend } } as unknown as BrowserWindow,
      commRouter
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

  it("kernels:validate returns valid when pdv_kernel is installed", async () => {
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

  it("kernels:validate returns invalid when pdv_kernel is missing", async () => {
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
    expect(result.error).toContain("pdv_kernel");
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
        relative_path: expect.stringMatching(/analysis\.py$/),
        language: "python",
      })
    );
    expect(result.success).toBe(true);
    expect(result.scriptPath).toBeTruthy();
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
        relative_path: expect.stringMatching(/derivation\.md$/),
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
    const result = await save({}, "/tmp/project", []);
    expect(projectManager.save).toHaveBeenCalledWith("/tmp/project", []);
    expect(result).toBe(true);
  });

  it("project:load delegates to ProjectManager.load", async () => {
    const { projectManager } = setup();
    (projectManager.load as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "box1" },
    ]);
    const load = getHandler(IPC.project.load);
    const result = await load({}, "/tmp/project");
    expect(projectManager.load).toHaveBeenCalledWith("/tmp/project", expect.any(Function));
    expect(result).toEqual([{ id: "box1" }]);
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

  it("codeCells:load returns null initially, codeCells:save persists", async () => {
    setup();
    const load = getHandler(IPC.codeCells.load);
    expect(await load({})).toBeNull();

    const save = getHandler(IPC.codeCells.save);
    await save({}, { boxes: [{ id: "b1" }] });

    const afterSave = await load({});
    expect(afterSave).toEqual({ boxes: [{ id: "b1" }] });
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
        pdv_version: PDV_PROTOCOL_VERSION,
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

    (mocks.moduleManagerListInstalled as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
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
        pdv_version: PDV_PROTOCOL_VERSION,
        tree_checksum: "",
        modules: [],
        module_settings: {},
      })
    );

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
    expect(mocks.moduleManagerResolveActionScripts).toHaveBeenCalledWith("demo-module");
    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.SCRIPT_REGISTER,
      expect.objectContaining({
        parent_path: "demo-module.scripts",
        name: "run",
        relative_path: "/tmp/pdv-test/demo-module/scripts/run.py",
        reload: true,
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
        pdv_version: PDV_PROTOCOL_VERSION,
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
    // project:load's bindActiveProjectModules also calls resolveActionScripts — add an
    // extra Once for that call, then the second Once (with actionTab) is for listImported.
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
      ])
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
        pdv_version: PDV_PROTOCOL_VERSION,
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
    (mocks.moduleManagerEvaluateHealth as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { code: "missing_action_script", message: "Action script not found: scripts/run.py" },
    ]);
    // project:load's bindActiveProjectModules calls resolveActionScripts first (caught, returns early),
    // then listImported calls it again — both need to fail with MissingActionScriptError.
    (mocks.moduleManagerResolveActionScripts as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new Error("Module action script does not exist: scripts/run.py (demo-module)")
      )
      .mockRejectedValueOnce(
        new Error("Module action script does not exist: scripts/run.py (demo-module)")
      );
    mocks.fsReadFile.mockResolvedValue(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: PDV_PROTOCOL_VERSION,
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
    mocks.fsReadFile.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: PDV_PROTOCOL_VERSION,
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
      pdv_version: PDV_PROTOCOL_VERSION,
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
        pdv_version: PDV_PROTOCOL_VERSION,
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
        pdv_version: PDV_PROTOCOL_VERSION,
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

  it("kernels:start fails fast when selected runtime lacks pdv_kernel", async () => {
    const { kernelManager } = setup();
    vi.spyOn(EnvironmentDetector, "checkPDVInstalled").mockResolvedValueOnce({
      installed: false,
      version: null,
      compatible: false,
    });

    const start = getHandler(IPC.kernels.start);
    await expect(
      start({}, { language: "python", env: { PYTHON_PATH: "/usr/bin/python3" } })
    ).rejects.toThrow("pdv_kernel");
    expect(kernelManager.start).not.toHaveBeenCalled();
  });

  it("project:load binds imported module scripts when kernel is active", async () => {
    const { commRouter } = setup();
    const start = getHandler(IPC.kernels.start);
    await start({}, { language: "python" });

    // tree-index.json read (from copyFilesForLoad) → no file-backed nodes in test project
    mocks.fsReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    // project.json read (from ProjectManager.readManifest inside refreshProjectModuleHealth)
    mocks.fsReadFile.mockResolvedValueOnce(
      JSON.stringify({
        schema_version: "1.1",
        saved_at: "2026-01-01T00:00:00.000Z",
        pdv_version: PDV_PROTOCOL_VERSION,
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

    expect(mocks.moduleManagerResolveActionScripts).toHaveBeenCalledWith("demo-module");
    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.SCRIPT_REGISTER,
      expect.objectContaining({
        parent_path: "diagnosticA.scripts",
        name: "run",
        relative_path: "/tmp/pdv-test/diagnosticA/scripts/run.py",
        reload: true,
      })
    );
  });
});
