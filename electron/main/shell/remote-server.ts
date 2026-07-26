/**
 * remote-server.ts — a {@link ServerHandle} whose server lives on a cluster.
 *
 * The transport underneath is unchanged: an SSH channel running
 * `pdv-server attach --session <id> --stdio` is a stream pair, and
 * {@link RpcClient} already takes one. What differs is *lifetime*. A local
 * server dies with its child process, so a dropped connection means the work
 * is gone. A remote session outlives its channel, so a dropped connection
 * means only that we have lost sight of work that is still happening.
 *
 * That single difference is why this is a separate implementation rather
 * than the local supervisor with a swapped-in stream:
 *
 *  - **`RpcClient` is disposable here; the pending map is not.** The client
 *    self-closes when its readable ends and cannot survive that, so this
 *    handle keeps the pending invokes one level above and creates a fresh
 *    client per attach. Local mode keeps one client for the process
 *    lifetime, which is why that behaviour must not change there.
 *  - **A crash is a reconnect, not a Restart dialog.**
 *  - **Shutdown means "stop the daemon", while disconnect means "stop
 *    watching it"** — two different user intents that a local server cannot
 *    distinguish because it has only one.
 *
 * Reconnection deliberately never loops an interactive auth prompt: a
 * retry uses `BatchMode=yes` so it either works from the existing master or
 * fails immediately, and re-authentication is surfaced to the user instead
 * of triggering a Duo push they did not ask for.
 *
 * This module does NOT establish the SSH master (`remote/remote-connection.ts`
 * does) or decide what the renderer shows.
 */

import type { Readable, Writable } from "stream";

import { isIdempotentChannel } from "../ipc";
import { RPC_CHANNELS, RPC_PROTOCOL_VERSION } from "../transport/protocol";
import type {
  RpcAttachRequest,
  RpcAttachResult,
  RpcConfirmRequest,
  RpcConfirmResponse,
} from "../transport/protocol";
import { RpcClient } from "../transport/rpc-client";
import type { BridgeHandlers, ServerHandle, ServerKind } from "./server-supervisor";

/** How long a parked invoke waits for a reconnect before it is failed. */
export const PARKED_INVOKE_TTL_MS = 60_000;

/** Backoff schedule between reconnect attempts. */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10_000];

/**
 * Raised when a mutation's fate cannot be established after a reconnect.
 *
 * Distinguishable on purpose: the renderer must be able to say "the result
 * of this operation is unknown — check the Tree" rather than reporting a
 * plain failure, because the operation may well have succeeded.
 */
export class RpcRequestLostError extends Error {
  /** The channel whose outcome is unknown. */
  readonly channel: string;

  /**
   * @param channel - The channel that was in flight.
   */
  constructor(channel: string) {
    super(
      `The result of "${channel}" is unknown: the connection dropped while ` +
        "it was running and the session could not account for it. " +
        "Check the Tree before retrying.",
    );
    this.name = "RpcRequestLostError";
    this.channel = channel;
  }
}

/** A stream pair plus a way to tear it down. */
export interface RemoteChannel {
  readable: Readable;
  writable: Writable;
  /** Close the underlying channel. */
  dispose: () => void;
}

/** Options accepted by {@link RemoteServerHandle}. */
export interface RemoteServerHandleOptions {
  /** Session id to attach to. */
  sessionId: string;
  /**
   * Opens a channel to the session. Called once per attach, so a reconnect
   * gets a brand-new ssh channel rather than reusing a dead one.
   */
  openChannel: (opts: { batchMode: boolean }) => Promise<RemoteChannel>;
  /** Reports connection state for the reconnect UX. */
  onState?: (state: RemoteSessionState) => void;
  /** Called after a reattach that replayed cleanly. */
  onReattached?: () => void;
  /** Called after a reattach the session declared stale (full resync). */
  onStale?: (reason: string) => void;
  /** Parked-invoke TTL. Defaults to {@link PARKED_INVOKE_TTL_MS}. */
  parkedTtlMs?: number;
  /** Backoff schedule. Defaults to {@link RECONNECT_DELAYS_MS}. */
  reconnectDelaysMs?: readonly number[];
  /** Injected clock for tests; monotonic in production. */
  now?: () => number;
}

