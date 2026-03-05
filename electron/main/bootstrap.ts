/**
 * bootstrap.ts — Runtime entrypoint for the Electron main process.
 *
 * Creates process-wide service singletons and opens the BrowserWindow.
 */

import { app, BrowserWindow } from "electron";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { createWindow, wireAppEvents } from "./app";
import { CommRouter } from "./comm-router";
import { ConfigStore } from "./config";
import { KernelManager } from "./kernel-manager";
import { ProjectManager } from "./project-manager";

let kernelManager: KernelManager | null = null;
let mainWindow: BrowserWindow | null = null;
let openingWindow: Promise<void> | null = null;
let configStore: ConfigStore | null = null;

const commRouter = new CommRouter();
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
