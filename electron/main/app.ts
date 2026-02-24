/**
 * app.ts — Electron app lifecycle and BrowserWindow creation.
 *
 * Owns BrowserWindow creation/loading and high-level Electron app events.
 * Kernel/comm business logic remains in `index.ts` and injected dependencies.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §4.1, §11.1
 * index.ts — IPC handler registration and push forwarding
 */

import { BrowserWindow, app } from "electron";
import * as path from "path";

import { KernelManager } from "./kernel-manager";
import { CommRouter } from "./comm-router";
import { ProjectManager } from "./project-manager";
import { ConfigStore } from "./config";
import { registerIpcHandlers } from "./index";

/**
 * Create and initialize the main BrowserWindow.
 *
 * @param kernelManager - Active kernel manager instance.
 * @param commRouter - Active comm router instance.
 * @param projectManager - Active project manager instance.
 * @param configStore - Active config store instance.
 * @returns Created BrowserWindow.
 */
export async function createWindow(
  kernelManager: KernelManager,
  commRouter: CommRouter,
  projectManager: ProjectManager,
  configStore: ConfigStore
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerIpcHandlers(win, kernelManager, commRouter, projectManager, configStore);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (process.env.NODE_ENV === "development" && devServerUrl) {
    await win.loadURL(devServerUrl);
  } else {
    await win.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
  }

  return win;
}

/**
 * Register core Electron app events.
 *
 * @param getKernelManager - Lazy getter for the current kernel manager.
 */
export function wireAppEvents(
  getKernelManager: () => KernelManager | null
): void {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Guard against re-entry: Electron fires `before-quit` again after we call
  // `app.quit()` once async shutdown is complete.
  let isShuttingDown = false;

  app.on("before-quit", (event) => {
    const kernelManager = getKernelManager();
    if (!kernelManager || isShuttingDown) {
      return;
    }
    // Prevent the default quit so we can await async cleanup first.
    event.preventDefault();
    isShuttingDown = true;
    kernelManager
      .shutdownAll()
      .catch((error: unknown) => {
        console.error("[PDV] Failed to shutdown kernels during quit:", error);
      })
      .finally(() => {
        app.quit();
      });
  });

  app.on("activate", () => {
    // Window re-creation is coordinated by the main startup module.
  });
}

