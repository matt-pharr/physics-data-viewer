/**
 * rpc-server.ts — Server-side endpoint of the pdv-server RPC transport.
 *
 * Serves the invoke registry (`server/invoke-registry.ts`) over one
 * connection's streams: decodes {@link RpcRequest} lines, dispatches each
 * on its own microtask (parity with `ipcMain.handle` — a slow
 * `kernels.start` must never block a `config.get`), and writes the
 * settlement back. Provides the connection's `PushSender`, stamping every
 * push with a per-connection monotonic seq (the future reconnect/replay
 * handshake is additive on top).
 *
 * Reserved channels handled here rather than in the registry:
 *  - `pdv.rpc.ping` — answered inline with `{ts, seq}`.
 *  - `pdv.rpc.shutdown` — acked, then the injected `onShutdown` runs.
 *  - `pdv.rpc.sessionReset` — the injected `onSessionReset` runs, then acks.
 *  - `pdv.rpc.confirmResponse` — handed to the injected `onConfirmResponse`.
 *
 * Error contract: whatever the dispatcher throws (already logged and
 * normalized to an `Error` by `dispatchInvoke`) is serialized as
 * `{message, name, stack}` so the client rebuilds an identical Error.
 *
 * This module does NOT import Electron, construct managers (server-main
 * does), or write to stdout except through its writer (server-main rebinds
 * `console.*` to stderr before anything else runs).
 */

import type { Readable, Writable } from "stream";
import {
  dispatchInvoke,
  type InvokeContext,
  type PushSender,
} from "../server/invoke-registry";
import {
  LineDecoder,
  LineWriter,
  attachDecoder,
  MAX_LINE_BYTES,
} from "./line-codec";
import type { AttachPlan } from "./attach";
import { PushJournal } from "./push-journal";
import { ResponseStore } from "./response-store";
import {
  RPC_CHANNELS,
  RPC_PROTOCOL_MIN,
  RPC_PROTOCOL_VERSION,
  UNSEQUENCED_SEQ,
  isRpcRequest,
  isUnsequencedChannel,
  type RpcAttachRequest,
  type RpcError,
  type RpcHello,
  type RpcPingResult,
  type RpcPush,
  type RpcRequest,
  type RpcResponse,
  type UnsequencedChannel,
} from "./protocol";

/** Options accepted by {@link RpcServer}. */
export interface RpcServerOptions {
  /** Unified app version advertised in the hello push. */
  version: string;
  /**
   * Invoke dispatcher. Defaults to the registry's `dispatchInvoke`; tests
   * inject their own.
   */
  dispatch?: (
    channel: string,
    ctx: InvokeContext,
    args: unknown[]
  ) => Promise<unknown>;
  /** Runs after a `pdv.rpc.shutdown` invoke has been acked. */
  onShutdown?: () => void | Promise<void>;
  /** Runs (and is awaited) before a `pdv.rpc.sessionReset` invoke acks. */
  onSessionReset?: () => void | Promise<void>;
  /**
   * Receives the first argument of a `pdv.rpc.confirmResponse` invoke —
   * the shell's answer to a `confirmRequest` push (see
   * `server/shell-confirm.ts`).
   */
  onConfirmResponse?: (payload: unknown) => void;
  /** Override the decoder's max-line guard (tests). */
  maxLineBytes?: number;
  /**
   * The session's push journal. Defaults to a fresh one, which is correct
   * for local mode: one connection for the process lifetime, so "the
   * session" and "this connection" are the same thing. A session daemon
   * serving successive attaches passes its own, which is what lets seq
   * survive a reconnect.
   */
  journal?: PushJournal;
  /**
   * The session's retained-settlement store. Like the journal, it belongs to
   * the session rather than the connection — that is what lets a result
   * produced during a disconnect reach the client that reattaches.
   */
  responses?: ResponseStore;
  /** Session id advertised in the hello push; `null` for local mode. */
  session?: string | null;
  /**
   * Serves the `pdv.rpc.attach` invoke. Present only on a session daemon;
   * a local server has no sessions to (re)join and rejects the channel.
   */
  onAttach?: (request: RpcAttachRequest) => AttachPlan;
  /**
   * Called with every settlement frame after it is recorded. A session uses
   * this to re-route a late settlement to whichever connection is now
   * active — the one that dispatched it may be long gone.
   */
  onSettle?: (id: string, frame: Buffer) => void;
  /**
   * Called when a request begins dispatching. A session uses this to track
   * in-flight work at session scope: this connection may be gone by the
   * time the handler finishes, and its own record dies with it.
   */
  onDispatch?: (id: string) => void;
}

/** Serialize a rejection for the wire, preserving the visible message. */
function serializeError(err: unknown): RpcError {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}

