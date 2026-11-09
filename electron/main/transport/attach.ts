/**
 * attach.ts — decide what a (re)attaching client is owed.
 *
 * One pure function over the session's journal and settlement store, kept
 * deliberately free of sockets, daemons and lifecycle so that the rules
 * which lose data when they are wrong can be tested exhaustively without any
 * of that machinery.
 *
 * The order of the checks is itself the design, and it is the part most
 * easily got wrong:
 *
 *  1. **Protocol range** — refuse outright. A client that cannot parse the
 *     stream is not helped by a replay.
 *  2. **Session epoch, before any seq arithmetic.** This is the check that
 *     prevents silent data loss. A daemon that died and was recreated
 *     restarts its seq at 0, so a client holding `lastSeq: 4000` would
 *     compute `4001 >= firstRetainedSeq (0)`, conclude it was replayable,
 *     receive nothing, and believe it was caught up — while the entire
 *     session it was watching is gone. Comparing epochs first makes that
 *     unreachable; comparing them after would make it merely unlikely.
 *  3. **Replay reachability** — only now may seq be reasoned about.
 *
 * Two rules that survive being stale, because their failures are silent:
 *
 *  - **Pending requests are reconciled either way.** Journal loss and
 *    settlement loss are independent failures with independent stores, so a
 *    blown replay ring must not also discard a completed `script.run`.
 *  - **Verdicts are three-valued.** "Not in flight, therefore failed" would
 *    reject work that actually completed.
 *
 * This module does NOT own connections, write frames, or decide what a
 * client does about a `stale` verdict (that is the reconnect UX).
 */

import type { PushJournal } from "./push-journal";
import {
  RPC_PROTOCOL_MIN,
  RPC_PROTOCOL_VERSION,
  type RpcAttachError,
  type RpcAttachRequest,
  type RpcAttachResult,
  type RpcPendingVerdict,
} from "./protocol";

/** What the session should do with an attach request. */
export type AttachPlan =
  | {
      /** Serve the client: send `result`, then write `replay` in order. */
      outcome: "attached";
      result: RpcAttachResult;
      /** Missed push frames; always empty when `result.status` is `"stale"`. */
      replay: Buffer[];
    }
  | {
      /** Refuse: send `error` on `attachError` and close the connection. */
      outcome: "rejected";
      error: RpcAttachError;
    };

/** Inputs to {@link planAttach}. */
export interface PlanAttachInputs {
  /** What the client claims to have seen and to be waiting on. */
  request: RpcAttachRequest;
  /** The session's push journal. */
  journal: PushJournal;
  /**
   * Classifier for one pending request id — normally `RpcServer.reconcile`.
   * Injected rather than taken as a store so the in-flight set, which lives
   * on the connection's dispatcher, can participate.
   */
  reconcile: (id: string) => RpcPendingVerdict;
}

/**
 * Decide what an attaching client is owed.
 *
 * @param inputs - The request, the session's journal, and a reconciler.
 * @returns An {@link AttachPlan}: either an attach result plus the frames to
 *   replay, or a rejection to send on `attachError`.
 */
export function planAttach(inputs: PlanAttachInputs): AttachPlan {
  const { request, journal, reconcile } = inputs;

  if (
    request.protocol < RPC_PROTOCOL_MIN ||
    request.protocol > RPC_PROTOCOL_VERSION
  ) {
    return {
      outcome: "rejected",
      error: {
        message:
          `client speaks RPC protocol ${request.protocol}; this session ` +
          `serves ${RPC_PROTOCOL_MIN}–${RPC_PROTOCOL_VERSION}`,
        protocol: RPC_PROTOCOL_VERSION,
        protocolMin: RPC_PROTOCOL_MIN,
      },
    };
  }

  // Reconciled before the epoch and gap checks, so every path below reports
  // pending verdicts: a client forced to resync its *view* must still learn
  // the fate of work it dispatched.
  const pending: Record<string, RpcPendingVerdict> = {};
  for (const id of request.pendingRequests) {
    pending[id] = reconcile(id);
  }

  const common = {
    sessionEpoch: journal.sessionEpoch,
    pending,
    lastSeq: journal.lastSeq,
  };

  const stale = (reason: RpcAttachResult & { status: "stale" }): AttachPlan => ({
    outcome: "attached",
    result: reason,
    replay: [],
  });

  // No cursor at all: a cold client, or one whose in-memory lastSeq went
  // with a restarted app. Never persisted, precisely so this path is taken
  // rather than replaying 30 pushes into a renderer that missed the first
  // 300.
  if (request.sessionEpoch === null) {
    return stale({ status: "stale", reason: "no-cursor", ...common });
  }

  // THE guard — before any seq arithmetic. Do not reorder.
  if (request.sessionEpoch !== journal.sessionEpoch) {
    return stale({ status: "stale", reason: "epoch-mismatch", ...common });
  }

  const replay = journal.framesSince(request.lastSeq);
  if (replay === null) {
    return stale({ status: "stale", reason: "replay-gap", ...common });
  }

  return {
    outcome: "attached",
    result: { status: "ok", ...common },
    replay,
  };
}
