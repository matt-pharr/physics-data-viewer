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
 * @returns Nothing.
 * @throws {Error} When bootstrap execution fails or handshake times out.
 */
export async function initializeKernelSession(
  kernelManager: KernelManager,
  commRouter: CommRouter,
  queryRouter: QueryRouter,
  projectManager: ProjectManager,
  kernelId: string,
  kernelWorkingDirs: Map<string, string>
): Promise<void> {
  const kernel = kernelManager.getKernel(kernelId);
  const language = kernel?.language ?? "python";
  const bootstrapCode = language === "julia" ? JULIA_BOOTSTRAP : PYTHON_BOOTSTRAP;
  // Julia JIT compilation can be slow on first load; allow more time.
  const readyTimeoutMs = language === "julia" ? 60_000 : 15_000;

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
  await readyPromise;
  // Ping the shell channel before sending pdv.init.  The bootstrap
  // execute leaves unread kernel_info_reply / execute_reply frames in the
  // DEALER socket's receive buffer.  Sending a kernel_info_request and
  // reading the correlated reply drains those stale frames and confirms
  // the kernel's shell thread is ready to accept the next message.
  // Without this, pdv.init (a comm_msg) can be silently lost on the
  // ROUTER socket under ipykernel ≥ 7.
  await kernelManager.ping(kernelId);
  const workingDir = await projectManager.createWorkingDir();
  await commRouter.request(PDVMessageType.INIT, {
    working_dir: workingDir,
    pdv_version: getAppVersion(),
    query_port: kernelManager.getQueryPort(kernelId),
  });
  queryRouter.attach(kernelManager, kernelId);
  kernelWorkingDirs.set(kernelId, workingDir);
}
