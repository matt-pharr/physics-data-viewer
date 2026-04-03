/**
 * ipc-register-gui-editor.ts — Register GUI editor window IPC handlers.
 *
 * Responsibilities:
 * - Register `window.pdv.guiEditor.*` IPC channels.
 * - Delegate to GuiEditorWindowManager for window lifecycle.
 * - Read/write gui.json manifest files for PDVGui tree nodes.
 *
 * Non-responsibilities:
 * - Window creation/management logic (see gui-editor-window-manager.ts).
 * - GUI manifest validation or editing logic.
 */

import { ipcMain } from "electron";
import * as fs from "fs/promises";

import {
  IPC,
  type GuiEditorOpenRequest,
  type GuiEditorOpenResult,
  type GuiEditorContext,
  type GuiEditorReadResult,
  type GuiEditorSaveRequest,
  type GuiEditorSaveResult,
} from "./ipc";
import { PDVMessageType } from "./pdv-protocol";
import type { GuiEditorWindowManager } from "./gui-editor-window-manager";
import type { GuiViewerWindowManager } from "./gui-viewer-window-manager";
import type { CommRouter } from "./comm-router";

interface RegisterGuiEditorIpcHandlersOptions {
  guiEditorWindowManager: GuiEditorWindowManager;
  guiViewerWindowManager: GuiViewerWindowManager;
  commRouter: CommRouter;
}

/**
 * Resolve the absolute filesystem path for a PDVGui node's backing file.
 *
 * Uses the kernel's `pdv.tree.resolve_file` comm to map a tree path to a
 * real filesystem path.
 *
 * @param commRouter - Active comm router.
 * @param treePath - Dot-delimited tree path of the PDVGui node.
 * @returns Absolute path to the .gui.json file.
 * @throws {Error} When the comm resolution fails.
 */
async function resolveGuiFilePath(
  commRouter: CommRouter,
  treePath: string
): Promise<string> {
  const response = await commRouter.request(PDVMessageType.TREE_RESOLVE_FILE, {
    path: treePath,
  });
  const filePath = response.payload?.file_path;
  if (typeof filePath !== "string" || !filePath) {
    throw new Error(`Failed to resolve file path for tree node: ${treePath}`);
  }
  return filePath;
}

/**
 * Register GUI editor IPC handlers under `IPC.guiEditor.*`.
 *
 * @param options - Dependencies.
 * @returns Nothing.
 */
export function registerGuiEditorIpcHandlers(
  options: RegisterGuiEditorIpcHandlersOptions
): void {
  const { guiEditorWindowManager, guiViewerWindowManager, commRouter } = options;

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
    IPC.guiEditor.context,
    async (event): Promise<GuiEditorContext | null> => {
      return guiEditorWindowManager.getContextForSender(event.sender.id)
        ?? guiViewerWindowManager.getContextForSender(event.sender.id);
    }
  );

  ipcMain.handle(
    IPC.guiEditor.read,
    async (_event, treePath: string): Promise<GuiEditorReadResult> => {
      try {
        const filePath = await resolveGuiFilePath(commRouter, treePath);
        const raw = await fs.readFile(filePath, "utf-8");
        const manifest = JSON.parse(raw);
        return { success: true, manifest };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle(
    IPC.guiEditor.save,
    async (_event, request: GuiEditorSaveRequest): Promise<GuiEditorSaveResult> => {
      try {
        const filePath = await resolveGuiFilePath(commRouter, request.treePath);
        const json = JSON.stringify(request.manifest, null, 2) + "\n";
        await fs.writeFile(filePath, json, "utf-8");
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );
}
