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

import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from "electron";

import { type AppMenuTopLevel, IPC, type MenuActionPayload, type MenuEnabledState } from "./ipc";

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
  const items: MenuItemConstructorOptions[] = recentProjects.map((projectPath) => {
    // Show the folder name as the label, with the full path as a sublabel.
    const folderName = projectPath.split("/").filter(Boolean).pop() ?? projectPath;
    return {
      label: folderName,
      sublabel: projectPath,
      click: () =>
        sendMenuAction({
          action: "project:openRecent",
          path: projectPath,
        }),
    };
  });
  items.push(
    { type: "separator" },
    {
      label: "Clear Menu",
      click: () => sendMenuAction({ action: "recentProjects:clear" }),
    }
  );
  return items;
}

// Build the full platform-aware application menu template.
//
// Menu accelerators are FIXED — they cannot be user-customized because Electron
// cannot update native menu accelerators at runtime. User-customizable shortcuts
// live in the renderer's shortcuts.ts and are handled by useKeyboardShortcuts.
// See ARCHITECTURE.md for the full distinction.
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
      id: "file",
      label: "File",
      submenu: [
        {
          id: "project:new",
          label: "New Project",
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuAction({ action: "project:new" }),
        },
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
        {
          id: "modules:newEmpty",
          label: "New Module...",
          accelerator: "CmdOrCtrl+Shift+M",
          enabled: isEnabled("modules:newEmpty"),
          click: () => sendMenuAction({ action: "modules:newEmpty" }),
        },
        { type: "separator" },
        {
          id: "settings:open",
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => sendMenuAction({ action: "settings:open" }),
        },
        { type: "separator" },
        process.platform === "darwin"
          ? { role: "close" as const, accelerator: "CmdOrCtrl+Shift+W" }
          : { role: "quit" as const, accelerator: "CmdOrCtrl+Shift+W" },
      ],
    },
    { id: "edit", role: "editMenu" },
    { id: "view", role: "viewMenu" },
    { id: "window", role: "windowMenu" },
    // The "/dev/" path is the canonical pre-1.0 docs URL slug. Once versioned
    // docs are published post-1.0, derive the slug from `app.getVersion()`.
    {
      id: "help",
      label: "Help",
      submenu: [
        {
          label: "Getting Started",
          click: () => void shell.openExternal("https://matt-pharr.github.io/physics-data-viewer/dev/getting-started/"),
        },
        {
          label: "User Guide",
          click: () => void shell.openExternal("https://matt-pharr.github.io/physics-data-viewer/dev/user-guide/"),
        },
        {
          label: "API Docs",
          click: () => void shell.openExternal("https://matt-pharr.github.io/physics-data-viewer/dev/api-reference/"),
        },
        ...(process.platform !== "darwin"
          ? [
              { type: "separator" as const },
              {
                label: "About Physics Data Viewer",
                click: () => {
                  void dialog.showMessageBox({
                    type: "info",
                    title: "About Physics Data Viewer",
                    message: `Physics Data Viewer v${app.getVersion()}`,
                    detail: "A desktop application for computational and experimental physics analysis.",
                    buttons: ["OK"],
                  });
                },
              },
            ]
          : []),
      ],
    }
  );
  return template;
}

// Extract the top-level menus rendered inside the Linux title bar.
function buildTopLevelMenuModel(): AppMenuTopLevel[] {
  return [
    { id: "file", label: "File" },
    { id: "edit", label: "Edit" },
    { id: "view", label: "View" },
    { id: "window", label: "Window" },
    { id: "help", label: "Help" },
  ];
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
  if (process.platform === "linux") {
    win.setAutoHideMenuBar(true);
    win.setMenuBarVisibility(false);
  }
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

/**
 * Return the top-level menus used by the integrated Linux title bar.
 *
 * @returns Ordered list of top-level menu buttons.
 */
export function getTopLevelMenuModel(): AppMenuTopLevel[] {
  return buildTopLevelMenuModel();
}

/**
 * Open one native submenu popup for the selected top-level menu.
 *
 * @param menuId - Top-level menu identifier.
 * @param x - Horizontal anchor coordinate in window CSS pixels.
 * @param y - Vertical anchor coordinate in window CSS pixels.
 * @returns True when a matching submenu was opened.
 */
export function popupTopLevelMenu(
  menuId: AppMenuTopLevel["id"],
  x: number,
  y: number
): boolean {
  if (!currentWindow || currentWindow.isDestroyed()) {
    return false;
  }
  const templateEntry = buildTemplate().find(
    (entry) => entry.id === menuId && Array.isArray(entry.submenu)
  );
  if (!templateEntry || !Array.isArray(templateEntry.submenu)) {
    return false;
  }
  const menu = Menu.buildFromTemplate(templateEntry.submenu);
  menu.popup({
    window: currentWindow,
    x: Math.round(x),
    y: Math.round(y),
  });
  return true;
}
