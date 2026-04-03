/**
 * comm-router.test.ts — Unit tests for CommRouter.
 *
 * All tests use MockKernelManager — no real kernel process is spawned.
 *
 * Tests cover:
 * 1. request() resolves when a matching in_reply_to response arrives (ok).
 * 2. request() rejects with PDVCommError when response has status='error'.
 * 3. request() rejects with PDVCommTimeoutError after timeoutMs with no response.
 * 4. Two concurrent request() calls each resolve to their own matching response.
 * 5. Push notifications (no in_reply_to) are forwarded to onPush listeners.
 * 6. A message with incompatible major pdv_version is rejected before dispatch.
 * 7. detach() rejects all pending requests immediately.
 * 8. offPush() stops delivery to the unregistered handler.
 * 9. A reply message is not forwarded to push handlers.
 * 10. reset() rejects all pending requests.
 *
 * Reference: ARCHITECTURE.md §3
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { CommRouter, PDVCommError, PDVCommTimeoutError } from "./comm-router";
import { PDVMessage, getAppVersion, setAppVersion } from "./pdv-protocol";
import type { IopubCallback, JupyterMessage } from "./kernel-manager";

// ---------------------------------------------------------------------------
// MockKernelManager
// ---------------------------------------------------------------------------

/**
 * Minimal mock of KernelManager used by CommRouter tests.
 *
 * - onIopubMessage(): stores the callback; returns an unsubscribe function.
 * - sendCommMsg(): records each call; resolves immediately.
 * - simulateIopub(): delivers a synthetic comm_msg JupyterMessage to the
 *   stored iopub callback, as if it arrived on the real iopub socket.
 */
class MockKernelManager {
  private callbacks = new Map<string, Set<IopubCallback>>();

  /** All comm_msg calls made by CommRouter since the last reset. */
  readonly sentMessages: Array<{
    kernelId: string;
    commId: string | null;
    data: Record<string, unknown>;
  }> = [];

  onIopubMessage(kernelId: string, callback: IopubCallback): () => void {
    let cbs = this.callbacks.get(kernelId);
    if (!cbs) {
      cbs = new Set();
      this.callbacks.set(kernelId, cbs);
    }
    cbs.add(callback);
    return () => {
      this.callbacks.get(kernelId)?.delete(callback);
    };
  }

  async sendCommMsg(
    kernelId: string,
    commId: string | null,
    data: Record<string, unknown>
  ): Promise<void> {
    this.sentMessages.push({ kernelId, commId, data });
  }

