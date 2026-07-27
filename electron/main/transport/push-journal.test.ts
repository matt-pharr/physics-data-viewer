/**
 * push-journal.test.ts — sequencing and replay rules.
 *
 * The cases that matter here are the ones where a wrong answer looks like a
 * right one: a gap reported as "caught up", a cursor silently advanced past
 * dropped frames, an oversized push evicted by its own arrival. Each of
 * those loses data without raising an error anywhere, so they get explicit
 * tests rather than being left to the happy path.
 */

import { describe, expect, it } from "vitest";

import { PushJournal } from "./push-journal";

/** Decode a replayed frame back to its envelope for assertions. */
function decode(frame: Buffer): { event: string; payload: unknown; seq: number } {
  return JSON.parse(frame.toString("utf8"));
}

describe("PushJournal", () => {
  it("starts empty at seq −1 and numbers pushes from 0", () => {
    const journal = new PushJournal();
    expect(journal.lastSeq).toBe(-1);

    expect(journal.append("a", {}).seq).toBe(0);
    expect(journal.append("b", {}).seq).toBe(1);
    expect(journal.lastSeq).toBe(1);
  });

  it("encodes each frame once, as a complete newline-terminated line", () => {
    const journal = new PushJournal();
    const { frame } = journal.append("push:chunk", { part: 1 });

    expect(frame.at(-1)).toBe(0x0a);
    expect(decode(frame)).toEqual({
      event: "push:chunk",
      payload: { part: 1 },
      seq: 0,
    });
  });

  it("gives every session a distinct epoch", () => {
    expect(new PushJournal().sessionEpoch).not.toBe(
      new PushJournal().sessionEpoch,
    );
  });

  describe("replay", () => {
    it("replays exactly what a cursor missed, in order", () => {
      const journal = new PushJournal();
      for (const n of [0, 1, 2, 3]) journal.append("e", { n });

      const frames = journal.framesSince(1);
      expect(frames?.map((f) => decode(f).seq)).toEqual([2, 3]);
    });

    it("replays the whole session for a cold client at −1", () => {
      const journal = new PushJournal();
      journal.append("a", {});
      journal.append("b", {});

      expect(journal.framesSince(-1)?.map((f) => decode(f).seq)).toEqual([0, 1]);
    });

    it("returns an empty replay — not a gap — for a caught-up client", () => {
      const journal = new PushJournal();
      journal.append("a", {});

      expect(journal.framesSince(0)).toEqual([]);
    });

    it("treats a fresh journal as replayable rather than stale", () => {
      // Nothing has ever been pushed, so a cold client is trivially current.
      // Reporting a gap here would force a full resync on every connect.
      const journal = new PushJournal();
      expect(journal.framesSince(-1)).toEqual([]);
      expect(journal.canReplayFrom(-1)).toBe(true);
    });

    it("reports a gap when the cursor fell off the back of the ring", () => {
      const journal = new PushJournal({ maxMessages: 2 });
      for (const n of [0, 1, 2, 3]) journal.append("e", { n });

      // Retains seq 2,3. A client at 0 needs seq 1, which is gone.
      expect(journal.firstRetainedSeq).toBe(2);
      expect(journal.framesSince(0)).toBeNull();
      expect(journal.canReplayFrom(0)).toBe(false);
    });

    it("serves the exact boundary cursor and refuses the one below it", () => {
      const journal = new PushJournal({ maxMessages: 2 });
      for (const n of [0, 1, 2, 3]) journal.append("e", { n });

      // A client at 1 needs seq 2, which is the oldest retained frame.
      expect(journal.framesSince(1)?.map((f) => decode(f).seq)).toEqual([2, 3]);
      expect(journal.framesSince(0)).toBeNull();
    });

    it("refuses a cursor ahead of the journal instead of replaying nothing", () => {
      // This is the shape of the restarted-daemon bug: a client holding a
      // high seq must never be told it is caught up by a journal that
      // restarted at 0. The epoch check is the real guard; this is the
      // backstop for when it is missed.
      const journal = new PushJournal();
      journal.append("a", {});

      expect(journal.framesSince(4000)).toBeNull();
    });
  });

  describe("eviction", () => {
    it("drops oldest frames past the message ceiling", () => {
      const journal = new PushJournal({ maxMessages: 3 });
      for (const n of [0, 1, 2, 3, 4]) journal.append("e", { n });

      expect(journal.retainedCount).toBe(3);
      expect(journal.firstRetainedSeq).toBe(2);
      expect(journal.lastSeq).toBe(4);
    });

    it("drops oldest frames past the byte ceiling", () => {
      const payload = { blob: "x".repeat(1000) };
      const journal = new PushJournal({ maxBytes: 2500 });
      for (let n = 0; n < 5; n += 1) journal.append("e", payload);

      expect(journal.retainedBytes).toBeLessThanOrEqual(2500);
      expect(journal.retainedCount).toBe(2);
    });

    it("keeps an oversized frame that alone exceeds the byte ceiling", () => {
      // Evicting it would make firstRetainedSeq === lastSeq + 1, which claims
      // every client is caught up on a push none of them has received. A
      // large payload (a plot) is exactly what a reconnecting client most
      // needs replayed.
      const journal = new PushJournal({ maxBytes: 100 });
      journal.append("push:plot", { blob: "x".repeat(5000) });

      expect(journal.retainedCount).toBe(1);
      expect(journal.firstRetainedSeq).toBe(0);
      expect(journal.framesSince(-1)).toHaveLength(1);
    });

    it("never renumbers surviving frames", () => {
      const journal = new PushJournal({ maxMessages: 2 });
      for (const n of [0, 1, 2]) journal.append("e", { n });

      // Seq is the session's identity for a push; a compacting ring that
      // renumbered would desynchronize every connected cursor at once.
      expect(journal.framesSince(-1)).toBeNull();
      expect(journal.framesSince(0)?.map((f) => decode(f).seq)).toEqual([1, 2]);
    });
  });
});
