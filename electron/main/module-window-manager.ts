/**
 * module-window-manager.ts — Manages module GUI popup BrowserWindows.
 *
 * Responsibilities:
 * - Create, focus, and destroy per-module popup windows.
 * - Track module context (alias + kernelId) per child window.
 * - Forward push messages to all open child windows.
 *
 * Non-responsibilities:
 * - IPC handler registration (see ipc-register-module-windows.ts).
 * - Module manifest validation or action execution.
 */

import { BrowserWindow } from "electron";
import * as path from "path";
import type { ModuleWindowContext } from "./ipc";

/**
 * Manages module GUI popup BrowserWindows keyed by module alias.
 *
 * @param mainWindow - Reference to the main application window.
 * @param preloadPath - Absolute path to the preload script.
 */
export class ModuleWindowManager {
  private windows = new Map<string, BrowserWindow>();
  private contexts = new Map<number, ModuleWindowContext>();

  constructor(
    private mainWindow: BrowserWindow,
    private preloadPath: string
  ) {}

  /**
   * Open a module GUI window for the given alias, or focus it if already open.
   *
   * @param alias - Project-local module alias.
   * @param kernelId - Active kernel ID.
   * @throws {Error} When the window fails to load content.
   */
  async open(alias: string, kernelId: string): Promise<void> {
    const existing = this.windows.get(alias);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }

    const child = new BrowserWindow({
      width: 500,
      height: 700,
      title: `Module: ${alias}`,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const context: ModuleWindowContext = { alias, kernelId };
    const webContentsId = child.webContents.id;
    this.windows.set(alias, child);
    this.contexts.set(webContentsId, context);

    child.on("closed", () => {
      this.windows.delete(alias);
      this.contexts.delete(webContentsId);
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (process.env.NODE_ENV === "development" && devServerUrl) {
      const base = devServerUrl.replace(/\/$/, "");
      await child.loadURL(`${base}/module-window.html`);
    } else {
      const rendererDir = path.join(
        __dirname,
        "..",
        "..",
        "renderer",
        "dist"
      );
      await child.loadFile(path.join(rendererDir, "module-window.html"));
    }

    child.show();
  }

  /**
   * Close a module GUI window by alias.
   *
   * @param alias - Module alias whose window to close.
   * @returns True when a window was found and closed.
   */
  close(alias: string): boolean {
    const win = this.windows.get(alias);
    if (!win || win.isDestroyed()) {
      this.windows.delete(alias);
      return false;
    }
    win.close();
    return true;
  }

  /**
   * Close all open module GUI windows.
   */
  closeAll(): void {
    for (const [alias, win] of this.windows) {
      if (!win.isDestroyed()) {
        win.close();
      }
      this.windows.delete(alias);
    }
    this.contexts.clear();
  }

  /**
   * Look up the module context for a given webContents sender.
   *
   * @param webContentsId - The `event.sender.id` from an IPC event.
   * @returns Context if the sender is a module window, null otherwise.
   */
  getContextForSender(webContentsId: number): ModuleWindowContext | null {
    return this.contexts.get(webContentsId) ?? null;
  }

  /**
   * Send a push message to all live child windows.
   *
   * @param channel - IPC push channel name.
   * @param payload - Push payload to forward.
   */
  broadcastToAll(channel: string, payload: unknown): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }
}
