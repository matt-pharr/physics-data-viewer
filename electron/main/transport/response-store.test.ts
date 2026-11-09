/**
 * response-store.test.ts — retention, expiry, and the three-state
 * reconciliation the store exists to make possible.
 *
 * The clock is injected so ageing is exact rather than slept for, and so the
 * monotonic requirement is actually exercised: a test that used wall clock
 * would pass just as happily against a wall-clock implementation.
 */

import { describe, expect, it } from "vitest";

import { ResponseStore } from "./response-store";

/** A controllable monotonic clock in nanoseconds. */
function fakeClock(): { now: () => bigint; advanceMs: (ms: number) => void } {
  let ns = 1_000_000_000n;
  return {
    now: () => ns,
    advanceMs: (ms: number) => {
      ns += BigInt(ms) * 1_000_000n;
    },
  };
}

describe("ResponseStore", () => {
  it("retains a settlement and returns it by id", () => {
    const store = new ResponseStore();
    store.record({ id: "7", result: { ok: true } }, 42);

    const entry = store.get("7");
    expect(entry?.settledAtSeq).toBe(42);
    expect(JSON.parse(String(entry?.frame))).toEqual({
      id: "7",
      result: { ok: true },
    });
  });

  it("encodes the frame as a complete newline-terminated line", () => {
    const store = new ResponseStore();
    const entry = store.record({ id: "1", result: 1 }, 0);
    expect(entry.frame.at(-1)).toBe(0x0a);
  });

  it("retains rejections as faithfully as results", () => {
    // A failed script.run during a disconnect must still reach the client;
    // losing the error would leave the UI waiting forever on work that has
    // already definitively failed.
    const store = new ResponseStore();
    store.record({ id: "9", error: { message: "kernel died" } }, 3);

    expect(JSON.parse(String(store.get("9")?.frame))).toEqual({
      id: "9",
      error: { message: "kernel died" },
    });
  });

  it("stamps the seq each settlement happened at", () => {
    // The stamp is what lets a replay interleave parked responses back into
    // the push stream instead of dumping them all at the end.
    const store = new ResponseStore();
    store.record({ id: "a" }, 5);
    store.record({ id: "b" }, 9);

    expect(store.get("a")?.settledAtSeq).toBe(5);
    expect(store.get("b")?.settledAtSeq).toBe(9);
  });

  it("reports an unrecorded id as missing", () => {
    expect(new ResponseStore().get("nope")).toBeNull();
  });

  describe("expiry", () => {
    it("drops an entry past its TTL", () => {
      const clock = fakeClock();
      const store = new ResponseStore({ ttlMs: 1000, now: clock.now });
      store.record({ id: "1", result: 1 }, 0);

      clock.advanceMs(999);
      expect(store.get("1")).not.toBeNull();

      clock.advanceMs(2);
      expect(store.get("1")).toBeNull();
    });

    it("prunes expired entries oldest-first", () => {
      const clock = fakeClock();
      const store = new ResponseStore({ ttlMs: 1000, now: clock.now });
      store.record({ id: "old" }, 0);
      clock.advanceMs(900);
      store.record({ id: "new" }, 1);
      clock.advanceMs(200); // old is 1100ms, new is 200ms

      expect(store.prune()).toBe(1);
      expect(store.get("old")).toBeNull();
      expect(store.get("new")).not.toBeNull();
    });
  });

  describe("bounds", () => {
    it("evicts oldest entries past the count ceiling", () => {
      const store = new ResponseStore({ maxEntries: 2 });
      store.record({ id: "1" }, 0);
      store.record({ id: "2" }, 1);
      store.record({ id: "3" }, 2);

      expect(store.size).toBe(2);
      expect(store.get("1")).toBeNull();
      expect(store.get("3")).not.toBeNull();
    });

    it("moves a re-recorded id to the back of the eviction order", () => {
      const store = new ResponseStore({ maxEntries: 2 });
      store.record({ id: "1" }, 0);
      store.record({ id: "2" }, 1);
      store.record({ id: "1", result: "again" }, 2);
      store.record({ id: "3" }, 3);

      // "2" is now the oldest and goes; the refreshed "1" survives.
      expect(store.get("2")).toBeNull();
      expect(store.get("1")?.settledAtSeq).toBe(2);
      expect(store.get("3")).not.toBeNull();
    });
  });
});