/** Where a remote session's connection stands. */
export type RemoteSessionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "auth-required"
  | "disconnected";

/** One invoke this handle owns, independent of any connection. */
interface OwnedInvoke {
  channel: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Monotonic timestamp when it was dispatched. */
  at: number;
  /** The per-connection id it currently carries, if dispatched. */
  wireId: string | null;
}

/**
 * A remote session's {@link ServerHandle} (see the file header).
 */
export class RemoteServerHandle implements ServerHandle {
  readonly kind: ServerKind = "remote";

  private readonly opts: RemoteServerHandleOptions;
  private readonly now: () => number;
  /** Invokes this handle owns; survives every RpcClient underneath it. */
  private readonly owned = new Map<number, OwnedInvoke>();
  private nextOwnedId = 0;

  private client: RpcClient | null = null;
  private channel: RemoteChannel | null = null;
  private bridge: BridgeHandlers | null = null;
  private lastSeq = -1;
  private sessionEpoch: string | null = null;
  private state: RemoteSessionState = "disconnected";
  private stopped = false;
  private reconnecting = false;

  /**
   * @param opts - Session id, channel factory, and reconnect tuning.
   */
  constructor(opts: RemoteServerHandleOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  }

  /**
   * Connection state, for the status bar and reconnect UX.
   *
   * @returns The current state.
   */
  get connectionState(): RemoteSessionState {
    return this.state;
  }

  /**
   * Open the channel and attach to the session.
   *
   * @returns Resolves once attached.
   * @throws Error if the channel cannot be opened or the attach is refused.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.setState("connecting");
    await this.connect({ batchMode: false });
  }

  /**
   * Stop watching the session without ending it.
   *
   * The daemon keeps running with its kernel; this is "close the laptop",
   * not "throw away the work".
   *
   * @returns Resolves once the channel is closed.
   */
  async disconnect(): Promise<void> {
    this.stopped = true;
    this.failOwned(new Error("Disconnected from the remote session."));
    this.teardownChannel();
    this.setState("disconnected");
  }

