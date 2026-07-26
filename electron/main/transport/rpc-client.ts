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
  /** Highest push seq received (−1 before any push). */
  private lastSeqReceived = -1;
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
    if (this.closed) {
      return Promise.reject(new Error("RPC connection closed"));
    }
    const id = String(++this.nextId);
    const request: RpcRequest = { id, channel, args };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writer.write(request);
    });
  }

  /**
   * Resolve with the server's hello push (seq 0). Resolves immediately if
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
   * Highest push seq received so far (−1 before any push). Recorded for
   * the future reconnect/replay handshake.
   *
   * @returns The last seq.
   */
  get lastSeq(): number {
    return this.lastSeqReceived;
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
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
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
      if (msg.seq > this.lastSeqReceived) {
        this.lastSeqReceived = msg.seq;
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
