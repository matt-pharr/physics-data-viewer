/**
 * app.ts — Electron app lifecycle and BrowserWindow creation.
 *
 * Owns BrowserWindow creation/loading and high-level Electron app events.
 * Session/kernel logic lives in the pdv-server process; this module only
 * needs a {@link ServerHandle} (async config reads before the window
 * exists, graceful shutdown on quit) — and never needs to know whether the
 * server behind it is local or remote.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §4.1, §11.1
 * index.ts — IPC handler registration and push forwarding
 * shell/server-supervisor.ts — the ServerHandle contract and local implementation
 */

import { BrowserWindow, app, nativeTheme, type BrowserWindowConstructorOptions } from "electron";
import * as path from "path";
import * as os from "os";
import * as fsSync from "fs";

import { registerIpcHandlers } from "./index";
import { initializeAppMenu } from "./menu";
import { IPC, type PDVConfig } from "./ipc";
import type { ServerHandle } from "./shell/server-supervisor";

/**
 * Check whether a process with the given PID is currently running.
 *
 * Uses signal 0 which tests existence without actually sending a signal.
 *
 * @param pid - Process ID to check.
 * @returns `true` if the process is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

/**
 * Built-in theme `bg-primary` lookup, mirrored from
 * `renderer/src/themes.ts`'s `BUILTIN_THEMES`. Duplicated here because
 * `themes.ts` lives in the renderer bundle and isn't reachable from main.
 * Keep in sync when adding or renaming built-in themes.
 */
const BUILTIN_BG_PRIMARY: Record<string, string> = {
  "Dark+ (VSCode)": "#1e1e1e",
  "Light+ (VSCode)": "#ffffff",
  "Monokai": "#272822",
  "Xcode Light": "#ffffff",
  "Xcode Dark": "#242529",
  "Dark Modern (VSCode)": "#1f1f1f",
  "Light Modern (VSCode)": "#ffffff",
};

const FALLBACK_DARK_BG = "#1e1e1e";
const FALLBACK_LIGHT_BG = "#ffffff";

/**
 * Resolve the BrowserWindow `backgroundColor` from persisted appearance
 * settings before any renderer code runs. Mirrors the renderer's
 * `useThemeManager` resolution: honors `followSystemTheme` via
 * `nativeTheme.shouldUseDarkColors`, then falls back to a constant dark
 * value if no usable theme name is found.
 *
 * Custom user themes (saved on disk by `themes:save`) aren't visible from
 * here without an extra disk read on the hot-path; if the active theme is
 * custom we fall back to dark/light by system preference. The renderer's
 * follow-up `window:setBackgroundColor` call corrects it within ms.
 *
 * @param settings - The persisted `appearance` block (may be undefined).
 * @returns A hex color string suitable for `BrowserWindowConstructorOptions.backgroundColor`.
 */
