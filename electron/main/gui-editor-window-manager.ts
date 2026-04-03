/**
 * gui-editor-window-manager.ts — Manages GUI editor popup BrowserWindows.
 *
 * Responsibilities:
 * - Create, focus, and destroy per-GUI-node editor windows.
 * - Track editor context (treePath + kernelId) per child window.
 * - Forward push messages to all open child windows.
 *
 * Non-responsibilities:
 * - IPC handler registration (see ipc-register-gui-editor.ts).
 * - GUI manifest validation or editing logic.
 */

import { BrowserWindow } from "electron";
import * as path from "path";
import type { GuiEditorContext } from "./ipc";

/**
 * Manages GUI editor popup BrowserWindows keyed by tree path.
 *
 * @param mainWindow - Reference to the main application window.
 * @param preloadPath - Absolute path to the preload script.
 */
export class GuiEditorWindowManager {
  private windows = new Map<string, BrowserWindow>();
  private contexts = new Map<number, GuiEditorContext>();

  constructor(
    private mainWindow: BrowserWindow,
    private preloadPath: string
  ) {}

  /**
   * Open a GUI editor window for the given tree path, or focus it if already open.
   *
   * @param treePath - Dot-delimited tree path of the PDVGui node to edit.
   * @param kernelId - Active kernel ID.
   * @throws {Error} When the window fails to load content.
   */
  async open(treePath: string, kernelId: string): Promise<void> {
    const existing = this.windows.get(treePath);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }

    const child = new BrowserWindow({
      width: 1100,
      height: 800,
      title: `GUI Editor: ${treePath}`,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const context: GuiEditorContext = { treePath, kernelId };
    const webContentsId = child.webContents.id;
    this.windows.set(treePath, child);
    this.contexts.set(webContentsId, context);

    child.on("closed", () => {
      this.windows.delete(treePath);
      this.contexts.delete(webContentsId);
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (process.env.NODE_ENV === "development" && devServerUrl) {
      const base = devServerUrl.replace(/\/$/, "");
      await child.loadURL(`${base}/gui-editor.html`);
    } else {
      const rendererDir = path.join(
        __dirname,
        "..",
        "..",
        "renderer",
        "dist"
      );
      await child.loadFile(path.join(rendererDir, "gui-editor.html"));
    }

    child.show();
  }

  /**
   * Close a GUI editor window by tree path.
   *
   * @param treePath - Tree path whose editor window to close.
   * @returns True when a window was found and closed.
   */
  close(treePath: string): boolean {
    const win = this.windows.get(treePath);
    if (!win || win.isDestroyed()) {
      this.windows.delete(treePath);
      return false;
    }
    win.close();
    return true;
  }

  /**
   * Close all open GUI editor windows.
   */
  closeAll(): void {
    for (const [treePath, win] of this.windows) {
      if (!win.isDestroyed()) {
        win.close();
      }
      this.windows.delete(treePath);
    }
    this.contexts.clear();
  }

  /**
   * Look up the editor context for a given webContents sender.
   *
   * @param webContentsId - The `event.sender.id` from an IPC event.
   * @returns Context if the sender is an editor window, null otherwise.
   */
  getContextForSender(webContentsId: number): GuiEditorContext | null {
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
