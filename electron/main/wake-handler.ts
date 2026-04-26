/**
 * wake-handler.ts — System sleep/wake recovery for the kernel connection.
 *
 * On macOS (and other platforms), system sleep suspends all processes.
 * When the machine wakes, ZeroMQ sockets on loopback normally survive
 * because both endpoints were frozen simultaneously. However the kernel
 * process may have been killed by the OS during sleep (memory pressure /
 * jetsam), or a long hibernation may leave sockets in a bad state.
 *
 * This module pings the active kernel after wake and notifies the renderer
 * so it can refresh its cached tree/namespace state.
 *
 * See Also
 * --------
 * bootstrap.ts — registers the powerMonitor listener
 * kernel-manager.ts — owns the ping() method
 */

import type { BrowserWindow } from "electron";
import type { KernelManager } from "./kernel-manager";
import { IPC } from "./ipc";

/**
 * Check the active kernel after a system resume event.
 *
 * PDV runs a single kernel at a time. If the kernel responds to a
 * shell-channel ping, a `kernelReconnected` push is sent to the renderer
 * so it can refresh stale UI state. If the ping fails, the kernel's
 * existing process-exit crash handler will fire independently — no extra
 * action is needed here.
 *
 * @param kernelManager - Active kernel manager (may be null before first use).
 * @param getMainWindow - Returns the main BrowserWindow, or null.
 */
export async function handleSystemResume(
  kernelManager: KernelManager | null,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  if (!kernelManager) return;

  const kernels = kernelManager.list();
  const kernel = kernels.find((k) => k.status !== "dead");
  if (!kernel) return;

  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;

  try {
    await kernelManager.ping(kernel.id, 10_000);
    win.webContents.send(IPC.push.kernelReconnected, {
      kernelId: kernel.id,
    });
  } catch {
    console.warn(
      `[PDV] Kernel ${kernel.id.slice(0, 8)} unresponsive after wake`
    );
  }
}
