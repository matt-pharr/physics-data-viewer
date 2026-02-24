/**
 * ipc.ts — Electron IPC handler registration.
 *
 * Registers all ``ipcMain.handle()`` channels that the renderer uses to
 * communicate with the main process. Each handler translates a renderer
 * request into the appropriate kernel comm request (via CommRouter) or
 * main-process operation (via ProjectManager, ConfigStore, etc.) and
 * returns the result.
 *
 * IPC channel names mirror the PDV message type catalogue for consistency:
 *
 *   pdv:tree:list          → CommRouter.request('pdv.tree.list', ...)
 *   pdv:tree:get           → CommRouter.request('pdv.tree.get', ...)
 *   pdv:namespace:query    → CommRouter.request('pdv.namespace.query', ...)
 *   pdv:project:save       → ProjectManager.save(...)
 *   pdv:project:load       → ProjectManager.load(...)
 *   pdv:kernel:execute     → KernelManager.execute(...)
 *   pdv:kernel:restart     → KernelManager.restart()
 *   pdv:config:get         → ConfigStore.get(...)
 *   pdv:config:set         → ConfigStore.set(...)
 *   pdv:dialog:openDir     → dialog.showOpenDialog(...)
 *
 * Push notifications from the kernel are forwarded to the renderer via
 * ``BrowserWindow.webContents.send()``. See the bottom of this file.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §9 (IPC layer), §11 (renderer ↔ main contract)
 * electron/preload.ts — exposes ipcRenderer.invoke/on to the renderer
 */

import { ipcMain, BrowserWindow, dialog } from "electron";
import { CommRouter } from "./comm-router";
import { KernelManager } from "./kernel-manager";
import { ProjectManager } from "./project-manager";
import { ConfigStore } from "./config";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all IPC handlers.
 *
 * Must be called once during app startup, after the BrowserWindow has been
 * created and all managers have been instantiated.
 *
 * @param win - The main BrowserWindow (used to forward push notifications).
 * @param kernelManager - The active KernelManager.
 * @param commRouter - The CommRouter connected to the kernel.
 * @param projectManager - The ProjectManager.
 * @param configStore - The ConfigStore.
 */
export function registerIpcHandlers(
  win: BrowserWindow,
  kernelManager: KernelManager,
  commRouter: CommRouter,
  projectManager: ProjectManager,
  configStore: ConfigStore
): void {
  // TODO: implement in Step 5
  throw new Error("registerIpcHandlers not yet implemented");
}

// ---------------------------------------------------------------------------
// Push notification forwarding
// ---------------------------------------------------------------------------

/**
 * Register push notification forwarding from the kernel to the renderer.
 *
 * Subscribes to the CommRouter push handlers for all message types that
 * the renderer needs to react to:
 * - ``pdv.tree.changed``
 * - ``pdv.project.loaded``
 * - ``pdv.kernel.status``
 *
 * @param win - The main BrowserWindow.
 * @param commRouter - The CommRouter.
 */
export function registerPushForwarding(
  win: BrowserWindow,
  commRouter: CommRouter
): void {
  // TODO: implement in Step 5
  throw new Error("registerPushForwarding not yet implemented");
}

/**
 * Remove all IPC handlers registered by this module.
 *
 * Must be called on app shutdown to avoid handler leaks.
 */
export function unregisterIpcHandlers(): void {
  // TODO: implement in Step 5
  throw new Error("unregisterIpcHandlers not yet implemented");
}
