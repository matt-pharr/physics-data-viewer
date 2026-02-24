/**
 * kernel-manager.ts — Manages the Jupyter kernel lifecycle.
 *
 * Responsible for:
 * 1. Spawning a Jupyter kernel process using the detected Python environment.
 * 2. Connecting to the kernel via the Jupyter client protocol.
 * 3. Opening the ``pdv.kernel`` comm channel and handing it to CommRouter.
 * 4. Monitoring the kernel process and emitting lifecycle events.
 * 5. Gracefully shutting down the kernel and cleaning up the working directory.
 *
 * KernelManager does NOT know about the PDV protocol — it only deals with
 * raw Jupyter kernel machinery. All PDV comm traffic flows through CommRouter.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §4 (startup sequence), §6 (working directory lifecycle)
 * comm-router.ts — receives raw comm data from here
 * environment-detector.ts — provides pythonPath / jupyterPath
 */

import { CommRouter } from "./comm-router";
import { DetectedEnvironment } from "./environment-detector";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KernelStatus =
  | "idle"
  | "starting"
  | "ready"
  | "busy"
  | "restarting"
  | "dead";

export interface KernelManagerEvents {
  /** Emitted when the kernel transitions to 'ready' (pdv.ready received). */
  ready: [];
  /** Emitted when the kernel status changes. */
  statusChanged: [status: KernelStatus];
  /** Emitted when the kernel process dies unexpectedly. */
  died: [error?: Error];
}

// ---------------------------------------------------------------------------
// KernelManager
// ---------------------------------------------------------------------------

export class KernelManager extends EventEmitter {
  /**
   * @param environment - The detected Python environment to use.
   * @param workingDir - The PDV working directory path (created by the app).
   */
  constructor(
    private readonly environment: DetectedEnvironment,
    private readonly workingDir: string
  ) {
    super();
    // TODO: implement in Step 3
    throw new Error("KernelManager constructor not yet implemented");
  }

  /**
   * Start the kernel process and connect to it.
   *
   * Returns once the kernel is in 'ready' state (i.e. ``pdv.ready`` has been
   * received and ``pdv.init`` has been sent and acknowledged).
   *
   * @throws If the kernel fails to start within the timeout.
   */
  async start(): Promise<void> {
    // TODO: implement in Step 3
    throw new Error("KernelManager.start not yet implemented");
  }

  /**
   * Restart the kernel without changing the working directory.
   *
   * Sends interrupt, waits for the kernel to die, restarts it, re-runs
   * bootstrap, and re-sends pdv.init.
   */
  async restart(): Promise<void> {
    // TODO: implement in Step 3
    throw new Error("KernelManager.restart not yet implemented");
  }

  /**
   * Shut down the kernel gracefully.
   *
   * Sends a shutdown_request, kills the process if it doesn't exit within
   * the timeout, and deletes the working directory.
   *
   * @param deleteWorkingDir - If true (default), deletes the working directory.
   */
  async shutdown(deleteWorkingDir?: boolean): Promise<void> {
    // TODO: implement in Step 3
    throw new Error("KernelManager.shutdown not yet implemented");
  }

  /**
   * Execute user code in the kernel (execute_request).
   *
   * @param code - Python source code to execute.
   * @returns A promise that resolves when execution completes (execute_reply).
   */
  async execute(code: string): Promise<void> {
    // TODO: implement in Step 3
    throw new Error("KernelManager.execute not yet implemented");
  }

  /** The CommRouter connected to this kernel's comm channel. */
  get commRouter(): CommRouter {
    // TODO: implement in Step 3
    throw new Error("KernelManager.commRouter not yet implemented");
  }

  /** Current kernel status. */
  get status(): KernelStatus {
    // TODO: implement in Step 3
    throw new Error("KernelManager.status not yet implemented");
  }
}
