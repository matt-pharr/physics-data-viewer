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

import { app, dialog, ipcMain, shell } from "electron";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";

import type { ConfigStore, PDVConfig } from "./config";
import type { CodeCellData, Theme } from "./ipc";
import { IPC } from "./ipc";
import { updateMenuEnabled, updateRecentProjectsMenu } from "./menu";

let savedThemes: Theme[] = [];
let savedCodeCells: CodeCellData | null = null;

interface RegisterAppStateIpcHandlersOptions {
  configStore: ConfigStore;
  readConfig: (configStore: ConfigStore) => PDVConfig;
  themesDir: string;
  stateDir: string;
  codeCellsPath: string;
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
  const { configStore, readConfig, themesDir, stateDir, codeCellsPath } = options;

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

  ipcMain.handle(IPC.config.get, async () => readConfig(configStore));

  ipcMain.handle(IPC.about.getVersion, () => app.getVersion());

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

  ipcMain.handle(IPC.files.pickDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });
}
