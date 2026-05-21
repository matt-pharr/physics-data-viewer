/**
 * kernel-session.ts — Kernel bootstrap/init handshake helpers.
 *
 * Responsibilities:
 * - Execute kernel bootstrap code to open `pdv.kernel` comm target.
 * - Await `pdv.ready`, send `pdv.init`, and assign working directories.
 *
 * Non-responsibilities:
 * - Registering IPC handlers.
 * - Managing kernel crash cleanup.
 * - Project save/load flow.
 */

import { CommRouter } from "./comm-router";
import { QueryRouter } from "./query-router";
import { KernelManager } from "./kernel-manager";
import { PDVMessageType, getAppVersion } from "./pdv-protocol";
import { ProjectManager } from "./project-manager";

const PYTHON_BOOTSTRAP = `
from IPython import get_ipython
import pdv
from pdv import PDVTree
import pdv.comms as _pdv_comms
try:
    from ipykernel.comm import Comm
except Exception:
    from comm import Comm
_ip = get_ipython()
pdv.bootstrap(_ip)
if _pdv_comms._comm is None:
    _pdv_comm = Comm(target_name="pdv.kernel")
    _pdv_comms._comm = _pdv_comm
    _pdv_comm.on_msg(_pdv_comms._on_comm_message)
    _pdv_comms.send_message("pdv.ready", {})
`;

const JULIA_BOOTSTRAP = `
using PDVKernel
PDVKernel.bootstrap()

# Open the comm from the kernel side (like Python does).
# Comm(target) with primary=true (default) sends comm_open on iopub automatically.
import IJulia
if PDVKernel._comm[] === nothing
    _pdv_comm = IJulia.CommManager.Comm(PDVKernel.PDV_COMM_TARGET)
    _pdv_comm.on_msg = PDVKernel.on_comm_message
    PDVKernel._comm[] = _pdv_comm
    IJulia.CommManager.send_comm(_pdv_comm, Dict{String,Any}(
        "pdv_version" => PDVKernel.__pdv_protocol_version__,
        "msg_id" => string(PDVKernel.UUIDs.uuid4()),
        "in_reply_to" => nothing,
        "type" => "pdv.ready",
        "status" => "ok",
        "payload" => Dict{String,Any}(),
    ))
end
`;

async function waitForPush(
  commRouter: CommRouter,
  type: string,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      commRouter.offPush(type, handler);
      reject(new Error(`Timed out waiting for push: ${type}`));
    }, timeoutMs);
    const handler = (): void => {
      clearTimeout(timer);
      commRouter.offPush(type, handler);
      resolve();
    };
    commRouter.onPush(type, handler);
  });
}

/**
 * Run the full kernel bootstrap/init handshake and create a working directory.
 *
 * @param kernelManager - Kernel manager used for code execution.
 * @param commRouter - Comm router used for push/request handshake.
 * @param projectManager - Project manager used to create kernel working dirs.
 * @param kernelId - Kernel id to initialize.
 * @param kernelWorkingDirs - Working-dir map updated with this kernel's directory.
 * @param workingDirBase - Optional custom base directory for working dirs (from user settings).
 * @param preCreatedWorkingDir - Optional working directory created by the
 *   caller before the kernel was spawned. uv-mode kernels must materialize
 *   their venv (and therefore their working dir) before launch (§10.5.9);
 *   when supplied, this directory is used as-is instead of creating one.
 * @returns Nothing.
 * @throws {Error} When bootstrap execution fails or handshake times out.
 */
export async function initializeKernelSession(
  kernelManager: KernelManager,
  commRouter: CommRouter,
  queryRouter: QueryRouter,
  projectManager: ProjectManager,
  kernelId: string,
  kernelWorkingDirs: Map<string, string>,
  workingDirBase?: string,
  preCreatedWorkingDir?: string,
): Promise<void> {
  const kernel = kernelManager.getKernel(kernelId);
  const language = kernel?.language ?? "python";
  const bootstrapCode = language === "julia" ? JULIA_BOOTSTRAP : PYTHON_BOOTSTRAP;
  // Julia JIT compilation can be slow on first load; allow more time.
  const readyTimeoutMs = language === "julia" ? 60_000 : 15_000;

  // Track the last iopub msg_type seen during the handshake so that, if
  // anything throws, the diagnostic message can tell the user what the
  // kernel was last doing instead of just "Kernel failed to start".
  let lastIopubMsgType: string | null = null;
  const disposeIopubObserver = kernelManager.onIopubMessage(kernelId, (m) => {
    lastIopubMsgType = m.header.msg_type;
  });

  let step: "bootstrap" | "ready" | "init" = "bootstrap";
  try {
    const readyPromise = waitForPush(commRouter, PDVMessageType.READY, readyTimeoutMs);
    // Avoid unhandled rejection warnings if bootstrap fails before pdv.ready.
    void readyPromise.catch(() => undefined);
    const bootstrapResult = await kernelManager.execute(kernelId, {
      code: bootstrapCode,
      silent: true,
    });
    if (bootstrapResult.error) {
      throw new Error(bootstrapResult.error);
    }
    // KernelManager.execute resolves on `status: idle` correlated to the
    // bootstrap execute's msg_id (see kernel-manager.ts), so by this point
    // the shell handler has finished bootstrap and is ready for the next
    // message. The previous extra `ping()` round-trip was a stopgap that
    // racetrap'd cold boots; the iopub-idle signal above is the
    // deterministic readiness invariant we actually want.
    step = "ready";
    await readyPromise;
    step = "init";
    const workingDir =
      preCreatedWorkingDir ?? (await projectManager.createWorkingDir(workingDirBase));
    await commRouter.request(PDVMessageType.INIT, {
      working_dir: workingDir,
      pdv_version: getAppVersion(),
      query_port: kernelManager.getQueryPort(kernelId),
    });
    queryRouter.attach(kernelManager, kernelId);
    kernelWorkingDirs.set(kernelId, workingDir);
  } catch (err) {
    const original = err instanceof Error ? err.message : String(err);
    const proc = kernelManager.getKernelProcessState(kernelId);
    const status = kernelManager.getKernel(kernelId)?.status ?? "(unknown)";
    const procStr = proc
      ? `exitCode=${proc.exitCode === null ? "null" : proc.exitCode} killed=${proc.killed}`
      : "(kernel not found)";
    throw new Error(
      `Kernel handshake failed at step '${step}': ${original}\n` +
        `  process: ${procStr}\n` +
        `  kernel status: ${status}\n` +
        `  last iopub msg_type: ${lastIopubMsgType ?? "(none)"}`
    );
  } finally {
    disposeIopubObserver();
  }
}
