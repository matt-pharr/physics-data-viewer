/**
 * server-main.test.ts — the daemon's idle-policy WIRING, not the policy.
 *
 * `session-idle.test.ts` proves the policy class; this file proves the
 * coupling `wireSessionIdle` owns — that `kernel:executionState` events on
 * a real KernelManager actually reach `onExecutionIdle`/`onExecutionBusy`,
 * and that the predicates read the live kernel list. That coupling is the
 * part a review found vacuous: fourteen green unit tests sat on top of a
 * daemon whose stub autosave always succeeded and whose `onExecutionIdle`
 * nothing called, which silently degraded "the cap counts idle time" into
 * "no cap at all while executing".
 *
 * A real KernelManager instance carries the events (so a renamed event
 * fails here), with `list`/`getExecutionState` spied to simulate kernels
 * without spawning any.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KernelManager, type KernelInfo } from "../kernel-manager";
import { REATTACH_GRACE_MS } from "./session-idle";
import { wireSessionIdle } from "./server-main";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1000;

/** A real KernelManager with one simulated kernel and a settable state. */
function makeKernelWorld(): {
  km: KernelManager;
  setState: (state: "idle" | "busy") => void;
  emitState: (state: "idle" | "busy") => void;
} {
  const km = new KernelManager();
  let state: "idle" | "busy" = "idle";
  vi.spyOn(km, "list").mockImplementation(() => [
    { id: "k1" } as unknown as KernelInfo,
  ]);
  vi.spyOn(km, "getExecutionState").mockImplementation(() => state);
  return {
    km,
    setState: (s) => {
      state = s;
    },
    // The real emission path: what the manager does when the kernel's
    // iopub status message flips execution_state.
    emitState: (s) => {
      state = s;
      km.emit("kernel:executionState", "k1", s);
    },
  };
}

describe("wireSessionIdle", () => {
  it("re-arms the cap when the kernel's idle event arrives", async () => {
    // The degradation the stub wiring caused: with nothing calling
    // onExecutionIdle, a kernel that was busy at detach time was never
    // capped at all. Here the cap must start from the real event.
    const { km, emitState, setState } = makeKernelWorld();
    const autosave = vi.fn(async () => true);
    const shutdown = vi.fn();
    const idle = wireSessionIdle({ kernelManager: km, wire: { autosaveForShutdown: autosave }, shutdown });

    setState("busy");
    idle.onClientsGone();
    await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + 20 * HOUR);
    expect(shutdown).not.toHaveBeenCalled();

    emitState("idle");
    await vi.advanceTimersByTimeAsync(12 * HOUR + 10);
    expect(autosave).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("suspends an armed cap when the kernel's busy event arrives", async () => {
    const { km, emitState } = makeKernelWorld();
    const shutdown = vi.fn();
    const idle = wireSessionIdle({
      kernelManager: km,
      wire: { autosaveForShutdown: async () => true },
      shutdown,
    });

    idle.onClientsGone();
    await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + HOUR);
    expect(idle.isCountingDown).toBe(true);

    emitState("busy");
    await vi.advanceTimersByTimeAsync(20 * HOUR);
    expect(shutdown).not.toHaveBeenCalled();

    emitState("idle");
    await vi.advanceTimersByTimeAsync(12 * HOUR + 10);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("a kernel that dies while busy does not suspend the cap forever", async () => {
    // Process exit never flips executionState off "busy", and dead kernels
    // stay in list() — counting them as executing would leak the daemon on
    // a login node permanently, since no further executionState event will
    // ever arrive from a dead kernel.
    const { km, setState } = makeKernelWorld();
    vi.spyOn(km, "getKernel").mockImplementation(
      () => ({ id: "k1", status: "dead" }) as unknown as ReturnType<KernelManager["getKernel"]>,
    );
    const shutdown = vi.fn();
    const idle = wireSessionIdle({
      kernelManager: km,
      wire: { autosaveForShutdown: async () => true },
      shutdown,
    });

    setState("busy"); // frozen at "busy" by the crash
    idle.onClientsGone();
    await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + 12 * HOUR + 10);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("a crash event re-arms the cap when the death arrives later", async () => {
    const { km, setState } = makeKernelWorld();
    const shutdown = vi.fn();
    const idle = wireSessionIdle({
      kernelManager: km,
      wire: { autosaveForShutdown: async () => true },
      shutdown,
    });

    setState("busy");
    idle.onClientsGone();
    await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + HOUR);
    expect(shutdown).not.toHaveBeenCalled();

    // The kernel dies mid-run: status flips to dead and the crash event
    // fires — the only signal the policy will ever get from this kernel.
    vi.spyOn(km, "getKernel").mockImplementation(
      () => ({ id: "k1", status: "dead" }) as unknown as ReturnType<KernelManager["getKernel"]>,
    );
    km.emit("kernel:crashed", "k1");
    await vi.advanceTimersByTimeAsync(12 * HOUR + 10);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("blocks the shutdown while the injected autosave fails", async () => {
    // The gate is the injected autosave — the daemon passes the real
    // snapshot here, and a false answer must keep the session alive.
    const { km } = makeKernelWorld();
    const autosave = vi.fn(async () => false);
    const shutdown = vi.fn();
    const idle = wireSessionIdle({ kernelManager: km, wire: { autosaveForShutdown: autosave }, shutdown });

    idle.onClientsGone();
    await vi.advanceTimersByTimeAsync(REATTACH_GRACE_MS + 12 * HOUR + 10);
    expect(autosave).toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();

    autosave.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
