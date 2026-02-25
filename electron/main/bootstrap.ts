/**
 * bootstrap.ts — Runtime entrypoint for the Electron main process.
 *
 * Creates process-wide service singletons and opens the BrowserWindow.
 */

import { app, BrowserWindow } from "electron";

import { createWindow, wireAppEvents } from "./app";
import { CommRouter } from "./comm-router";
import { type ConfigStore } from "./config";
import { type PDVConfig } from "./ipc";
import { KernelManager } from "./kernel-manager";
import { ProjectManager } from "./project-manager";

class InMemoryConfigStore {
  private state: Partial<PDVConfig> = {};

  getAll(): PDVConfig {
    return { ...(this.state as PDVConfig) };
  }

  set(key: string, value: unknown): void {
    (this.state as Record<string, unknown>)[key] = value;
  }
}

let kernelManager: KernelManager | null = null;
let mainWindow: BrowserWindow | null = null;
let openingWindow: Promise<void> | null = null;

const commRouter = new CommRouter();
const projectManager = new ProjectManager(commRouter);
const configStore = new InMemoryConfigStore() as unknown as ConfigStore;

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
