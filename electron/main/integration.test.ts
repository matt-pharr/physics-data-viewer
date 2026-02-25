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
import { PDVMessage, PDVMessageType } from "./pdv-protocol";

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

describe("@slow Cross-boundary integration (Python + Electron)", { timeout: 120_000 }, () => {
  let km: KernelManager;
  let router: CommRouter;
  let kernelId: string;
  let readyMessage: PDVMessage | null = null;
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

    const readyPromise = waitForPush(router, PDVMessageType.READY);
    const bootstrapResult = await km.execute(kernelId, {
      code: BOOTSTRAP_AND_OPEN_COMM,
    });
    expect(bootstrapResult.error).toBeUndefined();
    readyMessage = await readyPromise;
  });

  afterAll(async () => {
    router.detach();
    await km.shutdownAll();
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it("start kernel -> bootstrap -> pdv.ready received", async () => {
    expect(readyMessage).not.toBeNull();
    expect(readyMessage!.type).toBe(PDVMessageType.READY);
    expect(readyMessage!.in_reply_to).toBeNull();
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
});