/**
 * Server half of one RPC connection (see the file header).
 *
 * Lifecycle: construct over the connection's streams, then call
 * {@link RpcServer.start} to begin serving (its first act is the hello
 * push, unsequenced). {@link RpcServer.close} detaches from the streams.
 */
export class RpcServer {
  private readonly writer: LineWriter;
  private readonly readable: Readable;
  private readonly opts: RpcServerOptions;
  private detachDecoderFn: (() => void) | null = null;

  /**
   * The session's push journal: it assigns every seq and retains the frames
   * for replay. Exposed so a session daemon can drive the attach handshake.
   */
  readonly journal: PushJournal;

  /**
   * Recent settlements, retained so a result produced during a disconnect
   * can still be delivered. Exposed for the attach handshake's three-state
   * reconciliation.
   */
  readonly responses: ResponseStore;

  /**
   * Request ids currently being dispatched. A reattaching client asking
   * about an id needs three distinct answers — still running, already
   * settled (here is the result), or unknown — and two-state reconciliation
   * is silently wrong: it rejects work that in fact completed.
   */
  private readonly inFlight = new Set<string>();

  /**
   * The connection's `PushSender` — inject this as server handlers' `push`.
   * Bound, so it can be passed around bare.
   */
  readonly push: PushSender = (channel, payload) => {
    const { frame } = this.journal.append(channel, payload);
    // While gated the push is still journalled — it is session state and
    // happened — but not written. Anything produced during the gate reaches
    // the client through the attach replay instead, which is what keeps the
    // client's first post-attach frame contiguous with its cursor.
    if (!this.pushGated) this.writer.writeFrame(frame);
  };

  /** See {@link setPushGate}. Off by default, so local mode is unaffected. */
  private pushGated = false;

  /**
   * @param readable - Client → server stream (e.g. process stdin).
   * @param writable - Server → client stream (e.g. process stdout).
   * @param opts - Version, dispatcher, and lifecycle hooks.
   */
  constructor(readable: Readable, writable: Writable, opts: RpcServerOptions) {
    this.readable = readable;
    this.opts = opts;
    this.writer = new LineWriter(writable);
    this.journal = opts.journal ?? new PushJournal();
    this.responses = opts.responses ?? new ResponseStore();
  }

  /**
   * Classify a request id a reattaching client is still waiting on.
   *
   * @param id - The request id from the client's pending set.
   * @returns `"in-flight"` (keep waiting), `"completed"` (settlement
   *   available via {@link responses}), or `"unknown"` — never seen or aged
   *   out, which the client must surface rather than silently retry.
   */
  reconcile(id: string): "in-flight" | "completed" | "unknown" {
    if (this.inFlight.has(id)) return "in-flight";
    return this.responses.get(id) ? "completed" : "unknown";
  }

  /**
   * Hold or release the sequenced push stream for this connection.
   *
   * A session daemon gates a fresh connection until its attach completes:
   * between accept and attach the client has not yet said where its cursor
   * is, so any push written to it would arrive at an unpredictable seq and
   * read as a gap on the very first frame of a reconnect.
   *
   * @param gated - True to journal without writing; false to resume.
   * @returns Nothing.
   */
  setPushGate(gated: boolean): void {
    this.pushGated = gated;
  }

  /**
   * Write already-encoded frames straight to this connection, bypassing the
   * journal — they are replays of frames it has already assigned.
   *
   * @param frames - Frames from {@link PushJournal.framesSince}.
   * @returns Nothing.
   */
  writeFrames(frames: readonly Buffer[]): void {
    for (const frame of frames) this.writer.writeFrame(frame);
  }

  /**
   * Write a frame that is deliberately outside the sequenced stream.
   *
   * Restricted to {@link UNSEQUENCED_CHANNELS} by its parameter type *and*
   * by a runtime check, because this is the one way to put a push on the
   * wire without journalling it: an unsequenced frame is invisible to
   * replay, so a session-state push sent this way would be lost by any
   * client that reconnects.
   *
   * @param channel - One of the three unsequenced channels.
   * @param payload - Push payload.
   * @returns Nothing.
   * @throws Error if `channel` is not an unsequenced channel.
   */
  writeUnsequenced(channel: UnsequencedChannel, payload: unknown): void {
    if (!isUnsequencedChannel(channel)) {
      throw new Error(
        `[rpc-server] refusing to send "${channel}" unsequenced — ` +
          "only hello/attachError/superseded bypass the journal"
      );
    }
    const push: RpcPush = { event: channel, payload, seq: UNSEQUENCED_SEQ };
    this.writer.write(push);
  }

