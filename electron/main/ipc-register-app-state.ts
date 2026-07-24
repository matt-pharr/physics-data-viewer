/**
 * ipc-register-app-state.ts — Register app-state and file-picker IPC handlers.
 *
 * Responsibilities:
 * - Register theme/menu/chrome/updater/file-picker IPC handlers.
 * - Hydrate the in-memory theme cache from disk.
 *
 * Non-responsibilities:
 * - Kernel lifecycle, project, tree, or modules IPC handling.
 * - `config.get`/`config.set` — server channels (see ipc-register-config.ts).
 * - Push forwarding between comm router and renderer.
 */

import { BrowserWindow as ElectronBrowserWindow, app, dialog, shell, type BrowserWindow } from "electron";
import { handleIpc } from "./ipc-registry";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";

import type { UpdateCheckStamp } from "./auto-updater";
import type { Theme, WindowChromeInfo, WindowChromePlatform } from "./ipc";
import { IPC } from "./ipc";
import { getTopLevelMenuModel, popupTopLevelMenu, updateMenuEnabled, updateRecentProjectsMenu } from "./menu";
import { initAutoUpdater, checkForUpdates, downloadUpdate, installUpdate, openReleasesPage, getUpdateStatus } from "./auto-updater";
import { isQuitting, isQuitRequestPending, clearQuitRequestPending } from "./app";

let savedThemes: Theme[] = [];

interface RegisterAppStateIpcHandlersOptions {
  win: BrowserWindow;
  themesDir: string;
  stateDir: string;
  /** Flips the close-guard flag in `app.ts` so the next `win.close()` proceeds. */
  setAllowClose: (allow: boolean) => void;
  /** Async accessors for the updater's lastUpdateCheck timestamp. */
  updateCheckStamp: UpdateCheckStamp;
}

function getWindowChromePlatform(): WindowChromePlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "windows";
}

function buildWindowChromeInfo(win: BrowserWindow): WindowChromeInfo {
  const platform = getWindowChromePlatform();
  return {
    platform,
    showCustomTitleBar: platform === "macos" || platform === "linux",
    showMenuBar: platform === "linux",
    showWindowControls: platform === "linux",
    isMaximized: win.isMaximized() || win.isFullScreen(),
  };
}

function loadThemesFromDisk(themesDir: string): void {
  if (savedThemes.length > 0) {
    return;
  }
  if (!fsSync.existsSync(themesDir)) {
    try {
      fsSync.mkdirSync(themesDir, { recursive: true });
      console.log(`[ipc-register-app-state] No themes directory found, created ${themesDir}`);
    } catch (mkdirErr) {
      console.warn(`[ipc-register-app-state] Unable to create themes directory: ${themesDir}`, mkdirErr);
    }
    return;
  }
  try {
    const entries = fsSync.readdirSync(themesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fsSync.readFileSync(path.join(themesDir, entry), "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.name === "string" && obj.colors && typeof obj.colors === "object") {
            savedThemes.push({ name: obj.name, colors: obj.colors as Record<string, string> });
          }
        }
      } catch (error) {
        console.warn(
          `[ipc-register-app-state] Skipping unreadable theme file: ${entry}`,
          error
        );
      }
    }
  } catch (error) {
    console.warn(
      `[ipc-register-app-state] Unable to read themes directory: ${themesDir}`,
      error
    );
  }
}

/**
 * Register app-state IPC handlers (config/themes/code-cells/menu/files).
 *
 * @param options - Handler dependencies and local state paths.
 * @returns Nothing.
 * @throws {Error} Propagates filesystem or dialog errors from handler execution.
 */
