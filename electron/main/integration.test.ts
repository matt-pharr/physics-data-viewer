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
import { PDVMessage, PDVMessageType, PDV_PROTOCOL_VERSION } from "./pdv-protocol";

const PYTHON_PACKAGE_DIR = path.resolve(__dirname, "../../pdv-python");
const TEST_PYTHON_EXECUTABLE = process.env.PYTHON_PATH ?? "python3";

const BOOTSTRAP_AND_OPEN_COMM = `
from IPython import get_ipython
import pdv_kernel.comms as _pdv_comms
from pdv_kernel.tree import PDVTree
from pdv_kernel.namespace import PDVApp
try:
    from ipykernel.comm import Comm
except Exception:
    from comm import Comm
_ip = get_ipython()
_tree = PDVTree()
_app = PDVApp()
_ip.user_ns["pdv_tree"] = _tree
_ip.user_ns["pdv"] = _app
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
    pdv_version: PDV_PROTOCOL_VERSION,
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

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    router.detach();
    await km.shutdownAll();
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

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
    expect(payload.change_type).toBe("added");
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
    expect(payload.change_type).toBe("removed");
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
    expect(variables?.x.type).toBe("scalar");
    expect(String(variables?.x.preview)).toContain("42");
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
    const scriptsDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-int-script-"));
    tempDirs.push(scriptsDir);
    const scriptPath = path.join(scriptsDir, "fit_model.py");
    await fs.writeFile(
      scriptPath,
      "def run(pdv_tree: dict, x: int = 1):\n    return {'x2': x * 2}\n",
      "utf8"
    );

    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.SCRIPT_REGISTER, {
      parent_path: "scripts.analysis",
      name: "fit_model",
      relative_path: scriptPath,
      language: "python",
    });
    expect(response.status).toBe("ok");

    const changedPush = await changedPromise;
    const changedPayload = changedPush.payload as {
      changed_paths?: unknown;
      change_type?: unknown;
    };
    expect(changedPayload.change_type).toBe("added");
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

  it("pdv.script.params returns params on demand for relative-path scripts", async () => {
    // Write a script with parameters into the working directory
    const scriptRelDir = path.join(initialWorkingDir, "scripts");
    await fs.mkdir(scriptRelDir, { recursive: true });
    await fs.writeFile(
      path.join(scriptRelDir, "solve.py"),
      [
        "def run(pdv_tree: dict, n: int = 3, dt: float = 0.01, method: str = 'rk4'):",
        "    return {'result': n}",
        "",
      ].join("\n"),
      "utf8"
    );

    // Register the script with a relative path (relative to working_dir)
    const changedPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
    const response = await router.request(PDVMessageType.SCRIPT_REGISTER, {
      parent_path: "scripts",
      name: "solve",
      relative_path: "scripts/solve.py",
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
    const scriptPath = path.join(initialWorkingDir, "scripts", "solve.py");
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
