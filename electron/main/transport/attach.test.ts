/**
 * attach.test.ts — the reattach rules, especially the ordering one.
 *
 * The headline case is `epoch-mismatch` with a replayable-looking cursor:
 * every check individually passes, the seq arithmetic says "caught up", and
 * the client would silently lose a whole session. It gets its own test
 * because the only thing preventing it is the *order* of two `if`s, which no
 * type or signature can enforce.
 */

import { describe, expect, it } from "vitest";

import { planAttach } from "./attach";
import { PushJournal } from "./push-journal";
import {
  RPC_PROTOCOL_MIN,
  RPC_PROTOCOL_VERSION,
  type RpcAttachRequest,
  type RpcPendingVerdict,
} from "./protocol";

/** An attach request with sensible defaults, overridable per test. */
function request(over: Partial<RpcAttachRequest> = {}): RpcAttachRequest {
  return {
    sessionEpoch: null,
    lastSeq: -1,
    pendingRequests: [],
    protocol: RPC_PROTOCOL_VERSION,
    ...over,
  };
}

/** Reconciler returning a fixed verdict for every id. */
const always =
  (verdict: RpcPendingVerdict) =>
  (): RpcPendingVerdict =>
    verdict;

describe("planAttach", () => {
  describe("protocol range", () => {
    it("rejects a client below the served range", () => {
      const plan = planAttach({
        request: request({ protocol: RPC_PROTOCOL_MIN - 1 }),
        journal: new PushJournal(),
        reconcile: always("unknown"),
      });

      expect(plan.outcome).toBe("rejected");
      if (plan.outcome !== "rejected") return;
      expect(plan.error.protocolMin).toBe(RPC_PROTOCOL_MIN);
      expect(plan.error.message).toMatch(/serves/);
    });

    it("rejects a client above the served range", () => {
      const plan = planAttach({
        request: request({ protocol: RPC_PROTOCOL_VERSION + 1 }),
        journal: new PushJournal(),
        reconcile: always("unknown"),
      });
      expect(plan.outcome).toBe("rejected");
    });
  });

  describe("session epoch", () => {
    it("is checked BEFORE seq arithmetic", () => {
      // The silent-data-loss case: a daemon died and was recreated, so its
      // journal restarts at 0 while the client still holds seq 4000. Seq
      // arithmetic alone would call this replayable, replay nothing, and
      // leave the client believing it was caught up.
      const journal = new PushJournal({ sessionEpoch: "epoch-B" });
      journal.append("push:a", {});

      const plan = planAttach({
        request: request({ sessionEpoch: "epoch-A", lastSeq: 4000 }),
        journal,
        reconcile: always("unknown"),
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.status).toBe("stale");
      if (plan.result.status !== "stale") return;
      expect(plan.result.reason).toBe("epoch-mismatch");
      expect(plan.replay).toEqual([]);
      // And it reports the epoch the client is now on, so the next attach
      // can succeed rather than looping.
      expect(plan.result.sessionEpoch).toBe("epoch-B");
    });

    it("catches a restarted session that has run PAST the client's cursor", () => {
      // The shape the cursor-ahead backstop cannot catch: the daemon
      // restarted and has since pushed *more* than the client ever saw, so
      // every seq check passes — the cursor is in range and the frames
      // exist. Without the epoch check the client is handed frames 3 and 4
      // of a completely different session, told `status: "ok"`, and nothing
      // downstream ever notices.
      //
      // Verified by mutation: deleting the epoch check fails this test with
      // a successful attach carrying foreign frames, which is the silent
      // failure. (Merely *reordering* the check is caught by the sibling
      // test above — both are needed, they fail differently.)
      const journal = new PushJournal({ sessionEpoch: "incarnation-2" });
      for (const n of [0, 1, 2, 3, 4]) journal.append("push", { n });

      const plan = planAttach({
        request: request({ sessionEpoch: "incarnation-1", lastSeq: 2 }),
        journal,
        reconcile: always("unknown"),
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.status).toBe("stale");
      if (plan.result.status !== "stale") return;
      expect(plan.result.reason).toBe("epoch-mismatch");
      expect(plan.replay).toEqual([]);
    });

    it("treats a cold client with no cursor as stale", () => {
      const journal = new PushJournal();
      journal.append("push:a", {});

      const plan = planAttach({
        request: request({ sessionEpoch: null, lastSeq: -1 }),
        journal,
        reconcile: always("unknown"),
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.status).toBe("stale");
      if (plan.result.status !== "stale") return;
      expect(plan.result.reason).toBe("no-cursor");
    });
  });

  describe("replay", () => {
    it("serves the frames a matching client missed", () => {
      const journal = new PushJournal({ sessionEpoch: "e1" });
      journal.append("push:a", { n: 0 });
      journal.append("push:b", { n: 1 });
      journal.append("push:c", { n: 2 });

      const plan = planAttach({
        request: request({ sessionEpoch: "e1", lastSeq: 0 }),
        journal,
        reconcile: always("unknown"),
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.status).toBe("ok");
      expect(plan.replay.map((f) => JSON.parse(String(f)).event)).toEqual([
        "push:b",
        "push:c",
      ]);
      expect(plan.result.lastSeq).toBe(2);
    });

    it("attaches a caught-up client with an empty replay", () => {
      const journal = new PushJournal({ sessionEpoch: "e1" });
      journal.append("push:a", {});

      const plan = planAttach({
        request: request({ sessionEpoch: "e1", lastSeq: 0 }),
        journal,
        reconcile: always("unknown"),
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.status).toBe("ok");
      expect(plan.replay).toEqual([]);
    });

    it("is stale when the cursor fell off the back of the ring", () => {
      const journal = new PushJournal({ sessionEpoch: "e1", maxMessages: 2 });
      for (const n of [0, 1, 2, 3]) journal.append("push", { n });

      const plan = planAttach({
        request: request({ sessionEpoch: "e1", lastSeq: 0 }),
        journal,
        reconcile: always("unknown"),
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.status).toBe("stale");
      if (plan.result.status !== "stale") return;
      expect(plan.result.reason).toBe("replay-gap");
    });
  });

  describe("pending reconciliation", () => {
    it("reports a verdict per pending id on a successful attach", () => {
      const journal = new PushJournal({ sessionEpoch: "e1" });
      const verdicts: Record<string, RpcPendingVerdict> = {
        "1": "in-flight",
        "2": "completed",
        "3": "unknown",
      };

      const plan = planAttach({
        request: request({
          sessionEpoch: "e1",
          lastSeq: -1,
          pendingRequests: ["1", "2", "3"],
        }),
        journal,
        reconcile: (id) => verdicts[id],
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.pending).toEqual(verdicts);
    });

    it("still reconciles when the attach is stale", () => {
      // Journal loss and settlement loss are independent failures with
      // independent stores. A blown replay ring must not also discard a
      // completed script.run — that result is exactly what the user is
      // waiting for.
      const journal = new PushJournal({ sessionEpoch: "e1", maxMessages: 1 });
      for (const n of [0, 1, 2]) journal.append("push", { n });

      const plan = planAttach({
        request: request({
          sessionEpoch: "e1",
          lastSeq: 0,
          pendingRequests: ["42"],
        }),
        journal,
        reconcile: always("completed"),
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.status).toBe("stale");
      expect(plan.result.pending).toEqual({ "42": "completed" });
    });

    it("reconciles even on an epoch mismatch", () => {
      const plan = planAttach({
        request: request({
          sessionEpoch: "gone",
          lastSeq: 99,
          pendingRequests: ["7"],
        }),
        journal: new PushJournal({ sessionEpoch: "live" }),
        reconcile: always("completed"),
      });

      expect(plan.outcome).toBe("attached");
      if (plan.outcome !== "attached") return;
      expect(plan.result.pending).toEqual({ "7": "completed" });
    });
  });
});
