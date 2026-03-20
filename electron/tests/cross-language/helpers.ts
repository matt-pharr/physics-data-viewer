/**
 * helpers.ts — Shared utilities for cross-language equivalence tests.
 *
 * Provides helpers to:
 * - Bootstrap both Python and Julia kernels
 * - Send identical comm messages to both and collect responses
 * - Assert structural equivalence between responses (ignoring language-specific fields)
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { expect } from "vitest";
import { KernelManager } from "../../main/kernel-manager";
import { CommRouter } from "../../main/comm-router";
import {
  PDVMessage,
  PDVMessageType,
  PDV_PROTOCOL_VERSION,
} from "../../main/pdv-protocol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PYTHON_PACKAGE_DIR = path.resolve(__dirname, "../../../pdv-python");
const JULIA_PACKAGE_DIR = path.resolve(__dirname, "../../../pdv-julia");
const TEST_PYTHON_EXECUTABLE = process.env.PYTHON_PATH ?? "python3";
const TEST_JULIA_EXECUTABLE = process.env.JULIA_PATH ?? "julia";

const PYTHON_BOOTSTRAP = `
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

const JULIA_BOOTSTRAP = `
using PDVKernel
PDVKernel.bootstrap()
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A kernel session ready for cross-language testing. */
export interface TestKernelSession {
  km: KernelManager;
  router: CommRouter;
  kernelId: string;
  workingDir: string;
  language: "python" | "julia";
}

/** Paired responses from both kernels. */
export interface DualResponse {
  python: PDVMessage;
  julia: PDVMessage;
}

// ---------------------------------------------------------------------------
// Push helpers
// ---------------------------------------------------------------------------

export function waitForPush(
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

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function pythonPath(): string {
  const existing = process.env.PYTHONPATH;
  return existing
    ? `${PYTHON_PACKAGE_DIR}${path.delimiter}${existing}`
    : PYTHON_PACKAGE_DIR;
}

/**
 * Start a Python kernel session, bootstrap, and initialize.
 */
export async function startPythonSession(
  tempDirs: string[]
): Promise<TestKernelSession> {
  const km = new KernelManager();
  const router = new CommRouter();

  const info = await km.start({
    language: "python",
    env: {
      PYTHONPATH: pythonPath(),
      PYTHON_PATH: TEST_PYTHON_EXECUTABLE,
    },
  });

  router.attach(km, info.id);

  const readyPromise = waitForPush(router, PDVMessageType.READY);
  const bootstrapResult = await km.execute(info.id, {
    code: PYTHON_BOOTSTRAP,
  });
  expect(bootstrapResult.error).toBeUndefined();
  await readyPromise;

  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-xtest-py-"));
  tempDirs.push(workingDir);
  await router.request(PDVMessageType.INIT, {
    working_dir: workingDir,
    pdv_version: PDV_PROTOCOL_VERSION,
  });

  return { km, router, kernelId: info.id, workingDir, language: "python" };
}

/**
 * Start a Julia kernel session, bootstrap, and initialize.
 *
 * Uses a longer timeout for Julia's JIT compilation warmup.
 */
export async function startJuliaSession(
  tempDirs: string[]
): Promise<TestKernelSession> {
  const km = new KernelManager();
  const router = new CommRouter();

  const info = await km.start({
    language: "julia",
    env: {
      JULIA_PATH: TEST_JULIA_EXECUTABLE,
      JULIA_PROJECT: JULIA_PACKAGE_DIR,
    },
  });

  router.attach(km, info.id);

  // Julia JIT is slow on first load — 60s timeout.
  const readyPromise = waitForPush(router, PDVMessageType.READY, 60_000);
  const bootstrapResult = await km.execute(info.id, {
    code: JULIA_BOOTSTRAP,
  });
  expect(bootstrapResult.error).toBeUndefined();
  await readyPromise;

  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-xtest-jl-"));
  tempDirs.push(workingDir);
  await router.request(PDVMessageType.INIT, {
    working_dir: workingDir,
    pdv_version: PDV_PROTOCOL_VERSION,
  });

  return { km, router, kernelId: info.id, workingDir, language: "julia" };
}

/**
 * Clean up a kernel session.
 */
export async function stopSession(session: TestKernelSession | undefined): Promise<void> {
  if (!session) return;
  session.router.detach();
  await session.km.shutdownAll();
}

// ---------------------------------------------------------------------------
// Dual-send helpers
// ---------------------------------------------------------------------------

/**
 * Send the same PDV comm request to both routers and return paired responses.
 */
export async function sendToBoth(
  py: TestKernelSession,
  jl: TestKernelSession,
  msgType: string,
  payload: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<DualResponse> {
  const [python, julia] = await Promise.all([
    py.router.request(msgType, payload, timeoutMs),
    jl.router.request(msgType, payload, timeoutMs),
  ]);
  return { python, julia };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Fields that are expected to differ between languages. */
const DEFAULT_IGNORE_FIELDS = new Set([
  "msg_id",
  "in_reply_to",
  "python_type",
  "julia_type",
  "timestamp",
  "saved_at",
]);

/**
 * Assert that two PDV responses have the same structure (same keys, same value
 * types) while ignoring language-specific or non-deterministic fields.
 *
 * Does NOT compare exact values — only structural shape and field presence.
 */
export function assertStructurallyEqual(
  pyResponse: PDVMessage,
  jlResponse: PDVMessage,
  extraIgnore: string[] = []
): void {
  const ignore = new Set([...DEFAULT_IGNORE_FIELDS, ...extraIgnore]);
  _assertShapeEqual(pyResponse.payload, jlResponse.payload, "payload", ignore);
}

function _assertShapeEqual(
  a: unknown,
  b: unknown,
  path: string,
  ignore: Set<string>
): void {
  if (a === null || a === undefined) {
    // Allow null/undefined on either side to match.
    return;
  }

  const typeA = Array.isArray(a) ? "array" : typeof a;
  const typeB = Array.isArray(b) ? "array" : typeof b;

  expect(typeA, `Type mismatch at ${path}: Python=${typeA}, Julia=${typeB}`).toBe(
    typeB
  );

  if (typeA === "object" && !Array.isArray(a)) {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA).filter((k) => !ignore.has(k)).sort();
    const keysB = Object.keys(objB).filter((k) => !ignore.has(k)).sort();
    expect(keysA, `Key mismatch at ${path}`).toEqual(keysB);
    for (const key of keysA) {
      _assertShapeEqual(objA[key], objB[key], `${path}.${key}`, ignore);
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    // For arrays, check first element shape if both non-empty.
    if (a.length > 0 && b.length > 0) {
      _assertShapeEqual(a[0], b[0], `${path}[0]`, ignore);
    }
  }
  // Scalars: type equality already checked.
}

/**
 * Assert that a PDV response has status "ok".
 */
export function assertOk(msg: PDVMessage, label: string): void {
  expect(msg.status, `${label} expected status=ok, got ${msg.status}`).toBe("ok");
}

/**
 * Assert that a PDV response has status "error" with a specific error code.
 */
export function assertError(
  msg: PDVMessage,
  expectedCode: string,
  label: string
): void {
  expect(msg.status, `${label} expected status=error`).toBe("error");
  const payload = msg.payload as Record<string, unknown>;
  expect(payload.code, `${label} expected error code=${expectedCode}`).toBe(
    expectedCode
  );
}
