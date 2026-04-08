/**
 * comm-router.ts — Routes PDV comm messages between the kernel and the app.
 *
 * CommRouter sits on top of KernelManager's raw iopub stream and turns
 * Jupyter comm_msg frames into typed PDVMessage objects.  It provides two
 * communication patterns:
 *
 * 1. **Request / response** (CommRouter.request) — sends a PDV message on
 *    the shell socket and returns a Promise that resolves when the matching
 *    in_reply_to response arrives on iopub, or rejects on timeout/error.
 *
 * 2. **Push notifications** (CommRouter.onPush) — registers listeners for
 *    unsolicited kernel-initiated messages (e.g. pdv.tree.changed).
 *
 * CommRouter is stateless between attach() / detach() cycles. Call attach()
 * once per kernel session and detach() before discarding the router or when
 * the kernel dies.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §3 (comm protocol), §3.2 (envelope), §3.3 (routing)
 * pdv-protocol.ts — TypeScript types for PDV messages
 * kernel-manager.ts — owns the ZeroMQ sockets; CommRouter calls its methods
 */

import * as crypto from "crypto";
import {
  PDVMessage,
  PDVErrorPayload,
  getAppVersion,
  PDV_COMM_TARGET,
  isPDVMessage,
  checkVersionCompatibility,
} from "./pdv-protocol";
import type { KernelManager, JupyterMessage } from "./kernel-manager";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when a PDV request receives a response with status='error'.
 */
export class PDVCommError extends Error {
  constructor(
    message: string,
    /** Machine-readable error code from the payload (e.g. "tree.path_not_found"). */
    public readonly code: string,
    /** The full error response envelope. */
    public readonly response: PDVMessage
  ) {
    super(message);
    this.name = "PDVCommError";
  }
}

/**
 * Validate and narrow an error response payload to {@link PDVErrorPayload}.
 *
 * ARCHITECTURE.md §3.5 specifies that every error envelope must carry both
 * `code` and `message` as strings. Earlier code defaulted missing fields to
 * `"unknown"` / `"PDV error"`, which silently masked malformed errors. This
 * validator surfaces them as a typed PDVCommError with a synthetic
 * `protocol.malformed_error` code and the raw payload preview in the message,
 * so contract violations are visible during development.
 *
 * @param raw - Untyped payload from a status='error' PDVMessage.
 * @param msg - The full enclosing PDVMessage (used as the error response).
 * @returns A validated PDVErrorPayload, or a synthetic one describing the
 *   malformed payload when validation fails.
 */
function parsePDVErrorPayload(raw: unknown, msg: PDVMessage): PDVErrorPayload {
  if (
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { code?: unknown }).code === "string" &&
    typeof (raw as { message?: unknown }).message === "string"
  ) {
    return raw as PDVErrorPayload;
  }
  let preview: string;
  try {
    preview = JSON.stringify(raw);
  } catch {
    preview = String(raw);
  }
  console.error(
    `[CommRouter] Malformed error payload on ${msg.type} (msg_id=${msg.msg_id}): ${preview}`
  );
  return {
    code: "protocol.malformed_error",
    message: `Malformed error payload received from kernel (${msg.type}): ${preview}`,
  };
}

/**
 * Thrown when a PDV request receives no response within the configured
 * timeout window.
 */
export class PDVCommTimeoutError extends Error {
  constructor(
    message: string,
    /** The PDV message type that timed out. */
    public readonly messageType: string
  ) {
    super(message);
    this.name = "PDVCommTimeoutError";
  }
}

/**
 * Thrown (and logged) when an incoming message has an incompatible major
 * protocol version.
 */
