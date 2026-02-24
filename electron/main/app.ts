/**
 * app.ts — Electron app lifecycle (BrowserWindow creation, app events).
 *
 * Handles:
 * - Creating the BrowserWindow with the correct preload script.
 * - Loading the renderer URL (Vite dev server in development, file:// in production).
 * - Responding to ``app.on('activate')`` (macOS dock click).
 * - Calling ``registerIpcHandlers()`` after the window is ready.
 * - Graceful shutdown sequence on window-close.
 *
 * Does NOT own the kernel or comm layer — those are owned by index.ts and
 * passed in.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §4.1 (startup), §6.3 (shutdown)
 * index.ts — the entry point that calls createWindow()
 */

import { BrowserWindow, app } from "electron";
import * as path from "path";
import { KernelManager } from "./kernel-manager";
import { CommRouter } from "./comm-router";
import { ProjectManager } from "./project-manager";
import { ConfigStore } from "./config";
import { registerIpcHandlers, registerPushForwarding } from "./ipc";

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

/**
 * Create the main BrowserWindow and load the renderer.
 *
 * @param kernelManager - An already-started KernelManager.
 * @param commRouter - The CommRouter from the kernel.
 * @param projectManager - The ProjectManager.
 * @param configStore - The ConfigStore.
 * @returns The created BrowserWindow.
 */
export async function createWindow(
  kernelManager: KernelManager,
  commRouter: CommRouter,
  projectManager: ProjectManager,
  configStore: ConfigStore
): Promise<BrowserWindow> {
  // TODO: implement in Step 5
  throw new Error("createWindow not yet implemented");
}

// ---------------------------------------------------------------------------
// App event wiring
// ---------------------------------------------------------------------------

/**
 * Wire up ``app.on('activate')`` and ``app.on('window-all-closed')``
 * for macOS and cross-platform behaviour.
 *
 * Called once from index.ts after the app is ready.
 *
 * @param getKernelManager - Returns the current KernelManager (may be null
 *   if the kernel hasn't started yet).
 */
export function wireAppEvents(
  getKernelManager: () => KernelManager | null
): void {
  // TODO: implement in Step 5
  throw new Error("wireAppEvents not yet implemented");
}
