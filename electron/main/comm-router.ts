/**
 * comm-router.ts — Routes incoming Jupyter comm messages to typed handlers.
 *
 * Receives raw comm messages from the Jupyter client (via kernel-manager),
 * validates them as PDV envelopes, and dispatches them to registered
 * handlers keyed by the message type.
 *
 * Outgoing requests are constructed here and sent through the comm channel.
 * Pending requests are tracked by msg_id so responses can be matched and
 * resolved as promises.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §3 (comm protocol), §3.2 (envelope), §3.3 (routing)
 * pdv-protocol.ts — TypeScript types for envelopes
 * kernel-manager.ts — owns the actual Jupyter client connection
 */

import { PDVEnvelope, PDV_COMM_TARGET, PDV_PROTOCOL_VERSION } from "./pdv-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback invoked when a push notification arrives (no in_reply_to). */
export type PushHandler = (msg: PDVEnvelope) => void;

// ---------------------------------------------------------------------------
// CommRouter class
// ---------------------------------------------------------------------------

export class CommRouter {
  /**
   * Construct a CommRouter.
   *
   * @param sendFn - Async function that sends a raw data payload over the
   *   Jupyter comm channel. Provided by KernelManager.
   *
   * Reference: ARCHITECTURE.md §3.3
   */
  constructor(
    private readonly sendFn: (data: Record<string, unknown>) => Promise<void>
  ) {
    // TODO: implement in Step 3
    throw new Error("CommRouter constructor not yet implemented");
  }

  /**
   * Handle a raw incoming comm message from the Jupyter client.
   *
   * Parses the PDV envelope, resolves pending promises for responses,
   * and dispatches push notifications to registered handlers.
   *
   * @param data - Raw data payload from the Jupyter comm channel.
   */
  handleIncoming(data: unknown): void {
    // TODO: implement in Step 3
    throw new Error("CommRouter.handleIncoming not yet implemented");
  }

  /**
   * Send a PDV request and return a Promise that resolves to the response.
   *
   * Adds a msg_id to the request, tracks it internally, and resolves the
   * promise when the matching response arrives. Rejects on timeout or error.
   *
   * @param type - PDV message type (e.g. "pdv.tree.list").
   * @param payload - Request payload.
   * @param timeoutMs - Milliseconds before the promise is rejected. Default 30000.
   *
   * Reference: ARCHITECTURE.md §3.3.1
   */
  request(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<PDVEnvelope> {
    // TODO: implement in Step 3
    throw new Error("CommRouter.request not yet implemented");
  }

  /**
   * Register a handler for unsolicited push notifications of a given type.
   *
   * @param type - PDV message type string.
   * @param handler - Called whenever a matching push notification arrives.
   */
  onPush(type: string, handler: PushHandler): void {
    // TODO: implement in Step 3
    throw new Error("CommRouter.onPush not yet implemented");
  }

  /**
   * Remove a previously registered push handler.
   *
   * @param type - PDV message type string.
   * @param handler - The exact handler reference to remove.
   */
  offPush(type: string, handler: PushHandler): void {
    // TODO: implement in Step 3
    throw new Error("CommRouter.offPush not yet implemented");
  }

  /**
   * Reject all pending request promises and clear the push handler registry.
   *
   * Called when the kernel dies or the comm channel closes unexpectedly.
   */
  reset(): void {
    // TODO: implement in Step 3
    throw new Error("CommRouter.reset not yet implemented");
  }
}