  /**
   * Begin serving: send the hello push (unsequenced, seq -1) and start decoding
   * requests from the readable stream.
   *
   * @returns Nothing.
   */
  start(): void {
    const hello: RpcHello = {
      version: this.opts.version,
      pid: process.pid,
      protocol: RPC_PROTOCOL_VERSION,
      protocolMin: RPC_PROTOCOL_MIN,
      session: this.opts.session ?? null,
      sessionEpoch: this.journal.sessionEpoch,
    };
    // Unsequenced: hello is per-connection, but seq now belongs to the
    // session. Letting it consume a seq would renumber the session's stream
    // on every reconnect — and a replay would hand the client somebody
    // else's hello in the middle of its history.
    this.writeUnsequenced(RPC_CHANNELS.hello, hello);
    const decoder = new LineDecoder({
      onMessage: (msg) => this.onMessage(msg),
      maxLineBytes: this.opts.maxLineBytes ?? MAX_LINE_BYTES,
      label: "rpc-server",
    });
    this.detachDecoderFn = attachDecoder(this.readable, decoder);
  }

  /**
   * Stop decoding requests (idempotent). Does not destroy the streams —
   * the process owner does that.
   *
   * @returns Nothing.
   */
  close(): void {
    this.detachDecoderFn?.();
    this.detachDecoderFn = null;
  }

  /**
   * Resolve once every message written so far is handed to the stream.
   * Used by the graceful-shutdown path so the shutdown ack reaches the
   * shell before the process exits.
   *
   * @returns Promise from the writer's flush.
   */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** Route one decoded wire message. */
  private onMessage(msg: unknown): void {
    if (!isRpcRequest(msg)) {
      console.error("[rpc-server] ignoring non-request message");
      return;
    }
    // Fire-and-forget: each request settles independently, so a slow
    // handler never serializes behind or ahead of a fast one.
    void this.handleRequest(msg);
  }

  /** Dispatch one request and write its settlement. */
  private async handleRequest(request: RpcRequest): Promise<void> {
    const { id, channel, args } = request;
    this.inFlight.add(id);
    this.opts.onDispatch?.(id);
    try {
      const result = await this.dispatchChannel(channel, args);
      const response: RpcResponse =
        result === undefined ? { id } : { id, result };
      this.settle(response);
    } catch (err) {
      this.settle({ id, error: serializeError(err) });
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Record a settlement, then write it.
   *
   * The order is the point. A result produced while the connection is down
   * is still a real result — the handler ran, the kernel executed, the Tree
   * changed — so it must exist somewhere the next connection can find it
   * before it is handed to a writer that may be gone.
   */
  private settle(response: RpcResponse): void {
    const entry = this.responses.record(response, this.journal.lastSeq);
    this.writer.writeFrame(entry.frame);
    // The session may need to deliver this elsewhere: if this connection
    // died while the handler ran, the frame above went to a dead socket and
    // the only live copy is the one just recorded.
    this.opts.onSettle?.(response.id, entry.frame);
  }

  /** Handle reserved channels inline; everything else goes to dispatch. */
  private async dispatchChannel(
    channel: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (channel) {
      case RPC_CHANNELS.ping: {
        const result: RpcPingResult = {
          ts: Date.now(),
          seq: this.journal.lastSeq,
        };
        return result;
      }
      case RPC_CHANNELS.shutdown: {
        // Ack first: setImmediate runs after the microtask that writes the
        // response, so the shell sees the ack even when the hook exits the
        // process (hooks should still `await flush()` before exiting).
        setImmediate(() => void this.opts.onShutdown?.());
        return undefined;
      }
      case RPC_CHANNELS.sessionReset: {
        await this.opts.onSessionReset?.();
        return undefined;
      }
      case RPC_CHANNELS.confirmResponse: {
        this.opts.onConfirmResponse?.(args[0]);
        return undefined;
      }
      case RPC_CHANNELS.attach: {
        const handle = this.opts.onAttach;
        if (!handle) throw new Error("this server does not serve sessions");
        const plan = handle(args[0] as RpcAttachRequest);
        if (plan.outcome === "rejected") {
          this.writeUnsequenced(RPC_CHANNELS.attachError, plan.error);
          throw new Error(plan.error.message);
        }
        // Replay after the response, never before: the client must know
        // whether it was accepted (and whether it must resync) before frames
        // start arriving, or it cannot tell replay from live traffic.
        setImmediate(() => {
          this.writeFrames(plan.replay);
          this.setPushGate(false);
        });
        return plan.result;
      }
      default: {
        const dispatch = this.opts.dispatch ?? dispatchInvoke;
        const ctx: InvokeContext = { push: this.push };
        return dispatch(channel, ctx, args);
      }
    }
  }
}
