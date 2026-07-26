/**
 * rpc-client.ts — Shell-side client for the pdv-server RPC transport.
 *
 * Owns the client half of a single connection: invoke correlation
 * (monotonic ids → pending-promise map), push delivery with seq tracking,
 * the hello handshake wait, and the ping liveness loop. The shell's
 * server-bridge forwards `ipcMain.handle` invokes through
 * {@link RpcClient.invoke} and fans {@link RpcClientOptions.onPush} out to
 * windows; reserved `pdv.rpc.*` pushes go to the bridge's internal
 * handler and never reach the renderer.
 *
 * Error parity: a server-side rejection arrives as a serialized
 * `{message, name, stack}` and is rethrown here as an `Error` carrying the
 * same fields, so the existing ipcMain wrapper + preload strip produce the
 * exact renderer-visible message a direct handler would have.
 *
 * This module does NOT depend on Electron, spawn the server (the
 * supervisor does), or interpret application payloads.
 */

import { randomBytes } from "crypto";
import type { Readable, Writable } from "stream";
import {
  LineDecoder,
  LineWriter,
  attachDecoder,
  MAX_LINE_BYTES,
} from "./line-codec";
import {
  RPC_CHANNELS,
  isReservedRpcChannel,
  isRpcPush,
  isRpcResponse,
  type RpcError,
  type RpcHello,
  type RpcRequest,
} from "./protocol";

/** Default interval between liveness pings. */
export const PING_INTERVAL_MS = 15_000;
/** Consecutive unanswered pings before the server is declared unresponsive. */
export const PING_MAX_MISSES = 3;

/** Options accepted by {@link RpcClient}. */
export interface RpcClientOptions {
  /**
   * Called for every non-reserved push. The bridge forwards these to
   * renderer windows unchanged.
   */
  onPush: (event: string, payload: unknown, seq: number) => void;
  /**
   * Called for reserved `pdv.rpc.*` pushes other than hello (hello settles
   * {@link RpcClient.waitForHello} internally). Step-4 bridge work: the
   * confirm-request interceptor plugs in here.
   */
  onReservedPush?: (event: string, payload: unknown, seq: number) => void;
  /**
   * Called once when {@link PING_MAX_MISSES} consecutive pings go
   * unanswered. Pinging stops; the supervisor decides what to do.
   */
  onUnresponsive?: () => void;
  /**
   * Called once when the connection closes (stream end/error or explicit
   * {@link RpcClient.close}), after pending invokes were rejected.
   */
  onClose?: (reason: string) => void;
  /** Override the ping interval (tests). */
  pingIntervalMs?: number;
  /** Override the miss threshold (tests). */
  pingMaxMisses?: number;
  /** Override the decoder's max-line guard (tests). */
  maxLineBytes?: number;
  /**
   * What happens to invokes still in flight when the connection closes.
   *
   * `"reject"` (the default, and today's behaviour) settles them with the
   * close reason — correct for local mode, where the server dying means the
   * work died with it.
   *
   * `"park"` leaves them unsettled for a reattach to resolve. A remote
   * session outlives its connection, so a `script.run` that was running when
   * the channel dropped is still running on the daemon; rejecting it would
   * report completed work as failed. Whoever parks them owns settling them —
   * see {@link rejectParked}.
   */
  pendingPolicy?: "reject" | "park";
  /**
   * Seed the push cursor across a reconnect, so gap detection is meaningful
   * from the first frame rather than from −1.
   */
  initialLastSeq?: number;
  /**
   * Called when a push arrives with a seq that is not the expected next one.
   *
   * A live detector, not a diagnostic: the replay handshake is supposed to
   * make gaps impossible, so if one appears the invariant is already broken
   * and the client learns on the very next frame instead of quietly missing
   * state. Receiving this means resync, not retry.
   */
  onSequenceGap?: (expected: number, received: number) => void;
}

/** A not-yet-settled invoke. */
interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Rebuild an `Error` from its serialized wire form, preserving the
 * renderer-visible message plus name/stack for shell-side logging.
 */
