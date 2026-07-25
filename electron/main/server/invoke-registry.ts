/**
 * invoke-registry.ts — Electron-free invoke-handler registry for the
 * pdv-server core.
 *
 * Server-destined IPC handlers (kernels, tree, project, modules, autosave,
 * environment, …) register here via {@link handleInvoke} instead of calling
 * `ipcMain.handle` directly — the registry is a plain Map with no Electron
 * anywhere in it. The stdio transport's rpc-server dispatches incoming
 * requests straight into {@link dispatchInvoke}; tests dispatch the same
 * way without a transport.
 *
 * {@link dispatchInvoke} owns the error contract previously provided by
 * `ipc-registry.ts`'s wrapper: failures are logged once with their channel
 * name, and non-`Error` throws are normalized to `Error` instances so the
 * renderer never receives a bare string/object rejection. Handlers that
 * report failure by *returning* `{ success: false, error }` are untouched.
 *
 * This module does NOT import Electron, own channel-name constants (those
 * live in `ipc.ts`), or perform any transport I/O.
 */

/**
 * Renderer-push sender: `(channel, payload)`. Implementations must be safe
 * to call at any time — the shell's closure no-ops once the window is
 * destroyed; the transport's implementation queues onto the wire.
 */
export type PushSender = (channel: string, payload?: unknown) => void;

/**
 * Per-dispatch context passed as every invoke handler's first argument
 * (replacing Electron's `IpcMainInvokeEvent`).
 */
export interface InvokeContext {
  /** Send a push notification to the renderer. */
  push: PushSender;
}

/** Registered handler shape as stored in the registry (internal). */
type StoredInvokeHandler = (
  ctx: InvokeContext,
  ...args: unknown[]
) => unknown;

/** Channels currently registered through {@link handleInvoke}. */
const handlers = new Map<string, StoredInvokeHandler>();

/**
 * Register an invoke handler for a channel.
 *
 * Mirrors `ipcMain.handle` semantics: registering a second handler for the
 * same channel throws, so a registration made without a matching teardown
 * fails loudly instead of silently shadowing (the drift class
 * `ipc-registry.ts` exists to prevent).
 *
 * @param channel - IPC channel name (a constant from `ipc.ts`).
 * @param handler - Handler receiving `(ctx, ...args)`; may return a value
 *   or a promise.
 * @throws Error if a handler is already registered for `channel`.
 */
export function handleInvoke<Args extends unknown[]>(
  channel: string,
  handler: (ctx: InvokeContext, ...args: Args) => unknown
): void {
  if (handlers.has(channel)) {
    throw new Error(
      `Attempted to register a second handler for '${channel}'`
    );
  }
  handlers.set(channel, handler as StoredInvokeHandler);
}

/**
 * Dispatch one invoke to its registered handler.
 *
 * Owns the cross-boundary error contract: failures are logged with the
 * channel name, and non-`Error` throws are normalized to `Error` instances.
 * The caller (the transport's rpc-server) forwards the result/rejection to
 * the shell, which hands it to the renderer unchanged.
 *
 * @param channel - IPC channel name to dispatch.
 * @param ctx - Per-dispatch context (push sender).
 * @param args - Arguments as received from the renderer.
 * @returns The handler's (awaited) return value.
 * @throws Error if no handler is registered for `channel`, or whatever the
 *   handler threw (normalized to an `Error`).
 */
export async function dispatchInvoke(
  channel: string,
  ctx: InvokeContext,
  args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for '${channel}'`);
  }
  try {
    return await handler(ctx, ...args);
  } catch (err) {
    console.error(`[ipc] ${channel} failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Remove every handler registered through {@link handleInvoke} and clear
 * the record. Called alongside the shell's `removeAllIpcHandlers()` on
 * teardown (e.g. macOS window re-creation) so re-registration never trips
 * the duplicate-handler guard.
 *
 * @returns Nothing.
 */
export function removeAllInvokeHandlers(): void {
  handlers.clear();
}

/**
 * Snapshot of the channels currently registered through
 * {@link handleInvoke}. Used by `index.ts` to mirror the registry onto
 * `ipcMain`, and by tests asserting registration/teardown symmetry.
 *
 * @returns A new array of the registered channel names.
 */
export function listRegisteredInvokeChannels(): string[] {
  return [...handlers.keys()];
}
