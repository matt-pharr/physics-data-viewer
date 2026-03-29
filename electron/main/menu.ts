/**
 * menu.ts — Native app menu construction and menu action forwarding.
 *
 * Builds the Electron application menu and forwards File-menu actions
 * to the renderer via a typed push channel.
 *
 * This module does NOT execute project operations directly; it only emits
 * user intents for other layers to handle.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11 (renderer/main boundaries)
 * ipc.ts — menu action payload types and push channel names
 */

import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

import { IPC, type MenuActionPayload, type MenuEnabledState } from "./ipc";

let currentWindow: BrowserWindow | null = null;
let recentProjects: string[] = [];
let menuEnabledState: MenuEnabledState = {};

// Forward a menu action to the renderer when a window is available.
function sendMenuAction(payload: MenuActionPayload): void {
  if (!currentWindow || currentWindow.isDestroyed()) {
    return;
  }
  currentWindow.webContents.send(IPC.push.menuAction, payload);
}

// Build the "Open Recent" submenu items from the current recent-project list.
function buildOpenRecentSubmenu(): MenuItemConstructorOptions[] {
  if (recentProjects.length === 0) {
    return [{ label: "No Recent Projects", enabled: false }];
  }
  return recentProjects.map((projectPath) => ({
    label: projectPath,
    click: () =>
      sendMenuAction({
        action: "project:openRecent",
        path: projectPath,
      }),
  }));
}

// Build the full platform-aware application menu template.
function buildTemplate(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") {
    template.push({ role: "appMenu" });
  }
  /** Resolve enabled state for a menu item, defaulting to true. */
  const isEnabled = (id: keyof MenuEnabledState): boolean =>
    menuEnabledState[id] !== false;

  template.push(
    {
      label: "File",
      submenu: [
        {
          id: "project:open",
          label: "Open...",
          accelerator: "CmdOrCtrl+O",
          click: () => sendMenuAction({ action: "project:open" }),
        },
        {
          label: "Open Recent",
          submenu: buildOpenRecentSubmenu(),
        },
        { type: "separator" },
        {
          id: "project:save",
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          enabled: isEnabled("project:save"),
          click: () => sendMenuAction({ action: "project:save" }),
        },
        {
          id: "project:saveAs",
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          enabled: isEnabled("project:saveAs"),
          click: () => sendMenuAction({ action: "project:saveAs" }),
        },
        { type: "separator" },
        {
          id: "modules:import",
          label: "Import Module...",
          accelerator: "CmdOrCtrl+I",
          enabled: isEnabled("modules:import"),
          click: () => sendMenuAction({ action: "modules:import" }),
        },
        { type: "separator" },
        process.platform === "darwin"
          ? { role: "close" as const, accelerator: "CmdOrCtrl+Shift+W" }
          : { role: "quit" as const, accelerator: "CmdOrCtrl+Shift+W" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  );
  return template;
}

// Rebuild and apply the current application menu.
function applyMenu(): void {
  const menu = Menu.buildFromTemplate(buildTemplate());
  Menu.setApplicationMenu(menu);
}

/**
 * Initialize and attach the PDV application menu to a BrowserWindow.
 *
 * @param win - BrowserWindow that receives forwarded menu-action push events.
 * @returns Nothing.
 */
export function initializeAppMenu(win: BrowserWindow): void {
  currentWindow = win;
  win.on("closed", () => {
    if (currentWindow === win) {
      currentWindow = null;
    }
  });
  applyMenu();
}

/**
 * Update enabled/disabled state for specific menu items and refresh the menu.
 *
 * @param state - Partial map of menu-item IDs to enabled booleans.
 * @returns Nothing.
 */
export function updateMenuEnabled(state: MenuEnabledState): void {
  menuEnabledState = { ...menuEnabledState, ...state };
  if (app.isReady()) {
    applyMenu();
  }
}

/**
 * Update the "Open Recent" menu entries and refresh the native app menu.
 *
 * @param paths - Candidate recent project paths ordered by recency.
 * @returns Nothing.
 */
export function updateRecentProjectsMenu(paths: string[]): void {
  const unique = new Set<string>();
  const normalized: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || unique.has(trimmed)) continue;
    unique.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= 10) break;
  }
  recentProjects = normalized;
  if (app.isReady()) {
    applyMenu();
  }
}
