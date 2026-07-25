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
import {
  RPC_CHANNELS,
  RPC_PROTOCOL_VERSION,
  isRpcRequest,
  type RpcError,
  type RpcHello,
  type RpcPingResult,
  type RpcPush,
  type RpcRequest,
  type RpcResponse,
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
 * push, seq 0). {@link RpcServer.close} detaches from the streams.
 */
export class RpcServer {
  private readonly writer: LineWriter;
  private readonly readable: Readable;
  private readonly opts: RpcServerOptions;
  private detachDecoderFn: (() => void) | null = null;
  /** Next push seq to stamp; hello consumes 0. */
  private nextSeq = 0;

  /**
   * The connection's `PushSender` — inject this as server handlers' `push`.
   * Bound, so it can be passed around bare.
   */
  readonly push: PushSender = (channel, payload) => {
    const push: RpcPush = { event: channel, payload, seq: this.nextSeq++ };
    this.writer.write(push);
  };

  /**
   * @param readable - Client → server stream (e.g. process stdin).
   * @param writable - Server → client stream (e.g. process stdout).
   * @param opts - Version, dispatcher, and lifecycle hooks.
   */
  constructor(readable: Readable, writable: Writable, opts: RpcServerOptions) {
    this.readable = readable;
    this.opts = opts;
    this.writer = new LineWriter(writable);
  }

  /**
   * Begin serving: send the hello push (seq 0) and start decoding
   * requests from the readable stream.
   *
   * @returns Nothing.
   */
  start(): void {
    const hello: RpcHello = {
      version: this.opts.version,
      pid: process.pid,
      protocol: RPC_PROTOCOL_VERSION,
      session: null,
    };
    this.push(RPC_CHANNELS.hello, hello);
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
    try {
      const result = await this.dispatchChannel(channel, args);
      const response: RpcResponse =
        result === undefined ? { id } : { id, result };
      this.writer.write(response);
    } catch (err) {
      this.writer.write({ id, error: serializeError(err) } as RpcResponse);
    }
  }

  /** Handle reserved channels inline; everything else goes to dispatch. */
  private async dispatchChannel(
    channel: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (channel) {
      case RPC_CHANNELS.ping: {
        const result: RpcPingResult = { ts: Date.now(), seq: this.nextSeq - 1 };
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
      default: {
        const dispatch = this.opts.dispatch ?? dispatchInvoke;
        const ctx: InvokeContext = { push: this.push };
        return dispatch(channel, ctx, args);
      }
    }
  }
}
