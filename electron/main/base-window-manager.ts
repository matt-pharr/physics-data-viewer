/**
 * base-window-manager.ts — Generic per-key BrowserWindow manager.
 *
 * Shared infrastructure for the three popup-window managers:
 * {@link GuiEditorWindowManager}, {@link GuiViewerWindowManager}, and
 * {@link ModuleWindowManager}. Each subclass differs only in:
 *
 * - the renderer HTML file it loads,
 * - the BrowserWindow dimensions/title it constructs, and
 * - the typed context attached to each window.
 *
 * The base class owns:
 * - the `windows` map keyed by per-subclass identity (alias / treePath),
 * - the `contexts` map keyed by `webContents.id` for IPC sender lookup,
 * - open / close / closeAll lifecycle, and
 * - broadcast to all live windows.
 *
 * Subclasses implement {@link openWindow} via a typed public `open(...)`
 * that builds a context and calls {@link openWindowInternal}.
 */

import { BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import * as path from "path";

/**
 * Static and per-call configuration for one BrowserWindow.
 *
 * Subclasses return one of these from {@link BaseWindowManager.buildConfig}
 * to describe the window they want to open.
 */
export interface ChildWindowConfig {
  /**
   * Renderer-side HTML file basename to load (e.g. `"module-window.html"`).
   * The base class resolves it against the dev server in development and
   * against `renderer/dist/` in production.
   */
  htmlFile: string;
  /**
   * BrowserWindow constructor options for the new child window.
   *
   * The base class always overrides `show: false` (the window is shown
   * after content is loaded) and supplies a fresh `webPreferences` block
   * with the manager's preload path; subclasses should not set those.
   */
  windowOptions: Omit<BrowserWindowConstructorOptions, "show" | "webPreferences">;
}

/**
 * Generic per-key BrowserWindow manager.
 *
 * @typeParam TKey - The lookup key for child windows (typically `string`,
 *   either a module alias or a tree path).
 * @typeParam TContext - The typed per-window context attached to each
 *   window for IPC sender lookup.
 */
export abstract class BaseWindowManager<TKey extends string, TContext> {
  protected readonly windows = new Map<TKey, BrowserWindow>();
  protected readonly contexts = new Map<number, TContext>();

  constructor(protected readonly preloadPath: string) {}

  /**
   * Build the per-call window configuration. Implemented by each subclass
   * to return its dimensions, title, and HTML file. Receives the key and
   * context so titles can be derived from either.
   */
  protected abstract buildConfig(
    key: TKey,
    context: TContext
  ): ChildWindowConfig;

  /**
   * Open a child window for the given key, or focus an existing one.
   *
   * Subclasses expose a typed public `open(...)` that constructs the
   * context and delegates here.
   *
   * @throws {Error} When the renderer content fails to load.
   */
  protected async openWindowInternal(key: TKey, context: TContext): Promise<void> {
    const existing = this.windows.get(key);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }

    const config = this.buildConfig(key, context);
    const child = new BrowserWindow({
      ...config.windowOptions,
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const webContentsId = child.webContents.id;
    this.windows.set(key, child);
    this.contexts.set(webContentsId, context);

    child.on("closed", () => {
      this.windows.delete(key);
      this.contexts.delete(webContentsId);
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (process.env.NODE_ENV === "development" && devServerUrl) {
      const base = devServerUrl.replace(/\/$/, "");
      await child.loadURL(`${base}/${config.htmlFile}`);
    } else {
      const rendererDir = path.join(
        __dirname,
        "..",
        "..",
        "renderer",
        "dist"
      );
      await child.loadFile(path.join(rendererDir, config.htmlFile));
    }

    child.show();
  }

  /**
   * Close a child window by key. Returns true when a live window was
   * found and asked to close. The actual map cleanup happens via the
   * `closed` event handler attached in {@link openWindowInternal}.
   */
  close(key: TKey): boolean {
    const win = this.windows.get(key);
    if (!win || win.isDestroyed()) {
      this.windows.delete(key);
      return false;
    }
    win.close();
    return true;
  }

  /**
   * Close all open child windows and clear lookup maps.
   *
   * Maps are cleared after the close loop instead of inside it to avoid
   * mutating during iteration; the per-window `closed` handler is also a
   * no-op on the cleared map.
   */
  closeAll(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.close();
      }
    }
    this.windows.clear();
    this.contexts.clear();
  }

  /**
   * Look up the typed context for a given `webContents.id`. Used by IPC
   * handlers that need to know which child window an `event.sender`
   * belongs to.
   */
  getContextForSender(webContentsId: number): TContext | null {
    return this.contexts.get(webContentsId) ?? null;
  }

  /** Send a push message to every live child window. */
  broadcastToAll(channel: string, payload: unknown): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }
}
