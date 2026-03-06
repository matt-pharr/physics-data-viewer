/**
 * pdv-protocol.ts — TypeScript types for the PDV comm protocol envelope.
 *
 * All PDV messages sent over the Jupyter comm channel conform to the
 * envelope defined here. Contains ONLY type definitions (interfaces, type
 * aliases, const maps) and pure functions — no side effects.
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
const PDV_VERSION = "1.0" as const;

/** The version string imported by all production and test code. */
export const PDV_PROTOCOL_VERSION = PDV_VERSION;

/** Comm target name registered on the kernel (ARCHITECTURE.md §3.1). */
export const PDV_COMM_TARGET = "pdv.kernel" as const;

// ---------------------------------------------------------------------------
// Message type catalogue (ARCHITECTURE.md §3.4)
// ---------------------------------------------------------------------------

/** All PDV message type strings as named constants. */
export const PDVMessageType = {
  // Lifecycle
  /** Kernel → app. Sent once when pdv-python has fully initialized. */
  READY: "pdv.ready",
  /** App → kernel. Sent after pdv.ready; carries working dir and config. */
  INIT: "pdv.init",
  /** Kernel → app. Confirms pdv.init was accepted. */
  INIT_RESPONSE: "pdv.init.response",

  // Project
  /** App → kernel. Instructs kernel to load a project from a save directory. */
  PROJECT_LOAD: "pdv.project.load",
  /** Kernel → app (push). Sent after tree is fully populated from a load. */
  PROJECT_LOADED: "pdv.project.loaded",
  /** App → kernel. Instructs kernel to serialize the tree to a save directory. */
  PROJECT_SAVE: "pdv.project.save",
  /** Kernel → app. Confirms save; includes node_count and checksum. */
  PROJECT_SAVE_RESPONSE: "pdv.project.save.response",

  // Tree
  /** App → kernel. Request tree nodes at a given path. */
  TREE_LIST: "pdv.tree.list",
  /** Kernel → app. Returns array of node metadata objects. */
  TREE_LIST_RESPONSE: "pdv.tree.list.response",
  /** App → kernel. Request data value for a specific node. */
  TREE_GET: "pdv.tree.get",
  /** Kernel → app. Returns node value (may be lazy-loaded). */
  TREE_GET_RESPONSE: "pdv.tree.get.response",
  /** Kernel → app (push). Tree structure changed. */
  TREE_CHANGED: "pdv.tree.changed",

  // Namespace
  /** App → kernel. Request a snapshot of the kernel namespace. */
  NAMESPACE_QUERY: "pdv.namespace.query",
  /** Kernel → app. Returns array of variable descriptors. */
  NAMESPACE_QUERY_RESPONSE: "pdv.namespace.query.response",

  // Script
  /** App → kernel. Register a newly created script file as a tree node. */
  SCRIPT_REGISTER: "pdv.script.register",
  /** Kernel → app. Confirms script registration. */
  SCRIPT_REGISTER_RESPONSE: "pdv.script.register.response",

  // File
  /** App → kernel. Register a file-backed node (namelist, Fortran source, or opaque file). */
  FILE_REGISTER: "pdv.file.register",
  /** Kernel → app. Confirms file registration. */
  FILE_REGISTER_RESPONSE: "pdv.file.register.response",
} as const;

/** Union of all PDV message type string values. */
type PDVMessageTypeValue =
  (typeof PDVMessageType)[keyof typeof PDVMessageType];

// ---------------------------------------------------------------------------
// Base envelope (ARCHITECTURE.md §3.2)
// ---------------------------------------------------------------------------

/**
 * All PDV messages — inbound and outbound — use this envelope.
 *
 * For outgoing requests, `status` is omitted; for incoming responses it is
 * always present. The `in_reply_to` field is null for push notifications.
 */
export interface PDVMessage {
  /** Protocol version. Major version must match PDV_VERSION. */
  pdv_version: string;
  /** Unique ID for this message (UUID v4). */
  msg_id: string;
  /** msg_id of the request this is replying to, or null for push notifications. */
  in_reply_to: string | null;
  /** Dot-namespaced message type (e.g. "pdv.tree.list.response"). */
  type: string;
  /** "ok" or "error". Present on responses; absent on requests (ARCHITECTURE.md §3.2). */
  status?: "ok" | "error";
  /** Message payload — shape depends on type. */
  payload: Record<string, unknown>;
}



