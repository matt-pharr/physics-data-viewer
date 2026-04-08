/**
 * gui-viewer-window-manager.ts — Manages standalone GUI viewer BrowserWindows.
 *
 * Thin subclass of {@link BaseWindowManager} that supplies the read-only
 * viewer's window dimensions and renderer entry point. Reuses
 * {@link GuiEditorContext} as the per-window context type since the viewer
 * needs the same information (treePath + kernelId). Per-window IPC dispatch
 * is handled by `getContextForSender` from the base class — the viewer does
 * not delegate to ipc-register-gui-editor.ts.
 *
 * Non-responsibilities:
 * - IPC handler registration.
 * - GUI manifest validation or editing logic.
 */

import { BaseWindowManager, type ChildWindowConfig } from "./base-window-manager";
import type { GuiEditorContext } from "./ipc";

/** Manages standalone GUI viewer popup BrowserWindows keyed by tree path. */
export class GuiViewerWindowManager extends BaseWindowManager<string, GuiEditorContext> {
  protected buildConfig(treePath: string): ChildWindowConfig {
    const displayName = treePath.split(".").pop() ?? treePath;
    return {
      htmlFile: "gui-viewer.html",
      windowOptions: {
        width: 500,
        height: 700,
        title: displayName,
      },
    };
  }

  /**
   * Open a GUI viewer window for the given tree path, or focus it if
   * already open.
   *
   * @param treePath - Dot-delimited tree path of the PDVGui node to view.
   * @param kernelId - Active kernel ID.
   * @throws {Error} When the window fails to load content.
   */
  async open(treePath: string, kernelId: string): Promise<void> {
    await this.openWindowInternal(treePath, { treePath, kernelId });
  }
}
