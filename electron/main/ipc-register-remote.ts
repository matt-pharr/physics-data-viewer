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
  INTERNAL_CHANNELS,
  IPC,
  type RemoteConnectResult,
  type RemoteHostAlias,
  type RemoteHostConfigPayload,
  type RemoteHostConfigUpdate,
  type RemoteSessionResult,
  type RemoteSetupTestResult,
  type RemoteStatus,
  type SessionStatePayload,
} from "./ipc";
import type { PushedDirKey, RemoteHostStore } from "./remote/host-config";
import { WRONG_NODE_MARKER } from "./server/attach-cli";
import { openSessionChannel } from "./remote/remote-channel";
import {
  listSetupScriptHosts,
  readLocalSetupScript,
  shipSetupScript,
  writeLocalSetupScript,
} from "./remote/setup-script";
import { runSetupScriptTest } from "./remote/setup-script-test";
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
   * Per-host settings store. Omitting it leaves the Remote Hosts channels
   * answering with empty config and declining writes, which is what a build
   * (or test) without host settings should do rather than failing.
   */
  hostStore?: RemoteHostStore;
  /** Runs the setup-script dry run. Injected by tests. */
  runScriptTest?: typeof runSetupScriptTest;
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
      // Aim a PDV-created master at the login node the session daemon was
      // last seen on (recorded below at session start). See the option's
      // JSDoc for why a round-robin alias needs this.
      sessionNodeFor: (host) => options.hostStore?.get(host).sessionNode ?? null,
      // Per-host X11 toggle (#377), applied to masters PDV creates.
      forwardX11For: (host) => options.hostStore?.get(host).forwardX11 === true,
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

  // Concurrent disconnect invokes coalesce onto one in-flight promise. The
  // swap back to local takes as long as spawning a fresh pdv-server child,
  // and both the welcome button and the dialog's Disconnect stay clickable
  // through that window — a double-click used to run swapBackToLocal twice
  // (both invokes pass the router.kind check before either swaps), and the
  // second swap returned the FIRST local server as `previous`, silently
  // abandoning it as an orphan child process.
  let disconnectInFlight: Promise<void> | null = null;

  handleIpc(IPC.remote.disconnect, async () => {
    if (disconnectInFlight) return disconnectInFlight;
    disconnectInFlight = (async () => {
      // Disconnecting while the session runs remotely returns this window
      // to a fresh local session; the daemon and its kernel keep running on
      // the host for a later reconnect. Without the swap the window would
      // keep routing every invoke at a channel that is about to be torn
      // down.
      if (options.router?.kind === "remote" && !options.createLocalServer) {
        // Same decline endSession gives: tearing the mux down UNDER the
        // live session would strand the window with a dead server.
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
        // connection up since the session still rides it. The original
        // error is rethrown (the tsconfig target predates Error's `cause`
        // option), with the context logged beside it.
        console.error(
          "[remote] could not return to a local session; staying on the remote session:",
          err,
        );
        throw err;
      }
      await manager.disconnect();
    })().finally(() => {
      disconnectInFlight = null;
    });
    return disconnectInFlight;
  });

  handleIpc(IPC.remote.getStatus, async (): Promise<RemoteStatus> => manager.getStatus());

  handleIpc(
    IPC.remote.getHostConfig,
    async (_event, host: string): Promise<RemoteHostConfigPayload> => {
      if (typeof host !== "string" || !host.trim()) {
        return { settings: {}, setupScript: "", sessionNode: null };
      }
      const trimmed = host.trim();
      const record = options.hostStore?.get(trimmed) ?? {};
      // Recorded state stays out of the editable settings payload.
      const { sessionNode, pushedDirKeys: _pushed, ...settings } = record;
      return {
        settings,
        setupScript: options.setupScriptDir
          ? readLocalSetupScript(options.setupScriptDir, trimmed)
          : "",
        sessionNode: sessionNode ?? null,
      };
    },
  );

  handleIpc(
    IPC.remote.setHostConfig,
    async (_event, host: string, update: RemoteHostConfigUpdate): Promise<void> => {
      if (typeof host !== "string" || !host.trim()) {
        throw new Error("No host was given.");
      }
      if (!update || typeof update !== "object") {
        throw new Error("No settings were given.");
      }
      const trimmed = host.trim();
      // The script is written first: it is the failure-prone half (a real
      // file write), and settings recorded for a host whose script silently
      // failed to save would claim more than was persisted.
      if (options.setupScriptDir) {
        writeLocalSetupScript(
          options.setupScriptDir,
          trimmed,
          typeof update.setupScript === "string" ? update.setupScript : "",
        );
      }
      options.hostStore?.setSettings(trimmed, update.settings ?? {});
    },
  );

  handleIpc(IPC.remote.listConfiguredHosts, async (): Promise<string[]> => {
    // Union of the two configuration surfaces: the settings store and the
    // setup-script directory (a host configured by hand-writing a script —
    // the only way before this tab existed — must still appear).
    const configured = new Set<string>(options.hostStore?.listConfiguredHosts() ?? []);
    if (options.setupScriptDir) {
      for (const host of listSetupScriptHosts(options.setupScriptDir)) {
        configured.add(host);
      }
    }
    return [...configured].sort();
  });

  handleIpc(IPC.remote.forgetHost, async (_event, host: string): Promise<void> => {
    if (typeof host !== "string" || !host.trim()) {
      throw new Error("No host was given.");
    }
    const trimmed = host.trim();
    options.hostStore?.forget(trimmed);
    if (options.setupScriptDir) {
      writeLocalSetupScript(options.setupScriptDir, trimmed, "");
    }
  });

  handleIpc(
    IPC.remote.testSetupScript,
    async (_event, host: string, script: string): Promise<RemoteSetupTestResult> => {
      const declined = (message: string): RemoteSetupTestResult => ({
        ok: false,
        exitCode: null,
        output: "",
        before: [],
        after: [],
        message,
      });
      if (typeof host !== "string" || !host.trim()) {
        return declined("No host was given.");
      }
      const status = manager.getStatus();
      const control = manager.control;
      if (!control || status.host !== host.trim()) {
        return declined(
          `Connect to ${host.trim()} first — the test runs the script in a ` +
            "real login shell on the host.",
        );
      }
      const run = options.runScriptTest ?? runSetupScriptTest;
      return run({
        control,
        content: typeof script === "string" ? script : "",
        sshPath,
      });
    },
  );

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

    // Recorded on every successful start/reattach: the daemon lives on the
    // node this connection reached (the session socket is node-local, so an
    // attach can only ever succeed there). The pin steers the NEXT master.
    const recordSessionNode = (): void => {
      const node = manager.getStatus().node;
      if (host && node) options.hostStore?.setSessionNode(host, node);
    };

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
    let shippedScript = false;
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
      shippedScript = shipped.shipped;
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
          recordSessionNode();
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

    // Computed at PUSH time from the handle's LATEST attach result, not
    // once at start: the handle's internal reconnect loop can resurrect the
    // daemon (which sources the last-shipped script) or land on one whose
    // capture failed, flipping the truth in either direction — a warning
    // frozen at start would then lie until the next explicit startSession.
    // A ref because the handle's callbacks are created before the handle
    // variable exists.
    const handleRef: { current: RemoteServerHandle | null } = { current: null };
    const withWarning = (payload: SessionStatePayload): SessionStatePayload =>
      shippedScript && handleRef.current?.setupScriptApplied === false
        ? {
            ...payload,
            setupScriptWarning:
              `Your setup script for ${host ?? "this host"} is not active ` +
              "in this session — the session daemon started without it. " +
              "Shut the remote session down and start it again to apply " +
              "the script.",
          }
        : payload;

    // Tail of the attach channel's stderr, kept for failure diagnosis: the
    // wrong-node refusal arrives there as a `PDV_WRONG_NODE node=<host>`
    // marker (attach-cli.ts), and turning it into an actionable message —
    // and a recorded pin for the next connect — needs the bytes.
    let attachStderrTail = "";

    const handle = new RemoteServerHandle({
      sessionId,
      // Launcher routing derives host/control from the HANDLE (via the
      // router), never from the per-window manager — see the option's
      // JSDoc for the window-reopen staleness this avoids.
      launcherTarget: host ? { host, control } : undefined,
      openChannel: async ({ batchMode }) =>
        open({
          control,
          sessionId,
          serverCommand,
          create: true,
          sshPath,
          muxOptions: { batchMode },
          // Per-host X11 toggle (#377): the daemon spawned by --create
          // inherits this channel's env, so forwarding requested HERE is
          // what gives its kernels a DISPLAY.
          forwardX11: host ? options.hostStore?.get(host).forwardX11 === true : false,
          onStderr: (chunk) => {
            attachStderrTail = (attachStderrTail + chunk).slice(-4096);
          },
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
        pushSessionState(withWarning({ kind: "remote", host, state }));
      },
      onStale: (reason) => {
        // A first attach is always stale ("no-cursor") — there is nothing to
        // resume yet — and the swap below already asks for a rebuild. Telling
        // the renderer twice made it print two "output may be missing"
        // markers for one connect, which reads as two lost intervals.
        if (reason === "no-cursor") return;
        if (router.active !== handle) return;
        console.error(`[remote] session resync required: ${reason}`);
        pushSessionState(
          withWarning({
            kind: "remote",
            host,
            state: "connected",
            resync: true,
            cause: "recovered",
          }),
        );
      },
      onReattached: () => {
        if (router.active !== handle) return;
        pushSessionState(withWarning({ kind: "remote", host, state: "connected" }));
      },
    });

    handleRef.current = handle;

    try {
      await handle.start();
      // The daemon can only have been reached on the node this connection
      // landed on — record it NOW, before anything below can fail, so even
      // a declined move teaches the next connect where the session lives.
      recordSessionNode();

      // Apply this host's directory settings to ITS server config before
      // the window swaps onto it. `~/.PDV/preferences.json` on the host is
      // what the server actually reads for working dirs and save locations,
      // and the laptop-side per-host settings are its master copy — pushed
      // here the same way the setup script is shipped. Before the swap so a
      // failure is loud and leaves the local session untouched: a kernel
      // quietly writing to an NFS home the user pointed at scratch is the
      // harder bug to notice.
      //
      // Clearing propagates too: a key this code once pushed and the user
      // has since blanked is pushed as "" (every consumer treats an empty
      // string as unset), because the stale scratch path lingering in the
      // host's config IS the silent-data-placement bug. A key never pushed
      // is never touched — the user may have set it on the host themselves.
      const hostRecord = host ? options.hostStore?.get(host) : undefined;
      const dirOverrides: Record<string, string> = {};
      const nowPushed: PushedDirKey[] = [];
      for (const key of ["workingDirBase", "defaultSaveLocation"] as const) {
        const value = hostRecord?.[key];
        if (value) {
          dirOverrides[key] = value;
          nowPushed.push(key);
        } else if (hostRecord?.pushedDirKeys?.includes(key)) {
          dirOverrides[key] = "";
        }
      }
      if (Object.keys(dirOverrides).length > 0) {
        try {
          await handle.invoke(INTERNAL_CHANNELS.serverConfigSet, [dirOverrides]);
          if (host) options.hostStore?.setPushedDirKeys(host, nowPushed);
        } catch (err) {
          void handle.disconnect().catch(() => undefined);
          return {
            ok: false,
            message:
              `The directory settings for ${host ?? "this host"} could not ` +
              `be applied: ${(err as Error).message}. The session was left ` +
              "running there; fix the settings (or the host) and try again.",
          };
        }
      }
    } catch (err) {
      // The local session is untouched: nothing was swapped, so a failed
      // start leaves the user working exactly as before rather than with
      // neither session.
      const wrongNode = new RegExp(`${WRONG_NODE_MARKER} node=(\\S+)`).exec(
        attachStderrTail,
      );
      if (wrongNode && host) {
        // Teach the pin now, so the very next connect aims at the right
        // node even though THIS one could not.
        options.hostStore?.setSessionNode(host, wrongNode[1]);
        const reached = manager.getStatus().node;
        return {
          ok: false,
          message:
            `Your session is running on ${wrongNode[1]}, but this ` +
            `connection reached ${reached ?? "a different node"}. ` +
            `Disconnect and reconnect — PDV will aim for ${wrongNode[1]} ` +
            `automatically.`,
        };
      }
      return { ok: false, message: (err as Error).message };
    }

    const previous = router.swap(handle);
    pushSessionState(
      withWarning({
        kind: "remote",
        host,
        state: "connected",
        resync: true,
        cause: "moved",
      }),
    );
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
    // The pin dies with the session. Cleared optimistically — if the
    // shutdown ack above is lost and the daemon survives, the next connect
    // simply lands wherever the alias sends it and the attach guard
    // re-teaches the pin with its wrong-node refusal.
    const endedHost = manager.getStatus().host;
    if (endedHost) options.hostStore?.setSessionNode(endedHost, null);
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
