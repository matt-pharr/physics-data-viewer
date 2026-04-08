/**
 * ipc-register-app-state.ts — Register app-state and file-picker IPC handlers.
 *
 * Responsibilities:
 * - Register config/theme/code-cell/menu/file-picker IPC handlers.
 * - Hydrate in-memory theme/code-cell caches from disk.
 *
 * Non-responsibilities:
 * - Kernel lifecycle, project, tree, or modules IPC handling.
 * - Push forwarding between comm router and renderer.
 */

import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";

import type { ConfigStore, PDVConfig } from "./config";
import type { CodeCellData, Theme, WindowChromeInfo, WindowChromePlatform } from "./ipc";
import { IPC } from "./ipc";
import { getTopLevelMenuModel, popupTopLevelMenu, updateMenuEnabled, updateRecentProjectsMenu } from "./menu";
import { initAutoUpdater, checkForUpdates, downloadUpdate, installUpdate, openReleasesPage } from "./auto-updater";

let savedThemes: Theme[] = [];
let savedCodeCells: CodeCellData | null = null;

interface RegisterAppStateIpcHandlersOptions {
  win: BrowserWindow;
  configStore: ConfigStore;
  readConfig: (configStore: ConfigStore) => PDVConfig;
  themesDir: string;
  stateDir: string;
  codeCellsPath: string;
  /** Flips the close-guard flag in `app.ts` so the next `win.close()` proceeds. */
  setAllowClose: (allow: boolean) => void;
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

function loadCodeCellsFromDisk(codeCellsPath: string): void {
  if (savedCodeCells !== null) {
    return;
  }
  try {
    const raw = fsSync.readFileSync(codeCellsPath, "utf8");
    savedCodeCells = JSON.parse(raw) as CodeCellData;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      console.warn(
        `[ipc-register-app-state] Unable to read code cells from ${codeCellsPath}`,
        error
      );
    }
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
  const { win, configStore, readConfig, themesDir, stateDir, codeCellsPath, setAllowClose } = options;

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
  loadCodeCellsFromDisk(codeCellsPath);

  const pushWindowChromeState = (): void => {
    if (win.isDestroyed()) {
      return;
    }
    win.webContents.send(IPC.push.chromeStateChanged, buildWindowChromeInfo(win));
  };
  win.on("maximize", pushWindowChromeState);
  win.on("unmaximize", pushWindowChromeState);
  win.on("enter-full-screen", pushWindowChromeState);
  win.on("leave-full-screen", pushWindowChromeState);

  ipcMain.handle(IPC.config.get, async () => readConfig(configStore));

  ipcMain.handle(IPC.about.getVersion, () => app.getVersion());

  // Auto-updater
  initAutoUpdater(win, configStore);
  ipcMain.handle(IPC.updater.checkForUpdates, async () => { await checkForUpdates(configStore); });
  ipcMain.handle(IPC.updater.downloadUpdate, async () => { await downloadUpdate(); });
  ipcMain.handle(IPC.updater.installUpdate, async () => { installUpdate(); });
  ipcMain.handle(IPC.updater.openReleasesPage, async () => { await openReleasesPage(); });

  ipcMain.handle(IPC.config.set, async (_event, updates: Partial<PDVConfig>) => {
    const current = readConfig(configStore);
    const merged: PDVConfig = { ...current, ...updates };
    for (const key of Object.keys(updates) as Array<keyof PDVConfig>) {
      const value = updates[key];
      if (value !== undefined) {
        configStore.set(key, value);
      }
    }
    return { ...merged, ...configStore.getAll() };
  });

  ipcMain.handle(IPC.themes.get, async () => savedThemes);

  ipcMain.handle(IPC.themes.save, async (_event, theme: Theme) => {
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

  ipcMain.handle(IPC.themes.openDir, async () => {
    await fs.mkdir(themesDir, { recursive: true });
    return shell.openPath(themesDir);
  });

  ipcMain.handle(IPC.codeCells.load, async () => savedCodeCells);

  ipcMain.handle(IPC.codeCells.save, async (_event, data: CodeCellData) => {
    savedCodeCells = data;
    await fs.writeFile(codeCellsPath, JSON.stringify(data, null, 2), "utf8");
    return true;
  });

  ipcMain.handle(IPC.menu.updateRecentProjects, async (_event, paths: string[]) => {
    updateRecentProjectsMenu(Array.isArray(paths) ? paths : []);
    return true;
  });

  ipcMain.handle(IPC.menu.updateEnabled, async (_event, state: Record<string, boolean>) => {
    updateMenuEnabled(state);
    return true;
  });

  ipcMain.handle(IPC.menu.getModel, async () => getTopLevelMenuModel());

  ipcMain.handle(IPC.menu.popup, async (_event, menuId: "file" | "edit" | "view" | "window", x: number, y: number) =>
    popupTopLevelMenu(menuId, x, y)
  );

  ipcMain.handle(IPC.chrome.getInfo, async () => buildWindowChromeInfo(win));

  ipcMain.handle(IPC.chrome.minimize, async () => {
    win.minimize();
    return true;
  });

  ipcMain.handle(IPC.chrome.toggleMaximize, async () => {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });

  ipcMain.handle(IPC.chrome.close, async () => {
    // Route through the same close-confirmation flow as the OS-level close
    // (`win.on('close')` in app.ts) so the title-bar X also prompts about
    // unsaved changes. The renderer will call `IPC.app.confirmClose` once
    // the user resolves the prompt.
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.push.requestClose);
    }
    return true;
  });

  ipcMain.handle(IPC.app.confirmClose, async () => {
    setAllowClose(true);
    if (!win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.handle(IPC.files.pickExecutable, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.files.pickFile, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile"] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.files.pickDirectory, async (_event, defaultPath?: string) => {
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
