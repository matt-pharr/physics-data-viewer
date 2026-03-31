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

/* eslint-disable @typescript-eslint/no-unused-vars -- payload interfaces document the protocol schema (ARCHITECTURE.md §3.4) */

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
  /** Kernel → app (push). Progress update during save/load operations. */
  PROGRESS: "pdv.progress",

  // Tree
  /** App → kernel. Request tree nodes at a given path. */
  TREE_LIST: "pdv.tree.list",
  /** Kernel → app. Returns array of node metadata objects. */
  TREE_LIST_RESPONSE: "pdv.tree.list.response",
  /** App → kernel. Request data value for a specific node. */
  TREE_GET: "pdv.tree.get",
  /** Kernel → app. Returns node value. */
  TREE_GET_RESPONSE: "pdv.tree.get.response",
  /** App → kernel. Resolve a file-backed tree node to its absolute path. */
  TREE_RESOLVE_FILE: "pdv.tree.resolve_file",
  /** Kernel → app. Returns the resolved absolute file path. */
  TREE_RESOLVE_FILE_RESPONSE: "pdv.tree.resolve_file.response",
  /** Kernel → app (push). Tree structure changed. */
  TREE_CHANGED: "pdv.tree.changed",

  // Namespace
  /** App → kernel. Request a snapshot of the kernel namespace. */
  NAMESPACE_QUERY: "pdv.namespace.query",
  /** Kernel → app. Returns array of variable descriptors. */
  NAMESPACE_QUERY_RESPONSE: "pdv.namespace.query.response",
  /** App → kernel. Inspect one namespace value lazily. */
  NAMESPACE_INSPECT: "pdv.namespace.inspect",
  /** Kernel → app. Returns child descriptors for one namespace value. */
  NAMESPACE_INSPECT_RESPONSE: "pdv.namespace.inspect.response",

  // Script
  /** App → kernel. Register a newly created script file as a tree node. */
  SCRIPT_REGISTER: "pdv.script.register",
  /** Kernel → app. Confirms script registration. */
  SCRIPT_REGISTER_RESPONSE: "pdv.script.register.response",
  /** App → kernel. Extract current run() parameters from a script file. */
  SCRIPT_PARAMS: "pdv.script.params",
  /** Kernel → app. Returns array of script parameter descriptors. */
  SCRIPT_PARAMS_RESPONSE: "pdv.script.params.response",

  // Note
  /** App → kernel. Register a newly created markdown note as a tree node. */
  NOTE_REGISTER: "pdv.note.register",
  /** Kernel → app. Confirms note registration. */
  NOTE_REGISTER_RESPONSE: "pdv.note.register.response",

  // File
  /** App → kernel. Register a file-backed node (namelist, library, or opaque file). */
  FILE_REGISTER: "pdv.file.register",
  /** Kernel → app. Confirms file registration. */
  FILE_REGISTER_RESPONSE: "pdv.file.register.response",

  // Module registration
  /** App → kernel. Register a PDVModule node in the tree. */
  MODULE_REGISTER: "pdv.module.register",
  /** Kernel → app. Confirms module registration. */
  MODULE_REGISTER_RESPONSE: "pdv.module.register.response",
  /** App → kernel. Register a PDVGui node in the tree. */
  GUI_REGISTER: "pdv.gui.register",
  /** Kernel → app. Confirms GUI registration. */
  GUI_REGISTER_RESPONSE: "pdv.gui.register.response",

  // Namelist
  /** App → kernel. Read and parse a namelist file in the tree. */
  NAMELIST_READ: "pdv.namelist.read",
  /** Kernel → app. Parsed namelist data with hints and types. */
  NAMELIST_READ_RESPONSE: "pdv.namelist.read.response",
  /** App → kernel. Write edited namelist data back to file. */
  NAMELIST_WRITE: "pdv.namelist.write",
  /** Kernel → app. Confirms write success. */
  NAMELIST_WRITE_RESPONSE: "pdv.namelist.write.response",

  // Modules
  /** App → kernel. Setup module library namespaces (sys.path + entry points). */
  MODULES_SETUP: "pdv.modules.setup",
  /** Kernel → app. Confirms module setup; carries registered handler map. */
  MODULES_SETUP_RESPONSE: "pdv.modules.setup.response",
  /** App → kernel. Invoke a registered type handler for a tree node. */
  HANDLER_INVOKE: "pdv.handler.invoke",
  /** Kernel → app. Confirms handler invocation result. */
  HANDLER_INVOKE_RESPONSE: "pdv.handler.invoke.response",
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

/** Payload for pdv.project.load.response (kernel → app). */
export interface PDVProjectLoadResponsePayload {
  /** Total number of tree nodes loaded from the project. */
  node_count: number;
  /** Content-based XXH3-128 checksum of the reconstructed in-memory tree. */
  post_load_checksum: string;
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

/** Selector used to drill into a namespace value. */
export interface PDVNamespaceAccessSegment {
  /** Access mode used at one step in the selector chain. */
  kind: "attr" | "index" | "key" | "column";
  /** Primitive selector value used to resolve the next child. */
  value: string | number | boolean | null;
}

/** Payload for pdv.namespace.inspect (app → kernel). */
export interface PDVNamespaceInspectPayload {
  /** Top-level namespace variable name. */
  root_name: string;
  /** Selector chain from the root variable to the current node. */
  path?: PDVNamespaceAccessSegment[];
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
  node_type: "namelist" | "lib" | "file";
  /** Optional explicit tree node name. When omitted the kernel derives it from filename. */
  name?: string;
  /** Optional module ID that owns this file node. */
  module_id?: string;
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
  FILE: "file",
  MODULE: "module",
  GUI: "gui",
  LIB: "lib",
  MARKDOWN: "markdown",
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
  /** ISO 8601 creation timestamp. */
  created_at?: string;
  /** ISO 8601 last-modification timestamp. */
  updated_at?: string;
  /** Human-readable preview string (e.g. "float64 array (1024 × 4)"). */
  preview?: string;
  /** Script language for script nodes. */
  language?: string | null;
  /** Physical filename with extension for file-backed nodes (e.g. "run.nml"). Null for others. */
  filename?: string | null;
  /** Fully qualified Python type string (e.g. "builtins.int"). */
  python_type?: string;
  /** True if a custom handler is registered for this node's type. */
  has_handler?: boolean;
  /** Module identifier. Present when type is "module" or "gui". */
  module_id?: string;
  /** Module display name. Present when type is "module". */
  module_name?: string;
  /** Module version. Present when type is "module". */
  module_version?: string;
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
