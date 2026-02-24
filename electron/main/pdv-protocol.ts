/**
 * pdv-protocol.ts — TypeScript types for the PDV comm protocol envelope.
 *
 * All PDV messages sent over the Jupyter comm channel conform to the
 * envelope defined here. Implement only the type definitions (interfaces,
 * type aliases, const maps) — no runtime logic lives here.
 *
 * These types are consumed by:
 * - comm-router.ts  — parses raw comm data into typed messages
 * - kernel-manager.ts — constructs outbound messages
 * - project-manager.ts — reads response payloads
 * - ipc.ts — forwards responses to the renderer
 *
 * Reference: ARCHITECTURE.md §3.2, §3.4, §7.2, §7.3
 */

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/** The PDV protocol version this build targets. */
export const PDV_PROTOCOL_VERSION = "1.0" as const;

/** Comm target name registered on the kernel. */
export const PDV_COMM_TARGET = "pdv.kernel" as const;

// ---------------------------------------------------------------------------
// Base envelope
// ---------------------------------------------------------------------------

/** All PDV messages — inbound and outbound — use this envelope. */
export interface PDVEnvelope {
  /** Protocol version. Major version must match PDV_PROTOCOL_VERSION. */
  pdv_version: string;
  /** Unique ID for this message (UUID v4). */
  msg_id: string;
  /** msg_id of the request this is replying to, or null for push notifications. */
  in_reply_to: string | null;
  /** Dot-namespaced message type (e.g. "pdv.tree.list.response"). */
  type: string;
  /** "ok" or "error". */
  status: "ok" | "error";
  /** Message payload — shape depends on type. */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Error payload (status = "error")
// ---------------------------------------------------------------------------

export interface PDVErrorPayload {
  /** Machine-readable error code (e.g. "tree.path_not_found"). */
  code: string;
  /** Human-readable error message for display in the UI. */
  message: string;
}

// ---------------------------------------------------------------------------
// Lifecycle message payloads
// ---------------------------------------------------------------------------

// TODO: Add payload interfaces for pdv.init, pdv.init.response, pdv.ready
// Reference: ARCHITECTURE.md §3.4 (lifecycle messages)

// ---------------------------------------------------------------------------
// Project message payloads
// ---------------------------------------------------------------------------

// TODO: Add payload interfaces for:
// - pdv.project.load
// - pdv.project.loaded (push notification)
// - pdv.project.save
// - pdv.project.save.response
// Reference: ARCHITECTURE.md §3.4 (project messages)

// ---------------------------------------------------------------------------
// Tree message payloads
// ---------------------------------------------------------------------------

// TODO: Add payload interfaces for:
// - pdv.tree.list, pdv.tree.list.response
// - pdv.tree.get, pdv.tree.get.response
// - pdv.tree.changed (push notification)
// Reference: ARCHITECTURE.md §3.4 (tree messages), §7.2, §7.3

// ---------------------------------------------------------------------------
// Namespace message payloads
// ---------------------------------------------------------------------------

// TODO: Add payload interfaces for:
// - pdv.namespace.query, pdv.namespace.query.response
// Reference: ARCHITECTURE.md §3.4 (namespace messages)

// ---------------------------------------------------------------------------
// Script message payloads
// ---------------------------------------------------------------------------

// TODO: Add payload interfaces for:
// - pdv.script.register, pdv.script.register.response
// Reference: ARCHITECTURE.md §3.4 (script messages)

// ---------------------------------------------------------------------------
// Node descriptor (shared by tree.list.response and tree.get.response)
// ---------------------------------------------------------------------------

// TODO: Add NodeDescriptor interface and NodeKind const enum
// Reference: ARCHITECTURE.md §7.2, §7.3

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

// TODO: Implement isPDVEnvelope(data: unknown): data is PDVEnvelope
// TODO: Implement isErrorEnvelope(msg: PDVEnvelope): boolean
