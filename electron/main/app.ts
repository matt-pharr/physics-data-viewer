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

import { BrowserWindow, app, type BrowserWindowConstructorOptions } from "electron";
import * as path from "path";
import * as os from "os";
import * as fsSync from "fs";

import { KernelManager } from "./kernel-manager";
import { CommRouter } from "./comm-router";
import { QueryRouter } from "./query-router";
import { ProjectManager } from "./project-manager";
import { ConfigStore } from "./config";
import { registerIpcHandlers } from "./index";
import { initializeAppMenu } from "./menu";
import { IPC } from "./ipc";

function getWindowChromeOptions(): BrowserWindowConstructorOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
    };
  }
  if (process.platform === "linux") {
    return {
      frame: false,
    };
  }
  return {};
}

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
  queryRouter: QueryRouter,
  projectManager: ProjectManager,
  configStore: ConfigStore
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    ...getWindowChromeOptions(),
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

  // `allowClose` gates the close intercept below. The renderer flips it via
  // `IPC.app.confirmClose` after the user resolves the unsaved-changes prompt.
  let allowClose = false;
  const setAllowClose = (allow: boolean): void => {
    allowClose = allow;
  };

  const resetSessionState = registerIpcHandlers(
    win,
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    configStore,
    path.join(os.homedir(), ".PDV"),
    setAllowClose,
  );

  // Intercept window close (title-bar X, OS close, Cmd+Q) so the renderer can
  // prompt the user about unsaved changes before the window goes away.
  win.on("close", (event) => {
    if (allowClose || win.webContents.isDestroyed()) {
      return;
    }
    // When a real quit is already in progress (Cmd+Q, autoUpdater restart,
    // OS logout), do NOT intercept — let Electron close the window
    // naturally so `window-all-closed` and `will-quit` can run. Routing
    // through the renderer dirty prompt here re-enters the quit machinery
    // and wedges the process on macOS. The title-bar X is still
    // intercepted because `isQuittingGlobal` is false in that case.
    if (isQuittingGlobal) {
      return;
    }
    event.preventDefault();
    win.webContents.send(IPC.push.requestClose);
  });

  // Reset in-memory project state on every renderer load/reload so that stale
  // module imports and project dirs from a previous session are cleared before
  // the renderer makes any IPC calls (e.g. modules:listImported).
  win.webContents.on("did-finish-load", () => {
    // Re-arm the close guard after a renderer reload so a stale `allowClose`
    // from a prior close attempt cannot leak into the next one.
    allowClose = false;
    resetSessionState();
  });

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

// Set by `before-quit` so window `close` handlers can distinguish a real quit
// (Cmd+Q, app.quit(), autoUpdater.quitAndInstall(), OS logout) from the user
// just closing the window with the title-bar X. Without this, macOS apps that
// intercept `close` get stuck: the window goes away but the process never
// exits, because `window-all-closed` is a no-op on darwin.
let isQuittingGlobal = false;

export function isQuitting(): boolean {
  return isQuittingGlobal;
}

export function markQuitting(): void {
  isQuittingGlobal = true;
}

/**
 * Register core Electron app events.
 *
 * @param getKernelManager - Lazy getter for the current kernel manager.
 * @returns Nothing.
 */
export function wireAppEvents(
  getKernelManager: () => KernelManager | null
): void {
  app.on("before-quit", () => {
    isQuittingGlobal = true;
  });

  app.on("window-all-closed", () => {
    // On darwin we normally keep the app alive after the window closes (so
    // Cmd+W behaves like a typical mac app). But if a real quit is in
    // progress, we must actually exit so `will-quit` runs and the kernel
    // shuts down — otherwise the process stays in the dock forever and
    // autoUpdater.quitAndInstall() can never replace the binary.
    if (process.platform !== "darwin" || isQuittingGlobal) {
      app.quit();
    }
  });

  // Run kernel shutdown during will-quit, after renderer close/save flows
  // have completed, so save-on-quit can still reach the active kernel.
  app.on("will-quit", (event) => {
    const kernelManager = getKernelManager();
    const kernelCount = kernelManager
      ? Array.from((kernelManager as unknown as { kernels: Map<string, unknown> }).kernels?.keys() ?? []).length
      : 0;
    // Nothing to clean up — let the quit proceed normally. preventDefault'ing
    // here and re-calling app.quit() afterwards is unreliable on macOS once
    // will-quit has been canceled.
    if (!kernelManager || isShuttingDownGlobal || kernelCount === 0) {
      return;
    }
    event.preventDefault();
    isShuttingDownGlobal = true;
    kernelManager
      .shutdownAll()
      .catch((error: unknown) => {
        console.error("[PDV] Failed to shutdown kernels during quit:", error);
      })
      .finally(() => {
        // Use app.exit() rather than app.quit() — once we've preventDefault'd
        // will-quit, re-entering the quit cycle is unreliable on macOS.
        app.exit(0);
      });
  });

  app.on("activate", () => {
    // Window re-creation is coordinated by the main startup module.
  });
}
