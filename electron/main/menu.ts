import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

import { IPC, type MenuActionPayload } from "./ipc";

let currentWindow: BrowserWindow | null = null;
let recentProjects: string[] = [];

function sendMenuAction(payload: MenuActionPayload): void {
  if (!currentWindow || currentWindow.isDestroyed()) {
    return;
  }
  currentWindow.webContents.send(IPC.push.menuAction, payload);
}

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

function applyMenu(): void {
  const menu = Menu.buildFromTemplate(buildTemplate());
  Menu.setApplicationMenu(menu);
}

export function initializeAppMenu(win: BrowserWindow): void {
  currentWindow = win;
  win.on("closed", () => {
    if (currentWindow === win) {
      currentWindow = null;
    }
  });
  applyMenu();
}

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
