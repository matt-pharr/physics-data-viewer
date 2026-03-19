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
import * as os from "os";
import * as fsSync from "fs";

import { KernelManager } from "./kernel-manager";
import { CommRouter } from "./comm-router";
import { ProjectManager } from "./project-manager";
import { ConfigStore } from "./config";
import { registerIpcHandlers } from "./index";
import { initializeAppMenu } from "./menu";


async function loadDevUrlWithRetry(
  win: BrowserWindow,
  url: string,
  attempts = 40,
  delayMs = 250
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await win.loadURL(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to load dev server URL");
}

/**
 * Create and initialize the main BrowserWindow.
 *
 * @param kernelManager - Active kernel manager instance.
 * @param commRouter - Active comm router instance.
 * @param projectManager - Active project manager instance.
 * @param configStore - Active config store instance.
 * @returns Created BrowserWindow.
 * @throws {Error} When renderer content cannot be loaded.
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Clean up any orphaned pdv-* working dirs from a previous crash.
  const tmpDir = os.tmpdir();
  try {
    const entries = fsSync.readdirSync(tmpDir);
    for (const e of entries) {
      if (/^pdv-/.test(e)) {
        fsSync.rmSync(path.join(tmpDir, e), { recursive: true, force: true });
      }
    }
  } catch { /* best-effort */ }

  const resetSessionState = registerIpcHandlers(win, kernelManager, commRouter, projectManager, configStore, path.join(os.homedir(), ".PDV"));

  // Reset in-memory project state on every renderer load/reload so that stale
  // module imports and project dirs from a previous session are cleared before
  // the renderer makes any IPC calls (e.g. modules:listImported).
  win.webContents.on("did-finish-load", resetSessionState);

  initializeAppMenu(win);

  const rendererIndexPath = path.join(
    __dirname,
    "..",
    "..",
    "renderer",
    "dist",
    "index.html",
  );
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  try {
    if (process.env.NODE_ENV === "development") {
      if (!devServerUrl) {
        throw new Error("VITE_DEV_SERVER_URL is not set");
      }
      await loadDevUrlWithRetry(win, devServerUrl);
    } else {
      await win.loadFile(rendererIndexPath);
    }
    win.show();
  } catch (error) {
    win.destroy();
    throw error;
  }

  return win;
}

// Module-level shutdown flag to prevent re-entrant kernel cleanup during quit.
let isShuttingDownGlobal = false;

/**
 * Register core Electron app events.
 *
 * @param getKernelManager - Lazy getter for the current kernel manager.
 * @returns Nothing.
 */
export function wireAppEvents(
  getKernelManager: () => KernelManager | null
): void {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Run kernel shutdown during will-quit, after renderer close/save flows
  // have completed, so save-on-quit can still reach the active kernel.
  app.on("will-quit", (event) => {
    const kernelManager = getKernelManager();
    if (!kernelManager || isShuttingDownGlobal) {
      return;
    }
    // Prevent the default quit so we can await async cleanup first.
    event.preventDefault();
    isShuttingDownGlobal = true;
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