function resolveInitialBackgroundColor(
  settings: { themeName?: string; followSystemTheme?: boolean; darkTheme?: string; lightTheme?: string; colors?: Record<string, string> } | undefined,
): string {
  const systemDark = nativeTheme.shouldUseDarkColors;
  if (!settings) return systemDark ? FALLBACK_DARK_BG : FALLBACK_LIGHT_BG;
  if (settings.colors?.["bg-primary"]) return settings.colors["bg-primary"];
  const activeName = settings.followSystemTheme
    ? (systemDark ? settings.darkTheme : settings.lightTheme)
    : settings.themeName;
  if (activeName && BUILTIN_BG_PRIMARY[activeName]) return BUILTIN_BG_PRIMARY[activeName];
  return systemDark ? FALLBACK_DARK_BG : FALLBACK_LIGHT_BG;
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
 * @param server - The session's server handle (already started); used for
 *   the pre-window config read and the IPC bridge registration.
 * @returns Created BrowserWindow.
 * @throws {Error} When renderer content cannot be loaded or the server is
 *   unreachable for the initial config read.
 */
export async function createWindow(
  server: ServerHandle
): Promise<BrowserWindow> {
  // One config snapshot before any window exists: initial background color
  // and the custom working-dir base for the orphan scan below. The config
  // lives with the server — the shell holds no ConfigStore.
  const config = (await server.invoke(IPC.config.get)) as PDVConfig;

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    backgroundColor: resolveInitialBackgroundColor(config.settings?.appearance),
    ...getWindowChromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Clean up orphaned pdv-* working dirs from a previous crash.
  // Each session writes a session.lock with its PID; dirs whose owner is
  // no longer running (or that lack a lockfile) are treated as orphans.
  // Scan both the default location and any custom location from config.
  // Skipped under PDV_E2E so fixture-seeded orphans (autosave-recovery
  // spec) survive into the test, and so a developer running the suite
  // doesn't have their real ~/.PDV/working state mutated.
  const defaultWorkingBase = path.join(os.homedir(), ".PDV", "working");
  const customWorkingBase = config.workingDirBase;
  const workingBases = new Set([defaultWorkingBase]);
  if (customWorkingBase) workingBases.add(customWorkingBase);
  if (process.env.PDV_E2E === "1") {
    workingBases.clear();
  }
  for (const workingBase of workingBases) {
    try {
      const entries = fsSync.readdirSync(workingBase);
      for (const e of entries) {
        if (!/^pdv-/.test(e)) continue;
        const sessionDir = path.join(workingBase, e);
        const lockPath = path.join(sessionDir, "session.lock");
        try {
          const lockData = JSON.parse(fsSync.readFileSync(lockPath, "utf8"));
          if (typeof lockData.pid === "number" && isProcessAlive(lockData.pid)) {
            continue;
          }
        } catch {
          // No lockfile or unreadable — treat as orphan.
        }
        // Preserve dirs that have autosaved tree state — the welcome screen's
        // "Recoverable Unsaved Sessions" surfaces these so the user can opt to
        // Recover or Discard. Wiping here would silently destroy unsaved work
        // from a previous crash. Recover/Discard remove the dir afterwards.
        if (fsSync.existsSync(path.join(sessionDir, ".autosave", "tree-index.json"))) {
          continue;
        }
        fsSync.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch { /* best-effort — workingBase may not exist on first launch */ }
  }

  // `allowClose` gates the close intercept below. The renderer flips it via
  // `IPC.app.confirmClose` after the user resolves the unsaved-changes prompt.
  let allowClose = false;
  const setAllowClose = (allow: boolean): void => {
    allowClose = allow;
  };

  const resetSessionState = await registerIpcHandlers(
    win,
    server,
    path.join(os.homedir(), ".PDV"),
    setAllowClose,
  );

  // Intercept window close (title-bar X, OS close) so the renderer can
  // prompt the user about unsaved changes before the window goes away.
  // Skipped under PDV_E2E: Playwright's app.close() drives the same code
  // path, and `projectDirty` flips to true as soon as the kernel reaches
  // ready, so the dialog would block every spec's teardown indefinitely.
  const skipCloseGuard = process.env.PDV_E2E === "1";
  win.on("close", (event) => {
    if (skipCloseGuard || allowClose || win.webContents.isDestroyed()) {
      return;
    }
    // X-click / native close supersedes any pending quit dialog: this is a
    // close, not a quit, so confirmClose should call win.close() (and on
    // darwin leave the app in the dock) rather than app.quit().
    quitRequestPending = false;
    event.preventDefault();
    win.webContents.send(IPC.push.requestClose);
  });

  // Intercept Cmd+Q / menu Quit / autoUpdater restart / OS logout so the same
  // unsaved-changes dialog runs before the app exits. The renderer's existing
  // `requestClose` handler decides whether to show the dialog (dirty) or
  // immediately confirm (clean), then calls `confirmClose`, which sets
  // `allowClose=true` and re-invokes `app.quit()`. On the second pass we fall
  // through the `allowClose` gate and the quit proceeds normally.
  const beforeQuitGuard = (event: Electron.Event): void => {
    if (skipCloseGuard || allowClose) {
      isQuittingGlobal = true;
      quitRequestPending = false;
      return;
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      isQuittingGlobal = true;
      quitRequestPending = false;
      return;
    }
    event.preventDefault();
    quitRequestPending = true;
    win.webContents.send(IPC.push.requestClose);
  };
  app.on("before-quit", beforeQuitGuard);
  // The guard belongs to this window. Detach it when the window goes away:
  // otherwise every macOS close → activate → re-create cycle stacks another
  // handler whose destroyed-window branch flips isQuittingGlobal before the
  // live window's guard has decided whether to block the quit.
  win.on("closed", () => {
    app.removeListener("before-quit", beforeQuitGuard);
    // Detach the bridge with the window it belongs to. The handlers close
    // over this BrowserWindow; leaving them attached means a server-side
    // confirm arriving while no window exists (macOS close-but-don't-quit)
    // would target a destroyed window instead of taking the supervisor's
    // safe auto-cancel path. The next window's registerIpcHandlers()
    // installs a fresh bridge.
    server.clearBridgeHandlers();
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

// Set when a quit is actively proceeding (we've passed the `allowClose` gate
// or there's no renderer to ask). `window-all-closed` reads this on darwin
// to decide whether to actually exit; without it, macOS apps that intercept
// `close` get stuck in the dock with no live window.
let isQuittingGlobal = false;

// Set when `before-quit` fired and we deferred to the renderer's dirty
// prompt — i.e. a quit is requested but awaiting user resolution. Read by
// `confirmClose` to decide whether to call `app.quit()` (full quit) or
// `win.close()` (just close window, app stays in dock on darwin). Cleared
// when the user clicks the title-bar X / native close instead, so an
// X-click supersedes any orphaned quit request and a confirm afterwards
// doesn't accidentally quit the app on darwin.
let quitRequestPending = false;

export function isQuitting(): boolean {
  return isQuittingGlobal;
}

export function markQuitting(): void {
  isQuittingGlobal = true;
}

export function isQuitRequestPending(): boolean {
  return quitRequestPending;
}

export function clearQuitRequestPending(): void {
  quitRequestPending = false;
}

/**
 * Register core Electron app events.
 *
 * @param getServer - Lazy getter for the session's server handle; drives the
 *   graceful shutdown chain (server stops kernels and MCP) during quit.
 * @returns Nothing.
 */
export function wireAppEvents(
  getServer: () => ServerHandle | null
): void {
  app.on("before-quit", () => {
    isQuittingGlobal = true;
  });

  app.on("window-all-closed", () => {
    // On darwin we normally keep the app alive after the window closes (so
    // Cmd+W behaves like a typical mac app). But if a real quit is in
    // progress, we must actually exit so `will-quit` runs and the server
    // shuts down — otherwise the process stays in the dock forever and
    // autoUpdater.quitAndInstall() can never replace the binary.
    if (process.platform !== "darwin" || isQuittingGlobal) {
      app.quit();
    }
  });

  // Run the server shutdown during will-quit, after renderer close/save
  // flows have completed, so save-on-quit can still reach the active
  // kernel. The server owns kernel shutdown, MCP stop, and working-dir
  // cleanup; the supervisor escalates if it hangs.
  app.on("will-quit", (event) => {
    const server = getServer();
    if (!server || isShuttingDownGlobal) {
      return;
    }
    event.preventDefault();
    isShuttingDownGlobal = true;
    server
      .shutdown()
      .catch((error: unknown) => {
        console.error("[PDV] Failed to shutdown pdv-server during quit:", error);
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
