/**
 * bootstrap.ts — Runtime entrypoint for the Electron main process (shell).
 *
 * Startup sequence (in order):
 * 1. Enable remote debugging if `NODE_ENV=development` (CDP port 9222).
 * 2. Request single-instance lock; quit immediately if denied.
 * 3. Wire app lifecycle events (`ready`, `activate`, `second-instance`).
 * 4. On `ready`: start the pdv-server child process via
 *    {@link ServerSupervisor} (spawn + hello handshake), then open the
 *    main `BrowserWindow` via {@link createWindow}, whose IPC wiring
 *    bridges every server channel over the stdio transport.
 * 5. On `second-instance`: focus existing window or open a new one.
 *
 * The shell constructs no session managers: KernelManager, CommRouter,
 * ProjectManager, ConfigStore, and the MCP server all live in the
 * pdv-server process (`server/server-main.ts`).
 *
 * The `openingWindow` promise acts as a mutex: concurrent calls to
 * `openMainWindow()` (e.g. rapid `second-instance` events) coalesce into
 * a single window creation.
 *
 * See Also
 * --------
 * app.ts — BrowserWindow lifecycle and renderer loading
 * shell/server-supervisor.ts — pdv-server process lifecycle
 * index.ts — IPC handler registration (called from {@link createWindow})
 */

// Prepend a timestamp to every console.* call from the main process.
// Installed before any other imports so all module-level logs are stamped.
(function installConsoleTimestamps(): void {
  const stamp = (): string => {
    const d = new Date();
    const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => original(`[${stamp()}]`, ...args);
  }
})();

import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import * as os from "os";
import * as path from "path";

import { createWindow, wireAppEvents } from "./app";
import { INTERNAL_CHANNELS } from "./ipc";
import { ServerSupervisor } from "./shell/server-supervisor";

// Under PDV_E2E, redirect Electron's userData (where the renderer's
// localStorage and the server's ConfigStore-backed preferences live) to a
// path under the test's temp HOME. On macOS, app.getPath('appData') is
// derived from NSHomeDirectory() / getpwuid(), NOT $HOME, so overriding
// HOME in the launcher alone leaks userData into the developer's real PDV
// install. Each E2E launch gets its own temp HOME (mkdtemp in launch.ts),
// so this gives us per-test localStorage isolation. Must run before the
// supervisor is created — it passes userData to the server process.
if (process.env.PDV_E2E === "1" && process.env.HOME) {
  app.setPath("userData", path.join(process.env.HOME, ".pdv-e2e-userdata"));
}

let serverSupervisor: ServerSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;
let openingWindow: Promise<void> | null = null;

async function openMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return;
  }
  if (openingWindow) {
    await openingWindow;
    return;
  }
  openingWindow = (async () => {
    const server = serverSupervisor;
    if (!server) {
      throw new Error("pdv-server is not running");
    }
    const win = await createWindow(server);
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
  wireAppEvents(() => serverSupervisor);
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

  app.whenReady().then(async () => {
    if (process.env.NODE_ENV === "development" && !process.env.VITE_DEV_SERVER_URL) {
      process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
    }

    // Start the pdv-server before any window: the window's initial
    // background color and IPC bridge both need it.
    const supervisor = new ServerSupervisor({
      version: app.getVersion(),
      userDataDir: app.getPath("userData"),
      pdvDir: path.join(os.homedir(), ".PDV"),
      resourcesRoot: process.resourcesPath ?? null,
      getWindow: () => mainWindow,
    });
    try {
      await supervisor.start();
    } catch (error) {
      console.error("[PDV] Failed to start pdv-server:", error);
      dialog.showErrorBox(
        "PDV failed to start",
        `The PDV backend process could not be started.\n\n${
          error instanceof Error ? error.message : String(error)
        }`
      );
      app.exit(1);
      return;
    }
    serverSupervisor = supervisor;

    // System wake recovery runs next to the kernel connection — forward
    // the resume event to the server.
    powerMonitor.on("resume", () => {
      void supervisor.invoke(INTERNAL_CHANNELS.systemResumed).catch((err) => {
        console.error("[PDV] Wake handler error:", err);
      });
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