  /**
   * End the session itself: shut the daemon down, then close the channel.
   *
   * @returns Resolves once the daemon has acknowledged.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    try {
      await this.client?.invoke(RPC_CHANNELS.shutdown);
    } catch {
      // The daemon may exit before acking; that is a successful shutdown.
    }
    this.failOwned(new Error("The remote session was shut down."));
    this.teardownChannel();
    this.setState("disconnected");
  }

  /**
   * Invoke a channel on the remote session.
   *
   * @param channel - Channel name.
   * @param args - Arguments.
   * @returns The handler's result.
   * @throws Error from the handler, or {@link RpcRequestLostError} when a
   *   reconnect could not establish what happened to a mutation.
   */
  invoke(channel: string, args: unknown[] = []): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(new Error("The remote session is not connected."));
    }
    const ownedId = ++this.nextOwnedId;
    return new Promise<unknown>((resolve, reject) => {
      const entry: OwnedInvoke = {
        channel,
        args,
        resolve,
        reject,
        at: this.now(),
        wireId: null,
      };
      this.owned.set(ownedId, entry);
      this.dispatch(ownedId, entry);
    });
  }

  /**
   * Full session reset.
   *
   * @returns Resolves when the session has reset.
   */
  async sessionReset(): Promise<void> {
    await this.invoke(RPC_CHANNELS.sessionReset);
  }

  /**
   * Attach the window's bridge handlers.
   *
   * @param handlers - Push, confirm and child-window callbacks.
   * @returns Nothing.
   */
  setBridgeHandlers(handlers: BridgeHandlers): void {
    this.bridge = handlers;
  }

  /**
   * Detach the bridge handlers; traffic is dropped until new ones arrive.
   *
   * @returns Nothing.
   */
  clearBridgeHandlers(): void {
    this.bridge = null;
  }

  /** Send one owned invoke over the current connection, if there is one. */
  private dispatch(ownedId: number, entry: OwnedInvoke): void {
    const client = this.client;
    if (!client) return; // Stays owned; dispatched after the next attach.
    const { id, promise } = client.invokeTracked(entry.channel, entry.args);
    entry.wireId = id;
    promise.then(
      (result) => {
        if (this.owned.delete(ownedId)) entry.resolve(result);
      },
      (err: Error) => {
        // A connection death does not settle an owned invoke: the work may
        // still be running on the daemon, and the reattach reconciliation
        // decides its fate.
        if (this.reconnecting || this.stopped === false) {
          if (this.client === client) {
            if (this.owned.delete(ownedId)) entry.reject(err);
          }
          return;
        }
        if (this.owned.delete(ownedId)) entry.reject(err);
      },
    );
  }

  /** Open a channel, attach, and wire the client up. */
  private async connect(opts: { batchMode: boolean }): Promise<void> {
    const channel = await this.opts.openChannel(opts);
    const client = new RpcClient(channel.readable, channel.writable, {
      onPush: (event, payload, seq) => {
        this.lastSeq = seq;
        this.bridge?.onPush(event, payload);
      },
      onReservedPush: (event, payload) => this.onReservedPush(event, payload),
      pendingPolicy: "park",
      initialLastSeq: this.lastSeq,
      onSequenceGap: (expected, received) => {
        console.error(
          `[remote] push gap: expected seq ${expected}, received ${received}; ` +
            "forcing a resync",
        );
        this.opts.onStale?.("sequence-gap");
      },
      onClose: () => this.onConnectionLost(),
    });

    this.channel = channel;
    this.client = client;
    // A stream that is *destroyed* emits "close" without "end" or "error",
    // which is exactly how an ssh channel dies when the network drops. The
    // client only self-closes on end/error, so without this the handle would
    // not notice until the ping timeout — a minute of a session that looks
    // alive and answers nothing.
    channel.readable.once("close", () => {
      client.close("remote channel closed");
      this.onConnectionLost();
    });
    await client.waitForHello(30_000);

    const request: RpcAttachRequest = {
      sessionEpoch: this.sessionEpoch,
      lastSeq: this.lastSeq,
      pendingRequests: [...this.owned.values()]
        .map((e) => e.wireId)
        .filter((id): id is string => id !== null),
      protocol: RPC_PROTOCOL_VERSION,
    };
    const result = (await client.invoke(RPC_CHANNELS.attach, [
      request,
    ])) as RpcAttachResult;

    this.sessionEpoch = result.sessionEpoch;
    this.lastSeq = Math.max(this.lastSeq, result.lastSeq);
    this.reconcile(result);
    this.setState("connected");
    client.startPing();

    if (result.status === "stale") {
      this.opts.onStale?.(result.reason);
    } else {
      this.opts.onReattached?.();
    }
  }

  /** Settle or re-dispatch owned invokes according to the attach verdict. */
  private reconcile(result: RpcAttachResult): void {
    const client = this.client;
    for (const [ownedId, entry] of [...this.owned]) {
      const verdict = entry.wireId ? result.pending[entry.wireId] : undefined;
      if (client && entry.wireId && (verdict === "in-flight" || verdict === "completed")) {
        // The settlement carries the id from the connection that dispatched
        // it, so this connection must adopt that id or discard the response
        // as late traffic for nobody — and the caller would wait forever on
        // work that is running, or has already finished.
        client.adopt(entry.wireId).then(
          (value) => {
            if (this.owned.delete(ownedId)) entry.resolve(value);
          },
          (err: Error) => {
            if (this.owned.delete(ownedId)) entry.reject(err);
          },
        );
        continue;
      }
      // Unknown, or never dispatched. A read may be re-issued safely; a
      // mutation may not — running the same script twice against one kernel
      // would write to the Tree twice.
      if (isIdempotentChannel(entry.channel) || entry.wireId === null) {
        entry.wireId = null;
        this.dispatch(ownedId, entry);
        continue;
      }
      this.owned.delete(ownedId);
      entry.reject(new RpcRequestLostError(entry.channel));
    }
  }

  /** Reserved pushes the bridge must act on. */
  private onReservedPush(event: string, payload: unknown): void {
    if (event === RPC_CHANNELS.confirmRequest) {
      void this.answerConfirm(payload as RpcConfirmRequest);
      return;
    }
    if (event === RPC_CHANNELS.closeChildWindows) {
      this.bridge?.closeChildWindows();
      return;
    }
    if (event === RPC_CHANNELS.superseded) {
      // Another client took over. Reconnecting against a *different* client
      // would ping-pong the session between two machines forever, so only a
      // takeover by ourselves is worth recovering from.
      const bySelf = (payload as { bySameClientId?: boolean })?.bySameClientId;
      this.stopped = !bySelf;
      if (!bySelf) {
        this.failOwned(
          new Error("Another PDV window took over this remote session."),
        );
        this.setState("disconnected");
      }
    }
  }

  /**
   * Show a native confirm and send the answer back.
   *
   * A confirm that is never answered blocks the handler awaiting it for the
   * life of the session, so every path here produces a reply — including
   * "no window to ask", which answers with the dialog's own cancel choice.
   */
  private async answerConfirm(request: RpcConfirmRequest): Promise<void> {
    let response = request.options.cancelId ?? 0;
    if (this.bridge) {
      try {
        response = await this.bridge.confirm(request.options);
      } catch (err) {
        console.error("[remote] confirm dialog failed:", err);
      }
    }
    const reply: RpcConfirmResponse = { requestId: request.requestId, response };
    try {
      await this.client?.invoke(RPC_CHANNELS.confirmResponse, [reply]);
    } catch (err) {
      console.error("[remote] confirmResponse delivery failed:", err);
    }
  }

  /** The channel died; decide whether to chase it. */
  private onConnectionLost(): void {
    if (this.stopped || this.reconnecting) return;
    this.setState("reconnecting");
    void this.reconnectLoop();
  }

  /** Retry with backoff, never looping an interactive auth prompt. */
  private async reconnectLoop(): Promise<void> {
    this.reconnecting = true;
    const delays = this.opts.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;

    for (const wait of delays) {
      if (this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.stopped) break;
      this.teardownChannel();
      try {
        // BatchMode: succeed from the existing master or fail at once. A
        // silent Duo push the user never asked for is worse than an error.
        await this.connect({ batchMode: true });
        this.reconnecting = false;
        return;
      } catch (err) {
        console.error(`[remote] reconnect failed: ${(err as Error).message}`);
      }
    }

    this.reconnecting = false;
    if (this.stopped) return;
    // Out of attempts: settle everything loudly rather than leaving the
    // renderer spinning on promises that will never resolve.
    this.setState("auth-required");
    this.expireOwned();
  }

  /** Fail owned invokes past their TTL; a mutation reports as lost. */
  private expireOwned(): void {
    const ttl = this.opts.parkedTtlMs ?? PARKED_INVOKE_TTL_MS;
    const cutoff = this.now() - ttl;
    for (const [ownedId, entry] of [...this.owned]) {
      if (entry.at > cutoff) continue;
      this.owned.delete(ownedId);
      entry.reject(
        isIdempotentChannel(entry.channel)
          ? new Error(`"${entry.channel}" failed: the remote session is unreachable.`)
          : new RpcRequestLostError(entry.channel),
      );
    }
  }

  /** Settle every owned invoke with one error. */
  private failOwned(err: Error): void {
    for (const [, entry] of [...this.owned]) entry.reject(err);
    this.owned.clear();
  }

  /** Drop the current client and channel. */
  private teardownChannel(): void {
    this.client?.close("remote channel closed");
    this.client = null;
    this.channel?.dispose();
    this.channel = null;
  }

  /** Report a state change once. */
  private setState(state: RemoteSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state);
  }
}
