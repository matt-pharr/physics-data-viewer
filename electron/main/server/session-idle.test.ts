/**
 * session-idle.test.ts — when a session with nobody watching should stop.
 *
 * Fake timers throughout, so twelve-hour behaviour is asserted in
 * milliseconds. The cases that matter are the ones where shutting down is
 * the wrong answer: a long simulation, a brief network drop, a failed save.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IDLE_CAP_HOURS,
  NO_KERNEL_IDLE_MS,
  REATTACH_GRACE_MS,
  SessionIdlePolicy,
  type SessionIdlePolicyOptions,
} from "./session-idle";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1000;

/** A policy with recording actions and overridable predicates. */
function makePolicy(over: Partial<SessionIdlePolicyOptions> = {}): {
  policy: SessionIdlePolicy;
  shutdown: ReturnType<typeof vi.fn>;
  autosave: ReturnType<typeof vi.fn>;
} {
  const shutdown = vi.fn();
  const autosave = vi.fn(async () => true);
  const policy = new SessionIdlePolicy({
    hasKernel: () => true,
    isExecuting: () => false,
    autosave,
    shutdown,
    ...over,
  });
  return { policy, shutdown, autosave };
}

describe("SessionIdlePolicy", () => {
  describe("reattach grace", () => {
    it("does not start any countdown during the grace window", () => {
      const { policy, shutdown } = makePolicy();
      policy.onClientsGone();

      vi.advanceTimersByTime(REATTACH_GRACE_MS - 10);
      expect(shutdown).not.toHaveBeenCalled();
    });

    it("treats a quick reconnect as a non-event", async () => {
      // A dropped VPN or a lid closed for a minute must not begin a
      // shutdown clock at all.
      const { policy, shutdown } = makePolicy();
      policy.onClientsGone();
      vi.advanceTimersByTime(1000);
      policy.onClientAttached();

      expect(policy.isCountingDown).toBe(false);
      await vi.advanceTimersByTimeAsync(24 * HOUR);
      expect(shutdown).not.toHaveBeenCalled();
    });
  });

  describe("no kernel", () => {
    it("shuts down after the idle window", async () => {
      const { policy, shutdown } = makePolicy({ hasKernel: () => false });
      policy.onClientsGone();

      await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + NO_KERNEL_IDLE_MS + 10);
      expect(shutdown).toHaveBeenCalledOnce();
    });

    it("stays up while a client is still attached", async () => {
      const { policy, shutdown } = makePolicy({ hasKernel: () => false });
      await vi.advanceTimersByTimeAsync(2 * NO_KERNEL_IDLE_MS);
      expect(shutdown).not.toHaveBeenCalled();
      expect(policy.isCountingDown).toBe(false);
    });
  });

  describe("kernel cap", () => {
    it("shuts down an idle kernel after the cap", async () => {
      const { policy, shutdown, autosave } = makePolicy({ idleCapHours: 12 });
      policy.onClientsGone();

      await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + 12 * HOUR + 10);
      expect(autosave).toHaveBeenCalledOnce();
      expect(shutdown).toHaveBeenCalledOnce();
    });

    it("does NOT kill a long execution when the laptop is shut", async () => {
      // The headline case. A literal "12 hours after the client left" would
      // SIGKILL a 20-hour simulation — the exact data loss this feature
      // exists to prevent.
      const { policy, shutdown } = makePolicy({
        idleCapHours: 12,
        isExecuting: () => true,
      });
      policy.onClientsGone();

      await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + 20 * HOUR);
      expect(shutdown).not.toHaveBeenCalled();
    });

    it("starts the cap when execution finally goes idle", async () => {
      let executing = true;
      const { policy, shutdown } = makePolicy({
        idleCapHours: 12,
        isExecuting: () => executing,
      });
      policy.onClientsGone();
      await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + 20 * HOUR);
      expect(shutdown).not.toHaveBeenCalled();

      executing = false;
      policy.onExecutionIdle();
      await vi.advanceTimersByTimeAsync(12 * HOUR + 10);
      expect(shutdown).toHaveBeenCalledOnce();
    });

    it("honours capCountsExecution for the literal behaviour", async () => {
      const { policy, shutdown } = makePolicy({
        idleCapHours: 12,
        isExecuting: () => true,
        capCountsExecution: true,
      });
      policy.onClientsGone();

      await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + 12 * HOUR + 10);
      expect(shutdown).toHaveBeenCalledOnce();
    });

    it("never shuts down when the cap is disabled", async () => {
      const { policy, shutdown } = makePolicy({ idleCapHours: 0 });
      policy.onClientsGone();

      await vi.advanceTimersByTimeAsync(30 * 24 * HOUR);
      expect(shutdown).not.toHaveBeenCalled();
    });

    it("defaults to twelve hours", () => {
      expect(DEFAULT_IDLE_CAP_HOURS).toBe(12);
    });
  });

  describe("autosave", () => {
    it("blocks the shutdown when the save fails", async () => {
      // Exiting after a failed autosave destroys exactly the work the
      // autosave existed to protect.
      const autosave = vi.fn(async () => false);
      const { policy, shutdown } = makePolicy({ idleCapHours: 1, autosave });
      policy.onClientsGone();

      await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + HOUR + 10);
      expect(autosave).toHaveBeenCalled();
      expect(shutdown).not.toHaveBeenCalled();
    });

    it("blocks the shutdown when the save throws", async () => {
      const autosave = vi.fn(async () => {
        throw new Error("disk full");
      });
      const { policy, shutdown } = makePolicy({ idleCapHours: 1, autosave });
      policy.onClientsGone();

      await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + HOUR + 10);
      expect(shutdown).not.toHaveBeenCalled();
    });

    it("retries and shuts down once the save succeeds", async () => {
      let fail = true;
      const autosave = vi.fn(async () => !fail);
      const { policy, shutdown } = makePolicy({
        idleCapHours: 1,
        autosave,
        autosaveRetryMs: 60_000,
      });
      policy.onClientsGone();

      await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + HOUR + 10);
      expect(shutdown).not.toHaveBeenCalled();

      fail = false;
      await vi.advanceTimersByTimeAsync(60_000 + 10);
      expect(shutdown).toHaveBeenCalledOnce();
    });
  });

  it("stops scheduling once disposed", async () => {
    const { policy, shutdown } = makePolicy({ idleCapHours: 1 });
    policy.onClientsGone();
    policy.dispose();

    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(shutdown).not.toHaveBeenCalled();
  });
});
