/**
 * session-router.ts — The stable {@link ServerHandle} the shell wires once
 * and never re-wires, delegating to whichever server currently backs the
 * session.
 *
 * `registerIpcHandlers` (`index.ts`) captures its `server` argument in a
 * dozen closures — the bridge forwarders, `updateCheckStamp`, the launcher
 * context accessors, the renderer-reload reset. Handing those closures a
 * concrete supervisor would make changing servers mean re-running the whole
 * registration, which also recreates the child-window managers and drops
 * every open module/GUI window. Handing them this router instead makes a
 * change of server a single pointer move: no ipcMain churn, no window loss.
 *
 * Responsibilities
 * - Hold the active {@link ServerHandle} and forward the whole interface to it.
 * - Remember the bridge handlers across a swap, so the incoming server is
 *   wired to the same window without the bridge having to re-register.
 * - Hand the outgoing handle back to the caller, which decides whether to
 *   shut it down (a session replacement) or keep it (a future warm standby).
 *
 * What it does NOT do
 * - It does not start, stop, spawn or connect anything — a handle arrives
 *   already started, and the caller owns the outgoing one's shutdown.
 * - It does not cancel in-flight invokes on a swap. Those promises belong to
 *   the outgoing handle's transport and settle when the caller shuts it
 *   down (rejecting with that transport's close reason). Silently rejecting
 *   them here would be indistinguishable from the server having failed.
 * - It does not decide *when* to swap; that is the remote-connection flow.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.4
 * shell/server-supervisor.ts — the ServerHandle contract and local implementation
 */

import type {
  BridgeHandlers,
  ServerHandle,
  ServerKind,
} from "./server-supervisor";

/**
 * A {@link ServerHandle} that forwards to a swappable delegate.
 *
 * Construct it around the handle the app starts with and pass *it* — never
 * the underlying handle — to everything that needs to reach the server.
 */
export class SessionRouter implements ServerHandle {
  private current: ServerHandle;
  /**
   * Retained so a swap can wire the incoming handle to the same window.
   * Mirrors whatever the bridge last set, including a clear (null).
   */
  private bridge: BridgeHandlers | null = null;

  /**
   * @param initial - The handle backing the session at startup. Already
   *   started; the router never starts anything itself.
   */
  constructor(initial: ServerHandle) {
    this.current = initial;
  }

  /** The handle currently backing the session. */
  get active(): ServerHandle {
    return this.current;
  }

  /** @inheritdoc */
  get kind(): ServerKind {
    return this.current.kind;
  }

  /**
   * Replace the active handle, moving the current bridge handlers onto it.
   *
   * The incoming handle must already be started — a half-connected server
   * behind a live bridge would surface as failing invokes with no
   * explanation. The outgoing handle is detached from the bridge but left
   * running, so the caller can shut it down (and thereby settle its pending
   * invokes) in its own time.
   *
   * @param next - The started handle to route to. Swapping in the handle
   *   that is already active is a no-op.
   * @returns The handle that was active, or null when `next` was already active.
   */
  swap(next: ServerHandle): ServerHandle | null {
    if (next === this.current) return null;
    const previous = this.current;
    previous.clearBridgeHandlers();
    this.current = next;
    if (this.bridge) {
      next.setBridgeHandlers(this.bridge);
    } else {
      next.clearBridgeHandlers();
    }
    return previous;
  }

  /** @inheritdoc */
  start(): Promise<void> {
    return this.current.start();
  }

  /** @inheritdoc */
  shutdown(): Promise<void> {
    return this.current.shutdown();
  }

  /** @inheritdoc */
  invoke(channel: string, args: unknown[] = []): Promise<unknown> {
    return this.current.invoke(channel, args);
  }

  /** @inheritdoc */
  sessionReset(): Promise<void> {
    return this.current.sessionReset();
  }

  /** @inheritdoc */
  setBridgeHandlers(handlers: BridgeHandlers): void {
    this.bridge = handlers;
    this.current.setBridgeHandlers(handlers);
  }

  /** @inheritdoc */
  clearBridgeHandlers(): void {
    this.bridge = null;
    this.current.clearBridgeHandlers();
  }
}
