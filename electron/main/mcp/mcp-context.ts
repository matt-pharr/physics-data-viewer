/**
 * mcp-context.ts — Shared context passed to every MCP tool implementation.
 *
 * The MCP server runs in the Electron main process and reaches the kernel
 * through the same managers the IPC handlers use. `McpToolContext` bundles
 * those manager references plus the lifecycle accessors (`McpServerHooks`)
 * so each tool factory receives a single, testable dependency bag.
 *
 * This file contains type declarations only — no runtime logic.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15 — AI Agent Integration (MCP Server)
 * mcp-server.ts — constructs the context and owns the session registry
 */

import type { BrowserWindow } from "electron";

import type { CommRouter } from "../comm-router";
import type { ConfigStore } from "../config";
import type {
  TreeCreateLibResult,
  TreeCreateNoteResult,
  TreeCreateScriptResult,
} from "../ipc";
import type { KernelManager } from "../kernel-manager";
import type { ProjectManager } from "../project-manager";
import type { QueryRouter } from "../query-router";
import type { CellRpcClient } from "./cell-rpc";

/**
 * Lifecycle accessors the MCP server needs from the IPC-handler closure in
 * `index.ts`, where the active kernel/project ids and the generation counter
 * live as closure-scoped state.
 */
export interface McpServerHooks {
  /** Id of the currently active kernel, or `null` when none is running. */
  getActiveKernelId(): string | null;
  /** Absolute save directory of the active project, or `null` when none is open. */
  getActiveProjectDir(): string | null;
  /**
   * Kernel working directory for the active kernel, or `null` when no kernel
   * has been started yet. Used by execution tools to construct the per-run
   * `TranscriptWriter` (ARCHITECTURE.md §15.7).
   */
  getActiveWorkingDir(): string | null;
  /** Current project/kernel generation counter (ARCHITECTURE.md §15.3). */
  getGeneration(): number;
  /**
   * Increment the generation counter. Called when the active project,
   * kernel, or environment changes so connected MCP sessions become stale.
   */
  bumpGeneration(): void;
  /**
   * Pre-bound helpers for file-backed tree-node creation. Implementations
   * live in `index.ts` so they can close over the kernel working-dir map and
   * the project's module aliases; the MCP `create_tree_node` tool calls them
   * via the hooks without needing to know any of that wiring.
   */
  treeCreate: {
    /** Allocate a UUID-backed script file and register it with the kernel. */
    script(
      kernelId: string,
      parentPath: string,
      scriptName: string,
    ): Promise<TreeCreateScriptResult>;
    /** Allocate a UUID-backed Markdown note and register it with the kernel. */
    note(
      kernelId: string,
      parentPath: string,
      noteName: string,
    ): Promise<TreeCreateNoteResult>;
    /** Allocate a UUID-backed importable lib file and register it with the kernel. */
    lib(
      kernelId: string,
      parentPath: string,
      libName: string,
    ): Promise<TreeCreateLibResult>;
  };
}

/**
 * Everything an MCP tool implementation needs to reach the kernel and
 * inspect app state. Constructed once by `PdvMcpServer` and passed to every
 * tool factory.
 */
export interface McpToolContext {
  /** Kernel process manager (kernel status, raw execution). */
  kernelManager: KernelManager;
  /** Comm-channel router — used for write/side-effecting kernel messages. */
  commRouter: CommRouter;
  /** Query-socket router — used for read-only kernel queries. */
  queryRouter: QueryRouter;
  /** Project lifecycle manager. */
  projectManager: ProjectManager;
  /** Persistent app configuration store. */
  configStore: ConfigStore;
  /** Lifecycle accessors from the IPC-handler closure. */
  hooks: McpServerHooks;
  /** App version string (`app.getVersion()`), surfaced by `project_info`. */
  appVersion: string;
  /**
   * Renderer code-cell RPC client (ARCHITECTURE.md §15.8). Used by the MCP
   * cell tools to read and write the renderer's live cell tabs.
   */
  cellRpc: CellRpcClient;
  /**
   * Accessor for the renderer window an agent run's output should stream
   * into. Returns `null` when no window is open. Used by execution tools to
   * forward iopub chunks to the Console via `IPC.push.executeOutput` so
   * agent-initiated runs are visible alongside user runs (ARCHITECTURE.md
   * §15.9).
   */
  getRendererWindow(): BrowserWindow | null;
  /**
   * Generation a given MCP session connected at, or `undefined` for an
   * unknown session. Used by tools to reject calls from a session that
   * connected before a project/kernel change (ARCHITECTURE.md §15.3).
   *
   * @param sessionId - The MCP session id, or `undefined`.
   * @returns The connect-time generation, or `undefined`.
   */
  getSessionGeneration(sessionId: string | undefined): number | undefined;
  /**
   * Record that the calling MCP session has just read a code-cell tab, along
   * with a hash of the source that was returned. Used by the `cell_write`
   * read-before-write guard to detect concurrent edits by the user or
   * another agent.
   *
   * @param sessionId - The MCP session id (or `undefined` for an unknown
   *   session — recorded but never matched).
   * @param tabId - The cell tab id.
   * @param code - The cell source the session just observed.
   */
  recordCellRead(
    sessionId: string | undefined,
    tabId: number,
    code: string,
  ): void;
  /**
   * Hash of the cell source the given session most recently observed for the
   * given tab, or `undefined` when the session has not read that tab in this
   * connection.
   *
   * @param sessionId - The MCP session id, or `undefined`.
   * @param tabId - The cell tab id.
   * @returns The recorded hash, or `undefined`.
   */
  getCellReadHash(
    sessionId: string | undefined,
    tabId: number,
  ): string | undefined;
}
