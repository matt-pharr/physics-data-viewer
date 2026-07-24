/**
 * ipc-register-tree-namespace-script.test.ts — Unit tests for tree/namespace/
 * script IPC handlers.
 *
 * Covers all 19 channels (registration), the kernel-not-found guards, comm
 * payload construction for createScript / createGui (with module-ownership
 * detection via analyseModuleTarget), and the language-specific code
 * generation in `script.run`. The exhaustive integration of each tree
 * mutation (rename / move / duplicate / delete) is delegated to the comm
 * layer and tested through `comm-router.test.ts` and `index.test.ts`.
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
  readFile: vi.fn(async () => ""),
  access: vi.fn(async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    throw err;
  }),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}));

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    const child: { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> } = {
      on: vi.fn(),
      unref: vi.fn(),
    };
    return child;
  }),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
}));

vi.mock("fs/promises", () => fsMocks);
vi.mock("child_process", () => childProcessMocks);

import { HandlerInvokeTracker } from "./handler-invoke-tracker";
import { IPC } from "./ipc";
import { registerTreeNamespaceScriptIpcHandlers } from "./ipc-register-tree-namespace-script";
import { PDVMessageType } from "./pdv-protocol";
import {
  createCommRouterMock,
  createConfigStoreMock,
  createKernelManagerMock,
  createProjectManagerMock,
  makeKernelInfo,
  makeOkResponse,
  type InvokeHandler,
  getInvokeHandler,
  resetInvokeRegistry,
} from "./test-helpers";
import { QueryRouter } from "./query-router";
import type { PDVConfig } from "./config";

function getHandler(channel: string): InvokeHandler {
  return getInvokeHandler(channel);
}

interface Harness {
  kernelManager: ReturnType<typeof createKernelManagerMock>;
  commRouter: ReturnType<typeof createCommRouterMock>;
  queryRouter: QueryRouter;
  projectManager: ReturnType<typeof createProjectManagerMock>;
  config: ReturnType<typeof createConfigStoreMock<PDVConfig>>;
  kernelWorkingDirs: Map<string, string>;
  knownAliases: Set<string>;
  handlerInvokeTracker: HandlerInvokeTracker;
  trackerPushes: Array<{ channel: string; payload: Record<string, unknown> }>;
}

function setup(initial: { knownAliases?: Set<string> } = {}): Harness {
  const kernelManager = createKernelManagerMock();
  const commRouter = createCommRouterMock();
  const queryRouter = new QueryRouter();
  const projectManager = createProjectManagerMock();
  const trackerPushes: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const handlerInvokeTracker = new HandlerInvokeTracker((channel, payload) =>
    trackerPushes.push({ channel, payload: payload as Record<string, unknown> }),
  );
  const config = createConfigStoreMock<PDVConfig>({
    showPrivateVariables: false,
    showModuleVariables: false,
    showCallableVariables: false,
    autoRefreshNamespace: false,
  });
  const kernelWorkingDirs = new Map<string, string>([["k1", "/tmp/wd"]]);
  const knownAliases = initial.knownAliases ?? new Set<string>();

  registerTreeNamespaceScriptIpcHandlers({
    kernelManager,
    commRouter: commRouter.router,
    queryRouter,
    handlerInvokeTracker,
    projectManager,
    configStore: config.store,
    kernelWorkingDirs,
    getKnownModuleAliases: async () => knownAliases,
    readConfig: (store) => store.getAll() as PDVConfig,
    toNamespaceQueryPayload: (options) => ({ ...(options ?? {}) }) as Record<string, unknown>,
    toNamespaceInspectPayload: (target) => ({ ...target }) as unknown as Record<string, unknown>,
    sanitizeScriptName: (n: string, language?: "python" | "julia") =>
      `${n.replace(/\s+/g, "_")}.${language === "julia" ? "jl" : "py"}`,
    ensureScriptFile: async () => undefined,
    ensureLibFile: async () => undefined,
    buildEditorSpawn: (_cmd, file) => ({ file: "code", args: [file] }),
    resolveEditorSpawn: (file, args, _opts) => ({ file, args }),
  });

  return {
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    config,
    kernelWorkingDirs,
    knownAliases,
    handlerInvokeTracker,
    trackerPushes,
  };
}

beforeEach(() => {
  ipcRegistry.handlers.clear();
  resetInvokeRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tree:list / tree:get", () => {
  it("tree:list returns [] when the kernel does not exist", async () => {
    const { kernelManager } = setup();
    (kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const result = await getHandler(IPC.tree.list)({}, "missing", "");
    expect(result).toEqual([]);
  });

  it("tree:list forwards path, returns response.nodes array", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo(),
    );
    const nodes = [{ id: "a", path: "data" }];
    harness.commRouter.request.mockResolvedValueOnce(makeOkResponse({ nodes }));
    const result = await getHandler(IPC.tree.list)({}, "k1", "data");
    expect(result).toEqual(nodes);
    expect(harness.commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.TREE_LIST,
      { path: "data" },
    );
  });

  it("tree:get throws when the kernel does not exist", async () => {
    const { kernelManager } = setup();
    (kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    await expect(getHandler(IPC.tree.get)({}, "missing", "x")).rejects.toThrow(
      /Kernel not found/,
    );
  });
});

describe("tree:createScript", () => {
  it("standalone script (no module match) registers without module_id", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "python" }),
    );
    await getHandler(IPC.tree.createScript)({}, "k1", "scripts", "demo");

    const registerCall = harness.commRouter.request.mock.calls.find(
      (call) => call[0] === PDVMessageType.SCRIPT_REGISTER,
    );
    expect(registerCall).toBeTruthy();
    expect(registerCall![1]).toMatchObject({
      parent_path: "scripts",
      name: "demo",
      filename: "demo.py",
      language: "python",
      module_id: undefined,
      source_rel_path: undefined,
    });
  });

  it("module-owned script (target inside a known module) sets module_id + source_rel_path", async () => {
    const harness = setup({ knownAliases: new Set(["toy"]) });
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "python" }),
    );
    await getHandler(IPC.tree.createScript)({}, "k1", "toy.scripts", "demo");

    const registerCall = harness.commRouter.request.mock.calls.find(
      (call) => call[0] === PDVMessageType.SCRIPT_REGISTER,
    );
    expect(registerCall![1]).toMatchObject({
      module_id: "toy",
      source_rel_path: "scripts/demo.py",
    });
  });

  it("creates a Julia .jl script file when the kernel language is julia", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "julia" }),
    );
    await getHandler(IPC.tree.createScript)({}, "k1", "scripts", "demo");

    const registerCall = harness.commRouter.request.mock.calls.find(
      (call) => call[0] === PDVMessageType.SCRIPT_REGISTER,
    );
    expect(registerCall![1]).toMatchObject({
      filename: "demo.jl",
      language: "julia",
    });
  });
});

describe("tree:invokeHandler", () => {
  it("wraps the invoke in a console entry with a measured duration", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({}),
    );
    harness.commRouter.request.mockResolvedValueOnce(
      makeOkResponse({ dispatched: true }),
    );
    const result = (await getHandler(IPC.tree.invokeHandler)({}, "k1", "data.arr")) as {
      success: boolean;
      error?: string;
    };
    expect(result).toEqual({ success: true, error: undefined });
    // The generous timeout is load-bearing: a first plot can pay a
    // CairoMakie auto-load + precompile (minutes); the default 30 s
    // stamped a spurious timeout error (julia-hdf5-smoke e2e).
    expect(harness.commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.HANDLER_INVOKE,
      { path: "data.arr" },
      { timeoutMs: 300_000 },
    );
    const channels = harness.trackerPushes.map((p) => p.channel);
    expect(channels).toEqual([IPC.push.executeBegin, IPC.push.executeFinish]);
    const [begin, finish] = harness.trackerPushes.map((p) => p.payload);
    expect(begin.origin).toMatchObject({ label: "Handler data.arr" });
    expect(finish.executionId).toBe(begin.executionId);
    expect(typeof finish.duration).toBe("number");
    expect(finish.error).toBeUndefined();
  });

  it("undispatched invokes surface the kernel's error in the console entry", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({}),
    );
    harness.commRouter.request.mockResolvedValueOnce(
      makeOkResponse({ dispatched: false, error: "No handler for Core.Int64" }),
    );
    const result = (await getHandler(IPC.tree.invokeHandler)({}, "k1", "x")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("No handler for Core.Int64");
    const finish = harness.trackerPushes.find(
      (p) => p.channel === IPC.push.executeFinish,
    );
    expect(finish?.payload.error).toBe("No handler for Core.Int64");
  });

  it("comm failures finish the entry instead of leaking it", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({}),
    );
    harness.commRouter.request.mockRejectedValueOnce(new Error("comm timeout"));
    const result = (await getHandler(IPC.tree.invokeHandler)({}, "k1", "x")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("comm timeout");
    const finish = harness.trackerPushes.find(
      (p) => p.channel === IPC.push.executeFinish,
    );
    expect(finish?.payload.error).toBe("comm timeout");
  });
});

describe("tree:createGui", () => {
  it("rejects empty / non-alphanumeric gui names", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo(),
    );
    const result = (await getHandler(IPC.tree.createGui)({}, "k1", "ui", "  ???  ")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/alphanumeric/);
  });

  it("registers a gui node with default manifest and module ownership", async () => {
    const harness = setup({ knownAliases: new Set(["toy"]) });
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "python" }),
    );
    await getHandler(IPC.tree.createGui)({}, "k1", "toy.ui", "dashboard");

    const registerCall = harness.commRouter.request.mock.calls.find(
      (call) => call[0] === PDVMessageType.GUI_REGISTER,
    );
    expect(registerCall![1]).toMatchObject({
      name: "dashboard",
      filename: "dashboard.gui.json",
      module_id: "toy",
      source_rel_path: "ui/dashboard.gui.json",
    });
    // The default gui.json manifest is created on disk.
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("dashboard.gui.json"),
      expect.stringContaining('"layout"'),
      "utf-8",
    );
  });
});

describe("script:run", () => {
  it("Python scripts: builds pdv_tree['path'].run(kwarg=value) code and executes it", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "python" }),
    );
    const result = (await getHandler(IPC.script.run)({}, "k1", {
      treePath: "scripts.demo",
      params: { x: 5, flag: true, name: "abc" },
      executionId: "e1",
      origin: { kind: "tree-script" },
    })) as { code: string };

    expect(result.code).toContain('pdv_tree["scripts.demo"].run(');
    expect(result.code).toContain("x=5");
    expect(result.code).toContain("flag=True");
    expect(result.code).toContain('name="abc"');
    expect(harness.kernelManager.execute).toHaveBeenCalled();
  });

  it("Julia scripts: builds PDVKernel.run_tree_script(...) with Julia kwarg syntax", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "julia" }),
    );
    const result = (await getHandler(IPC.script.run)({}, "k1", {
      treePath: "scripts.demo",
      params: { x: 5, flag: true },
      executionId: "e1",
      origin: { kind: "tree-script" },
    })) as { code: string };
    expect(result.code).toContain("PDVKernel.run_tree_script(pdv_tree");
    expect(result.code).toContain("flag=true");
  });

  it("Julia scripts: escapes `$` in string params and tree paths (review M4)", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "julia" }),
    );
    const result = (await getHandler(IPC.script.run)({}, "k1", {
      treePath: "scripts.$weird",
      params: { label: "$\\alpha$ scan" },
      executionId: "e1",
      origin: { kind: "tree-script" },
    })) as { code: string };
    // Julia interpolates `$` in double-quoted literals; unescaped, a LaTeX
    // label is a parse error or a silent kernel-variable splice.
    expect(result.code).toContain('label="\\$\\\\alpha\\$ scan"');
    expect(result.code).toContain('"scripts.\\$weird"');
    expect(result.code).not.toMatch(/[^\\]\$\\alpha/);
  });

  it("emits MODULE_RELOAD_LIBS preflight for module-owned scripts (path with a dot)", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "python" }),
    );
    await getHandler(IPC.script.run)({}, "k1", {
      treePath: "toy.scripts.demo",
      params: {},
      executionId: "e1",
      origin: { kind: "tree-script" },
    });
    const reloadCall = harness.commRouter.request.mock.calls.find(
      (call) => call[0] === PDVMessageType.MODULE_RELOAD_LIBS,
    );
    expect(reloadCall![1]).toEqual({ alias: "toy" });
  });
});

describe("tree:print", () => {
  it("Python: builds print(pdv_tree[\"path\"]) and executes it", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "python" }),
    );
    const result = (await getHandler(IPC.tree.print)({}, "k1", {
      path: "data.x",
      executionId: "e1",
      origin: { kind: "unknown", label: "Tree print data.x" },
    })) as { code: string; executionId: string };
    expect(result.code).toBe('print(pdv_tree["data.x"])');
    expect(result.executionId).toBe("e1");
    expect(harness.kernelManager.execute).toHaveBeenCalled();
  });

  it("Julia: builds a size-limited text/plain show; empty path prints the whole tree", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(
      makeKernelInfo({ language: "julia" }),
    );
    const result = (await getHandler(IPC.tree.print)({}, "k1", {
      path: "",
      executionId: "e2",
      origin: { kind: "unknown" },
    })) as { code: string };
    expect(result.code).toBe(
      'show(IOContext(stdout, :limit => true), MIME("text/plain"), pdv_tree); println()',
    );
  });

  it("throws when the kernel is unknown", async () => {
    const harness = setup();
    (harness.kernelManager.getKernel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    await expect(
      getHandler(IPC.tree.print)({}, "nope", {
        path: "x",
        executionId: "e3",
        origin: { kind: "unknown" },
      }),
    ).rejects.toThrow(/Kernel not found/);
  });
});

describe("script:edit", () => {
  it("returns success:false when the kernel cannot resolve a file path", async () => {
    const harness = setup();
    harness.commRouter.request.mockResolvedValueOnce(makeOkResponse({}));
    const result = (await getHandler(IPC.script.edit)({}, "k1", "missing.script")) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not resolve/);
  });

  it("spawns the editor process with resolved path and detached child handles", async () => {
    const harness = setup();
    harness.commRouter.request.mockResolvedValueOnce(
      makeOkResponse({ file_path: "/tmp/wd/scripts/demo.py" }),
    );
    const result = (await getHandler(IPC.script.edit)({}, "k1", "scripts.demo")) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "code",
      ["/tmp/wd/scripts/demo.py"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });
});

describe("namespace:query", () => {
  it("forwards options through toNamespaceQueryPayload and returns normalized variables", async () => {
    const harness = setup();
    harness.commRouter.request.mockResolvedValueOnce(
      makeOkResponse({
        vars: { a: { kind: "scalar", type: "int" }, b: { kind: "ndarray", type: "ndarray" } },
      }),
    );
    const result = (await getHandler(IPC.namespace.query)({}, "k1", {
      includePrivate: true,
    })) as Array<{ name: string }>;
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(harness.commRouter.request).toHaveBeenCalledWith(
      PDVMessageType.NAMESPACE_QUERY,
      expect.objectContaining({ includePrivate: true }),
    );
  });
});
