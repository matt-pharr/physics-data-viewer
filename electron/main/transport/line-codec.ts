/**
 * line-codec.ts — Newline-delimited JSON framing for the pdv-server RPC
 * transport.
 *
 * Wire format: one UTF-8 JSON document per line, `\n`-terminated. JSON
 * serialization never emits a raw newline, so the delimiter is unambiguous.
 *
 * Responsibilities:
 *  - {@link encodeMessage} — serialize one message to a framed Buffer.
 *  - {@link LineDecoder} — reassemble lines from arbitrary chunk boundaries,
 *    with a max-line guard (base64-encoded plots make long lines, but a
 *    line beyond {@link MAX_LINE_BYTES} means a corrupt or hostile peer)
 *    and log-and-skip handling of unparseable lines (a stray line must
 *    never crash the process; stdout pollution is the known hazard).
 *  - {@link LineWriter} — a single serialized write queue honoring stream
 *    backpressure (`write()` return value + `drain`), so a burst of large
 *    pushes cannot interleave partial frames or balloon memory unbounded.
 *
 * This module does NOT interpret envelopes (see `protocol.ts`) or own any
 * stream lifecycle — callers attach it to streams they manage.
 */

import type { Readable, Writable } from "stream";

/**
 * Maximum accepted line length (256 MB). Chosen far above any real payload
 * (multi-megapixel base64 plots are tens of MB) while still bounding memory
 * against a peer that never sends a newline.
 */
export const MAX_LINE_BYTES = 256 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * Serialize one message as a framed line.
 *
 * @param msg - Any JSON-serializable value.
 * @returns A Buffer holding the UTF-8 JSON document plus trailing `\n`.
 * @throws TypeError if `msg` cannot be JSON-serialized (circular refs).
 */
export function encodeMessage(msg: unknown): Buffer {
  return Buffer.from(JSON.stringify(msg) + "\n", "utf8");
}

/** Options accepted by {@link LineDecoder}. */
export interface LineDecoderOptions {
  /** Called once per successfully parsed line. */
  onMessage: (msg: unknown) => void;
  /** Override the max-line guard (tests use a small value). */
  maxLineBytes?: number;
  /** Label used in skip/oversize log lines (e.g. `"rpc-client"`). */
  label?: string;
}

/**
 * Incremental newline-delimited JSON decoder.
 *
 * Feed raw stream chunks to {@link LineDecoder.write}; `onMessage` fires
 * once per complete, parseable line. Buffering is a chunk list (not a
 * repeated `Buffer.concat`), so a giant line arriving in many chunks costs
 * O(total) rather than O(total × chunks).
 *
 * Failure handling — both cases log and continue, never throw:
 *  - A line that fails `JSON.parse` is skipped.
 *  - A line exceeding the max-line guard is discarded as it streams in
 *    (the decoder resynchronizes at the next newline).
 */
export class LineDecoder {
  private readonly onMessage: (msg: unknown) => void;
  private readonly maxLineBytes: number;
  private readonly label: string;
  /** Chunks of the current (incomplete) line, in arrival order. */
  private pending: Buffer[] = [];
  /** Total byte length across {@link pending}. */
  private pendingBytes = 0;
  /** True while discarding an oversized line up to its terminating newline. */
  private skippingOversized = false;

  /**
   * @param opts - Decoder options; see {@link LineDecoderOptions}.
   */
  constructor(opts: LineDecoderOptions) {
    this.onMessage = opts.onMessage;
    this.maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
    this.label = opts.label ?? "line-codec";
  }

  /**
   * Consume one raw chunk from the stream, emitting any completed lines.
   *
   * @param chunk - Bytes as received (any chunk boundary is fine).
   * @returns Nothing.
   */
  write(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(NEWLINE, start);
      if (nl === -1) {
        this.buffer(chunk.subarray(start));
        return;
      }
      this.buffer(chunk.subarray(start, nl));
      this.endLine();
      start = nl + 1;
    }
  }

  /** Append bytes to the current line, enforcing the max-line guard. */
  private buffer(bytes: Buffer): void {
    if (this.skippingOversized) return;
    if (bytes.length === 0) return;
    if (this.pendingBytes + bytes.length > this.maxLineBytes) {
      console.error(
        `[${this.label}] dropping oversized line (> ${this.maxLineBytes} bytes)`
      );
      this.pending = [];
      this.pendingBytes = 0;
      this.skippingOversized = true;
      return;
    }
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
  }

  /** A newline arrived: parse and emit the buffered line, then reset. */
  private endLine(): void {
    if (this.skippingOversized) {
      this.skippingOversized = false;
      return;
    }
    if (this.pendingBytes === 0) return;
    const line =
      this.pending.length === 1
        ? this.pending[0]
        : Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    let text = line.toString("utf8");
    // Tolerate a peer that terminates with \r\n.
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (text.length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      console.error(
        `[${this.label}] skipping unparseable line: ${
          text.length > 200 ? text.slice(0, 200) + "…" : text
        }`
      );
      return;
    }
    this.onMessage(msg);
  }
}

