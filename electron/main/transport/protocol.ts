/**
 * protocol.ts — Envelope types and reserved channels for the pdv-server
 * RPC transport.
 *
 * The transport carries the existing `ipc.ts` channel names verbatim over
 * newline-delimited JSON (see `line-codec.ts`). Three envelope shapes flow
 * on the wire:
 *
 *  - {@link RpcRequest}  — client → server invoke (`{id, channel, args}`).
 *  - {@link RpcResponse} — server → client settlement (`{id, result|error}`).
 *  - {@link RpcPush}     — server → client notification (`{event, payload, seq}`).
 *
 * A small set of `pdv.rpc.*` channels is reserved for transport-internal
 * traffic (hello/ping/shutdown/…). These are consumed by the shell bridge
 * and NEVER forwarded to the preload/renderer.
 *
 * This module does NOT perform I/O, own application channel names (those
 * live in `ipc.ts`), or depend on Electron or Node APIs — it is pure types
 * and constants shared by `rpc-client.ts` and `rpc-server.ts`.
 */

/**
 * Version of the transport envelope format itself. Advertised in the hello
 * push; bumped only when the envelope shapes here change incompatibly.
 * Distinct from the unified app version (which the hello also carries and
 * which the shell checks for an exact match).
 */
export const RPC_PROTOCOL_VERSION = 1;

/** Serialized error carried in an {@link RpcResponse}. */
export interface RpcError {
  /** Error message — the renderer-visible text; must survive unchanged. */
  message: string;
  /** Error class name (e.g. `"UvBinaryNotFoundError"`), when available. */
  name?: string;
  /** Stack trace from the server process, for shell-side logging. */
  stack?: string;
}

/** Client → server invoke envelope. */
export interface RpcRequest {
  /** Client-generated monotonic id correlating the response. */
  id: string;
  /** IPC channel name (an `ipc.ts` constant, or a reserved `pdv.rpc.*`). */
  channel: string;
  /** Arguments exactly as the renderer passed them to `ipcRenderer.invoke`. */
  args: unknown[];
}

/**
 * Server → client settlement envelope. Exactly one of `result`/`error` is
 * present; a response with neither settles the invoke with `undefined`
 * (JSON serialization drops an `undefined` result — parity with a handler
 * that returns nothing).
 */
export interface RpcResponse {
  /** The correlating {@link RpcRequest} id. */
  id: string;
  /** Handler return value, when the invoke succeeded. */
  result?: unknown;
  /** Serialized rejection, when the invoke failed. */
  error?: RpcError;
}

/** Server → client push envelope (renderer push channels + reserved traffic). */
export interface RpcPush {
  /** Push channel name (an `ipc.ts` push constant, or `pdv.rpc.*`). */
  event: string;
  /** Push payload exactly as handed to the server's `PushSender`. */
  payload: unknown;
  /** Per-connection monotonic sequence number, stamped on every push. */
  seq: number;
}

/** Prefix shared by every reserved transport-internal channel. */
export const RPC_CHANNEL_PREFIX = "pdv.rpc.";

/**
 * Reserved transport-internal channels. Never exposed to preload — the
 * shell bridge consumes them.
 */
export const RPC_CHANNELS = {
  /** First push on every connection (seq 0): an {@link RpcHello} payload. */
  hello: "pdv.rpc.hello",
  /** Liveness invoke; result is an {@link RpcPingResult}. */
  ping: "pdv.rpc.ping",
  /** Graceful-teardown invoke (kernel stop, working-dir cleanup, exit 0). */
  shutdown: "pdv.rpc.shutdown",
  /** Invoke replacing the window-recreate session-state reset. */
  sessionReset: "pdv.rpc.sessionReset",
  /** Reverse-RPC native-confirm push (server → shell). */
  confirmRequest: "pdv.rpc.confirmRequest",
  /** Reverse-RPC native-confirm reply invoke (shell → server). */
  confirmResponse: "pdv.rpc.confirmResponse",
} as const;

/** Payload of the {@link RPC_CHANNELS.hello} push. */
export interface RpcHello {
  /** Unified app version; the shell aborts on any mismatch (exact-match rule). */
  version: string;
  /** Server process id, for supervision and diagnostics. */
  pid: number;
  /** {@link RPC_PROTOCOL_VERSION} of the server. */
  protocol: number;
  /** Session identifier; always `null` for local mode (remote is additive). */
  session: string | null;
}

/** Result of a {@link RPC_CHANNELS.ping} invoke. */
export interface RpcPingResult {
  /** Server wall-clock time (ms since epoch) when the ping was handled. */
  ts: number;
  /** Highest push seq the server has sent so far (−1 before any push). */
  seq: number;
}

/**
 * Whether a channel name is reserved for transport-internal traffic.
 *
 * @param channel - Channel name to classify.
 * @returns True when the channel starts with `pdv.rpc.`.
 */
export function isReservedRpcChannel(channel: string): boolean {
  return channel.startsWith(RPC_CHANNEL_PREFIX);
}

/** Narrowing helper: non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Type guard for {@link RpcRequest} envelopes (the only client → server shape).
 *
 * @param msg - A parsed JSON line.
 * @returns True when `msg` is structurally an RpcRequest.
 */
export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return (
    isRecord(msg) &&
    typeof msg.id === "string" &&
    typeof msg.channel === "string" &&
    Array.isArray(msg.args)
  );
}

/**
 * Type guard for {@link RpcResponse} envelopes.
 *
 * @param msg - A parsed JSON line.
 * @returns True when `msg` is structurally an RpcResponse.
 */
export function isRpcResponse(msg: unknown): msg is RpcResponse {
  return (
    isRecord(msg) &&
    typeof msg.id === "string" &&
    !("channel" in msg) &&
    !("event" in msg)
  );
}

/**
 * Type guard for {@link RpcPush} envelopes.
 *
 * @param msg - A parsed JSON line.
 * @returns True when `msg` is structurally an RpcPush.
 */
export function isRpcPush(msg: unknown): msg is RpcPush {
  return (
    isRecord(msg) &&
    typeof msg.event === "string" &&
    typeof msg.seq === "number"
  );
}
