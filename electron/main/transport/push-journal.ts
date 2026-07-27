/**
 * push-journal.ts — session-owned push sequencing and the replay ring.
 *
 * Push seq belongs to the *session*, not to a connection. A remote session
 * outlives the SSH channel carrying it, so a client that drops and reattaches
 * must be able to say "I last saw seq N" and receive exactly what it missed.
 * That is only meaningful if the numbering survives the connection, which
 * makes this journal — not `RpcServer` — the thing that assigns seq.
 *
 * Responsibilities:
 *  - Assign each push its seq and encode it once ({@link PushJournal.append}).
 *  - Retain recent frames in a bounded ring and hand back the ones a
 *    reattaching client missed ({@link PushJournal.framesSince}).
 *  - Report honestly when the answer is "I can no longer tell you" — a gap
 *    is returned as `null`, never as an empty replay.
 *
 * Two design points that are easy to get wrong, and that failing at looks
 * exactly like success:
 *
 *  - **One ring for the session, with a cursor per client** — not a buffer
 *    per client. Frames are encoded once at append and replay is a byte
 *    copy, so a second client costs a cursor rather than a copy of history.
 *  - **Overflow degrades loudly.** A cursor that has fallen off the back of
 *    the ring gets `null` (the caller must force a full resync); it is never
 *    quietly advanced to the oldest retained frame, which would leave the
 *    client believing it had seen pushes that were dropped.
 *
 * This module does NOT do I/O, own connections, or know what a push means —
 * it is pure bookkeeping over encoded frames, which is what makes the
 * sequencing rules testable without a socket.
 */

import { randomUUID } from "crypto";

import { encodeMessage } from "./line-codec";
import type { RpcPush } from "./protocol";

/**
 * Default retention. Sized to cover a realistic disconnect (a lid-close over
 * lunch during a chatty execution) without letting an idle session grow
 * without bound; whichever bound is hit first wins.
 */
export const DEFAULT_MAX_MESSAGES = 5000;

/** Default retention ceiling in bytes (32 MB). */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Options accepted by {@link PushJournal}. */
export interface PushJournalOptions {
  /** Retained-frame count ceiling. Defaults to {@link DEFAULT_MAX_MESSAGES}. */
  maxMessages?: number;
  /** Retained-frame byte ceiling. Defaults to {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /**
   * Session epoch to advertise. Injected only by tests, which need a stable
   * value to assert against; production always takes the random default.
   */
  sessionEpoch?: string;
}

/** One journalled push: its seq and the wire frame already encoded. */
export interface RetainedPush {
  /** Sequence number assigned at append time. */
  seq: number;
  /** The complete newline-terminated wire frame. */
  frame: Buffer;
}

/**
 * The session's push journal (see the file header).
 *
 * One instance per session. `RpcServer` appends through it and writes the
 * returned frame; the attach handshake reads {@link framesSince} to replay.
 */
export class PushJournal {
  /** Identifies this incarnation of the session; see {@link RpcHello.sessionEpoch}. */
  readonly sessionEpoch: string;

  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly ring: RetainedPush[] = [];
  private retainedBytesCount = 0;
  private nextSeq = 0;

  /**
   * @param opts - Retention bounds and (tests only) a fixed session epoch.
   */
  constructor(opts: PushJournalOptions = {}) {
    this.maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.sessionEpoch = opts.sessionEpoch ?? randomUUID();
  }

  /**
   * Highest seq assigned so far, or −1 before the first push.
   *
   * @returns The last assigned seq.
   */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Oldest seq still replayable.
   *
   * With an empty ring this is `lastSeq + 1`, which reads oddly but is the
   * only correct answer: nothing is retained, so the only client that can be
   * served is one already caught up — and `lastSeq + 1 >= lastSeq + 1` says
   * exactly that.
   *
   * @returns The oldest retained seq, or `lastSeq + 1` when nothing is retained.
   */
  get firstRetainedSeq(): number {
    return this.ring.length > 0 ? this.ring[0].seq : this.nextSeq;
  }

  /**
   * Number of frames currently retained (diagnostics and tests).
   *
   * @returns The ring length.
   */
  get retainedCount(): number {
    return this.ring.length;
  }

  /**
   * Bytes currently retained (diagnostics and tests).
   *
   * @returns Summed frame sizes.
   */
  get retainedBytes(): number {
    return this.retainedBytesCount;
  }

  /**
   * Assign the next seq to a push, encode it, and retain it.
   *
   * @param event - Push channel name.
   * @param payload - Push payload.
   * @returns The assigned seq and the encoded frame, ready to write.
   * @throws TypeError if `payload` cannot be JSON-serialized.
   */
  append(event: string, payload: unknown): RetainedPush {
    const seq = this.nextSeq++;
    const push: RpcPush = { event, payload, seq };
    const entry: RetainedPush = { seq, frame: encodeMessage(push) };
    this.ring.push(entry);
    this.retainedBytesCount += entry.frame.byteLength;
    this.evict();
    return entry;
  }

  /**
   * Frames a client needs to catch up from `afterSeq`.
   *
   * @param afterSeq - Highest seq the client has already seen (−1 if none).
   * @returns Frames with `seq > afterSeq` in order — empty when the client is
   *   already current — or `null` when the request cannot be satisfied and
   *   the caller must force a full resync.
   */
  framesSince(afterSeq: number): Buffer[] | null {
    // The client claims to have seen more than was ever sent. Under a correct
    // epoch check this is unreachable, so treat it as the bug it would be
    // rather than papering over it with an empty replay.
    if (afterSeq > this.lastSeq) return null;
    // Its next frame fell off the back of the ring: a real gap.
    if (afterSeq + 1 < this.firstRetainedSeq) return null;
    return this.ring.filter((entry) => entry.seq > afterSeq).map((e) => e.frame);
  }

  /**
   * Whether {@link framesSince} could serve this cursor.
   *
   * @param afterSeq - Highest seq the client has already seen (−1 if none).
   * @returns True when a replay is possible.
   */
  canReplayFrom(afterSeq: number): boolean {
    return this.framesSince(afterSeq) !== null;
  }

  /** Drop oldest frames until both bounds hold. */
  private evict(): void {
    // Never evict the newest frame, even when it alone exceeds maxBytes.
    // Dropping it would leave firstRetainedSeq === lastSeq + 1, which claims
    // "everyone is caught up" about a push nobody has received — silent loss
    // of exactly the oversized payload (a big plot) most worth keeping.
    while (
      this.ring.length > 1 &&
      (this.ring.length > this.maxMessages ||
        this.retainedBytesCount > this.maxBytes)
    ) {
      const dropped = this.ring.shift() as RetainedPush;
      this.retainedBytesCount -= dropped.frame.byteLength;
    }
  }
}