function reviveError(wire: RpcError): Error {
  const err = new Error(wire.message);
  if (wire.name) err.name = wire.name;
  if (wire.stack) err.stack = wire.stack;
  return err;
}

/**
 * Client half of one RPC connection (see the file header).
 *
 * Lifecycle: construct over the connection's streams, `await
 * waitForHello()`, then `startPing()`. The client closes itself when the
 * readable ends or errors; {@link RpcClient.close} is idempotent.
 */
export class RpcClient {
  private readonly writer: LineWriter;
  private readonly detachDecoder: () => void;
  private readonly opts: RpcClientOptions;
  private readonly pending = new Map<string, PendingInvoke>();
  private nextId = 0;
  /**
   * Per-connection prefix for request ids.
   *
   * Ids are per-connection monotonic integers that restart at 1 on every
   * reconnect, so without a prefix a parked id from the previous connection
   * would collide with a fresh one and a reattach could settle the wrong
   * promise. Random rather than a timestamp: two attaches can land in the
   * same millisecond after a wake.
   */
  private readonly idEpoch: string = randomBytes(4).toString("hex");
  /**
   * Invokes held across a connection drop under `pendingPolicy: "park"`.
   * Settled by {@link settleParked} or {@link rejectParked} — never dropped.
   */
  private readonly parked = new Map<string, PendingInvoke>();
  /** Highest push seq received (−1 before any push). */
  private lastSeqReceived: number;
  private closed = false;

  private helloPayload: RpcHello | null = null;
  /**
   * Waiters parked in {@link waitForHello}. Both halves are kept so
   * {@link close} can reject them with the real reason — a server that dies
   * before saying hello must surface its exit, not stall until the timeout.
   */
  private helloWaiters: Array<{
    resolve: (hello: RpcHello) => void;
    reject: (err: Error) => void;
  }> = [];

  private pingTimer: NodeJS.Timeout | null = null;
  /** Pings sent but not yet answered. */
  private pingsInFlight = 0;
  private declaredUnresponsive = false;

  /**
   * @param readable - Server → client stream (e.g. child stdout).
   * @param writable - Client → server stream (e.g. child stdin).
   * @param opts - Callbacks and tuning; see {@link RpcClientOptions}.
   */
  constructor(readable: Readable, writable: Writable, opts: RpcClientOptions) {
    this.opts = opts;
    this.lastSeqReceived = opts.initialLastSeq ?? -1;
    this.writer = new LineWriter(writable);
    const decoder = new LineDecoder({
      onMessage: (msg) => this.onMessage(msg),
      maxLineBytes: opts.maxLineBytes ?? MAX_LINE_BYTES,
      label: "rpc-client",
    });
    this.detachDecoder = attachDecoder(readable, decoder);
    readable.once("end", () => this.close("server stream ended"));
    readable.once("error", (err: Error) =>
      this.close(`server stream error: ${err.message}`)
    );
  }

  /**
   * Invoke a channel on the server.
   *
   * @param channel - IPC channel name (`ipc.ts` constant or `pdv.rpc.*`).
   * @param args - Arguments as the renderer passed them.
   * @returns The handler's result.
   * @throws Error rebuilt from the server's serialized rejection, or
   *   `"RPC connection closed"`-style errors when the connection dies
   *   before the response arrives.
   */
  invoke(channel: string, args: unknown[] = []): Promise<unknown> {
    return this.invokeTracked(channel, args).promise;
  }

