/**
 * session-host.ts — the long-lived session daemon.
 *
 * Serves one session over a Unix socket, outliving the connections that come
 * and go on top of it. The journal and settlement store belong to the host,
 * not to any connection, which is what lets a client drop, reattach, and be
 * handed exactly what it missed.
 *
 * **A new attach supersedes the old connection.** The machinery underneath
 * supports N clients — per-connection cursors over one journal — but the
 * reverse-RPC confirm would fan out to all of them, popping two native
 * dialogs for one question. So the newest connection wins and the previous
 * one is told why (`superseded`) before it is closed, which makes two live
 * clients impossible in steady state while still tolerating the reconnect
 * race where the old channel has not yet been reaped. `role` is reserved in
 * the attach result so multi-window can relax this later.
 *
 * **Every fresh connection is gated until it attaches.** Between accept and
 * attach the client has not said where its cursor is, so a kernel streaming
 * output in that window would hand it an unpredictable seq — a gap on the
 * first frame of a reconnect. Pushes are journalled but withheld, and reach
 * the client through the replay instead. The gate has a deadline so a hung
 * channel cannot hold the session open indefinitely.
 *
 * This module does NOT daemonize itself (the caller detaches it), spawn
 * kernels, or know what any application channel means.
 */

import * as fs from "fs";
import * as net from "net";

import type { PushSender } from "./invoke-registry";
import { planAttach } from "../transport/attach";
import { PushJournal } from "../transport/push-journal";
import { ResponseStore } from "../transport/response-store";
import { RPC_CHANNELS, type RpcAttachRequest } from "../transport/protocol";
import { RpcServer, type RpcServerOptions } from "../transport/rpc-server";
import type { SessionPaths } from "./session-paths";

/** How long a connection may sit unattached before it is closed. */
export const ATTACH_DEADLINE_MS = 15_000;

/** Grace period for a superseded connection's final frames to flush. */
const SUPERSEDE_FLUSH_MS = 250;

/** Options accepted by {@link SessionHost}. */
export interface SessionHostOptions {
  /** Resolved paths for this session. */
  paths: SessionPaths;
  /** Session identifier, advertised in every hello. */
  sessionId: string;
  /** Unified app version. */
  version: string;
  /** Shared journal. Defaults to a fresh one (a brand-new session). */
  journal?: PushJournal;
  /** Shared settlement store. Defaults to a fresh one. */
  responses?: ResponseStore;
  /** Invoke dispatcher, forwarded to each connection's {@link RpcServer}. */
  dispatch?: RpcServerOptions["dispatch"];
  /** Unattached-connection deadline. Defaults to {@link ATTACH_DEADLINE_MS}. */
  attachDeadlineMs?: number;
  /** Called when the last client goes away, for the idle policy. */
  onNoClients?: () => void;
  /** Called when a client attaches, for the idle policy. */
  onClientAttached?: () => void;
  /** Runs before a `pdv.rpc.sessionReset` invoke acks. */
  onSessionReset?: () => void | Promise<void>;
  /**
   * Receives a `pdv.rpc.confirmResponse` payload — the shell's answer to a
   * native confirm. Without it a parked confirm would never resolve and the
   * handler awaiting it would hang for the life of the session.
   */
  onConfirmResponse?: (payload: unknown) => void;
}

/** One live connection and the state the host tracks for it. */
interface HostConnection {
  socket: net.Socket;
  server: RpcServer;
  attached: boolean;
  deadline: NodeJS.Timeout | null;
}

/**
 * The session daemon (see the file header).
 *
 * Lifecycle: construct, {@link listen}, and later {@link close}. The socket
 * is unlinked on close so a subsequent spawn is not blocked by a leftover
 * file.
 */
export class SessionHost {
  /** The session's push journal — survives every connection. */
  readonly journal: PushJournal;
  /** The session's retained settlements — likewise. */
  readonly responses: ResponseStore;

  private readonly opts: SessionHostOptions;
  private readonly server: net.Server;
  private readonly connections = new Set<HostConnection>();
  /** The connection currently serving the client, if any. */
  private active: HostConnection | null = null;
  /**
   * Requests being dispatched anywhere in this session.
   *
   * Tracked here rather than per connection because the connection that
   * dispatched a request is routinely gone before the handler finishes —
   * that is the entire premise of the daemon. Asking only the current
   * connection would report running work as unknown, and the client would
   * be told a script it is waiting on may never have happened.
   */
  private readonly sessionInFlight = new Set<string>();
  private closed = false;