  /**
   * Simulate an incoming comm_msg on the iopub socket for the given kernelId.
   *
   * Wraps the PDV envelope in a synthetic JupyterMessage so CommRouter's
   * _handleIopubMessage() processes it exactly as it would in production.
   *
   * @param kernelId - The kernel to deliver the message to.
   * @param pdvEnvelope - The PDV message to deliver.
   */
  simulateIopub(kernelId: string, pdvEnvelope: PDVMessage): void {
    const jupyterMsg: JupyterMessage = {
      header: {
        msg_id: crypto.randomUUID(),
        username: "mock",
        session: "mock-session",
        msg_type: "comm_msg",
        version: "5.3",
        date: new Date().toISOString(),
      },
      parent_header: {},
      metadata: {},
      content: {
        comm_id: "mock-comm-id",
        data: pdvEnvelope as unknown as Record<string, unknown>,
      },
    };
    const cbs = this.callbacks.get(kernelId);
    if (cbs) {
      for (const cb of cbs) cb(jupyterMsg);
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const KERNEL_ID = "test-kernel-id";

/**
 * Build a minimal valid PDVMessage.
 *
 * @param overrides - Fields to merge over the defaults.
 */
function makeEnvelope(
  overrides: Partial<PDVMessage> & { type: string }
): PDVMessage {
  return {
    pdv_version: getAppVersion(),
    msg_id: crypto.randomUUID(),
    in_reply_to: null,
    status: "ok",
    payload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommRouter", () => {
  let mock: MockKernelManager;
  let router: CommRouter;

  beforeEach(() => {
    setAppVersion("0.0.7");
    mock = new MockKernelManager();
    router = new CommRouter();
    router.attach(mock as unknown as Parameters<CommRouter["attach"]>[0], KERNEL_ID);
  });

  // -------------------------------------------------------------------------
  // request() / response correlation
  // -------------------------------------------------------------------------

  describe("request() / response correlation", () => {
    it("resolves the promise when a matching in_reply_to ok response arrives", async () => {
      const requestPromise = router.request("pdv.tree.list", {});

      // Pull the msg_id that CommRouter assigned to the outgoing message.
      expect(mock.sentMessages.length).toBe(1);
      const outgoing = mock.sentMessages[0].data as { msg_id: string };

      const response = makeEnvelope({
        type: "pdv.tree.list.response",
        in_reply_to: outgoing.msg_id,
        status: "ok",
        payload: { nodes: [] },
      });

      mock.simulateIopub(KERNEL_ID, response);

      const resolved = await requestPromise;
      expect(resolved.in_reply_to).toBe(outgoing.msg_id);
      expect(resolved.status).toBe("ok");
      expect(resolved.payload).toEqual({ nodes: [] });
    });

    it("rejects with PDVCommError when response has status='error'", async () => {
      const requestPromise = router.request("pdv.tree.get", { path: "x" });

      const outgoing = mock.sentMessages[0].data as { msg_id: string };

      const errResponse = makeEnvelope({
        type: "pdv.tree.get.response",
        in_reply_to: outgoing.msg_id,
        status: "error",
        payload: {
          code: "tree.path_not_found",
          message: "No node at path: x",
        },
      });

      mock.simulateIopub(KERNEL_ID, errResponse);

      await expect(requestPromise).rejects.toBeInstanceOf(PDVCommError);
      const err = await requestPromise.catch((e: PDVCommError) => e);
      expect(err.code).toBe("tree.path_not_found");
    });

    it("rejects with PDVCommTimeoutError after timeoutMs elapses", async () => {
      vi.useFakeTimers();

      const requestPromise = router.request("pdv.namespace.query", {}, 100);

      // No response — advance time past the timeout.
      vi.advanceTimersByTime(200);

      await expect(requestPromise).rejects.toBeInstanceOf(PDVCommTimeoutError);
      const err = await requestPromise.catch((e: PDVCommTimeoutError) => e);
      expect(err.messageType).toBe("pdv.namespace.query");

      vi.useRealTimers();
    });

    it("two concurrent requests each resolve to their own matching response", async () => {
      const p1 = router.request("pdv.tree.list", {});
      const p2 = router.request("pdv.tree.get", { path: "x" });

      expect(mock.sentMessages.length).toBe(2);
      const id1 = (mock.sentMessages[0].data as { msg_id: string }).msg_id;
      const id2 = (mock.sentMessages[1].data as { msg_id: string }).msg_id;

      // Deliver responses in reverse order — router must still correlate correctly.
      mock.simulateIopub(
        KERNEL_ID,
        makeEnvelope({
          type: "pdv.tree.get.response",
          in_reply_to: id2,
          status: "ok",
          payload: { value: 42 },
        })
      );
      mock.simulateIopub(
        KERNEL_ID,
        makeEnvelope({
          type: "pdv.tree.list.response",
          in_reply_to: id1,
          status: "ok",
          payload: { nodes: ["a", "b"] },
        })
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.in_reply_to).toBe(id1);
      expect(r1.payload).toEqual({ nodes: ["a", "b"] });
      expect(r2.in_reply_to).toBe(id2);
      expect(r2.payload).toEqual({ value: 42 });
    });
  });

  // -------------------------------------------------------------------------
  // Push notifications
  // -------------------------------------------------------------------------

  describe("push notifications", () => {
    it("calls the registered onPush handler for a matching type", () => {
      const handler = vi.fn();
      router.onPush("pdv.tree.changed", handler);

      const push = makeEnvelope({
        type: "pdv.tree.changed",
        in_reply_to: null,
        status: "ok",
        payload: { changed_paths: ["x"], change_type: "added" },
      });

      mock.simulateIopub(KERNEL_ID, push);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        type: "pdv.tree.changed",
      }));
    });

    it("does not call the handler after offPush()", () => {
      const handler = vi.fn();
      router.onPush("pdv.tree.changed", handler);
      router.offPush("pdv.tree.changed", handler);

      mock.simulateIopub(
        KERNEL_ID,
        makeEnvelope({ type: "pdv.tree.changed", in_reply_to: null })
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("does NOT forward a reply message to push handlers", async () => {
      const pushHandler = vi.fn();
      router.onPush("pdv.tree.list.response", pushHandler);

      // Issue a request so we have a valid pending entry.
      const p = router.request("pdv.tree.list", {});
      const id = (mock.sentMessages[0].data as { msg_id: string }).msg_id;

      // Deliver a response (has in_reply_to) — must go to pending, not push.
      mock.simulateIopub(
        KERNEL_ID,
        makeEnvelope({
          type: "pdv.tree.list.response",
          in_reply_to: id,
          status: "ok",
          payload: { nodes: [] },
        })
      );

      await p; // Must resolve.
      expect(pushHandler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // detach()
  // -------------------------------------------------------------------------

  describe("detach()", () => {
    it("rejects all pending requests immediately", async () => {
      const p1 = router.request("pdv.tree.list", {});
      const p2 = router.request("pdv.namespace.query", {});

      router.detach();

      await expect(p1).rejects.toBeInstanceOf(PDVCommError);
      await expect(p2).rejects.toBeInstanceOf(PDVCommError);
    });
  });

  // -------------------------------------------------------------------------
  // reset()
  // -------------------------------------------------------------------------

  describe("reset()", () => {
    it("rejects all pending requests", async () => {
      const p = router.request("pdv.tree.list", {});

      router.reset();

      await expect(p).rejects.toBeInstanceOf(PDVCommError);
    });
  });

  // -------------------------------------------------------------------------
  // Version compatibility
  // -------------------------------------------------------------------------

  describe("version compatibility", () => {
    it("rejects an incoming message with an incompatible major pdv_version", async () => {
      // Issue a real request so there is a pending entry.
      const p = router.request("pdv.tree.list", {});
      const id = (mock.sentMessages[0].data as { msg_id: string }).msg_id;

      // Deliver a response with a wrong major version — should be dropped.
      mock.simulateIopub(
        KERNEL_ID,
        makeEnvelope({
          pdv_version: "99.0",
          type: "pdv.tree.list.response",
          in_reply_to: id,
          status: "ok",
          payload: {},
        })
      );

      // The request was rejected with a version error (not resolved with ok).
      await expect(p).rejects.toBeDefined();
      const err = await p.catch((e: unknown) => e);
      expect(String(err)).toContain("version");
    });

    it("accepts a message with the same major but different minor version", async () => {
      const p = router.request("pdv.tree.list", {});
      const id = (mock.sentMessages[0].data as { msg_id: string }).msg_id;

      // Minor version mismatch — should be accepted with a warning.
      mock.simulateIopub(
        KERNEL_ID,
        makeEnvelope({
          pdv_version: "0.99.0",
          type: "pdv.tree.list.response",
          in_reply_to: id,
          status: "ok",
          payload: { nodes: [] },
        })
      );

      const result = await p;
      expect(result.status).toBe("ok");
    });
  });
});
