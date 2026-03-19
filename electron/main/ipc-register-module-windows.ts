/**
 * ipc-register-module-windows.ts — Register module window IPC handlers.
 *
 * Responsibilities:
 * - Register `window.pdv.moduleWindows.*` IPC channels.
 * - Delegate to ModuleWindowManager for window lifecycle.
 * - Route child window execution requests to the main window.
 *
 * Non-responsibilities:
 * - Window creation/management logic (see module-window-manager.ts).
 * - Module manifest or action execution logic.
 */

import { BrowserWindow, ipcMain } from "electron";

import {
  IPC,
  type ModuleWindowOpenRequest,
  type ModuleWindowOpenResult,
  type ModuleWindowContext,
} from "./ipc";
import type { ModuleWindowManager } from "./module-window-manager";

interface RegisterModuleWindowIpcHandlersOptions {
  moduleWindowManager: ModuleWindowManager;
  mainWindow: BrowserWindow;
}

/**
 * Register module-window IPC handlers under `IPC.moduleWindows.*`.
 *
 * @param options - Dependencies.
 * @returns Nothing.
 */
export function registerModuleWindowIpcHandlers(
  options: RegisterModuleWindowIpcHandlersOptions
): void {
  const { moduleWindowManager, mainWindow } = options;

  ipcMain.handle(
    IPC.moduleWindows.open,
    async (
      _event,
      request: ModuleWindowOpenRequest
    ): Promise<ModuleWindowOpenResult> => {
      try {
        await moduleWindowManager.open(request.alias, request.kernelId);
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
    IPC.moduleWindows.close,
    async (_event, alias: string): Promise<boolean> => {
      return moduleWindowManager.close(alias);
    }
  );

  ipcMain.handle(
    IPC.moduleWindows.context,
    async (event): Promise<ModuleWindowContext | null> => {
      return moduleWindowManager.getContextForSender(event.sender.id);
    }
  );

  ipcMain.handle(
    IPC.moduleWindows.executeInMain,
    async (_event, code: string): Promise<void> => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.push.moduleExecuteRequest, code);
      }
    }
  );
}
