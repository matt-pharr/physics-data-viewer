/**
 * comm-router.test.ts — Unit tests for CommRouter.
 *
 * All tests mock the sendFn — no live Jupyter kernel is used.
 *
 * Tests cover:
 * 1. handleIncoming() resolves pending request promise on matching response.
 * 2. handleIncoming() rejects pending request promise when status=error.
 * 3. handleIncoming() dispatches push notifications to registered handlers.
 * 4. request() times out and rejects if no response arrives.
 * 5. request() rejects on major version mismatch.
 * 6. reset() rejects all pending promises.
 * 7. onPush / offPush lifecycle.
 *
 * Reference: ARCHITECTURE.md §3
 */

import { CommRouter } from "./comm-router";
import { PDVEnvelope, PDV_PROTOCOL_VERSION } from "./pdv-protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(
  overrides: Partial<PDVEnvelope> & { type: string }
): PDVEnvelope {
  // TODO: implement
  throw new Error("makeEnvelope not yet implemented");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommRouter", () => {
  let sendFn: jest.Mock;
  let router: CommRouter;

  beforeEach(() => {
    // TODO: construct CommRouter with mock sendFn
    throw new Error("beforeEach not yet implemented");
  });

  describe("request / response correlation", () => {
    it("resolves promise when matching response arrives", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });

    it("rejects promise when response has status=error", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });

    it("rejects promise on timeout", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });
  });

  describe("push notifications", () => {
    it("calls registered handler for matching push type", () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });

    it("does not call handler after offPush", () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });

    it("does not call push handler for a reply message", () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });
  });

  describe("reset", () => {
    it("rejects all pending requests", async () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });
  });

  describe("version check", () => {
    it("rejects incoming message with incompatible major version", () => {
      // TODO: implement in Step 3
      throw new Error("not implemented");
    });
  });
});
