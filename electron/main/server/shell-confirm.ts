/**
 * shell-confirm.ts — Reverse-RPC native-confirm broker for the extracted
 * pdv-server.
 *
 * Server-side handlers occasionally need a blocking native confirmation
 * (see `server/confirm.ts`). In the extracted server there is no dialog
 * API, so the broker turns each `confirm()` call into a
 * `pdv.rpc.confirmRequest` push; the shell shows the dialog and answers
 * with a `pdv.rpc.confirmResponse` invoke, which `server-main.ts` routes
 * to {@link ShellConfirmBroker.deliver}.
 *
 * There is deliberately no timeout: a confirmation dialog waits for the
 * user. If the connection dies before an answer arrives, the process owner
 * calls {@link ShellConfirmBroker.cancelAll} so every pending confirm
 * settles with its safe cancel choice.
 *
 * This module does NOT show dialogs, perform I/O, or depend on Electron.
 */

import type { RpcConfirmRequest, RpcConfirmResponse } from "../transport/protocol";
import { RPC_CHANNELS } from "../transport/protocol";
import type { ConfirmFn, ConfirmOptions } from "./confirm";
import type { PushSender } from "./invoke-registry";

/** A confirm awaiting the shell's answer. */
interface PendingConfirm {
  resolve: (response: number) => void;
  /** The safe answer used when the request can never be answered. */
  cancelResponse: number;
}

/**
 * Broker turning injected `confirm()` calls into reverse RPC over the
 * transport (see the file header).
 */
export class ShellConfirmBroker {
  private readonly push: PushSender;
  private readonly pending = new Map<string, PendingConfirm>();
  private nextId = 0;

  /**
   * @param push - The connection's push sender (stamps and writes the
   *   `confirmRequest` push).
   */
  constructor(push: PushSender) {
    this.push = push;
  }

  /**
   * The {@link ConfirmFn} to inject into the server wire: pushes a
   * `confirmRequest` and resolves when the shell's answer arrives (or with
   * the cancel choice on {@link ShellConfirmBroker.cancelAll}).
   *
   * @param options - Dialog options; see `server/confirm.ts`.
   * @returns Index of the clicked button.
   */
  readonly confirm: ConfirmFn = (options: ConfirmOptions): Promise<number> => {
    const requestId = String(++this.nextId);
    return new Promise<number>((resolve) => {
      this.pending.set(requestId, {
        resolve,
        cancelResponse: options.cancelId ?? 0,
      });
      const request: RpcConfirmRequest = { requestId, options };
      this.push(RPC_CHANNELS.confirmRequest, request);
    });
  };

  /**
   * Settle a pending confirm with the shell's answer. Unknown or already
   * settled request ids are ignored (a late answer after `cancelAll`).
   *
   * @param payload - The `confirmResponse` invoke's first argument.
   * @returns Nothing.
   */
  deliver(payload: unknown): void {
    const response = payload as Partial<RpcConfirmResponse> | undefined;
    if (!response || typeof response.requestId !== "string") {
      console.warn("[pdv-server] malformed confirmResponse ignored");
      return;
    }
    const entry = this.pending.get(response.requestId);
    if (!entry) return;
    this.pending.delete(response.requestId);
    entry.resolve(
      typeof response.response === "number"
        ? response.response
        : entry.cancelResponse
    );
  }

  /**
   * Settle every pending confirm with its safe cancel choice — called when
   * the connection to the shell is gone and no answer can ever arrive.
   *
   * @returns Nothing.
   */
  cancelAll(): void {
    for (const entry of this.pending.values()) {
      entry.resolve(entry.cancelResponse);
    }
    this.pending.clear();
  }
}
