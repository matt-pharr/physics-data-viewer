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

import type { CommRouter } from "../comm-router";
import type { ConfigStore } from "../config";
import type { KernelManager } from "../kernel-manager";
import type { ProjectManager } from "../project-manager";
import type { QueryRouter } from "../query-router";

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
  /** Current project/kernel generation counter (ARCHITECTURE.md §15.3). */
  getGeneration(): number;
  /**
   * Increment the generation counter. Called when the active project,
   * kernel, or environment changes so connected MCP sessions become stale.
   */
  bumpGeneration(): void;
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
   * Generation a given MCP session connected at, or `undefined` for an
   * unknown session. Used by tools to reject calls from a session that
   * connected before a project/kernel change (ARCHITECTURE.md §15.3).
   *
   * @param sessionId - The MCP session id, or `undefined`.
   * @returns The connect-time generation, or `undefined`.
   */
  getSessionGeneration(sessionId: string | undefined): number | undefined;
}
