/**
 * mcp-server.ts — The local MCP server for external AI coding agents.
 *
 * Runs inside the Electron main process for the lifetime of the app. Exposes
 * the active PDV project to MCP-capable agents (Claude Code, Codex, Cursor)
 * over Streamable HTTP on a loopback port, guarded by a bearer token.
 *
 * Responsibilities
 * - Owns the loopback `http.Server`, picks a free port, and routes requests
 *   to per-session `StreamableHTTPServerTransport` instances.
 * - Resolves the persisted bearer token and rejects unauthenticated requests.
 * - Tracks one `McpSession` per connected client, stamped with the
 *   project/kernel generation at connect time (ARCHITECTURE.md §15.3).
 *
 * What it does NOT do
 * - It does not own the kernel transport — tools reach the kernel through
 *   the shared `CommRouter` / `QueryRouter` / `KernelManager`.
 * - It is not a global singleton: one instance per project/window session,
 *   so multi-window can later run one server per window.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15 — AI Agent Integration (MCP Server)
 */

import { ipcMain } from "electron";

import { randomUUID } from "node:crypto";
import * as http from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { CommRouter } from "../comm-router";
import { DEFAULT_MCP_PORT } from "../config";
import type { ConfigStore } from "../config";
import { IPC, type McpStatus } from "../ipc";
import type { KernelManager } from "../kernel-manager";
import type { ProjectManager } from "../project-manager";
import type { QueryRouter } from "../query-router";
import { generateBearerToken, requestHasValidToken } from "./mcp-auth";
import type { McpServerHooks, McpToolContext } from "./mcp-context";
import { MCP_INSTRUCTIONS } from "./mcp-instructions";
import { registerAllTools } from "./tools";

/** Loopback host the MCP server always binds to. */
const HOST = "127.0.0.1";

/** How many consecutive ports to try before giving up. */
const MAX_PORT_ATTEMPTS = 20;

/** Constructor dependencies for {@link PdvMcpServer}. */
export interface PdvMcpServerDeps {
  /** Kernel process manager. */
  kernelManager: KernelManager;
  /** Comm-channel router. */
  commRouter: CommRouter;
  /** Query-socket router. */
  queryRouter: QueryRouter;
  /** Project lifecycle manager. */
  projectManager: ProjectManager;
  /** Persistent app configuration store. */
  configStore: ConfigStore;
  /** Lifecycle accessors from the IPC-handler closure. */
  hooks: McpServerHooks;
  /** App version string (`app.getVersion()`). */
  appVersion: string;
}

/** One connected MCP client session. */
interface McpSession {
  /** The session's Streamable HTTP transport. */
  transport: StreamableHTTPServerTransport;
  /** The MCP server instance bound to this session. */
  server: McpServer;
  /** Project/kernel generation the session connected at (ARCHITECTURE.md §15.3). */
  generation: number;
}

/**
 * The PDV MCP server. Construct once per project/window session; call
 * {@link start} on app launch and {@link stop} on quit.
 */
export class PdvMcpServer {
  private readonly deps: PdvMcpServerDeps;
  private readonly token: string;
  private readonly ctx: McpToolContext;
  private readonly sessions = new Map<string, McpSession>();
  private httpServer: http.Server | null = null;
  private port: number | null = null;

  /**
   * Construct the MCP server.
   *
   * @param deps - Manager references, lifecycle hooks, and the app version.
   */
  constructor(deps: PdvMcpServerDeps) {
    this.deps = deps;
    this.token = resolvePersistedToken(deps.configStore);
    this.ctx = {
      kernelManager: deps.kernelManager,
      commRouter: deps.commRouter,
      queryRouter: deps.queryRouter,
      projectManager: deps.projectManager,
      configStore: deps.configStore,
      hooks: deps.hooks,
      appVersion: deps.appVersion,
      getSessionGeneration: (sessionId) =>
        sessionId ? this.sessions.get(sessionId)?.generation : undefined,
    };
  }

