/**
 * cell-rpc.ts — Main-side RPC client for the renderer's code-cell state.
 *
 * Code cells live only in the renderer's React state (ARCHITECTURE.md §15.8).
 * The MCP cell tools therefore use a request/response pattern: main pushes a
 * request to the renderer, the renderer answers via `cells:respond` keyed by
 * the request id. One-way pushes apply writes.
 *
 * Responsibilities
 * - Owns the `ipcMain.handle(IPC.cells.respond)` handler — the renderer's
 *   reply lands here and resolves the matching pending promise.
 * - Provides typed `list()` / `read(tabId)` / `write(payload)` methods for
 *   tool code that does not want to think about request ids or timeouts.
 *
 * What it does NOT do
 * - It is not an MCP tool itself; it is a helper consumed by the cell tools
 *   in `tools/execution.ts` (Phase 2).
 * - It does not interpret cell content beyond the renderer-shape types.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.8 — Renderer Interaction
 */

import { BrowserWindow, ipcMain } from "electron";

import { randomUUID } from "node:crypto";

import {
  type CellListResult,
  type CellReadResult,
  type CellWritePush,
  type CellsResponse,
  IPC,
} from "../ipc";

/** How long a cell request waits before failing if the renderer never replies. */
const DEFAULT_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (result: CellListResult | CellReadResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Bridges main-process callers (the MCP cell tools) to renderer code-cell state.
 *
 * The client is window-bound — it sends pushes via the supplied BrowserWindow
 * accessor and matches responses back to pending requests by `requestId`. Call
 * {@link start} once at app boot to register the IPC handler; call {@link stop}
 * during shutdown so the handler is detached cleanly.
 */
export class CellRpcClient {
  private readonly getWindow: () => BrowserWindow | null;
  private readonly pending = new Map<string, PendingRequest>();
  private started = false;

  /**
   * @param getWindow - Accessor for the renderer window that owns the cell
   *   tabs. Returns `null` when no window is open — calls in that state are
   *   rejected rather than throwing synchronously.
   */
  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  /**
   * Register the `cells:respond` IPC handler. Idempotent.
   *
   * @returns Nothing.
   */
  start(): void {
    if (this.started) return;
    ipcMain.handle(IPC.cells.respond, (_event, response: CellsResponse) => {
      this.deliver(response);
    });
    this.started = true;
  }

  /**
   * Detach the IPC handler and reject any in-flight requests.
   *
   * @returns Nothing.
   */
  stop(): void {
    if (!this.started) return;
    ipcMain.removeHandler(IPC.cells.respond);
    this.started = false;
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
   * @throws {Error} When the renderer is unreachable or does not reply.
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
   * @throws {Error} When no renderer window is available.
   */
  write(payload: CellWritePush): void {
    const win = this.getWindow();
    if (!win) {
      throw new Error("Cell write failed: no renderer window");
    }
    win.webContents.send(IPC.push.cellWrite, payload);
  }

  private async request(
    body: { op: "list" | "read"; tabId?: number },
  ): Promise<CellListResult | CellReadResult> {
    const win = this.getWindow();
    if (!win) {
      throw new Error(`Cell ${body.op} failed: no renderer window`);
    }
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
      win.webContents.send(IPC.push.cellsRequest, { requestId, ...body });
    });
  }

  private deliver(response: CellsResponse): void {
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
}
