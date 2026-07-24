/**
 * confirm.ts — Injected native-confirmation contract for server-destined
 * code.
 *
 * Two server-side flows need a blocking user confirmation (module deletion
 * cleanup in `ipc-register-modules.ts`, agent-requested tree-node deletion
 * in `mcp/tools/tree-mutate.ts`). They previously called Electron's
 * `dialog.showMessageBox` directly; server code cannot. Instead they
 * receive a {@link ConfirmFn} through their dependency bag:
 *
 * - **Single-process mode**: the shell supplies a closure wrapping
 *   `dialog.showMessageBox` parented to the main window.
 * - **Extracted pdv-server**: the server sends a reverse RPC over the
 *   transport; the shell shows the dialog and replies.
 *
 * This file contains type declarations only — no runtime logic.
 */

/**
 * Options for a native confirmation dialog — the subset of Electron's
 * `MessageBoxOptions` the server-side flows use, kept Electron-type-free so
 * it can cross the shell↔server transport as plain JSON.
 */
export interface ConfirmOptions {
  /** Dialog icon/severity. */
  type?: "none" | "info" | "error" | "question" | "warning";
  /** Dialog window title (ignored on macOS, per Electron). */
  title?: string;
  /** Primary message text. */
  message: string;
  /** Secondary detail text. */
  detail?: string;
  /** Button labels, in order. */
  buttons: string[];
  /** Index of the default (Enter) button. */
  defaultId?: number;
  /** Index of the cancel (Escape / close) button. */
  cancelId?: number;
}

/**
 * Show a native confirmation dialog and resolve with the index of the
 * clicked button (mirroring `MessageBoxReturnValue.response`).
 */
export type ConfirmFn = (options: ConfirmOptions) => Promise<number>;
