/**
 * ipc-register-remote.ts — Register the remote-connection IPC handlers.
 *
 * Responsibilities:
 * - Expose the `IPC.remote.*` channels over a {@link RemoteConnectionManager}.
 * - Forward every connection state change to the renderer as a push.
 *
 * Non-responsibilities:
 * - Establishing the connection itself (see `remote/remote-connection.ts`).
 * - Swapping the active session onto the remote host. Connecting and running
 *   a session over that connection are separate steps; nothing here touches
 *   `SessionRouter`.
 * - Any server-side work. These are shell channels by necessity: they set up
 *   the connection a remote session is reached through.
 */

import { app, type BrowserWindow } from "electron";

import * as os from "os";

import {
  IPC,
  type RemoteConnectResult,
  type RemoteHostAlias,
  type RemoteSessionResult,
  type RemoteStatus,
  type SessionStatePayload,
} from "./ipc";
import { openSessionChannel } from "./remote/remote-channel";
import { shipSetupScript } from "./remote/setup-script";
import { RemoteServerHandle } from "./shell/remote-server";
import type { ServerHandle } from "./shell/server-supervisor";
import type { SessionRouter } from "./shell/session-router";
import { handleIpc } from "./ipc-registry";
import { RemoteConnectionManager } from "./remote/remote-connection";

/** Options for {@link registerRemoteIpcHandlers}. */
export interface RegisterRemoteIpcOptions {
  /** Window receiving connection-status pushes. */
  win: BrowserWindow;
  /**
   * Directory for PDV-owned control sockets. Injected rather than derived
   * here, matching the other registrars, and kept out of `~/.PDV`: that
   * directory belongs to the pdv-server, and in a remote session the
   * server's copy of it lives on the cluster. A control socket is a
   * local-machine runtime artifact and has no business there.
   *
   * Keep it shallow. macOS caps a Unix socket path near 104 bytes and the
   * hashed socket name is appended to this.
   */
  controlDir: string;
  /**
   * Directory holding the built remote bundles (`index.json` + tarballs).
   * Omitting it connects without bootstrapping, which is what a build with
   * no bundles should do rather than refusing to connect at all.
   */
  bundleDir?: string;
  /** Injected for tests; production uses the real ssh binary and node-pty. */
  manager?: RemoteConnectionManager;
  /**
   * The router whose active handle is swapped when a session moves. Omit to
   * expose connection control without the ability to move the session,
   * which is what a build with no session support should do rather than
   * offering a menu item that fails.
   */
  router?: SessionRouter;
  /** Session id to attach to. Defaults to a per-user stable id. */
  sessionId?: string;
  /** Opens the ssh channel. Injected by tests. */
  openChannel?: typeof openSessionChannel;
  /**
   * Directory of per-host setup-script master copies
   * (`<userData>/remote-setup`). Omitting it skips setup-script shipping
   * entirely, which is what a build (or test) with no setup-script support
   * should do rather than failing every session start.
   */
  setupScriptDir?: string;
  /** Ships the setup script. Injected by tests. */
  shipScript?: typeof shipSetupScript;
  /**
   * Starts a fresh local pdv-server. Ending a remote session (and
   * disconnecting while one runs) swaps the window back onto it; omitting
   * this leaves those actions declined rather than half-done.
   */
  createLocalServer?: () => Promise<ServerHandle>;
}

/**
 * Register the `IPC.remote.*` handlers.
 *
 * @param options - Window and optional injected manager/control directory.
 * @returns The manager backing the handlers, so callers can read the live
 *   connection (e.g. to build a remote `ServerHandle` once one exists).
 */
