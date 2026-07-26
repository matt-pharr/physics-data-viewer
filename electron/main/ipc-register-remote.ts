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
import { RemoteServerHandle } from "./shell/remote-server";
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
    if (router.kind === "remote") {
      return { ok: false, message: "This window already runs a remote session." };
    }

    const sessionId = options.sessionId ?? defaultSessionId();
    const open = options.openChannel ?? openSessionChannel;
    const host = manager.getStatus().host;
    const pushSessionState = (payload: SessionStatePayload): void => {
      if (win.isDestroyed()) return;
      win.webContents.send(IPC.push.sessionState, payload);
    };

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
      onState: (state) => {
        if (state === "connecting") return; // Not yet a session state.
        pushSessionState({ kind: "remote", host, state });
      },
      onStale: (reason) => {
        // The client's view could not be resumed. Query invalidation alone
        // would leave push-backed state (execution status, kernel status)
        // stale, so the renderer is told to rebuild everything.
        console.error(`[remote] session resync required: ${reason}`);
        pushSessionState({ kind: "remote", host, state: "connected", resync: true });
      },
      onReattached: () => {
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
    pushSessionState({ kind: "remote", host, state: "connected", resync: true });
    // The outgoing local server is shut down, not abandoned: it holds a
    // kernel and a working directory on this machine.
    void previous?.shutdown().catch((err: unknown) => {
      console.error("[remote] local server shutdown failed:", err);
    });
    return { ok: true, sessionId };
  });

  handleIpc(IPC.remote.endSession, async (): Promise<RemoteSessionResult> => {
    const router = options.router;
    if (!router || router.kind !== "remote") {
      return { ok: false, message: "This window is not running a remote session." };
    }
    return {
      ok: false,
      message:
        "Returning to a local session is not implemented yet. " +
        "Disconnecting leaves the remote session running on the host.",
    };
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
