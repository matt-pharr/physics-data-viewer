/**
 * handler-invoke-tracker.ts — Console-entry bookkeeping for tree handler
 * invocations (`pdv.handler.invoke`, the double-click action).
 *
 * A handler invoke runs over the comm channel, so everything the handler
 * emits — figures via `display_data`, `[PDV]` notices via `stream` — arrives
 * on iopub parented to the comm message, not to any in-flight execution.
 * Historically that meant two gaps: figures were surfaced as synthetic
 * "Plot" console entries stamped with a hardcoded `duration: 0`, and stream
 * output was dropped entirely (handler notices were invisible outside cell
 * runs).
 *
 * This tracker gives each invoke a real console entry instead. The
 * `tree.invokeHandler` IPC handler calls {@link HandlerInvokeTracker.begin}
 * before sending the comm request (seeding a renderer log entry via
 * `executeBegin`) and {@link HandlerInvokeTracker.finish} when the response
 * lands — the kernel replies only after the handler returns, so the comm
 * round-trip *is* the handler's wall-clock duration. While an invoke is in
 * flight, the orphan-iopub forwarder in `ipc-register-kernels.ts` routes
 * display and stream output into the entry via
 * {@link HandlerInvokeTracker.emitOutput}.
 *
 * This file does NOT touch sockets or IPC registration itself — it only
 * tracks invoke state and emits renderer pushes through the injected send
 * function (which the owner points at the main window's webContents).
 */

import { randomUUID } from "crypto";
import { IPC, ExecuteBeginPayload, ExecuteFinishPayload } from "./ipc";
import type { ExecuteOutputChunk } from "./kernel-manager";

/** Renderer-push sender: `(channel, payload)`, no-op once the window dies. */
export type PushSender = (channel: string, payload: unknown) => void;

/** One in-flight handler invocation. */
interface ActiveInvoke {
  executionId: string;
  startedAt: number;
}

/**
 * Tracks in-flight `pdv.handler.invoke` requests and owns their renderer
 * console entries (executeBegin / executeOutput / executeFinish pushes).
 *
 * Invokes are user-driven (double-clicks), so overlap is rare; when it does
 * happen, orphan output attaches to the most recently begun invoke — a
 * heuristic, but the alternative (dropping it) is strictly worse.
 */
export class HandlerInvokeTracker {
  private readonly send: PushSender;

  /** In-flight invokes by executionId. */
  private readonly active = new Map<string, ActiveInvoke>();

  /** executionId of the most recently begun invoke, or null. */
  private latestId: string | null = null;

  /**
   * @param send - Renderer-push sender (channel, payload). The owner is
   *   responsible for making it a no-op when the window is destroyed.
   */
  constructor(send: PushSender) {
    this.send = send;
  }

  /**
   * Begin tracking an invoke: seed the renderer console entry and record
   * the start time.
   *
   * @param nodePath - Tree path of the node whose handler is being invoked.
   * @returns The executionId identifying this invoke's console entry.
   */
  begin(nodePath: string): string {
    const executionId = `handler-${randomUUID()}`;
    const invoke: ActiveInvoke = { executionId, startedAt: Date.now() };
    this.active.set(executionId, invoke);
    this.latestId = executionId;
    const payload: ExecuteBeginPayload = {
      executionId,
      code: "",
      origin: { kind: "unknown", label: `Handler ${nodePath || "pdv_tree"}` },
      timestamp: invoke.startedAt,
    };
    this.send(IPC.push.executeBegin, payload);
    return executionId;
  }

  /**
   * Route an orphan output chunk into the most recent in-flight invoke's
   * console entry.
   *
   * @param chunk - Output chunk without an executionId (it is assigned here).
   * @returns True when an invoke was in flight and the chunk was emitted;
   *   false when nothing is in flight (caller may fall back or drop).
   */
  emitOutput(chunk: Omit<ExecuteOutputChunk, "executionId">): boolean {
    if (this.latestId === null) return false;
    const full: ExecuteOutputChunk = { executionId: this.latestId, ...chunk };
    this.send(IPC.push.executeOutput, full);
    return true;
  }

  /**
   * Finish an invoke: close its console entry with the measured wall-clock
   * duration (and error, if the handler failed or was never dispatched).
   *
   * @param executionId - The id returned by {@link begin}.
   * @param error - Error message when the invoke failed; omitted on success.
   */
  finish(executionId: string, error?: string): void {
    const invoke = this.active.get(executionId);
    if (!invoke) return;
    this.active.delete(executionId);
    if (this.latestId === executionId) {
      // Fall back to any other still-active invoke (most maps have 0–1).
      this.latestId = null;
      for (const id of this.active.keys()) this.latestId = id;
    }
    const payload: ExecuteFinishPayload = {
      executionId,
      duration: Date.now() - invoke.startedAt,
      ...(error ? { error } : {}),
    };
    this.send(IPC.push.executeFinish, payload);
  }
}
