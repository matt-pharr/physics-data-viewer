/**
 * query-router.ts — Routes read-only PDV queries through a dedicated ZeroMQ socket.
 *
 * The QueryRouter sends requests on the kernel's query socket (ZMQ REQ/REP)
 * instead of the comm channel, allowing tree and namespace queries to
 * execute even while the kernel is busy running user code.
 *
 * Lifecycle: call {@link attach} after kernel init, {@link detach} on kernel
 * stop/crash.  If the query socket is unavailable, callers should fall back
 * to CommRouter.
 *
 * See Also
 * --------
 * kernel-manager.ts — owns the ZeroMQ sockets and sendQueryRequest()
 * comm-router.ts — fallback for write operations and when query socket is down
 */

import * as crypto from "crypto";
import { type PDVMessage, getAppVersion } from "./pdv-protocol";
import type { KernelManager } from "./kernel-manager";

/**
 * Lightweight router for read-only kernel queries on a dedicated ZMQ channel.
 *
 * @throws PDVQueryError when the kernel returns status='error'.
 */
export class QueryRouter {
  private kernelManager: KernelManager | null = null;
  private kernelId: string | null = null;

  /**
   * Bind to a running kernel. Must be called after the kernel's query
   * server has been started (i.e. after ``pdv.init`` returns).
   *
   * @param kernelManager - The KernelManager that owns the ZMQ sockets.
   * @param kernelId - The active kernel's ID.
   */
  attach(kernelManager: KernelManager, kernelId: string): void {
    this.kernelManager = kernelManager;
    this.kernelId = kernelId;
  }

  /** Release the kernel reference (e.g. on stop or crash). */
  detach(): void {
    this.kernelManager = null;
    this.kernelId = null;
  }

  /** Whether the query router is currently connected to a kernel. */
  isAttached(): boolean {
    return this.kernelManager !== null && this.kernelId !== null;
  }

  /**
   * Send a read-only query to the kernel and return the response.
   *
   * @param type - PDV message type (e.g. ``'pdv.tree.list'``).
   * @param payload - Request payload.
   * @returns The response as a PDVMessage.
   * @throws Error if not attached, on timeout, or on error status.
   */
  async request(
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<PDVMessage> {
    if (!this.kernelManager || !this.kernelId) {
      throw new Error("QueryRouter is not attached to a kernel");
    }

    const envelope: Record<string, unknown> = {
      pdv_version: getAppVersion(),
      msg_id: crypto.randomUUID(),
      in_reply_to: null,
      type,
      payload,
    };

    const raw = await this.kernelManager.sendQueryRequest(
      this.kernelId,
      envelope,
    );

    const response = raw as unknown as PDVMessage;
    if (response.status === "error") {
      const errPayload = response.payload as {
        code?: string;
        message?: string;
      };
      throw new Error(
        `Query error [${errPayload.code ?? "unknown"}]: ${errPayload.message ?? "unknown error"}`,
      );
    }
    return response;
  }
}
