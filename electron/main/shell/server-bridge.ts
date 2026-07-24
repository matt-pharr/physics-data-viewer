/**
 * server-bridge.ts — Per-window bridge between the renderer's IPC surface
 * and the pdv-server transport.
 *
 * Registers an ipcMain forwarder for every `SERVER_CHANNELS` entry that
 * relays the renderer's invoke to the supervisor's RPC client, and plugs
 * the window-bound push/confirm/child-window handlers into the supervisor
 * so server pushes reach the renderer (with the `BROADCAST_PUSH_CHANNELS`
 * fan-out to child windows) and reverse-RPC confirm requests get a native
 * dialog parented to the main window.
 *
 * Error parity: the supervisor rethrows the server's rejection with its
 * original message, and the forwarders here are registered raw (no
 * re-wrapping — the server already logged and normalized), so the
 * renderer-visible error text is identical to a direct handler's.
 *
 * This module does NOT spawn or supervise the server process (the
 * supervisor does), own channel names (`ipc.ts` does), or contain
 * handler logic.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.4
 * shell/server-supervisor.ts — process lifecycle and transport client
 */

import { BrowserWindow, dialog } from "electron";

import { BROADCAST_PUSH_CHANNELS, SERVER_CHANNELS } from "../ipc";
import { handleIpcRaw } from "../ipc-registry";
import type { ConfirmOptions } from "../server/confirm";
import type { PushSender } from "../server/invoke-registry";
import type { ServerHandle } from "./server-supervisor";

/** The slice of a child-window manager the bridge needs. */
export interface ChildWindowSink {
  /** Send a push to every open window of this manager. */
  broadcastToAll(channel: string, payload?: unknown): void;
  /** Close every open window of this manager. */
  closeAll(): void;
}

/** Dependency bag for {@link registerServerBridge}. */
export interface RegisterServerBridgeOptions {
  /** The supervisor (or an in-process fake in tests). */
  server: ServerHandle;
  /** Main window receiving server pushes. */
  win: BrowserWindow;
  /** Child-window managers for broadcast fan-out and close-on-reset. */
  childWindowManagers: ChildWindowSink[];
}

/**
 * Wire the current window to the pdv-server: ipcMain forwarders for every
 * server channel, push fan-out, and the reverse-RPC confirm dialog.
 *
 * Teardown rides the existing registry bookkeeping
 * (`removeAllIpcHandlers`) plus {@link ServerHandle.clearBridgeHandlers};
 * re-registering for a new window simply replaces the bridge handlers.
 *
 * @param options - Dependency bag; see {@link RegisterServerBridgeOptions}.
 * @returns The window-bound push sender (shared with shell code that
 *   pushes directly, e.g. the app-state registrar's chrome events).
 */
export function registerServerBridge(
  options: RegisterServerBridgeOptions
): PushSender {
  const { server, win, childWindowManagers } = options;

  // The one place server pushes meet the BrowserWindow. Destroyed-window
  // guard lives here; broadcast channels fan out to child windows so the
  // server emits each push exactly once.
  const push: PushSender = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
    if (BROADCAST_PUSH_CHANNELS.includes(channel)) {
      for (const manager of childWindowManagers) {
        manager.broadcastToAll(channel, payload);
      }
    }
  };

  const confirm = async (confirmOptions: ConfirmOptions): Promise<number> => {
    const result = win.isDestroyed()
      ? await dialog.showMessageBox(confirmOptions)
      : await dialog.showMessageBox(win, confirmOptions);
    return result.response;
  };

  server.setBridgeHandlers({
    onPush: push,
    confirm,
    closeChildWindows: () => {
      for (const manager of childWindowManagers) manager.closeAll();
    },
  });

  // Forward every renderer-facing server channel through the transport.
  // Registered raw: the server side already logs and normalizes failures,
  // so wrapping again would double-log every rejection.
  for (const channel of SERVER_CHANNELS) {
    handleIpcRaw(channel, (_event, ...args) => server.invoke(channel, args));
  }

  return push;
}
