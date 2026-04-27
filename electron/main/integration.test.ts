/**
 * integration.test.ts — Cross-boundary integration tests (Python + Electron).
 *
 * @slow — Spawns a real Python kernel and verifies PDV comm traffic.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { KernelManager } from "./kernel-manager";
import { CommRouter } from "./comm-router";
import { PDVMessage, PDVMessageType, generateNodeUuid, getAppVersion, setAppVersion } from "./pdv-protocol";

const PYTHON_PACKAGE_DIR = path.resolve(__dirname, "../../pdv-python");
const TEST_PYTHON_EXECUTABLE = process.env.PYTHON_PATH ?? "python3";

const BOOTSTRAP_AND_OPEN_COMM = `
from IPython import get_ipython
import pdv.comms as _pdv_comms
from pdv.tree import PDVTree
try:
    from ipykernel.comm import Comm
except Exception:
    from comm import Comm
_ip = get_ipython()
_tree = PDVTree()
_ip.user_ns["pdv_tree"] = _tree
_pdv_comms._pdv_tree = _tree
_pdv_comms._ip = _ip
_pdv_comms._bootstrapped = True
_tree._attach_comm(lambda _type, _payload: _pdv_comms.send_message(_type, _payload))
_pdv_comm = Comm(target_name="pdv.kernel")
_pdv_comms._comm = _pdv_comm
_pdv_comm.on_msg(_pdv_comms._on_comm_message)
_pdv_comms.send_message("pdv.ready", {})
`;

function withPythonPath(): string {
  const existing = process.env.PYTHONPATH;
  return existing
    ? `${PYTHON_PACKAGE_DIR}${path.delimiter}${existing}`
    : PYTHON_PACKAGE_DIR;
}

function waitForPush(
  router: CommRouter,
  type: string,
  timeoutMs = 15_000
): Promise<PDVMessage> {
  return new Promise<PDVMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      router.offPush(type, handler);
      reject(new Error(`Timed out waiting for push: ${type}`));
    }, timeoutMs);

    const handler = (message: PDVMessage): void => {
      clearTimeout(timer);
      router.offPush(type, handler);
      resolve(message);
    };

    router.onPush(type, handler);
  });
}

async function bootstrapAndInit(
  km: KernelManager,
  router: CommRouter,
  kernelId: string,
  tempDirs: string[]
): Promise<{ ready: PDVMessage; initResponse: PDVMessage; workingDir: string }> {
  const readyPromise = waitForPush(router, PDVMessageType.READY);
  const bootstrapResult = await km.execute(kernelId, {
    code: BOOTSTRAP_AND_OPEN_COMM,
  });
  expect(bootstrapResult.error).toBeUndefined();
  const ready = await readyPromise;

  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-int-work-"));
  tempDirs.push(workingDir);
  const initResponse = await router.request(PDVMessageType.INIT, {
    working_dir: workingDir,
    pdv_version: getAppVersion(),
  });

  return { ready, initResponse, workingDir };
}

describe("@slow Cross-boundary integration (Python + Electron)", { timeout: 120_000 }, () => {
  let km: KernelManager;
  let router: CommRouter;
  let kernelId: string;
  let readyMessage: PDVMessage | null = null;
  let initResponse: PDVMessage | null = null;
  let initialWorkingDir = "";
  const tempDirs: string[] = [];

  // Bump the hook timeout to 20s (up from vitest's 10s default). On a
  // busy CI runner the real ipykernel subprocess + comm bootstrap can
  // take noticeably longer than local, and we'd rather give it breathing
  // room than chase flakes. The test timeout is already 120s via the
  // describe options above.
  beforeAll(async () => {
    setAppVersion("0.0.7");
    km = new KernelManager();
    router = new CommRouter();

    const info = await km.start({
      language: "python",
      env: {
        PYTHONPATH: withPythonPath(),
        PYTHON_PATH: TEST_PYTHON_EXECUTABLE,
      },
    });
    kernelId = info.id;
    router.attach(km, kernelId);

    const session = await bootstrapAndInit(km, router, kernelId, tempDirs);
    readyMessage = session.ready;
    initResponse = session.initResponse;
    initialWorkingDir = session.workingDir;
  }, 20_000);

  afterAll(async () => {
    router.detach();
    await km.shutdownAll();
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  }, 20_000);

  it("start kernel -> bootstrap -> pdv.ready then pdv.init.response", async () => {
    expect(readyMessage).not.toBeNull();
    expect(readyMessage!.type).toBe(PDVMessageType.READY);
    expect(readyMessage!.in_reply_to).toBeNull();
    expect(initResponse).not.toBeNull();
    expect(initResponse!.type).toBe(PDVMessageType.INIT_RESPONSE);
    expect(initResponse!.status).toBe("ok");
    expect(initialWorkingDir.length).toBeGreaterThan(0);
  });

  it("send pdv.tree.list -> Python returns nodes array", async () => {
    const response = await router.request(PDVMessageType.TREE_LIST, { path: "" });
    expect(response.status).toBe("ok");
    const nodes = (response.payload as { nodes?: unknown }).nodes;
    expect(Array.isArray(nodes)).toBe(true);
  });

  it("send pdv.tree.get -> Python returns value", async () => {
    const seedResult = await km.execute(kernelId, { code: "pdv_tree['x'] = 42" });
    expect(seedResult.error).toBeUndefined();

    const response = await router.request(PDVMessageType.TREE_GET, {
      path: "x",
      mode: "value",
    });
    expect(response.status).toBe("ok");
    const value = (response.payload as { value?: unknown }).value;
    expect(String(value)).toContain("42");
  });

  it("send pdv.tree.get mode=metadata -> Python returns metadata envelope", async () => {
    const response = await router.request(PDVMessageType.TREE_GET, {
      path: "x",
      mode: "metadata",
    });
    expect(response.status).toBe("ok");
    const payload = response.payload as {
      path?: unknown;
      type?: unknown;
      value?: unknown;
    };
    expect(payload.path).toBe("x");
    expect(payload.type).toBe("scalar");
    expect(payload.value).toBeUndefined();
  });

  it("set tree value in kernel -> pdv.tree.changed push received", async () => {
    const changedPath = `integration.changed_${Date.now()}`;
    const pushPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const execResult = await km.execute(kernelId, {
      code: `pdv_tree['${changedPath}'] = 1`,
    });
    expect(execResult.error).toBeUndefined();

    const push = await pushPromise;
    const payload = push.payload as {
      changed_paths?: unknown;
      change_type?: unknown;
    };
    // Debounced notifications arrive as "batch" change_type.
    expect(payload.change_type).toBe("batch");
    expect(payload.changed_paths).toContain(changedPath);
  });

  it("delete tree value in kernel -> pdv.tree.changed removed push received", async () => {
    const changedPath = `integration.removed_${Date.now()}`;
    const addPushPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const addResult = await km.execute(kernelId, {
      code: `pdv_tree['${changedPath}'] = 7`,
    });
    expect(addResult.error).toBeUndefined();
    await addPushPromise;

    const removePushPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const removeResult = await km.execute(kernelId, {
      code: `del pdv_tree['${changedPath}']`,
    });
    expect(removeResult.error).toBeUndefined();

    const push = await removePushPromise;
    const payload = push.payload as {
      changed_paths?: unknown;
      change_type?: unknown;
    };
    // Debounced notifications arrive as "batch" change_type.
    expect(payload.change_type).toBe("batch");
    expect(payload.changed_paths).toContain(changedPath);
  });

  it("send pdv.namespace.query -> Python returns namespace variables", async () => {
    const seedResult = await km.execute(kernelId, { code: "x = 42" });
    expect(seedResult.error).toBeUndefined();

    const response = await router.request(PDVMessageType.NAMESPACE_QUERY, {
      include_private: false,
      include_modules: false,
      include_callables: false,
    });
    expect(response.status).toBe("ok");
    const variables = (response.payload as { variables?: Record<string, { type?: string; preview?: string }> })
      .variables;
    expect(variables).toBeDefined();
    expect(variables?.x).toBeDefined();
    expect(variables?.x.type).toBe("int");
    expect(variables?.x.kind).toBe("scalar");
    expect(String(variables?.x.preview)).toContain("42");
  });

  it("send pdv.namespace.inspect -> Python returns child namespace values", async () => {
    const seedResult = await km.execute(kernelId, { code: "arr = [1, 2, 3]" });
    expect(seedResult.error).toBeUndefined();

    const response = await router.request(PDVMessageType.NAMESPACE_INSPECT, {
      root_name: "arr",
      path: [],
    });
    expect(response.status).toBe("ok");
    const payload = response.payload as {
      children?: Array<{ name?: string; expression?: string }>;
      truncated?: boolean;
    };
    expect(payload.truncated).toBe(false);
    expect(payload.children?.[0]?.name).toBe("[0]");
    expect(payload.children?.[0]?.expression).toBe("arr[0]");
  });

  it("send pdv.project.save -> tree-index.json written to disk", async () => {
    const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-int-save-"));
    tempDirs.push(saveDir);

    const response = await router.request(PDVMessageType.PROJECT_SAVE, {
      save_dir: saveDir,
    });
    expect(response.status).toBe("ok");

    const indexStat = await fs.stat(path.join(saveDir, "tree-index.json"));
    expect(indexStat.isFile()).toBe(true);
  });

  it("project save -> project load roundtrip restores values and emits loaded push", async () => {
    const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-int-roundtrip-"));
    tempDirs.push(saveDir);

    const seedResult = await km.execute(kernelId, {
      code: "pdv_tree['roundtrip.score'] = 123; pdv_tree['roundtrip.inner'] = {'ok': True}",
    });
    expect(seedResult.error).toBeUndefined();

    const saveResponse = await router.request(PDVMessageType.PROJECT_SAVE, {
      save_dir: saveDir,
    });
    expect(saveResponse.status).toBe("ok");

    const mutateResult = await km.execute(kernelId, {
      code: "pdv_tree['roundtrip.score'] = 0",
    });
    expect(mutateResult.error).toBeUndefined();

    const loadedPushPromise = waitForPush(router, PDVMessageType.PROJECT_LOADED);
    const loadResponse = await router.request(PDVMessageType.PROJECT_LOAD, {
      save_dir: saveDir,
    });
    expect(loadResponse.status).toBe("ok");
    const loadedPush = await loadedPushPromise;
    expect(loadedPush.type).toBe(PDVMessageType.PROJECT_LOADED);

    const scoreResponse = await router.request(PDVMessageType.TREE_GET, {
      path: "roundtrip.score",
      mode: "value",
    });
    expect(scoreResponse.status).toBe("ok");
    const scoreValue = (scoreResponse.payload as { value?: unknown }).value;
    expect(String(scoreValue)).toContain("123");
  });

  it("send pdv.script.register -> script node appears and tree.changed is pushed", async () => {
    const nodeUuid = generateNodeUuid();
    const scriptDir = path.join(initialWorkingDir, "tree", nodeUuid);
    await fs.mkdir(scriptDir, { recursive: true });
    await fs.writeFile(
      path.join(scriptDir, "fit_model.py"),
      "def run(pdv_tree: dict, x: int = 1):\n    return {'x2': x * 2}\n",
      "utf8"
    );

    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.SCRIPT_REGISTER, {
      parent_path: "scripts.analysis",
      name: "fit_model",
      uuid: nodeUuid,
      filename: "fit_model.py",
      language: "python",
    });
    expect(response.status).toBe("ok");

    const changedPush = await changedPromise;
    const changedPayload = changedPush.payload as {
      changed_paths?: unknown;
      change_type?: unknown;
    };
    expect(changedPayload.change_type).toBe("batch");
    expect(changedPayload.changed_paths).toContain("scripts.analysis.fit_model");

    const listResponse = await router.request(PDVMessageType.TREE_LIST, {
      path: "scripts.analysis",
    });
    expect(listResponse.status).toBe("ok");
    const nodes = (listResponse.payload as { nodes?: Array<{ key?: string; type?: string }> }).nodes ?? [];
    const scriptNode = nodes.find((n) => n.key === "fit_model");
    expect(scriptNode).toBeDefined();
    expect(scriptNode?.type).toBe("script");
  });

  const solveUuid = generateNodeUuid();

  it("pdv.script.params returns params on demand for UUID-based scripts", async () => {
    const solveDir = path.join(initialWorkingDir, "tree", solveUuid);
    await fs.mkdir(solveDir, { recursive: true });
    await fs.writeFile(
      path.join(solveDir, "solve.py"),
      [
        "def run(pdv_tree: dict, n: int = 3, dt: float = 0.01, method: str = 'rk4'):",
        "    return {'result': n}",
        "",
      ].join("\n"),
      "utf8"
    );

    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.SCRIPT_REGISTER, {
      parent_path: "scripts",
      name: "solve",
      uuid: solveUuid,
      filename: "solve.py",
      language: "python",
    });
    expect(response.status).toBe("ok");
    await changedPromise;

    // Fetch params on demand via pdv.script.params
    const paramsResponse = await router.request(PDVMessageType.SCRIPT_PARAMS, {
      path: "scripts.solve",
    });
    expect(paramsResponse.status).toBe("ok");
    const params = (paramsResponse.payload as { params?: Array<{ name: string; type: string; default?: unknown; required?: boolean }> }).params ?? [];
    expect(params.length).toBe(3);

    const paramNames = params.map((p) => p.name);
    expect(paramNames).toContain("n");
    expect(paramNames).toContain("dt");
    expect(paramNames).toContain("method");

    const nParam = params.find((p) => p.name === "n");
    expect(nParam?.default).toBe(3);
    expect(nParam?.required).toBe(false);
  });

  it("pdv.script.params reflects file edits without re-registering", async () => {
    // The script from the previous test already exists — edit it to add a param
    const scriptPath = path.join(initialWorkingDir, "tree", solveUuid, "solve.py");
    await fs.writeFile(
      scriptPath,
      [
        "def run(pdv_tree: dict, n: int = 3, dt: float = 0.01, method: str = 'rk4', verbose: bool = False):",
        "    return {'result': n}",
        "",
      ].join("\n"),
      "utf8"
    );

    // Fetch params again — should reflect the edit
    const paramsResponse = await router.request(PDVMessageType.SCRIPT_PARAMS, {
      path: "scripts.solve",
    });
    expect(paramsResponse.status).toBe("ok");
    const params = (paramsResponse.payload as { params?: Array<{ name: string; type: string; default?: unknown; required?: boolean }> }).params ?? [];
    expect(params.length).toBe(4);
    expect(params.map((p) => p.name)).toContain("verbose");
  });

  it("streaming iopub output arrives before execution completes", async () => {
    const streamTexts: string[] = [];
    const unsubscribe = km.onIopubMessage(kernelId, (msg) => {
      if (msg.header.msg_type !== "stream") return;
      const content = msg.content as { text?: string };
      if (content.text) {
        streamTexts.push(content.text);
      }
    });

    try {
      const executePromise = km.execute(kernelId, {
        code: "import time\nprint('chunk-1', flush=True)\ntime.sleep(0.4)\nprint('chunk-2', flush=True)",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(streamTexts.length).toBeGreaterThan(0);
      const result = await executePromise;
      expect(result.error).toBeUndefined();
      expect(result.stdout ?? "").toContain("chunk-1");
      expect(result.stdout ?? "").toContain("chunk-2");
    } finally {
      unsubscribe();
    }
  });

  // ── Tree context menu operations ──────────────────────────────────

  it("pdv.tree.create_node creates an empty container and pushes tree.changed", async () => {
    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.TREE_CREATE_NODE, {
      parent_path: "",
      name: "ctx_container",
    });
    expect(response.status).toBe("ok");
    const payload = response.payload as { path?: string; created?: boolean };
    expect(payload.created).toBe(true);
    expect(payload.path).toBe("ctx_container");

    const push = await changedPromise;
    const pushPayload = push.payload as { changed_paths?: string[] };
    expect(pushPayload.changed_paths).toContain("ctx_container");

    const listResponse = await router.request(PDVMessageType.TREE_LIST, { path: "" });
    const nodes = ((listResponse.payload as { nodes?: Array<{ key?: string }> }).nodes ?? []);
    expect(nodes.find((n) => n.key === "ctx_container")).toBeDefined();
  });

  it("pdv.tree.create_node rejects duplicate names", async () => {
    await expect(
      router.request(PDVMessageType.TREE_CREATE_NODE, {
        parent_path: "",
        name: "ctx_container",
      })
    ).rejects.toThrow(/already exists/);
  });

  it("pdv.tree.rename renames a node and pushes tree.changed", async () => {
    const seedResult = await km.execute(kernelId, {
      code: "pdv_tree['rename_me'] = 'hello'",
    });
    expect(seedResult.error).toBeUndefined();
    await waitForPush(router, PDVMessageType.TREE_CHANGED);

    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.TREE_RENAME, {
      path: "rename_me",
      new_name: "renamed",
    });
    expect(response.status).toBe("ok");
    const payload = response.payload as { old_path?: string; new_path?: string; renamed?: boolean };
    expect(payload.renamed).toBe(true);
    expect(payload.old_path).toBe("rename_me");
    expect(payload.new_path).toBe("renamed");
    await changedPromise;

    const getResponse = await router.request(PDVMessageType.TREE_GET, {
      path: "renamed",
      mode: "value",
    });
    expect(getResponse.status).toBe("ok");
    expect(String((getResponse.payload as { value?: unknown }).value)).toContain("hello");

    await expect(
      router.request(PDVMessageType.TREE_GET, { path: "rename_me", mode: "value" })
    ).rejects.toThrow(/path/i);
  });

  it("pdv.tree.move relocates a node to a new path", async () => {
    const seedResult = await km.execute(kernelId, {
      code: "pdv_tree['move_src'] = {'a': 1, 'b': 2}",
    });
    expect(seedResult.error).toBeUndefined();
    await waitForPush(router, PDVMessageType.TREE_CHANGED);

    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.TREE_MOVE, {
      path: "move_src",
      new_path: "ctx_container.moved",
    });
    expect(response.status).toBe("ok");
    const payload = response.payload as { old_path?: string; new_path?: string; moved?: boolean };
    expect(payload.moved).toBe(true);
    await changedPromise;

    const getResponse = await router.request(PDVMessageType.TREE_LIST, {
      path: "ctx_container.moved",
    });
    expect(getResponse.status).toBe("ok");
    const children = ((getResponse.payload as { nodes?: Array<{ key?: string }> }).nodes ?? []);
    expect(children.map((n) => n.key)).toEqual(expect.arrayContaining(["a", "b"]));

    await expect(
      router.request(PDVMessageType.TREE_GET, { path: "move_src", mode: "value" })
    ).rejects.toThrow(/path/i);
  });

  it("pdv.tree.move rejects circular moves", async () => {
    const seedResult = await km.execute(kernelId, {
      code: "pdv_tree['circ'] = {'inner': {'deep': 1}}",
    });
    expect(seedResult.error).toBeUndefined();
    await waitForPush(router, PDVMessageType.TREE_CHANGED);

    await expect(
      router.request(PDVMessageType.TREE_MOVE, {
        path: "circ",
        new_path: "circ.inner.inside_itself",
      })
    ).rejects.toThrow(/subtree/i);
  });

  it("pdv.tree.duplicate deep-copies a node to a new path", async () => {
    const seedResult = await km.execute(kernelId, {
      code: "pdv_tree['dup_src'] = {'val': 42}",
    });
    expect(seedResult.error).toBeUndefined();
    await waitForPush(router, PDVMessageType.TREE_CHANGED);

    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.TREE_DUPLICATE, {
      path: "dup_src",
      new_path: "dup_copy",
    });
    expect(response.status).toBe("ok");
    const payload = response.payload as { source_path?: string; new_path?: string; duplicated?: boolean };
    expect(payload.duplicated).toBe(true);
    await changedPromise;

    const srcResponse = await router.request(PDVMessageType.TREE_LIST, { path: "dup_src" });
    expect(srcResponse.status).toBe("ok");
    const copyResponse = await router.request(PDVMessageType.TREE_LIST, { path: "dup_copy" });
    expect(copyResponse.status).toBe("ok");
    const copyChildren = ((copyResponse.payload as { nodes?: Array<{ key?: string }> }).nodes ?? []);
    expect(copyChildren.find((n) => n.key === "val")).toBeDefined();
  });

  it("pdv.tree.duplicate rejects when destination already exists", async () => {
    await expect(
      router.request(PDVMessageType.TREE_DUPLICATE, {
        path: "dup_src",
        new_path: "dup_copy",
      })
    ).rejects.toThrow(/already exists/);
  });

  it("pdv.tree.delete removes a node and pushes tree.changed", async () => {
    const seedResult = await km.execute(kernelId, {
      code: "pdv_tree['delete_me'] = 'gone'",
    });
    expect(seedResult.error).toBeUndefined();
    await waitForPush(router, PDVMessageType.TREE_CHANGED);

    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.TREE_DELETE, {
      path: "delete_me",
    });
    expect(response.status).toBe("ok");
    const payload = response.payload as { path?: string; deleted?: boolean };
    expect(payload.deleted).toBe(true);
    await changedPromise;

    await expect(
      router.request(PDVMessageType.TREE_GET, { path: "delete_me", mode: "value" })
    ).rejects.toThrow(/path/i);
  });

  it("pdv.file.register creates a standalone lib with sys.path wired", async () => {
    const nodeUuid = generateNodeUuid();
    const libDir = path.join(initialWorkingDir, "tree", nodeUuid);
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(
      path.join(libDir, "helpers.py"),
      "MAGIC = 42\n\ndef double(x):\n    return x * 2\n",
      "utf8"
    );

    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.FILE_REGISTER, {
      tree_path: "ctx_container",
      filename: "helpers.py",
      uuid: nodeUuid,
      node_type: "lib",
      name: "helpers",
    });
    expect(response.status).toBe("ok");
    await changedPromise;

    const listResponse = await router.request(PDVMessageType.TREE_LIST, {
      path: "ctx_container",
    });
    const nodes = ((listResponse.payload as { nodes?: Array<{ key?: string; type?: string }> }).nodes ?? []);
    const libNode = nodes.find((n) => n.key === "helpers");
    expect(libNode).toBeDefined();
    expect(libNode?.type).toBe("lib");

    const importResult = await km.execute(kernelId, {
      code: "from helpers import double; result = double(21)",
    });
    expect(importResult.error).toBeUndefined();
    expect(importResult.stdout ?? "").not.toContain("Error");

    const checkResult = await km.execute(kernelId, { code: "print(result)" });
    expect(checkResult.error).toBeUndefined();
    expect(checkResult.stdout?.trim()).toBe("42");
  });

  it("pdv.tree.move works for file-backed nodes (PDVLib)", async () => {
    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.TREE_MOVE, {
      path: "ctx_container.helpers",
      new_path: "ctx_container.moved.helpers",
    });
    expect(response.status).toBe("ok");
    await changedPromise;

    const resolveResponse = await router.request(PDVMessageType.TREE_RESOLVE_FILE, {
      path: "ctx_container.moved.helpers",
    });
    expect(resolveResponse.status).toBe("ok");
    const filePath = (resolveResponse.payload as { file_path?: string }).file_path;
    expect(filePath).toBeDefined();
    expect(filePath).toMatch(/helpers\.py$/);
  });

  it("pdv.tree.duplicate copies file-backed nodes with new UUIDs", async () => {
    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.TREE_DUPLICATE, {
      path: "ctx_container.moved.helpers",
      new_path: "ctx_container.helpers_copy",
    });
    expect(response.status).toBe("ok");
    await changedPromise;

    const origResolve = await router.request(PDVMessageType.TREE_RESOLVE_FILE, {
      path: "ctx_container.moved.helpers",
    });
    const copyResolve = await router.request(PDVMessageType.TREE_RESOLVE_FILE, {
      path: "ctx_container.helpers_copy",
    });
    expect(origResolve.status).toBe("ok");
    expect(copyResolve.status).toBe("ok");

    const origPath = (origResolve.payload as { file_path?: string }).file_path!;
    const copyPath = (copyResolve.payload as { file_path?: string }).file_path!;
    expect(copyPath).toMatch(/helpers\.py$/);
    expect(copyPath).not.toBe(origPath);
  });

  it("kernel restart cycle re-bootstraps session and starts with an empty tree", async () => {
    const seedResult = await km.execute(kernelId, { code: "pdv_tree['restart_probe'] = 99" });
    expect(seedResult.error).toBeUndefined();

    router.detach();
    await km.stop(kernelId);

    const restarted = await km.start({
      language: "python",
      env: {
        PYTHONPATH: withPythonPath(),
        PYTHON_PATH: TEST_PYTHON_EXECUTABLE,
      },
    });
    kernelId = restarted.id;
    router.attach(km, kernelId);

    const session = await bootstrapAndInit(km, router, kernelId, tempDirs);
    expect(session.ready.type).toBe(PDVMessageType.READY);
    expect(session.initResponse.type).toBe(PDVMessageType.INIT_RESPONSE);
    expect(session.initResponse.status).toBe("ok");

    const listResponse = await router.request(PDVMessageType.TREE_LIST, {
      path: "",
    });
    expect(listResponse.status).toBe("ok");
    const nodes = (listResponse.payload as { nodes?: Array<{ key?: string }> }).nodes ?? [];
    const keys = nodes.map((node) => node.key);
    expect(keys).not.toContain("restart_probe");
  });
});
