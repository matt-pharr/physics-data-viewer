/**
 * handler-invoke-tracker.test.ts — Unit tests for HandlerInvokeTracker.
 *
 * Covers the begin/emitOutput/finish lifecycle: console-entry seeding,
 * output routing to the latest in-flight invoke, measured (non-hardcoded)
 * durations, error propagation, and the no-invoke fallback signal.
 */

import { describe, expect, it, vi } from "vitest";
import { HandlerInvokeTracker } from "./handler-invoke-tracker";
import { IPC } from "./ipc";

function makeTracker() {
  const pushes: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const tracker = new HandlerInvokeTracker((channel, payload) =>
    pushes.push({ channel, payload: payload as Record<string, unknown> }),
  );
  return { tracker, pushes };
}

describe("HandlerInvokeTracker", () => {
  it("begin seeds a console entry labeled with the node path", () => {
    const { tracker, pushes } = makeTracker();
    const id = tracker.begin("data.myh5.temp");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].channel).toBe(IPC.push.executeBegin);
    expect(pushes[0].payload.executionId).toBe(id);
    expect(pushes[0].payload.code).toBe("");
    expect(pushes[0].payload.origin).toMatchObject({
      kind: "unknown",
      label: "Handler data.myh5.temp",
    });
  });

  it("emitOutput routes chunks to the in-flight invoke and reports it", () => {
    const { tracker, pushes } = makeTracker();
    const id = tracker.begin("a.b");
    const routed = tracker.emitOutput({ type: "stdout", text: "[PDV] hi\n" });
    expect(routed).toBe(true);
    const output = pushes.find((p) => p.channel === IPC.push.executeOutput);
    expect(output?.payload).toMatchObject({
      executionId: id,
      type: "stdout",
      text: "[PDV] hi\n",
    });
  });

  it("emitOutput returns false when nothing is in flight (fallback path)", () => {
    const { tracker, pushes } = makeTracker();
    expect(tracker.emitOutput({ type: "stdout", text: "x" })).toBe(false);
    expect(pushes).toHaveLength(0);
  });

  it("finish stamps a measured duration, not a hardcoded zero", () => {
    vi.useFakeTimers();
    try {
      const { tracker, pushes } = makeTracker();
      const id = tracker.begin("a.b");
      vi.advanceTimersByTime(1234);
      tracker.finish(id);
      const finish = pushes.find((p) => p.channel === IPC.push.executeFinish);
      expect(finish?.payload).toMatchObject({ executionId: id, duration: 1234 });
      expect(finish?.payload.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finish carries the error and clears the invoke; repeats are no-ops", () => {
    const { tracker, pushes } = makeTracker();
    const id = tracker.begin("a.b");
    tracker.finish(id, "No handler for Core.Int64");
    const finish = pushes.find((p) => p.channel === IPC.push.executeFinish);
    expect(finish?.payload.error).toBe("No handler for Core.Int64");
    expect(tracker.emitOutput({ type: "stdout", text: "late" })).toBe(false);
    const count = pushes.length;
    tracker.finish(id); // already finished — must not double-push
    expect(pushes).toHaveLength(count);
  });

  it("overlapping invokes: output follows the most recent, then falls back", () => {
    const { tracker, pushes } = makeTracker();
    const first = tracker.begin("a");
    const second = tracker.begin("b");
    tracker.emitOutput({ type: "stdout", text: "to-second" });
    tracker.finish(second);
    tracker.emitOutput({ type: "stdout", text: "to-first" });
    tracker.finish(first);
    const outputs = pushes.filter((p) => p.channel === IPC.push.executeOutput);
    expect(outputs[0].payload.executionId).toBe(second);
    expect(outputs[1].payload.executionId).toBe(first);
  });
});
