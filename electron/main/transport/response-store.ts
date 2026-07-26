/**
 * response-store.ts — retained invoke settlements, so a result that arrives
 * while nobody is listening is not lost.
 *
 * Today a settlement goes straight to the writer, which is fine when the
 * writer is a child process's stdin that dies with the session. Over SSH it
 * is not: a `script.run` that finishes during a disconnect has produced a
 * real result on a daemon that is still very much alive, and dropping it
 * because the socket went away destroys work the user was waiting for.
 *
 * So the write is inverted — **record, then write**. Recording first is what
 * makes reconnection a lookup rather than a guess: on reattach a client
 * lists the ids it never saw settle, and each is answered from here or
 * classified honestly as unknown. Writing first and recording after would
 * leave a window where a settlement exists on the wire but nowhere else.
 *
 * Two details that look like nitpicks and are not:
 *
 *  - **The TTL uses a monotonic clock**, never wall clock. A laptop lid-close
 *    and an NTP correction both move wall clock discontinuously, and either
 *    could expire a parked response early — precisely during the disconnect
 *    the store exists to survive.
 *  - **Every entry records the journal seq it settled at.** Replaying parked
 *    responses after a reconnect in settle order would put them all at the
 *    end; the stamp lets the pump interleave them back into the push stream
 *    where they actually happened, so the client sees the original timeline.
 *
 * This module does NOT decide what to do with a missing entry (that is the
 * attach handshake's three-state reconciliation) or perform I/O — it is a
 * bounded map over encoded frames.
 */

import { encodeMessage } from "./line-codec";
import type { RpcResponse } from "./protocol";

/**
 * Default retention count. Sized well above any plausible number of invokes
 * in flight across a disconnect, while staying a hard bound.
 */
export const DEFAULT_MAX_RESPONSES = 200;

/** Default retention window (10 minutes) in milliseconds. */
export const DEFAULT_RESPONSE_TTL_MS = 10 * 60 * 1000;

/** Options accepted by {@link ResponseStore}. */
export interface ResponseStoreOptions {
  /** Entry-count ceiling. Defaults to {@link DEFAULT_MAX_RESPONSES}. */
  maxEntries?: number;
  /** Retention window in ms. Defaults to {@link DEFAULT_RESPONSE_TTL_MS}. */
  ttlMs?: number;
  /**
   * Monotonic clock in nanoseconds. Injected by tests to age entries without
   * sleeping; production uses `process.hrtime.bigint`.
   */
  now?: () => bigint;
}

/** One retained settlement. */
export interface RetainedResponse {
  /** The request id this settles. */
  id: string;
  /** The complete newline-terminated response frame. */
  frame: Buffer;
  /**
   * The session's `lastSeq` at the moment this settled, so a replay can
   * interleave it back into the push stream at the right point.
   */
  settledAtSeq: number;
  /** Monotonic timestamp (ns) used for the TTL. */
  at: bigint;
}

/** Nanoseconds per millisecond, for the monotonic TTL comparison. */
const NS_PER_MS = 1_000_000n;

/**
 * Bounded store of recent invoke settlements (see the file header).
 *
 * One instance per session, alongside the push journal. Insertion order is
 * settle order, which Map preserves, so eviction is oldest-first.
 */
export class ResponseStore {
  private readonly entries = new Map<string, RetainedResponse>();
  private readonly maxEntries: number;
  private readonly ttlNs: bigint;
  private readonly now: () => bigint;

  /**
   * @param opts - Retention bounds and (tests only) an injected clock.
   */
  constructor(opts: ResponseStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_RESPONSES;
    this.ttlNs = BigInt(opts.ttlMs ?? DEFAULT_RESPONSE_TTL_MS) * NS_PER_MS;
    this.now = opts.now ?? process.hrtime.bigint;
  }

  /**
   * Number of entries currently retained (diagnostics and tests).
   *
   * @returns The entry count, including any not yet pruned.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Record a settlement and return the frame to write.
   *
   * @param response - The settlement envelope.
   * @param settledAtSeq - The session's `lastSeq` at settle time.
   * @returns The retained entry, whose `frame` the caller writes.
   * @throws TypeError if `response` cannot be JSON-serialized.
   */
  record(response: RpcResponse, settledAtSeq: number): RetainedResponse {
    const entry: RetainedResponse = {
      id: response.id,
      frame: encodeMessage(response),
      settledAtSeq,
      at: this.now(),
    };
    // Re-recording an id must move it to the back of the eviction order, so
    // delete before set — Map keeps first-insertion position otherwise.
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    this.evict();
    return entry;
  }

  /**
   * Look up a settlement by request id.
   *
   * @param id - The request id to reconcile.
   * @returns The retained entry, or `null` when it was never recorded or has
   *   aged out. The caller must treat those two the same way — as unknown —
   *   because the store genuinely cannot tell them apart.
   */
  get(id: string): RetainedResponse | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  /**
   * Drop every entry past its TTL.
   *
   * @returns The number of entries dropped.
   */
  prune(): number {
    let dropped = 0;
    for (const [id, entry] of this.entries) {
      if (!this.isExpired(entry)) break; // insertion order ⇒ oldest first
      this.entries.delete(id);
      dropped += 1;
    }
    return dropped;
  }

  /** Whether an entry has aged past the TTL. */
  private isExpired(entry: RetainedResponse): boolean {
    return this.now() - entry.at > this.ttlNs;
  }

  /** Enforce the count ceiling, oldest first. */
  private evict(): void {
    this.prune();
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