export function registerRemoteIpcHandlers(
  options: RegisterRemoteIpcOptions,
): RemoteConnectionManager {
  const { win } = options;

  const pushStatus = (status: RemoteStatus): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC.push.remoteStatus, status);
  };

  const pushSessionState = (payload: SessionStatePayload): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC.push.sessionState, payload);
  };

  // The handle currently serving this window's remote session. Read from
  // the ROUTER, not registrar closure state: handlers are re-registered per
  // window (a macOS reopen builds a fresh closure) while the router and its
  // active handle live on — closure state would come back null and vacate
  // the recovery and shutdown guards below.
  const activeRemoteHandle = (): RemoteServerHandle | null => {
    const active = options.router?.active;
    return active instanceof RemoteServerHandle ? active : null;
  };

  /**
   * Swap the window back onto a fresh local server.
   *
   * Order is the safety property: the local server starts FIRST, so a
   * failure leaves the remote session untouched rather than the window with
   * neither. The outgoing remote handle is returned for the caller to
   * disconnect (session keeps running) or shut down (session ends).
   */
  const swapBackToLocal = async (): Promise<ServerHandle | null> => {
    const router = options.router;
    const createLocal = options.createLocalServer;
    if (!router || router.kind !== "remote" || !createLocal) return null;
    const local = await createLocal();
    const previous = router.swap(local);
    pushSessionState({
      kind: "local",
      host: null,
      state: "connected",
      resync: true,
      cause: "moved",
    });
    return previous;
  };

  // Two env seams, both for testing the remote path without a cluster. They
  // mirror the existing PDV_ZEROMQ_PATH / PYTHON_PATH convention: absent in
  // any normal run, and inert unless deliberately set.
  //
  // Without these the remote path can only be exercised by hand against a
  // real host — which is how three shipped bugs (an unquoted ControlPath, a
  // sun_path budget that ignored ssh's temp suffix, and a stale bundle) were
  // found by a human rather than by CI.
  const sshPath = process.env.PDV_SSH_PATH;
  const serverCommandOverride = process.env.PDV_REMOTE_SERVER_COMMAND;

  const manager =
    options.manager ??
    new RemoteConnectionManager({
      controlDir: options.controlDir,
      onStatus: pushStatus,
      appVersion: app.getVersion(),
      // An override supplies the server directly, so there is nothing to
      // bootstrap and probing a host that has no bundle would only fail.
      bundleDir: serverCommandOverride ? undefined : options.bundleDir,
      sshPath,
    });

  handleIpc(IPC.remote.listHosts, async (): Promise<RemoteHostAlias[]> => manager.listHosts());

  handleIpc(
    IPC.remote.connect,
    async (_event, host: string): Promise<RemoteConnectResult> => {
      if (typeof host !== "string" || !host.trim()) {
        return { ok: false, failure: "invalid-host", message: "No host was given." };
      }
      return manager.connect(host.trim());
    },
  );

  handleIpc(IPC.remote.respond, async (_event, text: string) => {
    // A reply is never logged or retained — it goes straight to the pty.
    if (typeof text === "string") manager.respond(text);
  });

  handleIpc(IPC.remote.cancel, async () => {
    manager.cancel();
  });

  handleIpc(IPC.remote.disconnect, async () => {
    // Disconnecting while the session runs remotely returns this window to
    // a fresh local session; the daemon and its kernel keep running on the
    // host for a later reconnect. Without the swap the window would keep
    // routing every invoke at a channel that is about to be torn down.
    if (options.router?.kind === "remote" && !options.createLocalServer) {
      // Same decline endSession gives: tearing the mux down UNDER the live
      // session would strand the window with a dead server.
      throw new Error(
        "This build cannot return to a local session, so disconnecting " +
          "while the session runs remotely is not available.",
      );
    }
    try {
      const previous = await swapBackToLocal();
      if (previous instanceof RemoteServerHandle) {
        await previous.disconnect();
      }
    } catch (err) {
      // The local server would not start; leave the remote session as the
      // active one rather than stranding the window, and keep the ssh
      // connection up since the session still rides it. The original error
      // is rethrown (the tsconfig target predates Error's `cause` option),
      // with the context logged beside it.
      console.error(
        "[remote] could not return to a local session; staying on the remote session:",
        err,
      );
      throw err;
    }
    await manager.disconnect();
  });

  handleIpc(IPC.remote.getStatus, async (): Promise<RemoteStatus> => manager.getStatus());

  handleIpc(IPC.remote.startSession, async (): Promise<RemoteSessionResult> => {
    const router = options.router;
    if (!router) {
      return { ok: false, message: "This build cannot run remote sessions." };
    }
    const control = manager.control;
    const serverCommand = serverCommandOverride ?? manager.serverCommand;
    if (!control || !serverCommand) {
      return {
        ok: false,
        message: "Connect to a host before starting a session there.",
      };
    }
    const sessionId = options.sessionId ?? defaultSessionId();
    const host = manager.getStatus().host;

    // The setup script must be on the host BEFORE any path that can spawn a
    // daemon: it is sourced exactly once, during the daemon's startup
    // login-environment capture, so a script arriving after `--create`
    // silently does not apply until the next session. That includes the
    // retryNow recovery below — its attach runs with `create: true` and
    // will resurrect a daemon that died while disconnected, which must
    // source the CURRENT script, not whatever a previous startSession left
    // behind. A configured script that cannot be delivered fails the start
    // loudly — a session whose interpreters are silently missing is the
    // harder bug to diagnose. (The one unshipped path left is the handle's
    // internal reconnect loop; a daemon resurrected there sources the last
    // startSession's copy, which is also the newest one ever shipped.)
    if (options.setupScriptDir && host) {
      const ship = options.shipScript ?? shipSetupScript;
      const shipped = await ship({
        control,
        host,
        sessionId,
        setupScriptDir: options.setupScriptDir,
        sshPath,
      });
      if (!shipped.ok) {
        return { ok: false, message: shipped.message };
      }
    }

    if (router.kind === "remote") {
      // The recovery path: the session is already here but its channel was
      // lost past the automatic backoff (`auth-required`). The user has just
      // re-authenticated in this dialog, so an interactive reattach is
      // exactly what "run session here" should mean now.
      const current = activeRemoteHandle();
      if (current && current.connectionState !== "connected") {
        try {
          await current.retryNow();
          return { ok: true, sessionId };
        } catch (err) {
          console.error("[remote] reattach via existing handle failed:", err);
          // Fall through and build a fresh handle: a handle that was
          // superseded (or closed) can never reattach — "reconnect" must
          // still work, and the attach protocol makes a fresh handle safe.
        }
      } else if (current) {
        return { ok: false, message: "This window already runs a remote session." };
      }
    }

    const open = options.openChannel ?? openSessionChannel;

    const handle = new RemoteServerHandle({
      sessionId,
      openChannel: async ({ batchMode }) =>
        open({
          control,
          sessionId,
          serverCommand,
          create: true,
          sshPath,
          muxOptions: { batchMode },
        }),
      // Every callback is gated on this handle actually fronting the
      // window. Before the swap the local server still does; after a swap
      // BACK to local, the retired handle's own disconnect()/shutdown()
      // fires a final "disconnected" state change — un-gated, that push
      // arrived after the "local, connected" one and left the renderer
      // showing a lost remote session while the window ran locally.
      onState: (state) => {
        if (state === "connecting") return; // Not yet a session state.
        if (router.active !== handle) return;
        pushSessionState({ kind: "remote", host, state });
      },
      onStale: (reason) => {
        // A first attach is always stale ("no-cursor") — there is nothing to
        // resume yet — and the swap below already asks for a rebuild. Telling
        // the renderer twice made it print two "output may be missing"
        // markers for one connect, which reads as two lost intervals.
        if (reason === "no-cursor") return;
        if (router.active !== handle) return;
        console.error(`[remote] session resync required: ${reason}`);
        pushSessionState({
          kind: "remote",
          host,
          state: "connected",
          resync: true,
          cause: "recovered",
        });
      },
      onReattached: () => {
        if (router.active !== handle) return;
        pushSessionState({ kind: "remote", host, state: "connected" });
      },
    });

    try {
      await handle.start();
    } catch (err) {
      // The local session is untouched: nothing was swapped, so a failed
      // start leaves the user working exactly as before rather than with
      // neither session.
      return { ok: false, message: (err as Error).message };
    }

    const previous = router.swap(handle);
    pushSessionState({
      kind: "remote",
      host,
      state: "connected",
      resync: true,
      cause: "moved",
    });
    if (previous instanceof RemoteServerHandle) {
      // The fresh-handle recovery path replaced a dead remote handle. Only
      // close it locally — a shutdown here would be delivered by the NEW
      // channel to the very daemon the user just reconnected to.
      void previous.disconnect().catch(() => undefined);
    } else if (previous) {
      // The outgoing local server is shut down, not abandoned: it holds a
      // kernel and a working directory on this machine.
      void previous.shutdown().catch((err: unknown) => {
        console.error("[remote] local server shutdown failed:", err);
      });
    }
    return { ok: true, sessionId };
  });

  handleIpc(IPC.remote.endSession, async (): Promise<RemoteSessionResult> => {
    const router = options.router;
    if (!router || router.kind !== "remote") {
      return { ok: false, message: "This window is not running a remote session." };
    }
    if (!options.createLocalServer) {
      return { ok: false, message: "This build cannot return to a local session." };
    }
    // The shutdown invoke can only reach the daemon over a live channel; on
    // a dead one it silently does nothing, and "Shut Down" would report
    // success while the daemon keeps running on the host. Decline instead.
    const current = activeRemoteHandle();
    if (current && current.connectionState !== "connected") {
      return {
        ok: false,
        message:
          "The session is unreachable right now. Reconnect first, or use " +
          "Disconnect — an unreachable session cannot be shut down from here.",
      };
    }
    let previous: ServerHandle | null;
    try {
      previous = await swapBackToLocal();
    } catch (err) {
      // The remote session is untouched — better a declined action than a
      // window with no server behind it.
      return {
        ok: false,
        message: `Could not start a local session to return to: ${(err as Error).message}`,
      };
    }
    // Only now is the daemon told to stop: the window is already safe on
    // the local server, so a lost ack (daemon exits before answering, ssh
    // drops) no longer matters.
    if (previous) {
      void previous.shutdown().catch((err: unknown) => {
        console.error("[remote] remote session shutdown failed:", err);
      });
    }
    return { ok: true };
  });

  return manager;
}

/**
 * A stable session id for this user on any host.
 *
 * Stable rather than random on purpose: reconnecting after a crash or an app
 * restart must find the *same* session, kernel and Tree. A fresh id each
 * time would strand the previous daemon holding the user's work with no way
 * back to it.
 *
 * @returns The default session identifier.
 */
function defaultSessionId(): string {
  return `pdv-${os.userInfo().username}`;
}
