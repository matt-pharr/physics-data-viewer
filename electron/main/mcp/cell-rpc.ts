/**
 * cell-rpc.ts — Server-side RPC client for the renderer's code-cell state.
 *
 * Code cells live only in the renderer's React state (ARCHITECTURE.md §15.8).
 * The MCP cell tools therefore use a request/response pattern: the server
 * pushes a request to the renderer over `IPC.push.cellsRequest`, the
 * renderer answers via the `cells:respond` invoke channel keyed by the
 * request id. One-way `IPC.push.cellWrite` pushes apply writes.
 *
 * Responsibilities
 * - Correlates `cells:respond` replies (delivered by the wiring layer via
 *   {@link CellRpcClient.deliver}) to pending requests, with a timeout.
 * - Provides typed `list()` / `read(tabId)` / `write(payload)` methods for
 *   tool code that does not want to think about request ids or timeouts.
 *
 * What it does NOT do
 * - It does not register the `cells:respond` invoke handler — `server/wire.ts`
 *   does, forwarding replies into {@link CellRpcClient.deliver}. Keeping
 *   registration in the wiring layer means re-wiring (macOS window
 *   re-creation) re-registers it alongside every other server channel.
 * - It is not an MCP tool itself; it is a helper consumed by the cell tools
 *   in `tools/execution.ts`.
 * - It does not know whether a renderer window exists: pushes go through the
 *   injected {@link PushSender}, and an unanswerable request fails by
 *   timeout rather than fast-failing on a missing window.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.8 — Renderer Interaction
 */

import { randomUUID } from "node:crypto";

import {
  type CellListResult,
  type CellReadResult,
  type CellWritePush,
  type CellsResponse,
  IPC,
} from "../ipc";
import type { PushSender } from "../server/invoke-registry";

/** How long a cell request waits before failing if the renderer never replies. */
const DEFAULT_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (result: CellListResult | CellReadResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Bridges server-side callers (the MCP cell tools) to renderer code-cell
 * state over the injected push sender.
 *
 * Call {@link stop} during shutdown so in-flight requests reject promptly
 * instead of dangling until their timeouts.
 */
export class CellRpcClient {
  private readonly push: PushSender;
  private readonly pending = new Map<string, PendingRequest>();

  /**
   * @param push - Renderer-push sender. In single-process mode this is the
   *   shell's window-bound closure; in the extracted pdv-server it is the
   *   transport's seq-stamping sender.
   */
  constructor(push: PushSender) {
    this.push = push;
  }

  /**
   * Reject any in-flight requests. Idempotent; the client remains usable
   * (a later request simply starts a new pending entry).
   *
   * @returns Nothing.
   */
  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Cell RPC client stopped"));
    }
    this.pending.clear();
  }

  /**
   * Ask the renderer for the current list of cell tabs.
   *
   * @returns Tabs + active-tab metadata.
   * @throws {Error} When the renderer does not reply in time.
   */
  async list(): Promise<CellListResult> {
    return (await this.request({ op: "list" })) as CellListResult;
  }

  /**
   * Ask the renderer for one cell tab's full source.
   *
   * @param tabId - The cell tab id.
   * @returns The tab's id, optional name, and source code.
   * @throws {Error} When no tab matches or the renderer does not reply.
   */
  async read(tabId: number): Promise<CellReadResult> {
    return (await this.request({ op: "read", tabId })) as CellReadResult;
  }

  /**
   * One-way: update a cell tab's source (or append a new tab).
   *
   * @param payload - The write payload.
   * @returns Nothing.
   */
  write(payload: CellWritePush): void {
    this.push(IPC.push.cellWrite, payload);
  }

  /**
   * Resolve a pending request from a renderer `cells:respond` reply.
   * Called by the wiring layer's invoke handler; late replies after a
   * timeout are dropped silently.
   *
   * @param response - The renderer's reply payload.
   * @returns Nothing.
   */
  deliver(response: CellsResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return; // late reply after timeout — drop silently
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok && response.result) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error ?? "Cell request failed"));
    }
  }

  private async request(
    body: { op: "list" | "read"; tabId?: number },
  ): Promise<CellListResult | CellReadResult> {
    return new Promise<CellListResult | CellReadResult>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `Cell ${body.op} timed out after ${DEFAULT_TIMEOUT_MS}ms ` +
              `(renderer did not reply)`,
          ),
        );
      }, DEFAULT_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.push(IPC.push.cellsRequest, { requestId, ...body });
    });
  }
}
