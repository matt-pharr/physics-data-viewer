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

import { IPC, type RemoteConnectResult, type RemoteHostAlias, type RemoteStatus } from "./ipc";
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

  const manager =
    options.manager ??
    new RemoteConnectionManager({
      controlDir: options.controlDir,
      onStatus: pushStatus,
      appVersion: app.getVersion(),
      bundleDir: options.bundleDir,
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

  return manager;
}
