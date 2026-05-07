/**
 * dialog-mock.ts — Stub Electron's native dialog APIs from a Playwright test.
 *
 * Native pickers (open/save dialogs, message boxes) are routed through
 * `electron.dialog` in the main process. Playwright cannot click them, so we
 * replace the relevant methods inside the spawned app via `app.evaluate`.
 *
 * Pass plain JS values; they are serialized into the main process and used to
 * synthesize a return value matching Electron's dialog return shape.
 */

import type { ElectronApplication } from "@playwright/test";

export interface DialogStubs {
  /** Path(s) to return from `dialog.showOpenDialog`. */
  showOpenDialogPaths?: string[];
  /** Result for `dialog.showSaveDialog`. */
  showSaveDialogPath?: string;
  /** Button index returned by `dialog.showMessageBox` (0-based). */
  showMessageBoxResponse?: number;
}

/**
 * Install dialog stubs into the running Electron app.
 *
 * Multiple calls overwrite previous stubs. Pass `undefined` to a field to
 * leave that dialog method untouched.
 */
export async function stubDialog(
  app: ElectronApplication,
  stubs: DialogStubs,
): Promise<void> {
  await app.evaluate(({ dialog }, s) => {
    if (s.showOpenDialogPaths !== undefined) {
      const paths = s.showOpenDialogPaths;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({
        canceled: paths.length === 0,
        filePaths: paths,
      });
    }
    if (s.showSaveDialogPath !== undefined) {
      const filePath = s.showSaveDialogPath;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showSaveDialog = async () => ({
        canceled: filePath.length === 0,
        filePath,
      });
    }
    if (s.showMessageBoxResponse !== undefined) {
      const response = s.showMessageBoxResponse;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showMessageBox = async () => ({
        response,
        checkboxChecked: false,
      });
    }
  }, stubs);
}