export function registerAppStateIpcHandlers(
  options: RegisterAppStateIpcHandlersOptions
): void {
  const { win, themesDir, stateDir, setAllowClose, updateCheckStamp } = options;

  fs.mkdir(themesDir, { recursive: true }).catch((error) => {
    console.warn(
      `[ipc-register-app-state] Unable to create themes directory: ${themesDir}`,
      error
    );
  });
  fs.mkdir(stateDir, { recursive: true }).catch((error) => {
    console.warn(
      `[ipc-register-app-state] Unable to create state directory: ${stateDir}`,
      error
    );
  });
  loadThemesFromDisk(themesDir);

  const pushWindowChromeState = (): void => {
    if (win.isDestroyed()) {
      return;
    }
    win.webContents.send(IPC.push.chromeStateChanged, buildWindowChromeInfo(win));
  };
  // Deliberately untracked: these attach to the BrowserWindow itself and are
  // released when the window is destroyed, unlike listeners on long-lived
  // objects (app, KernelManager) which must be detached on re-registration.
  win.on("maximize", pushWindowChromeState);
  win.on("unmaximize", pushWindowChromeState);
  win.on("enter-full-screen", pushWindowChromeState);
  win.on("leave-full-screen", pushWindowChromeState);

  handleIpc(IPC.about.getVersion, () => app.getVersion());

  handleIpc(IPC.about.openRepoPage, async () => {
    await shell.openExternal("https://github.com/matt-pharr/physics-data-viewer");
  });

  handleIpc(IPC.about.openIssuesPage, async () => {
    await shell.openExternal("https://github.com/matt-pharr/physics-data-viewer/issues");
  });

  handleIpc(IPC.about.openDocsPage, async () => {
    // Version-pinned docs URL. `app.getVersion()` reads the running
    // build's package.json version, so users always see the docs that
    // match the binary they're running — even if they're on an older
    // release that wouldn't reflect newer site changes.
    const version = app.getVersion();
    await shell.openExternal(`https://matt-pharr.github.io/physics-data-viewer/${version}/`);
  });

  // Auto-updater
  initAutoUpdater(win, updateCheckStamp);
  handleIpc(IPC.updater.checkForUpdates, async () => { await checkForUpdates(updateCheckStamp); });
  handleIpc(IPC.updater.downloadUpdate, async () => { await downloadUpdate(); });
  handleIpc(IPC.updater.installUpdate, async () => { installUpdate(); });
  handleIpc(IPC.updater.openReleasesPage, async () => { await openReleasesPage(); });
  handleIpc(IPC.updater.getStatus, async () => getUpdateStatus());

  handleIpc(IPC.window.setBackgroundColor, (event, color: string) => {
    // Sync the BrowserWindow's native background to the active theme's
    // bg-primary so live-resize gestures don't expose OS-default white.
    // Look up the source window so multi-window setups (gui-editor,
    // module-window, etc.) each update the right native chrome.
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    const sourceWin = ElectronBrowserWindow.fromWebContents(event.sender);
    sourceWin?.setBackgroundColor(color);
  });

  handleIpc(IPC.themes.get, async () => savedThemes);

  handleIpc(IPC.themes.save, async (_event, theme: Theme) => {
    const existing = savedThemes.findIndex((entry) => entry.name === theme.name);
    if (existing >= 0) {
      savedThemes[existing] = theme;
    } else {
      savedThemes = [...savedThemes, theme];
    }
    const safeName = theme.name.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    const filePath = path.join(themesDir, `${safeName}.json`);
    await fs.writeFile(filePath, JSON.stringify(theme, null, 2), "utf8");
    return true;
  });

  handleIpc(IPC.themes.openDir, async () => {
    await fs.mkdir(themesDir, { recursive: true });
    return shell.openPath(themesDir);
  });

  handleIpc(IPC.menu.updateRecentProjects, async (_event, paths: string[]) => {
    updateRecentProjectsMenu(Array.isArray(paths) ? paths : []);
    return true;
  });

  handleIpc(IPC.menu.updateEnabled, async (_event, state: Record<string, boolean>) => {
    updateMenuEnabled(state);
    return true;
  });

  handleIpc(IPC.menu.getModel, async () => getTopLevelMenuModel());

  handleIpc(IPC.menu.popup, async (_event, menuId: "file" | "edit" | "view" | "window", x: number, y: number) =>
    popupTopLevelMenu(menuId, x, y)
  );

  handleIpc(IPC.chrome.getInfo, async () => buildWindowChromeInfo(win));

  handleIpc(IPC.chrome.minimize, async () => {
    win.minimize();
    return true;
  });

  handleIpc(IPC.chrome.toggleMaximize, async () => {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });

  handleIpc(IPC.chrome.close, async () => {
    // Route through the same close-confirmation flow as the OS-level close
    // (`win.on('close')` in app.ts) so the title-bar X also prompts about
    // unsaved changes. The renderer will call `IPC.app.confirmClose` once
    // the user resolves the prompt.
    if (!win.isDestroyed()) {
      // Custom title-bar X is a close, not a quit — supersede any orphaned
      // quit-pending state so confirmClose calls win.close() (and on darwin
      // leaves the app in the dock) rather than app.quit().
      clearQuitRequestPending();
      win.webContents.send(IPC.push.requestClose);
    }
    return true;
  });

  handleIpc(IPC.app.setDocumentEdited, async (_event, edited: boolean) => {
    if (!win.isDestroyed()) {
      win.setDocumentEdited(Boolean(edited));
    }
  });

  handleIpc(IPC.app.confirmClose, async () => {
    setAllowClose(true);
    // During a real quit (Cmd+Q, autoUpdater restart, OS logout), call
    // app.quit() instead of win.close(). app.quit() will close the window
    // itself (the close handler passes through because allowClose is set),
    // then will-quit runs kernel cleanup. Calling both win.close() and
    // app.quit() in the same tick re-enters the quit machinery and breaks
    // electron-updater on macOS.
    //
    // `quitRequestPending` covers the deferred Cmd+Q case where before-quit
    // pushed the dialog and is awaiting our resolution; `isQuitting` covers
    // paths that set the proceed-flag directly (autoUpdater.markQuitting).
    if (isQuitRequestPending() || isQuitting()) {
      clearQuitRequestPending();
      app.quit();
      return;
    }
    if (!win.isDestroyed()) {
      win.close();
    }
  });

  handleIpc(IPC.files.pickExecutable, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  handleIpc(IPC.files.pickFile, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  handleIpc(IPC.files.pickDirectory, async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultPath || undefined,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });
}
