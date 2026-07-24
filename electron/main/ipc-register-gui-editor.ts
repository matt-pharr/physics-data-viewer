/**
 * ipc-register-gui-editor.ts — Register GUI editor window IPC handlers.
 *
 * Responsibilities:
 * - Register the shell-side `window.pdv.guiEditor.*` window channels
 *   (`open`, `openViewer`, `context`).
 * - Delegate to GuiEditorWindowManager / GuiViewerWindowManager for window
 *   lifecycle.
 *
 * Non-responsibilities:
 * - GUI manifest file I/O (`guiEditor.read`/`guiEditor.save` are server
 *   channels; see `ipc-register-gui-files.ts`).
 * - Window creation/management logic (see gui-editor-window-manager.ts).
 */

import { handleIpc } from "./ipc-registry";

import {
  IPC,
  type GuiEditorOpenRequest,
  type GuiEditorOpenResult,
  type GuiEditorContext,
} from "./ipc";
import type { GuiEditorWindowManager } from "./gui-editor-window-manager";
import type { GuiViewerWindowManager } from "./gui-viewer-window-manager";

interface RegisterGuiEditorIpcHandlersOptions {
  guiEditorWindowManager: GuiEditorWindowManager;
  guiViewerWindowManager: GuiViewerWindowManager;
}

/**
 * Register GUI editor window IPC handlers under `IPC.guiEditor.*`.
 *
 * @param options - Dependencies.
 * @returns Nothing.
 */
export function registerGuiEditorIpcHandlers(
  options: RegisterGuiEditorIpcHandlersOptions
): void {
  const { guiEditorWindowManager, guiViewerWindowManager } = options;

  handleIpc(
    IPC.guiEditor.open,
    async (
      _event,
      request: GuiEditorOpenRequest
    ): Promise<GuiEditorOpenResult> => {
      try {
        await guiEditorWindowManager.open(request.treePath, request.kernelId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  handleIpc(
    IPC.guiEditor.openViewer,
    async (
      _event,
      request: GuiEditorOpenRequest
    ): Promise<GuiEditorOpenResult> => {
      try {
        await guiViewerWindowManager.open(request.treePath, request.kernelId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  handleIpc(
    IPC.guiEditor.context,
    async (event): Promise<GuiEditorContext | null> => {
      return guiEditorWindowManager.getContextForSender(event.sender.id)
        ?? guiViewerWindowManager.getContextForSender(event.sender.id);
    }
  );
}
