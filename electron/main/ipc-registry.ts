/**
 * ipc-registry.ts — Self-recording wrapper around `ipcMain.handle`.
 *
 * Every `ipcMain.handle` registration in the main process goes through
 * `handleIpc`, which records the channel name as a side effect. Teardown
 * (`removeAllIpcHandlers`) then removes exactly the set of channels that
 * were actually registered.
 *
 * This replaces the hand-maintained `REGISTERED_CHANNELS` list that
 * previously lived in `index.ts`. That list had drifted: 17 registered
 * channels were missing (so the macOS close-window → activate →
 * re-register path threw "Attempted to register a second handler"), and
 * 4 stale entries referenced channels that were no longer registered at
 * all. Deriving the list from the registrations themselves makes that
 * class of drift structurally impossible.
 *
 * This module does NOT own any handler logic, channel-name constants
 * (those live in `ipc.ts`), or `ipcMain.on`-style event listeners —
 * only `handle`/`removeHandler` bookkeeping.
 */

import { ipcMain } from "electron";

/** Handler signature accepted by `ipcMain.handle`, reused verbatim. */
type IpcInvokeHandler = Parameters<typeof ipcMain.handle>[1];

/** Channels currently registered through {@link handleIpc}. */
const registeredChannels = new Set<string>();

/**
 * Register an `ipcMain.handle` listener and record its channel for
 * later teardown.
 *
 * The handler is wrapped so every failure crossing the process boundary
 * has one shape: the error is logged with its channel name (handlers
 * historically logged inconsistently or not at all), and non-`Error`
 * throws are normalized to `Error` instances so the renderer never
 * receives a bare string/object rejection. Handlers that report failure
 * by *returning* `{ success: false, error }` are untouched — that is the
 * other sanctioned shape, used where the renderer wants to render the
 * failure inline rather than catch it.
 *
 * @param channel - IPC channel name (a constant from `ipc.ts`).
 * @param handler - Invoke handler, exactly as `ipcMain.handle` accepts.
 * @throws Error if `ipcMain` already has a handler for `channel`
 *   (propagated from Electron) — indicating a registration made without
 *   a matching teardown, the exact bug this registry exists to prevent.
 */
export function handleIpc(channel: string, handler: IpcInvokeHandler): void {
  const wrapped: IpcInvokeHandler = async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };
  ipcMain.handle(channel, wrapped);
  registeredChannels.add(channel);
}

/**
 * Remove every handler registered through {@link handleIpc} and clear
 * the record. Called by `unregisterIpcHandlers()` before the handlers
 * are registered anew (e.g. macOS window re-creation on activate).
 *
 * @returns Nothing.
 */
export function removeAllIpcHandlers(): void {
  for (const channel of registeredChannels) {
    ipcMain.removeHandler(channel);
  }
  registeredChannels.clear();
}

/**
 * Snapshot of the channels currently registered through {@link handleIpc}.
 *
 * Exposed for tests (e.g. asserting that registration and teardown stay
 * symmetric); production code should not need it.
 *
 * @returns A new array of the recorded channel names.
 */
export function listRegisteredIpcChannels(): string[] {
  return [...registeredChannels];
}
