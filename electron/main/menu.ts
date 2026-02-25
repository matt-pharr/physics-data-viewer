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

import { IPC, type MenuActionPayload } from "./ipc";

let currentWindow: BrowserWindow | null = null;
let recentProjects: string[] = [];

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
  template.push(
    {
      label: "File",
      submenu: [
        {
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
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => sendMenuAction({ action: "project:save" }),
        },
        {
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => sendMenuAction({ action: "project:saveAs" }),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
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
