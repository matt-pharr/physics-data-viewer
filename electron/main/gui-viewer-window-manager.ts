/**
 * gui-viewer-window-manager.ts — Manages standalone GUI viewer BrowserWindows.
 *
 * Responsibilities:
 * - Create, focus, and destroy per-GUI viewer windows.
 * - Track viewer context (treePath + kernelId) per child window.
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
 * Manages standalone GUI viewer popup BrowserWindows keyed by tree path.
 *
 * Reuses {@link GuiEditorContext} as the context type since the viewer
 * needs the same information (treePath + kernelId). The viewer renders
 * a read-only PDVGui manifest using the same renderer pipeline as the
 * editor. Per-window IPC dispatch is handled by `getContextForSender`
 * (called from each handler that resolves a context for a sender) — the
 * viewer does not delegate to ipc-register-gui-editor.ts.
 */
export class GuiViewerWindowManager {
  private windows = new Map<string, BrowserWindow>();
  private contexts = new Map<number, GuiEditorContext>();

  constructor(
    private mainWindow: BrowserWindow,
    private preloadPath: string
  ) {}

  /**
   * Open a GUI viewer window for the given tree path, or focus it if already open.
   *
   * @param treePath - Dot-delimited tree path of the PDVGui node to view.
   * @param kernelId - Active kernel ID.
   * @throws {Error} When the window fails to load content.
   */
  async open(treePath: string, kernelId: string): Promise<void> {
    const existing = this.windows.get(treePath);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }

    const displayName = treePath.split(".").pop() ?? treePath;
    const child = new BrowserWindow({
      width: 500,
      height: 700,
      title: displayName,
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
      await child.loadURL(`${base}/gui-viewer.html`);
    } else {
      const rendererDir = path.join(
        __dirname,
        "..",
        "..",
        "renderer",
        "dist"
      );
      await child.loadFile(path.join(rendererDir, "gui-viewer.html"));
    }

    child.show();
  }

  /**
   * Close a GUI viewer window by tree path.
   *
   * @param treePath - Tree path whose viewer window to close.
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
   * Close all open GUI viewer windows.
   */
  closeAll(): void {
    for (const [, win] of this.windows) {
      if (!win.isDestroyed()) {
        win.close();
      }
    }
    this.windows.clear();
    this.contexts.clear();
  }

  /**
   * Look up the viewer context for a given webContents sender.
   *
   * @param webContentsId - The `event.sender.id` from an IPC event.
   * @returns Context if the sender is a viewer window, null otherwise.
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