  /**
   * @param opts - Paths, identity, and optional shared session state.
   */
  constructor(opts: SessionHostOptions) {
    this.opts = opts;
    this.journal = opts.journal ?? new PushJournal();
    this.responses = opts.responses ?? new ResponseStore();
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  /**
   * Bind the session socket and begin accepting attaches.
   *
   * @returns Resolves once the socket is listening.
   * @throws Error if the socket cannot be bound — including `EADDRINUSE`,
   *   which means another daemon holds this session and the caller lost the
   *   spawn race.
   */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.paths.sockPath, () => {
        this.server.removeListener("error", reject);
        // The socket carries the whole session; nobody else may connect.
        fs.chmodSync(this.opts.paths.sockPath, 0o600);
        resolve();
      });
    });
  }

  /**
   * Number of live connections (diagnostics and tests).
   *
   * @returns The connection count.
   */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * The session's `PushSender` — this is what session-scoped managers get,
   * rather than any one connection's.
   *
   * With a client attached the push goes out through that connection, which
   * journals and writes it. With nobody attached it is journalled anyway:
   * the kernel is still running and its output is still session state, and
   * it must reach whoever reattaches. Dropping it because the socket is
   * currently empty would lose exactly the work done while the laptop was
   * shut — the case this daemon exists for.
   *
   * Bound, so it can be passed around bare.
   */
  readonly push: PushSender = (channel, payload) => {
    if (this.active) {
      this.active.server.push(channel, payload);
      return;
    }
    this.journal.append(channel, payload);
  };

  /**
   * Stop accepting, drop every connection, and remove the socket.
   *
   * @returns Resolves once the listener is closed.
   */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const conn of [...this.connections]) this.dropConnection(conn);
    return new Promise((resolve) => {
      this.server.close(() => {
        try {
          fs.unlinkSync(this.opts.paths.sockPath);
        } catch {
          // Already gone — closed twice, or cleaned by a supervisor.
        }
        resolve();
      });
    });
  }

  /** Accept one connection and serve it, gated until it attaches. */
  private onConnection(socket: net.Socket): void {
    const server = new RpcServer(socket, socket, {
      version: this.opts.version,
      session: this.opts.sessionId,
      journal: this.journal,
      responses: this.responses,
      dispatch: this.opts.dispatch,
      onSessionReset: this.opts.onSessionReset,
      onConfirmResponse: this.opts.onConfirmResponse,
      onAttach: (request) => this.onAttach(conn, request),
      onDispatch: (id) => this.sessionInFlight.add(id),
      onSettle: (id, frame) => {
        this.sessionInFlight.delete(id);
        this.deliverSettlement(conn, frame);
      },
    });

    const conn: HostConnection = {
      socket,
      server,
      attached: false,
      deadline: null,
    };
    this.connections.add(conn);

    // Withhold pushes until the client says where its cursor is.
    server.setPushGate(true);
    conn.deadline = setTimeout(() => {
      if (!conn.attached) {
        console.error("[session-host] connection never attached; dropping");
        this.dropConnection(conn);
      }
    }, this.opts.attachDeadlineMs ?? ATTACH_DEADLINE_MS);
    // An unattached connection must not keep the process alive on its own.
    conn.deadline.unref?.();

    socket.on("close", () => this.forgetConnection(conn));
    socket.on("error", () => this.forgetConnection(conn));
    server.start();
  }

  /**
   * Make sure a settlement reaches a live client.
   *
   * A handler dispatched on one connection can finish long after that
   * connection died — that is the point of the daemon. Its own writer wrote
   * the frame into a closed socket, so if the session has since moved to a
   * different connection, the frame is written there instead. Without this
   * the caller waits forever on work that has already completed.
   *
   * @param from - The connection the handler was dispatched on.
   * @param frame - The encoded settlement.
   */
  private deliverSettlement(from: HostConnection, frame: Buffer): void {
    const active = this.active;
    if (!active || active === from) return;
    active.server.writeFrames([frame]);
  }

  /** Serve one attach request, superseding whoever held the session. */
  private onAttach(
    conn: HostConnection,
    request: RpcAttachRequest,
  ): ReturnType<typeof planAttach> {
    const plan = planAttach({
      request,
      journal: this.journal,
      reconcile: (id) => {
        if (this.sessionInFlight.has(id)) return "in-flight";
        return this.responses.get(id) ? "completed" : "unknown";
      },
    });

    if (plan.outcome === "rejected") return plan;

    conn.attached = true;
    if (conn.deadline) {
      clearTimeout(conn.deadline);
      conn.deadline = null;
    }

    const previous = this.active;
    this.active = conn;
    if (previous && previous !== conn) this.supersede(previous);

    // Hand back settlements that completed while this client was away. The
    // verdicts alone are not enough: "completed" is only useful with the
    // result attached.
    const retained: Buffer[] = [];
    for (const [id, verdict] of Object.entries(plan.result.pending)) {
      if (verdict !== "completed") continue;
      const entry = this.responses.get(id);
      if (entry) retained.push(entry.frame);
    }
    if (retained.length > 0) {
      setImmediate(() => conn.server.writeFrames(retained));
    }
    // Cancels any idle countdown: somebody is watching again.
    this.opts.onClientAttached?.();

    return plan;
  }

  /**
   * Tell an older connection it has been replaced, then close it.
   *
   * `bySameClientId` is what stops a reconnect war: when a *different*
   * client took over, the displaced shell must not automatically reconnect,
   * or two laptops ping-pong the session between them forever.
   */
  private supersede(conn: HostConnection): void {
    try {
      conn.server.writeUnsequenced(RPC_CHANNELS.superseded, {
        bySameClientId: false,
      });
    } catch {
      // The connection is already gone; nothing to announce.
    }
    // Give the notice a moment to reach the wire before dropping the socket,
    // so the displaced client can explain itself rather than reporting a
    // bare disconnect.
    const timer = setTimeout(() => this.dropConnection(conn), SUPERSEDE_FLUSH_MS);
    timer.unref?.();
  }

  /** Close a connection and stop tracking it. */
  private dropConnection(conn: HostConnection): void {
    this.forgetConnection(conn);
    conn.socket.destroy();
  }

  /** Stop tracking a connection that is closing or already closed. */
  private forgetConnection(conn: HostConnection): void {
    if (!this.connections.delete(conn)) return;
    if (conn.deadline) clearTimeout(conn.deadline);
    conn.server.close();
    if (this.active === conn) this.active = null;
    if (this.connections.size === 0 && !this.closed) {
      // The session stays alive with no clients — that is the entire point
      // of a daemon. The idle policy decides how long.
      this.opts.onNoClients?.();
    }
  }
}
