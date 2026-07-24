/**
 * ipc-register-gui-files.ts — Server-side GUI manifest file I/O handlers.
 *
 * Registers `guiEditor.read` / `guiEditor.save`: resolving a PDVGui tree
 * node to its backing `.gui.json` file via the kernel comm and reading or
 * atomically writing that manifest. These are server channels — they need
 * the comm router and the project filesystem, not a window.
 *
 * Non-responsibilities:
 * - GUI editor/viewer *window* lifecycle (`guiEditor.open`/`openViewer`/
 *   `context` are shell channels; see `ipc-register-gui-editor.ts`).
 * - GUI manifest validation or editing logic.
 */

import * as fs from "fs/promises";

import { atomicWriteFile } from "./atomic-write";
import type { CommRouter } from "./comm-router";
import {
  IPC,
  type GuiEditorReadResult,
  type GuiEditorSaveRequest,
  type GuiEditorSaveResult,
} from "./ipc";
import { PDVMessageType } from "./pdv-protocol";
import { handleInvoke } from "./server/invoke-registry";

/** Dependency bag for {@link registerGuiFilesIpcHandlers}. */
export interface RegisterGuiFilesIpcHandlersOptions {
  /** Comm router used to resolve tree paths to backing files. */
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
 * Register the `guiEditor.read` / `guiEditor.save` invoke handlers.
 *
 * @param options - Dependency bag; see {@link RegisterGuiFilesIpcHandlersOptions}.
 * @returns Nothing.
 */
export function registerGuiFilesIpcHandlers(
  options: RegisterGuiFilesIpcHandlersOptions
): void {
  const { commRouter } = options;

  handleInvoke(
    IPC.guiEditor.read,
    async (_ctx, treePath: string): Promise<GuiEditorReadResult> => {
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

  handleInvoke(
    IPC.guiEditor.save,
    async (_ctx, request: GuiEditorSaveRequest): Promise<GuiEditorSaveResult> => {
      try {
        const filePath = await resolveGuiFilePath(commRouter, request.treePath);
        const json = JSON.stringify(request.manifest, null, 2) + "\n";
        // Atomic: a crash mid-save must not tear the .gui.json manifest.
        await atomicWriteFile(filePath, json);
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