// ---------------------------------------------------------------------------
// Error payload (status = "error", ARCHITECTURE.md §3.5)
// ---------------------------------------------------------------------------

/** Standard payload shape for protocol responses with `status: "error"`. */
interface PDVErrorPayload {
  /** Machine-readable dot-namespaced error code (e.g. "tree.path_not_found"). */
  code: string;
  /** Human-readable message suitable for display in the UI. */
  message: string;
}

// ---------------------------------------------------------------------------
// Lifecycle message payloads (ARCHITECTURE.md §3.4)
// ---------------------------------------------------------------------------

/** Payload for pdv.init (app → kernel). */
interface PDVInitPayload {
  /** Absolute path to the PDV working directory created by the app. */
  working_dir: string;
  /** PDV protocol version the app expects. */
  pdv_version: string;
}

/** Payload for pdv.init.response (kernel → app). */
interface PDVInitResponsePayload {
  /** Absolute path the kernel accepted as working directory. */
  working_dir: string;
}

// ---------------------------------------------------------------------------
// Project message payloads
// ---------------------------------------------------------------------------

/** Payload for pdv.project.load (app → kernel). */
interface PDVProjectLoadPayload {
  /** Absolute path to the project save directory. */
  save_dir: string;
}

/** Payload for pdv.project.loaded push notification (kernel → app). */
export interface PDVProjectLoadedPayload {
  /** Total number of tree nodes loaded from the project. */
  node_count: number;
  /** Human-readable project name from project.json. */
  project_name: string;
  /** ISO 8601 timestamp of when the project was last saved. */
  saved_at: string;
}

/** Payload for pdv.project.save (app → kernel). */
interface PDVProjectSavePayload {
  /** Absolute path to the project save directory. */
  save_dir: string;
}

/** Payload for pdv.project.save.response (kernel → app). */
interface PDVProjectSaveResponsePayload {
  /** Total number of tree nodes serialized. */
  node_count: number;
  /** SHA-256 checksum of the written tree-index.json. */
  checksum: string;
}

// ---------------------------------------------------------------------------
// Tree message payloads (ARCHITECTURE.md §3.4, §7.2, §7.3)
// ---------------------------------------------------------------------------

/** Payload for pdv.tree.list (app → kernel). */
interface PDVTreeListPayload {
  /** Dot-separated path to list, or "" / null for root. */
  path?: string | null;
}

/** Payload for pdv.tree.get (app → kernel). */
interface PDVTreeGetPayload {
  /** Dot-separated path of the node to retrieve. */
  path: string;
}

/** Payload for pdv.tree.changed push notification (kernel → app). */
export interface PDVTreeChangedPayload {
  /** Dot-paths of changed nodes. */
  changed_paths: string[];
  /** Type of change. */
  change_type: "added" | "removed" | "updated";
}

// ---------------------------------------------------------------------------
// Namespace message payloads
// ---------------------------------------------------------------------------

/** Payload for pdv.namespace.query (app → kernel). */
interface PDVNamespaceQueryPayload {
  /** If true, include names starting with underscore. */
  include_private?: boolean;
  /** If true, include imported modules. */
  include_modules?: boolean;
  /** If true, include callable objects (functions, classes). */
  include_callables?: boolean;
}

// ---------------------------------------------------------------------------
// Script message payloads
// ---------------------------------------------------------------------------

/** Payload for pdv.script.register (app → kernel). */
interface PDVScriptRegisterPayload {
  /** Dot-separated path where the script node should appear in the tree. */
  tree_path: string;
  /** Relative path to the script file from the project root. */
  relative_path: string;
  /** If true, re-register an already-registered script (reload). */
  reload?: boolean;
}

/** Payload for pdv.file.register (app → kernel). */
export interface PDVFileRegisterPayload {
  /** Dot-path of the parent node; empty string for root. */
  tree_path: string;
  /** Physical filename with extension (e.g. "input.nml"). */
  filename: string;
  /** Node type classification for the file. */
  node_type: "namelist" | "fortran" | "file";
}