/**
 * Serialized, backpressure-honoring message writer.
 *
 * All transport writes for a connection funnel through one LineWriter, so
 * frames are emitted whole and in order. When the underlying stream's
 * buffer is full (`write()` returns false), queued messages wait for
 * `drain` instead of piling into the stream's internal buffer.
 *
 * A destroyed/errored stream makes the writer inert: further writes are
 * dropped (the connection owner learns of the failure from the stream's
 * own lifecycle events, not from the writer).
 */
export class LineWriter {
  private readonly stream: Writable;
  private readonly queue: Buffer[] = [];
  private pumping = false;
  private dead = false;
  /** Resolvers waiting on {@link flush}. */
  private flushWaiters: Array<() => void> = [];

  /**
   * @param stream - Destination stream (child stdin, socket, PassThrough).
   */
  constructor(stream: Writable) {
    this.stream = stream;
    // A write error (e.g. EPIPE after the peer died) must not throw out of
    // the pump; mark the writer dead and let the owner's stream handlers
    // deal with the connection.
    stream.on("error", () => {
      this.dead = true;
      this.queue.length = 0;
      this.settleFlushWaiters();
    });
    stream.on("close", () => {
      this.dead = true;
      this.queue.length = 0;
      this.settleFlushWaiters();
    });
  }

  /**
   * Enqueue one message for writing. Returns immediately; the internal
   * pump preserves order and honors backpressure.
   *
   * @param msg - Any JSON-serializable value.
   * @returns Nothing.
   */
  write(msg: unknown): void {
    if (this.dead || this.stream.destroyed) return;
    this.queue.push(encodeMessage(msg));
    void this.pump();
  }

  /**
   * Enqueue an already-encoded frame, bypassing serialization.
   *
   * Used for replay: the push journal encodes each frame once when it is
   * assigned its seq, so re-sending it to a reattaching client is a byte
   * copy. Re-serializing would also risk a *different* byte sequence for a
   * frame the client has partly seen.
   *
   * @param frame - A complete newline-terminated frame from `encodeMessage`.
   * @returns Nothing.
   */
  writeFrame(frame: Buffer): void {
    if (this.dead || this.stream.destroyed) return;
    this.queue.push(frame);
    void this.pump();
  }

  /**
   * Resolve once every message enqueued so far has been handed to the
   * stream (or the stream died). Used by tests and graceful shutdown.
   *
   * @returns Promise resolving when the queue is empty.
   */
  flush(): Promise<void> {
    if (this.queue.length === 0 && !this.pumping) return Promise.resolve();
    return new Promise((resolve) => this.flushWaiters.push(resolve));
  }

  /** Drain the queue into the stream, pausing on backpressure. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.dead && !this.stream.destroyed) {
        const buf = this.queue.shift() as Buffer;
        const ok = this.stream.write(buf);
        if (!ok) {
          await new Promise<void>((resolve) => {
            const onDrain = (): void => {
              cleanup();
              resolve();
            };
            const onDead = (): void => {
              cleanup();
              resolve();
            };
            const cleanup = (): void => {
              this.stream.off("drain", onDrain);
              this.stream.off("error", onDead);
              this.stream.off("close", onDead);
            };
            this.stream.once("drain", onDrain);
            this.stream.once("error", onDead);
            this.stream.once("close", onDead);
          });
        }
      }
    } finally {
      this.pumping = false;
      this.settleFlushWaiters();
    }
  }

  /** Wake everything awaiting {@link flush}. */
  private settleFlushWaiters(): void {
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * Attach a {@link LineDecoder} to a readable stream's `data` events.
 *
 * @param stream - Source stream (child stdout, socket, PassThrough).
 * @param decoder - Decoder to feed.
 * @returns A detach function removing the listener.
 */
export function attachDecoder(
  stream: Readable,
  decoder: LineDecoder
): () => void {
  const onData = (chunk: Buffer): void => decoder.write(chunk);
  stream.on("data", onData);
  return () => stream.off("data", onData);
}