class PDVVersionError extends Error {
  constructor(public readonly incomingVersion: string) {
    super(
      `Incompatible PDV protocol version: received ${incomingVersion}, ` +
        `expected major version ${getAppVersion().split(".")[0]}`
    );
    this.name = "PDVVersionError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback invoked when a push notification arrives (no in_reply_to). */
type PushHandler = (msg: PDVMessage) => void;

/** A pending request waiting for a matching in_reply_to on iopub. */
interface PendingRequest {
  resolve: (msg: PDVMessage) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  type: string;
}

/** Options for {@link CommRouter.request}. */
interface CommRequestOptions {
  /** Rejection timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
  /**
   * Push message type that resets the timeout timer on each arrival.
   *
   * When set, receiving a push of this type while the request is pending
   * resets the timeout clock, preventing timeout during long-running
   * operations that report progress via push notifications.
   */
  keepAlivePushType?: string;
}

// ---------------------------------------------------------------------------
// CommRouter class
// ---------------------------------------------------------------------------

/**
 * CommRouter — PDV protocol router on top of the raw iopub stream.
 *
 * Usage:
 * ```ts
 * const router = new CommRouter();
 * router.attach(kernelManager, kernelId);
 * const response = await router.request('pdv.tree.list', { path: null });
 * router.detach();
 * ```
 */
export class CommRouter {
  private kernelManager: KernelManager | null = null;
  private kernelId: string | null = null;

  /** The comm_id received from the kernel's comm_open message. */
  private commId: string | null = null;

  /** Unsubscribe function returned by KernelManager.onIopubMessage(). */
  private unsubscribe: (() => void) | null = null;

  /** Pending requests keyed by PDV msg_id. */
  private readonly pending = new Map<string, PendingRequest>();

  /** Push notification handlers keyed by PDV message type. */
  private readonly pushHandlers = new Map<string, Set<PushHandler>>();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Subscribe to iopub messages for the given kernel.
   *
   * Must be called before request() or onPush() will deliver anything.
   * Calling attach() while already attached silently replaces the previous
   * subscription after calling detach() first.
   *
   * @param kernelManager - The active KernelManager.
   * @param kernelId - The kernel ID to subscribe to.
   */
  attach(kernelManager: KernelManager, kernelId: string): void {
    if (this.kernelManager) {
      this.detach();
    }
    this.kernelManager = kernelManager;
    this.kernelId = kernelId;
    this.unsubscribe = kernelManager.onIopubMessage(
      kernelId,
      (msg) => void this._handleIopubMessage(msg)
    );
  }

  /**
   * Unsubscribe from iopub and reject all pending requests with a
   * cancellation error.
   *
   * Safe to call multiple times.
   */
  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.kernelManager = null;
    this.kernelId = null;
    this.commId = null;
    this._rejectAllPending(new PDVCommError(
      "CommRouter detached",
      "comm.detached",
      {
        pdv_version: getAppVersion(),
        msg_id: "",
        in_reply_to: null,
        type: "",
        status: "error",
        payload: { code: "comm.detached", message: "CommRouter detached" },
      }
    ));
  }

  // -------------------------------------------------------------------------
  // Request / response
  // -------------------------------------------------------------------------

  /**
   * Send a PDV request to the kernel and wait for the matching response.
   *
   * Generates a UUID msg_id, registers a pending entry, and sends a comm_msg
   * on the shell socket. The returned Promise resolves when a message with
   * matching in_reply_to arrives on iopub, or rejects on timeout or when
   * the response has status='error'.
   *
   * When `keepAlivePushType` is set, receiving a push of that type resets
   * the timeout clock, preventing timeout during long-running operations
   * that report progress via push notifications.
   *
   * @param type - PDV message type string (e.g. 'pdv.tree.list').
   * @param payload - Arbitrary message payload.
   * @param options - Optional timeout and keep-alive configuration.
   * @returns The response PDVMessage.
   * @throws {PDVCommError} when the response has status='error'.
   * @throws {PDVCommTimeoutError} when no response arrives within timeoutMs.
   */
  request(
    type: string,
    payload: Record<string, unknown> = {},
    options: CommRequestOptions | number = {}
  ): Promise<PDVMessage> {
    // Support legacy call signature: request(type, payload, timeoutMs)
    const opts: CommRequestOptions = typeof options === "number"
      ? { timeoutMs: options }
      : options;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const { keepAlivePushType } = opts;

    if (!this.kernelManager || !this.kernelId) {
      return Promise.reject(
        new Error("CommRouter is not attached to a kernel")
      );
    }

    const msgId = crypto.randomUUID();

    return new Promise<PDVMessage>((resolve, reject) => {
      const createTimer = (): ReturnType<typeof setTimeout> =>
        setTimeout(() => {
          if (keepAliveHandler) this.offPush(keepAlivePushType!, keepAliveHandler);
          this.pending.delete(msgId);
          reject(new PDVCommTimeoutError(`PDV request timed out: ${type}`, type));
        }, timeoutMs);

      let timer = createTimer();

      // Keep-alive: reset the timeout whenever a matching push arrives.
      let keepAliveHandler: PushHandler | undefined;
      if (keepAlivePushType) {
        keepAliveHandler = () => {
          clearTimeout(timer);
          timer = createTimer();
          // Update the timer reference in the pending entry so cleanup works.
          const pending = this.pending.get(msgId);
          if (pending) pending.timer = timer;
        };
        this.onPush(keepAlivePushType, keepAliveHandler);
      }

      const cleanup = (): void => {
        if (keepAliveHandler) this.offPush(keepAlivePushType!, keepAliveHandler);
      };

      this.pending.set(msgId, {
        resolve: (msg) => { cleanup(); resolve(msg); },
        reject: (err) => { cleanup(); reject(err); },
        timer,
        type,
      });

      const envelope: Record<string, unknown> = {
        pdv_version: getAppVersion(),
        msg_id: msgId,
        in_reply_to: null,
        type,
        payload,
      };

      this.kernelManager!
        .sendCommMsg(this.kernelId!, this.commId, envelope)
        .catch((err) => {
          cleanup();
          this.pending.delete(msgId);
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // -------------------------------------------------------------------------
  // Push notifications
  // -------------------------------------------------------------------------

  /**
   * Register a handler for unsolicited push notifications of a given type.
   *
   * Multiple handlers may be registered for the same type; they are all
   * called in registration order.
   *
   * @param type - PDV message type string (e.g. 'pdv.tree.changed').
   * @param handler - Called whenever a matching push notification arrives.
   */
  onPush(type: string, handler: PushHandler): void {
    let handlers = this.pushHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.pushHandlers.set(type, handlers);
    }
    handlers.add(handler);
  }

  /**
   * Remove a previously registered push handler.
   *
   * @param type - PDV message type string.
   * @param handler - The exact handler reference that was passed to onPush().
   */
  offPush(type: string, handler: PushHandler): void {
    this.pushHandlers.get(type)?.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Internal message handling
  // -------------------------------------------------------------------------

  /**
   * Handle a raw iopub JupyterMessage from KernelManager.
   *
   * Only processes messages with msg_type='comm_msg' or 'comm_open'. For
   * comm_open, captures the comm_id for subsequent requests. For comm_msg,
   * extracts and validates the PDV envelope then dispatches to either the
   * pending request registry or push handlers.
   *
   * @param raw - Parsed JupyterMessage from the iopub socket.
   */
  _handleIopubMessage(raw: JupyterMessage): void {
    const msgType = raw.header.msg_type;

    // Track the comm_id when the kernel opens the comm channel.
    if (msgType === "comm_open") {
      const target = raw.content.target_name;
      if (target === PDV_COMM_TARGET) {
        this.commId = String(raw.content.comm_id ?? "");
      }
      return;
    }

    if (msgType !== "comm_msg") return;

    // Extract the PDV envelope from the comm_msg data field.
    const data = raw.content.data;
    if (!isPDVMessage(data)) return;

    const msg = data as PDVMessage;

    // Validate protocol version — reject messages with incompatible major.
    const compat = checkVersionCompatibility(msg);
    if (compat === "major_mismatch") {
      console.error(
        `[CommRouter] Rejecting message: incompatible PDV version ${msg.pdv_version}`
      );
      // If there's a pending request whose response this was, reject it too.
      if (msg.in_reply_to) {
        const pending = this.pending.get(msg.in_reply_to);
        if (pending) {
          this.pending.delete(msg.in_reply_to);
          clearTimeout(pending.timer);
          pending.reject(new PDVVersionError(msg.pdv_version));
        }
      }
      return;
    }

    if (compat === "minor_mismatch") {
      console.warn(
        `[CommRouter] Minor version mismatch: received ${msg.pdv_version}, ` +
          `expected ${getAppVersion()}`
      );
    }

    // Dispatch: response (has in_reply_to) vs push (in_reply_to is null).
    if (msg.in_reply_to) {
      this._dispatchResponse(msg);
    } else {
      this._dispatchPush(msg);
    }
  }

  /** Resolve or reject a pending request whose msg_id matches in_reply_to. */
  private _dispatchResponse(msg: PDVMessage): void {
    const pending = this.pending.get(msg.in_reply_to!);
    if (!pending) return; // Response for an unknown or already-resolved request.

    this.pending.delete(msg.in_reply_to!);
    clearTimeout(pending.timer);

    if (msg.status === "error") {
      const payload = parsePDVErrorPayload(msg.payload, msg);
      pending.reject(new PDVCommError(payload.message, payload.code, msg));
    } else {
      pending.resolve(msg);
    }
  }

  /** Forward a push notification (no in_reply_to) to registered handlers. */
  private _dispatchPush(msg: PDVMessage): void {
    const handlers = this.pushHandlers.get(msg.type);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(msg);
      } catch (err) {
        console.error("[CommRouter] push handler threw:", err);
      }
    }
  }

  /** Reject every pending request (used by detach() and reset()). */
  private _rejectAllPending(err: unknown): void {
    for (const [_msgId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /** Return the current comm_id (for diagnostics). */
  getCommId(): string | null {
    return this.commId;
  }

  /**
   * Reject all pending request promises and clear push handlers.
   *
   * Called when the kernel dies or the comm channel closes unexpectedly.
   */
  reset(): void {
    this._rejectAllPending(
      new PDVCommError(
        "CommRouter reset",
        "comm.reset",
        {
          pdv_version: getAppVersion(),
          msg_id: "",
          in_reply_to: null,
          type: "",
          status: "error",
          payload: { code: "comm.reset", message: "CommRouter reset" },
        }
      )
    );
    this.pushHandlers.clear();
  }
}
