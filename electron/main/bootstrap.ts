/**
 * bootstrap.ts — Runtime entrypoint for the Electron main process.
 *
 * Startup sequence (in order):
 * 1. Enable remote debugging if `NODE_ENV=development` (CDP port 9222).
 * 2. Request single-instance lock; quit immediately if denied.
 * 3. Wire app lifecycle events (`ready`, `activate`, `second-instance`).
 * 4. On `ready`: lazy-create `KernelManager` and `ConfigStore`, then open
 *    the main `BrowserWindow` via {@link createWindow}.
 * 5. On `second-instance`: focus existing window or open a new one.
 *
 * Singletons (module-level):
 * - `commRouter`      — created once at import time; shared across windows.
 * - `projectManager`  — created once at import time; uses `commRouter`.
 * - `kernelManager`   — lazy-created on first window open so kernel infra
 *                        is not allocated during unit tests or quick exits.
 * - `configStore`     — lazy-created on first window open; reads/writes
 *                        `~/.PDV/config.json`.
 *
 * The `openingWindow` promise acts as a mutex: concurrent calls to
 * `openMainWindow()` (e.g. rapid `second-instance` events) coalesce into
 * a single window creation.
 *
 * See Also
 * --------
 * app.ts — BrowserWindow lifecycle and renderer loading
 * index.ts — IPC handler registration (called from {@link createWindow})
 */

import { app, BrowserWindow, powerMonitor } from "electron";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { createWindow, wireAppEvents } from "./app";
import { CommRouter } from "./comm-router";
import { QueryRouter } from "./query-router";
import { ConfigStore } from "./config";
import { KernelManager } from "./kernel-manager";
import { ProjectManager } from "./project-manager";
import { handleSystemResume } from "./wake-handler";

let kernelManager: KernelManager | null = null;
let mainWindow: BrowserWindow | null = null;
let openingWindow: Promise<void> | null = null;
let configStore: ConfigStore | null = null;

const commRouter = new CommRouter();
const queryRouter = new QueryRouter();
const projectManager = new ProjectManager(commRouter);

async function openMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return;
  }
  if (openingWindow) {
    await openingWindow;
    return;
  }
  openingWindow = (async () => {
    if (!kernelManager) {
      kernelManager = new KernelManager();
    }
    if (!configStore) {
      const pdvDir = path.join(os.homedir(), ".PDV");
      fs.mkdirSync(pdvDir, { recursive: true });
      configStore = new ConfigStore(pdvDir);
    }
    const win = await createWindow(
      kernelManager,
      commRouter,
      queryRouter,
      projectManager,
      configStore,
    );
    mainWindow = win;
    win.on("closed", () => {
      if (mainWindow === win) {
        mainWindow = null;
      }
    });
  })();
  try {
    await openingWindow;
  } finally {
    openingWindow = null;
  }
}

// Enable remote debugging in development so external tools (e.g. MCP
// servers) can connect to the renderer via CDP.
if (process.env.NODE_ENV === "development") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  wireAppEvents(() => kernelManager);
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
      return;
    }
    void openMainWindow().catch((error) => {
      console.error("[PDV] Failed to open main window on second-instance:", error);
    });
  });

  app.whenReady().then(() => {
    if (process.env.NODE_ENV === "development" && !process.env.VITE_DEV_SERVER_URL) {
      process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
    }

    powerMonitor.on("resume", () => {
      void handleSystemResume(kernelManager, () => mainWindow).catch(
        (err) => {
          console.error("[PDV] Wake handler error:", err);
        }
      );
    });

    void openMainWindow().catch((error) => {
      console.error("[PDV] Failed to open main window:", error);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void openMainWindow().catch((error) => {
          console.error("[PDV] Failed to re-open main window:", error);
        });
      }
    });
  });
}
