/**
 * gui-editor-window-manager.ts — Manages GUI editor popup BrowserWindows.
 *
 * Thin subclass of {@link BaseWindowManager} that supplies the GUI editor's
 * window dimensions and renderer entry point. All lifecycle, context lookup,
 * and broadcast logic lives in the base class.
 *
 * Non-responsibilities:
 * - IPC handler registration (see ipc-register-gui-editor.ts).
 * - GUI manifest validation or editing logic.
 */

import { BaseWindowManager, type ChildWindowConfig } from "./base-window-manager";
import type { GuiEditorContext } from "./ipc";

/** Manages GUI editor popup BrowserWindows keyed by tree path. */
export class GuiEditorWindowManager extends BaseWindowManager<string, GuiEditorContext> {
  protected buildConfig(treePath: string): ChildWindowConfig {
    return {
      htmlFile: "gui-editor.html",
      windowOptions: {
        width: 1100,
        height: 800,
        title: `GUI Editor: ${treePath}`,
      },
    };
  }

  /**
   * Open a GUI editor window for the given tree path, or focus it if
   * already open.
   *
   * @param treePath - Dot-delimited tree path of the PDVGui node to edit.
   * @param kernelId - Active kernel ID.
   * @throws {Error} When the window fails to load content.
   */
  async open(treePath: string, kernelId: string): Promise<void> {
    await this.openWindowInternal(treePath, { treePath, kernelId });
  }
}