  /**
   * Invoke a channel and expose the request id it was sent under.
   *
   * A caller that must survive this connection needs the id: it is what the
   * attach handshake reconciles against, so an owner tracking work across
   * reconnects cannot use {@link invoke}, whose id is invisible.
   *
   * @param channel - IPC channel name.
   * @param args - Arguments.
   * @returns The wire id and the settling promise.
   */
  invokeTracked(
    channel: string,
    args: unknown[] = []
  ): { id: string; promise: Promise<unknown> } {
    if (this.closed) {
      return {
        id: "",
        promise: Promise.reject(new Error("RPC connection closed")),
      };
    }
    const id = `${this.idEpoch}-${++this.nextId}`;
    const request: RpcRequest = { id, channel, args };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writer.write(request);
    });
    return { id, promise };
  }

  /**
   * Resolve with the server's hello push (unsequenced). Resolves immediately if
   * the hello already arrived.
   *
   * @param timeoutMs - How long to wait before giving up.
   * @returns The {@link RpcHello} payload.
   * @throws Error on timeout or when the connection closes first.
   */
  waitForHello(timeoutMs = 10_000): Promise<RpcHello> {
    if (this.helloPayload) return Promise.resolve(this.helloPayload);
    if (this.closed) {
      return Promise.reject(new Error("RPC connection closed"));
    }
    return new Promise<RpcHello>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiters = this.helloWaiters.filter((w) => w !== waiter);
        reject(
          new Error(`pdv-server hello not received within ${timeoutMs} ms`)
        );
      }, timeoutMs);
      const waiter = {
        resolve: (hello: RpcHello): void => {
          clearTimeout(timer);
          resolve(hello);
        },
        reject: (err: Error): void => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.helloWaiters.push(waiter);
    });
  }

  /**
   * Start the liveness loop: one `pdv.rpc.ping` per interval. When
   * {@link RpcClientOptions.pingMaxMisses} consecutive pings are
   * outstanding at tick time, `onUnresponsive` fires once and pinging
   * stops. Any answered ping resets the miss count.
   *
   * @returns Nothing.
   */
  startPing(): void {
    if (this.pingTimer || this.closed) return;
    const interval = this.opts.pingIntervalMs ?? PING_INTERVAL_MS;
    const maxMisses = this.opts.pingMaxMisses ?? PING_MAX_MISSES;
    this.pingTimer = setInterval(() => {
      if (this.pingsInFlight >= maxMisses) {
        this.stopPing();
        if (!this.declaredUnresponsive) {
          this.declaredUnresponsive = true;
          this.opts.onUnresponsive?.();
        }
        return;
      }
      this.pingsInFlight += 1;
      this.invoke(RPC_CHANNELS.ping).then(
        () => {
          this.pingsInFlight = 0;
        },
        () => {
          // Rejection here means the connection died; close() handles it.
        }
      );
    }, interval);
  }

  /**
   * Stop the liveness loop (idempotent).
   *
   * @returns Nothing.
   */
  stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Highest push seq received so far (−1 before any push).
   *
   * Authoritative on the client, never on the server: the server's cursor
   * records what it handed a writer, not what crossed the network. That is
   * also what makes a half-written frame at disconnect safe — the client
   * never counted it, so the reattach replays it whole.
   *
   * @returns The last seq.
   */
  get lastSeq(): number {
    return this.lastSeqReceived;
  }

  /**
   * Adopt a new push cursor mid-connection.
   *
   * Exists for exactly one caller: a STALE attach against a restarted
   * session, whose new epoch restarts seq near zero. The cursor this client
   * was seeded with belongs to the old epoch; keeping it makes every
   * subsequent push read as a sequence gap — a full resync per push,
   * forever. The attach response is the authority on where the new epoch's
   * stream begins.
   *
   * @param seq - The new epoch's last seq, from the attach result.
   * @returns Nothing.
   */
  adoptCursor(seq: number): void {
    this.lastSeqReceived = seq;
  }

  /**
   * Request ids currently parked across a drop.
   *
   * @returns The parked ids, for the attach handshake's `pendingRequests`.
   */
  get parkedIds(): string[] {
    return [...this.parked.keys()];
  }

  /**
   * Wait for a response under an id this connection did not issue.
   *
   * A reattaching owner carries request ids from the previous connection;
   * their settlements arrive here, on the new one. Without adoption the
   * client would discard them as late responses to nothing, and the caller
   * would wait forever for work that has already finished.
   *
   * @param id - A request id from an earlier connection.
   * @returns A promise settling when that response arrives.
   */
  adopt(id: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("RPC connection closed"));
        return;
      }
      this.pending.set(id, { resolve, reject });
    });
  }

  /**
   * Settle a parked invoke with a result the session retained for it.
   *
   * @param id - The parked request id.
   * @param result - The retained result.
   * @returns True if an invoke was waiting under that id.
   */
  settleParked(id: string, result: unknown): boolean {
    const invoke = this.parked.get(id);
    if (!invoke) return false;
    this.parked.delete(id);
    invoke.resolve(result);
    return true;
  }

  /**
   * Fail a parked invoke whose fate the session could not account for.
   *
   * @param id - The parked request id.
   * @param err - Why it could not be resolved.
   * @returns True if an invoke was waiting under that id.
   */
  rejectParkedId(id: string, err: Error): boolean {
    const invoke = this.parked.get(id);
    if (!invoke) return false;
    this.parked.delete(id);
    invoke.reject(err);
    return true;
  }

  /**
   * Fail every parked invoke — a reconnect that will not be retried.
   *
   * Called when the owner gives up. Leaving them parked forever would hang
   * the renderer on a spinner with no error and no way back.
   *
   * @param err - Why the reconnect failed.
   * @returns How many invokes were settled.
   */
  rejectParked(err: Error): number {
    const count = this.parked.size;
    for (const { reject } of this.parked.values()) reject(err);
    this.parked.clear();
    return count;
  }

  /**
   * Tear the connection down: stop pinging, detach stream listeners, and
   * reject every pending invoke. Idempotent.
   *
   * @param reason - Human-readable close reason used in rejections.
   * @returns Nothing.
   */
  close(reason = "RPC connection closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPing();
    this.detachDecoder();
    const err = new Error(reason);
    if (this.opts.pendingPolicy === "park") {
      // Held, not settled: the work may still be running on a daemon that
      // outlived this connection, so rejecting would report completed work
      // as failed. They move to `parked`, where the owner either resolves
      // them from the reattach reconciliation or gives up via
      // rejectParked() — a promise that never settles at all is worse than
      // one that fails.
      for (const [id, invoke] of this.pending) this.parked.set(id, invoke);
      this.pending.clear();
    } else {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    }
    const helloWaiters = this.helloWaiters;
    this.helloWaiters = [];
    for (const { reject } of helloWaiters) reject(err);
    this.opts.onClose?.(reason);
  }

  /** Route one decoded wire message. */
  private onMessage(msg: unknown): void {
    if (isRpcPush(msg)) {
      // An unsequenced frame (hello/attachError/superseded) carries seq −1
      // and is not part of the session's stream. Recording it would rewind
      // the cursor to −1, and the next reattach would then ask to replay the
      // entire session from the start — or be told it cannot be, and force a
      // needless full resync.
      if (msg.seq >= 0) {
        const expected = this.lastSeqReceived + 1;
        if (msg.seq !== expected && this.lastSeqReceived >= 0) {
          // The replay handshake is meant to make this unreachable. Reaching
          // it means state has already been missed, so say so now rather
          // than let the renderer drift.
          this.opts.onSequenceGap?.(expected, msg.seq);
        }
        if (msg.seq > this.lastSeqReceived) this.lastSeqReceived = msg.seq;
      }
      if (msg.event === RPC_CHANNELS.hello) {
        const hello = msg.payload as RpcHello;
        this.helloPayload = hello;
        const waiters = this.helloWaiters;
        this.helloWaiters = [];
        for (const { resolve } of waiters) resolve(hello);
        return;
      }
      if (isReservedRpcChannel(msg.event)) {
        this.opts.onReservedPush?.(msg.event, msg.payload, msg.seq);
        return;
      }
      this.opts.onPush(msg.event, msg.payload, msg.seq);
      return;
    }
    if (isRpcResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        // Late response after close/teardown raced — nothing to settle.
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(reviveError(msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    console.error("[rpc-client] ignoring unrecognized message shape");
  }
}