// ---------------------------------------------------------------------------
// Node descriptor (ARCHITECTURE.md §7.2, §7.3)
// ---------------------------------------------------------------------------

/** Known node kind values. */
const NodeKind = {
  NDARRAY: "ndarray",
  DATAFRAME: "dataframe",
  SERIES: "series",
  SCALAR: "scalar",
  TEXT: "text",
  MAPPING: "mapping",
  SEQUENCE: "sequence",
  SCRIPT: "script",
  BINARY: "binary",
  FOLDER: "folder",
  UNKNOWN: "unknown",
  NAMELIST: "namelist",
  FORTRAN: "fortran",
  FILE: "file",
} as const;

/** Union of all valid node `type` values in tree descriptors. */
type NodeKindValue = (typeof NodeKind)[keyof typeof NodeKind];

/** Script run() parameter descriptor extracted by pdv-python from function signatures. */
export interface ScriptParameter {
  /** Parameter name in the Python run() signature. */
  name: string;
  /** Stringified annotation type (e.g. "float", "int", "str", "any"). */
  type: string;
  /** Default value (null when required/no default). */
  default: unknown;
  /** True when no default is defined in the signature. */
  required: boolean;
}

/** Describes a single tree node as returned by pdv.tree.list.response. */
export interface NodeDescriptor {
  /** Stable node id (usually equal to path). */
  id?: string;
  /** Dot-separated full path (e.g. "data.waveforms.ch1"). */
  path: string;
  /** Leaf key (e.g. "ch1"). */
  key: string;
  /** Dot-separated parent path, or null for top-level nodes. */
  parent_path: string | null;
  /** Data type classification. */
  type: NodeKindValue;
  /** True if this node has child nodes. */
  has_children: boolean;
  /** True if the data has not yet been loaded from the save directory. */
  lazy: boolean;
  /** ISO 8601 creation timestamp. */
  created_at?: string;
  /** ISO 8601 last-modification timestamp. */
  updated_at?: string;
  /** Human-readable preview string (e.g. "float64 array (1024 × 4)"). */
  preview?: string;
  /** Script language for script nodes. */
  language?: string | null;
  /** Script parameters for script nodes only. */
  params?: ScriptParameter[];
  /** Physical filename with extension for file-backed nodes (e.g. "run.nml"). Null for others. */
  filename?: string | null;
}

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

/**
 * Type guard: returns true when `data` is a structurally valid PDVMessage.
 *
 * @param data - Any value to test.
 * @returns True if `data` conforms to PDVMessage.
 */
export function isPDVMessage(data: unknown): data is PDVMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    typeof msg.pdv_version === "string" &&
    typeof msg.msg_id === "string" &&
    (msg.in_reply_to === null || typeof msg.in_reply_to === "string") &&
    typeof msg.type === "string" &&
    (msg.status === undefined || msg.status === "ok" || msg.status === "error") &&
    typeof msg.payload === "object" &&
    msg.payload !== null
  );
}



// ---------------------------------------------------------------------------
// Version compatibility (ARCHITECTURE.md §3.6)
// ---------------------------------------------------------------------------

/**
 * Check whether an incoming message's protocol version is compatible with
 * the version this build of the app expects.
 *
 * - `'ok'`: Major and minor versions both match.
 * - `'minor_mismatch'`: Major matches; minor differs (tolerated, warn only).
 * - `'major_mismatch'`: Major versions differ (incompatible; reject message).
 *
 * @param msg - The incoming PDVMessage.
 * @returns Compatibility verdict.
 */
export function checkVersionCompatibility(
  msg: PDVMessage
): "ok" | "major_mismatch" | "minor_mismatch" {
  const myParts = PDV_VERSION.split(".").map(Number);
  const myMajor = myParts[0] ?? 0;
  const myMinor = myParts[1] ?? 0;

  const inParts = (msg.pdv_version ?? "0.0").split(".").map(Number);
  const inMajor = inParts[0] ?? 0;
  const inMinor = inParts[1] ?? 0;

  if (inMajor !== myMajor) return "major_mismatch";
  if (inMinor !== myMinor) return "minor_mismatch";
  return "ok";
}