  /**
   * Start listening on a loopback port. Idempotent — a second call is a
   * no-op while the server is already running.
   *
   * @returns Resolves once the server is listening.
   * @throws {Error} When no free port can be found.
   */
  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }
    const preferred =
      this.deps.configStore.get("mcp")?.defaultPort ?? DEFAULT_MCP_PORT;
    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    this.httpServer = server;
    try {
      this.port = await listenWithFallback(server, preferred, HOST);
    } catch (err) {
      this.httpServer = null;
      throw err;
    }
    console.log(`[mcp] server listening on http://${HOST}:${this.port}/mcp`);
    ipcMain.handle(IPC.mcp.getStatus, () => this.status);
  }

  /**
   * Close every session and stop listening.
   *
   * @returns Resolves once the HTTP server has closed.
   */
  async stop(): Promise<void> {
    ipcMain.removeHandler(IPC.mcp.getStatus);
    for (const session of this.sessions.values()) {
      try {
        await session.transport.close();
      } catch {
        /* best effort */
      }
      try {
        await session.server.close();
      } catch {
        /* best effort */
      }
    }
    this.sessions.clear();
    const server = this.httpServer;
    this.httpServer = null;
    this.port = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /**
   * Current server status for the Settings → Agents pane.
   *
   * @returns The {@link McpStatus} snapshot.
   */
  get status(): McpStatus {
    const running = this.httpServer !== null && this.port !== null;
    return {
      running,
      host: HOST,
      port: this.port,
      token: running ? this.token : null,
      url: running ? `http://${HOST}:${this.port}/mcp` : null,
      generation: this.deps.hooks.getGeneration(),
    };
  }

  // Route one incoming HTTP request: authenticate, then dispatch to the
  // matching session transport (or open a new session on initialize).
  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (!requestHasValidToken(req, this.token)) {
        respondJson(res, 401, { error: "unauthorized" });
        return;
      }
      const header = req.headers["mcp-session-id"];
      const sessionId = typeof header === "string" ? header : undefined;
      if (sessionId) {
        const existing = this.sessions.get(sessionId);
        if (!existing) {
          respondJson(res, 404, { error: "unknown MCP session; reconnect" });
          return;
        }
        await existing.transport.handleRequest(req, res);
        return;
      }
      if (req.method !== "POST") {
        respondJson(res, 400, { error: "missing mcp-session-id header" });
        return;
      }
      await this.openSession(req, res);
    } catch (err) {
      console.error("[mcp] request handling failed:", err);
      if (!res.headersSent) {
        respondJson(res, 500, { error: "internal MCP server error" });
      }
    }
  }

  // Create a fresh MCP server + transport for a new client and let the
  // transport drive the `initialize` handshake.
  private async openSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const mcpServer = new McpServer(
      { name: "pdv", version: this.deps.appVersion },
      { instructions: MCP_INSTRUCTIONS },
    );
    registerAllTools(mcpServer, this.ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId: string) => {
        this.sessions.set(newId, {
          transport,
          server: mcpServer,
          generation: this.deps.hooks.getGeneration(),
        });
      },
    });
    transport.onclose = (): void => {
      const id = transport.sessionId;
      if (id) {
        this.sessions.delete(id);
      }
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  }
}

/**
 * Resolve the MCP bearer token, minting and persisting one on first run.
 *
 * The token is stored under `mcp.authToken` in the config store so it stays
 * stable across app restarts — a connected agent keeps working after a
 * relaunch instead of failing auth against a freshly-rotated secret. At rest
 * it lives in the user's config file, which carries the same local-process
 * threat model as the loopback port itself (ARCHITECTURE.md §15.4).
 *
 * @param configStore - The persistent app configuration store.
 * @returns The persisted bearer token (newly minted on first call).
 */
function resolvePersistedToken(configStore: ConfigStore): string {
  const mcp = configStore.get("mcp");
  const existing = mcp?.authToken;
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  const token = generateBearerToken();
  configStore.set("mcp", { ...mcp, authToken: token });
  return token;
}

// Write a JSON body with the given status code.
function respondJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Try `preferred`, `preferred + 1`, … until one binds or the attempt cap is
// hit. Pass `preferred = 0` to let the OS pick a free port directly. Returns
// the port actually assigned by the kernel (read from `server.address()`),
// which lets `preferred = 0` work correctly.
async function listenWithFallback(
  server: http.Server,
  preferred: number,
  host: string,
): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const candidate = preferred === 0 ? 0 : preferred + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(candidate, host);
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("MCP server: unexpected http.Server.address() result");
      }
      return addr.port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw err;
      }
    }
  }
  throw new Error(
    `MCP server: no free port in range ${preferred}-${preferred + MAX_PORT_ATTEMPTS - 1}`,
  );
}
