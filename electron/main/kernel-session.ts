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
import { KernelManager } from "./kernel-manager";
import { PDVMessageType } from "./pdv-protocol";
import { ProjectManager } from "./project-manager";

const BOOTSTRAP_AND_OPEN_COMM = `
from IPython import get_ipython
import pdv_kernel
import pdv_kernel.comms as _pdv_comms
try:
    from ipykernel.comm import Comm
except Exception:
    from comm import Comm
_ip = get_ipython()
pdv_kernel.bootstrap(_ip)
if _pdv_comms._comm is None:
    _pdv_comm = Comm(target_name="pdv.kernel")
    _pdv_comms._comm = _pdv_comm
    _pdv_comm.on_msg(_pdv_comms._on_comm_message)
    _pdv_comms.send_message("pdv.ready", {})
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
  projectManager: ProjectManager,
  kernelId: string,
  kernelWorkingDirs: Map<string, string>
): Promise<void> {
  const readyPromise = waitForPush(commRouter, PDVMessageType.READY, 15_000);
  // Avoid unhandled rejection warnings if bootstrap fails before pdv.ready.
  void readyPromise.catch(() => undefined);
  const bootstrapResult = await kernelManager.execute(kernelId, {
    code: BOOTSTRAP_AND_OPEN_COMM,
    silent: true,
  });
  if (bootstrapResult.error) {
    throw new Error(bootstrapResult.error);
  }
  await readyPromise;
  const workingDir = await projectManager.createWorkingDir();
  await commRouter.request(PDVMessageType.INIT, {
    working_dir: workingDir,
    pdv_version: "1.0",
  });
  kernelWorkingDirs.set(kernelId, workingDir);
}
