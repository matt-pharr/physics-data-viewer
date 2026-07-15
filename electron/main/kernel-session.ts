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

/**
 * Kernel-side bootstrap snippet for Julia sessions. Exported so the Julia
 * integration test (`integration-julia.test.ts`) drives the exact snippet
 * production uses rather than a diverging copy.
 */
export const JULIA_BOOTSTRAP = `
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

/**
 * Wait for a comm push with an activity-based deadline (§10.8): the idle
 * timer restarts on every `keepalive()` call, under a hard total cap.
 *
 * @param commRouter - Comm router to observe.
 * @param type - Push message type to wait for.
 * @param idleMs - Maximum silence tolerated between keepalives.
 * @param maxMs - Hard ceiling on the whole wait regardless of activity.
 * @returns The wait promise plus the `keepalive` reset handle.
 */
function waitForPush(
  commRouter: CommRouter,
  type: string,
  idleMs: number,
  maxMs: number
): { promise: Promise<void>; keepalive: () => void } {
  let keepalive: () => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(capTimer);
      commRouter.offPush(type, handler);
      if (err) { reject(err); } else { resolve(); }
    };
    const idleExpired = (): void =>
      settle(
        new Error(
          `Timed out waiting for push: ${type} (no kernel activity for ${Math.round(idleMs / 1000)} s)`
        )
      );
    let idleTimer = setTimeout(idleExpired, idleMs);
    const capTimer = setTimeout(
      () =>
        settle(
          new Error(
            `Timed out waiting for push: ${type} (still absent after ${Math.round(maxMs / 1000)} s)`
          )
        ),
      maxMs
    );
    keepalive = (): void => {
      if (settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(idleExpired, idleMs);
    };
    const handler = (): void => settle();
    commRouter.onPush(type, handler);
  });
  return { promise, keepalive };
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
 * @param uvBinaryPath - Optional absolute path to the resolved `uv` binary,
 *   passed to the kernel (uv-mode only) so `pdv.install()` can run `uv add`
 *   directly (§10.5.11).
 * @param onBootOutput - Optional sink for kernel output produced during the
 *   handshake (process stderr + iopub stream text). Julia launches forward
 *   this to the EnvSyncModal so precompile progress is visible instead of a
 *   bare spinner (§10.8).
 * @returns Nothing.
 * @throws {Error} When bootstrap execution fails or the handshake goes
 *   silent past its idle allowance (or blows the hard cap) — see §10.8;
 *   a kernel that is visibly precompiling keeps the wait alive.
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
  uvBinaryPath?: string,
  onBootOutput?: (text: string) => void,
): Promise<void> {
  const kernel = kernelManager.getKernel(kernelId);
  const language = kernel?.language ?? "python";
  const bootstrapCode = language === "julia" ? JULIA_BOOTSTRAP : PYTHON_BOOTSTRAP;
  // Activity-based ready deadline (§10.8): the bootstrap's `using PDVKernel`
  // can legitimately recompile for minutes when caches are stale (package
  // update, Julia upgrade, edited dev-install), streaming progress the whole
  // time. Idle silence still fails fast; visible work extends up to the cap.
  const readyIdleMs = language === "julia" ? 60_000 : 15_000;
  const readyMaxMs = language === "julia" ? 20 * 60_000 : 60_000;

  // Track the last iopub msg_type seen during the handshake so that, if
  // anything throws, the diagnostic message can tell the user what the
  // kernel was last doing instead of just "Kernel failed to start".
  let lastIopubMsgType: string | null = null;

  let step: "bootstrap" | "ready" | "init" = "bootstrap";
  const ready = waitForPush(commRouter, PDVMessageType.READY, readyIdleMs, readyMaxMs);

  // Handshake activity taps (§10.8): iopub stream traffic (IJulia re-emits
  // captured execution output there, which is where bootstrap-time precompile
  // progress lands) and raw process output (where IJulia's own boot writes)
  // both count as signs of life and both feed the boot-output sink.
  const disposeIopubObserver = kernelManager.onIopubMessage(kernelId, (m) => {
    lastIopubMsgType = m.header.msg_type;
    if (m.header.msg_type === "stream") {
      ready.keepalive();
      const text = (m.content as { text?: unknown })?.text;
      if (typeof text === "string" && text.length > 0) onBootOutput?.(text);
    }
  });
  const disposeOutputObserver = kernelManager.onProcessOutput(
    kernelId,
    (_stream, data) => {
      ready.keepalive();
      onBootOutput?.(data);
    }
  );

  try {
    const readyPromise = ready.promise;
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
      ...(uvBinaryPath ? { uv_binary: uvBinaryPath } : {}),
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
    disposeOutputObserver();
  }
}
