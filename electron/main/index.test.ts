/**
 * index.test.ts — Step 5 IPC handler tests.
 *
 * Verifies that `registerIpcHandlers()` wires the required IPC surface to
 * KernelManager/CommRouter dependencies and forwards push notifications to the
 * renderer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

import { registerIpcHandlers, registerPushForwarding, unregisterIpcHandlers } from "./index";
import {
  IPC,
  type NamespaceVariable,
  type PDVConfig,
  type TreeNode,
} from "./ipc";
import { PDVMessageType, type PDVMessage } from "./pdv-protocol";
import type { KernelInfo, KernelManager } from "./kernel-manager";
import type { CommRouter } from "./comm-router";
import type { ProjectManager } from "./project-manager";
import type { ConfigStore } from "./config";

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
  const fsMkdir = vi.fn(async () => undefined);
  const fsStat = vi.fn(async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    throw err;
  });
  const fsWriteFile = vi.fn(async () => undefined);
  return { handlers, ipcHandle, ipcRemoveHandler, spawn, fsMkdir, fsStat, fsWriteFile };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: mocks.ipcHandle,
    removeHandler: mocks.ipcRemoveHandler,
  },
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("fs/promises", () => ({
  mkdir: mocks.fsMkdir,
  stat: mocks.fsStat,
  writeFile: mocks.fsWriteFile,
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
    pdv_version: "1.0",
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
    getKernel: vi.fn(() => makeKernelInfo()),
    shutdownAll: vi.fn(async () => undefined),
  } as unknown as KernelManager;

  const commRouter = {
    request: vi.fn(async () => makeMessage({})),
    onPush: vi.fn(),
    offPush: vi.fn(),
  } as unknown as CommRouter;

  const projectManager = {
    save: vi.fn(async () => undefined),
    load: vi.fn(async () => []),
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

  registerIpcHandlers(win, kernelManager, commRouter, projectManager, configStore);

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
    await edit({}, "/tmp/script.py");

    expect(mocks.spawn).toHaveBeenCalledWith(
      "code",
      ["/tmp/script.py"],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
      })
    );
  });

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
    expect(kernelManager.execute).toHaveBeenCalledWith("kernel-1", { code: "1+1" });
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

  it("kernels:complete returns empty matches when complete() is absent", async () => {
    const { kernelManager: _ } = setup();
    const complete = getHandler(IPC.kernels.complete);
    const result = (await complete({}, "kernel-1", "import ", 7)) as {
      matches: string[];
      cursor_start: number;
      cursor_end: number;
    };
    expect(result).toEqual({
      matches: [],
      cursor_start: 7,
      cursor_end: 7,
    });
  });

  it("kernels:inspect returns not-found when inspect() is absent", async () => {
    const { kernelManager: _ } = setup();
    const inspect = getHandler(IPC.kernels.inspect);
    const result = (await inspect({}, "kernel-1", "x", 0)) as { found: boolean };
    expect(result).toEqual({ found: false });
  });

  it("kernels:validate returns valid for non-empty path when validate() is absent", async () => {
    const { kernelManager: _ } = setup();
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
        name: "analysis.py",
        relative_path: "analysis.py",
        language: "python",
      })
    );
    expect(result.success).toBe(true);
    expect(result.scriptPath).toBeTruthy();
  });

  it("script:reload sends pdv.script.register with parent_path and name", async () => {
    const { commRouter } = setup();
    (commRouter.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessage({})
    );

    const reload = getHandler(IPC.script.reload);
    const result = (await reload({}, "scripts.analysis")) as { success: boolean };

    expect(commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.SCRIPT_REGISTER,
      expect.objectContaining({
        parent_path: "scripts",
        name: "analysis",
        reload: true,
      })
    );
    expect(result.success).toBe(true);
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
    expect(projectManager.load).toHaveBeenCalledWith("/tmp/project");
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

  it("commandBoxes:load returns null initially, commandBoxes:save persists", async () => {
    setup();
    const load = getHandler(IPC.commandBoxes.load);
    expect(await load({})).toBeNull();

    const save = getHandler(IPC.commandBoxes.save);
    await save({}, { boxes: [{ id: "b1" }] });

    const afterSave = await load({});
    expect(afterSave).toEqual({ boxes: [{ id: "b1" }] });
  });
});
