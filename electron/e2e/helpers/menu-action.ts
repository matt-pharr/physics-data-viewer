/**
 * menu-action.ts — Synthesize native-menu actions from Playwright.
 *
 * Native menus can't be clicked via Playwright. The renderer subscribes to
 * `menu:action` pushes from the main process; we fire those directly via
 * `app.evaluate` so tests can drive File-menu flows without OS chrome.
 */

import type { ElectronApplication } from "@playwright/test";

export interface MenuActionPayload {
  action: string;
  path?: string;
  [key: string]: unknown;
}

/** Send a `menu:action` push to the first BrowserWindow's renderer. */
export async function sendMenuAction(
  app: ElectronApplication,
  payload: MenuActionPayload,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("[menu-action] no main window");
    win.webContents.send("menu:action", p);
  }, payload);
}
