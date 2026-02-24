/**
 * LSP Server Manager
 *
 * Handles per-language LSP server lifecycle:
 *   - Detection (port probe + PATH check)
 *   - Process spawning (stdio transport)
 *   - WebSocket proxy so the renderer can connect via ws://127.0.0.1:<port>
 *   - State tracking and push notifications to renderer windows
 */

import * as net from 'net';
import * as child_process from 'child_process';
import * as path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import type { WebSocket as WsWebSocket } from 'ws';
import { BrowserWindow } from 'electron';
import { getLspRegistry, LspServerDefinition } from './lsp-registry';
import { loadConfig } from './config';

// ─── State types ─────────────────────────────────────────────────────────────

export type LspConnectionState =
  | 'not_configured'
  | 'detecting'
  | 'external_running'
  | 'launchable'
  | 'not_found'
  | 'starting'
  | 'connected'
  | 'error'
  | 'disabled';

export interface LspServerStatus {
  languageId: string;
  state: LspConnectionState;
  proxyPort?: number;
  detectedCommand?: string;
  detectedPort?: number;
  errorMessage?: string;
  displayName?: string;
}

// ─── Internal managed server record ──────────────────────────────────────────

interface ManagedServer {
  state: LspConnectionState;
  process?: child_process.ChildProcess;
  proxyServer?: WebSocketServer;
  proxyPort?: number;
  externalPort?: number;
  detectedCommand?: string;
  detectedPort?: number;
  errorMessage?: string;
}

// ─── LSP stdio framing ────────────────────────────────────────────────────────

/**
 * Reads Content-Length framed LSP messages from a readable stream buffer
 * and calls onMessage for each complete JSON-RPC message body.
 *
 * Exported for testing.
 */
export class LspMessageParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: string[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed header — discard up to after the separator
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + contentLength) break;

      const body = this.buffer.slice(start, start + contentLength).toString('utf-8');
      this.buffer = this.buffer.slice(start + contentLength);
      messages.push(body);
    }

    return messages;
  }
}

/**
 * Wrap a JSON string as an LSP Content-Length framed message for stdin.
 *
 * Exported for testing.
 */
export function frameLspMessage(json: string): Buffer {
  const body = Buffer.from(json, 'utf-8');
  const header = `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

// ─── TCP probe ───────────────────────────────────────────────────────────────

function probeTcpPort(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
    sock.connect(port, host);
  });
}

// ─── PATH probe ──────────────────────────────────────────────────────────────

function whichCommand(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const whichCmd = isWin ? 'where' : 'which';
    const proc = child_process.spawn(whichCmd, [cmd], { timeout: 3000 });
    let output = '';
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output.split('\n')[0].trim() || cmd);
      } else {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}

// ─── Free port ───────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Could not get free port'));
        }
      });
    });
    server.on('error', reject);
  });
}

// ─── LSP Server Manager ───────────────────────────────────────────────────────

export class LspServerManager {
  private servers = new Map<string, ManagedServer>();

  // ── Detection ─────────────────────────────────────────────────────────────

  async detectAll(): Promise<void> {
    const registry = getLspRegistry();
    const config = loadConfig();
    const langIds = registry.list().map((d) => d.languageId);
    await Promise.all(langIds.map((id) => this.detect(id, config.pythonPath)));
  }

  async detect(languageId: string, pythonPath?: string): Promise<LspServerStatus> {
    const registry = getLspRegistry();
    const def = registry.get(languageId);
    if (!def) {
      return this.setStatus(languageId, { state: 'not_configured' });
    }

    const config = loadConfig();
    const userCfg = config.languageServers?.[languageId];
    if (userCfg?.enabled === false) {
      return this.setStatus(languageId, { state: 'disabled' });
    }

    this.setStatus(languageId, { state: 'detecting' });

    // 1. Check for already-running external server on known ports
    for (const port of def.detectPorts) {
      const running = await probeTcpPort(port);
      if (running) {
        return this.setStatus(languageId, {
          state: 'external_running',
          detectedPort: port,
        });
      }
    }

    // 2. Check configured override command
    if (userCfg?.command) {
      const found = await whichCommand(userCfg.command);
      if (found) {
        return this.setStatus(languageId, {
          state: 'launchable',
          detectedCommand: userCfg.command,
        });
      }
    }

    // 3. For Python, try using the configured Python executable first
    if (languageId === 'python' && pythonPath) {
      for (const candidate of def.candidates) {
        const pyArgs = [pythonPath, '-m', candidate.detectCommand, '--version'];
        const ok = await new Promise<boolean>((resolve) => {
          const proc = child_process.spawn(pyArgs[0], pyArgs.slice(1), { timeout: 4000 });
          proc.on('close', (code) => resolve(code === 0));
          proc.on('error', () => resolve(false));
        });
        if (ok) {
          return this.setStatus(languageId, {
            state: 'launchable',
            detectedCommand: candidate.detectCommand,
          });
        }
      }
    }

    // 4. Check standard PATH candidates
    for (const candidate of def.candidates) {
      const found = await whichCommand(candidate.detectCommand);
      if (found) {
        return this.setStatus(languageId, {
          state: 'launchable',
          detectedCommand: candidate.detectCommand,
        });
      }
    }

    return this.setStatus(languageId, { state: 'not_found' });
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async connect(languageId: string): Promise<LspServerStatus> {
    const existing = this.servers.get(languageId);
    if (existing?.state === 'connected' && existing.proxyPort) {
      return this.toStatus(languageId, existing);
    }

    const registry = getLspRegistry();
    const def = registry.get(languageId);
    if (!def) {
      return this.setStatus(languageId, { state: 'not_configured', errorMessage: 'No definition registered' });
    }

    const config = loadConfig();
    const current = this.servers.get(languageId);
    const state = current?.state;

    if (state === 'external_running' && current?.detectedPort) {
      return this.connectToExternalTcp(languageId, def, current.detectedPort);
    }

    if (state === 'launchable') {
      return this.spawnAndConnect(languageId, def, current?.detectedCommand, config.pythonPath);
    }

    // Re-detect then try
    const detected = await this.detect(languageId, config.pythonPath);
    if (detected.state === 'external_running' && detected.detectedPort) {
      return this.connectToExternalTcp(languageId, def, detected.detectedPort);
    }
    if (detected.state === 'launchable') {
      return this.spawnAndConnect(languageId, def, detected.detectedCommand, config.pythonPath);
    }

    return this.setStatus(languageId, {
      state: 'error',
      errorMessage: `Cannot connect: server is ${detected.state}`,
    });
  }

  private async connectToExternalTcp(
    languageId: string,
    def: LspServerDefinition,
    externalPort: number,
  ): Promise<LspServerStatus> {
    this.setStatus(languageId, { state: 'starting', detectedPort: externalPort });
    try {
      const proxyPort = await this.startTcpProxy(languageId, externalPort);
      return this.setStatus(languageId, {
        state: 'connected',
        proxyPort,
        detectedPort: externalPort,
      });
    } catch (err) {
      return this.setStatus(languageId, {
        state: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async spawnAndConnect(
    languageId: string,
    def: LspServerDefinition,
    detectedCommand: string | undefined,
    pythonPath: string | undefined,
  ): Promise<LspServerStatus> {
    this.setStatus(languageId, { state: 'starting', detectedCommand });
    try {
      const { proc, command } = await this.spawnServer(languageId, def, detectedCommand, pythonPath);
      const proxyPort = await this.startStdioProxy(languageId, proc);
      return this.setStatus(languageId, {
        state: 'connected',
        proxyPort,
        detectedCommand: command,
      });
    } catch (err) {
      return this.setStatus(languageId, {
        state: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async spawnServer(
    languageId: string,
    def: LspServerDefinition,
    preferredCommand: string | undefined,
    pythonPath: string | undefined,
  ): Promise<{ proc: child_process.ChildProcess; command: string }> {
    const config = loadConfig();
    const userCfg = config.languageServers?.[languageId];

    let argv: string[];

    if (userCfg?.command) {
      argv = [userCfg.command, ...(userCfg.args ?? [])];
    } else if (preferredCommand) {
      // Resolve candidate by matched command
      const matchedCandidate = def.candidates.find(
        (c) => c.detectCommand === preferredCommand || c.command === preferredCommand,
      );
      if (matchedCandidate) {
        // For Python, prefer using configured pythonPath as runner
        if (languageId === 'python' && pythonPath && matchedCandidate.command !== pythonPath) {
          argv = [pythonPath, '-m', matchedCandidate.detectCommand, ...matchedCandidate.args];
        } else {
          argv = [matchedCandidate.command, ...matchedCandidate.args];
        }
      } else {
        argv = [preferredCommand];
      }
    } else {
      const first = def.candidates[0];
      if (languageId === 'python' && pythonPath) {
        argv = [pythonPath, '-m', first.detectCommand, ...first.args];
      } else {
        argv = [first.command, ...first.args];
      }
    }

    const [cmd, ...args] = argv;
    console.log(`[lsp] Spawning ${languageId} server:`, cmd, args.join(' '));

    const workspaceRoot = loadConfig().treeRoot ?? process.cwd();
    const proc = child_process.spawn(cmd, args, {
      cwd: path.dirname(workspaceRoot),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      console.error(`[lsp] ${languageId} server error:`, err);
      this.setStatus(languageId, { state: 'error', errorMessage: err.message });
    });

    proc.on('exit', (code, signal) => {
      console.log(`[lsp] ${languageId} server exited: code=${code} signal=${signal}`);
      const current = this.servers.get(languageId);
      if (current?.state === 'connected') {
        this.setStatus(languageId, { state: 'launchable', detectedCommand: current.detectedCommand });
      }
    });

    proc.stderr?.on('data', (d: Buffer) => {
      console.log(`[lsp:${languageId}:stderr]`, d.toString().trim());
    });

    // Record the process before returning
    const server = this.servers.get(languageId) ?? { state: 'starting' };
    server.process = proc;
    server.detectedCommand = argv[0];
    this.servers.set(languageId, server);

    return { proc, command: argv[0] };
  }

  // ── Proxy: stdio ──────────────────────────────────────────────────────────

  private async startStdioProxy(
    languageId: string,
    proc: child_process.ChildProcess,
  ): Promise<number> {
    const proxyPort = await getFreePort();
    const parser = new LspMessageParser();

    const wss = new WebSocketServer({ host: '127.0.0.1', port: proxyPort });

    // LSP process stdout → broadcast to all connected WebSocket clients
    const broadcastStdout = (chunk: Buffer) => {
      const messages = parser.push(chunk);
      for (const msg of messages) {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
          }
        });
      }
    };
    proc.stdout?.on('data', broadcastStdout);

    wss.on('connection', (ws: WsWebSocket) => {
      console.log(`[lsp] Renderer connected to ${languageId} proxy on port ${proxyPort}`);

      // WebSocket → LSP process stdin
      ws.on('message', (data) => {
        const json = typeof data === 'string' ? data : data.toString();
        proc.stdin?.write(frameLspMessage(json));
      });

      ws.on('error', (err) => {
        console.error(`[lsp] WebSocket error for ${languageId}:`, err);
      });
    });

    wss.on('error', (err) => {
      console.error(`[lsp] Proxy server error for ${languageId}:`, err);
    });

    const server = this.servers.get(languageId)!;
    server.proxyServer = wss;
    server.proxyPort = proxyPort;

    return proxyPort;
  }

  // ── Proxy: external TCP ───────────────────────────────────────────────────

  private async startTcpProxy(languageId: string, externalPort: number): Promise<number> {
    const proxyPort = await getFreePort();

    const wss = new WebSocketServer({ host: '127.0.0.1', port: proxyPort });

    wss.on('connection', (ws: WsWebSocket) => {
      const parser = new LspMessageParser();
      const tcpSocket = new net.Socket();
      tcpSocket.connect(externalPort, '127.0.0.1', () => {
        console.log(`[lsp] TCP proxy for ${languageId} connected to port ${externalPort}`);
      });

      // TCP → WebSocket
      tcpSocket.on('data', (chunk: Buffer) => {
        const messages = parser.push(chunk);
        for (const msg of messages) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
          }
        }
      });

      // WebSocket → TCP
      ws.on('message', (data) => {
        const json = typeof data === 'string' ? data : data.toString();
        tcpSocket.write(frameLspMessage(json));
      });

      tcpSocket.on('close', () => ws.close());
      ws.on('close', () => tcpSocket.destroy());

      tcpSocket.on('error', (err) => {
        console.error(`[lsp] TCP socket error for ${languageId}:`, err);
        ws.close();
      });
    });

    wss.on('error', (err) => {
      console.error(`[lsp] TCP proxy server error for ${languageId}:`, err);
    });

    const server = this.servers.get(languageId)!;
    server.proxyServer = wss;
    server.proxyPort = proxyPort;
    server.externalPort = externalPort;

    return proxyPort;
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  async disconnect(languageId: string): Promise<void> {
    const server = this.servers.get(languageId);
    if (!server) return;

    // Close proxy WebSocket server
    await new Promise<void>((resolve) => {
      if (server.proxyServer) {
        server.proxyServer.close(() => resolve());
      } else {
        resolve();
      }
    });

    // Terminate managed process
    if (server.process && !server.process.killed) {
      server.process.kill('SIGTERM');
      setTimeout(() => {
        if (server.process && !server.process.killed) {
          server.process.kill('SIGKILL');
        }
      }, 3000);
    }

    this.setStatus(languageId, {
      state: server.detectedCommand ? 'launchable' : 'not_found',
      detectedCommand: server.detectedCommand,
      proxyPort: undefined,
      externalPort: undefined,
      detectedPort: undefined,
      errorMessage: undefined,
    });
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.servers.keys());
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  // ── Status helpers ────────────────────────────────────────────────────────

  getStatus(languageId: string): LspServerStatus {
    const server = this.servers.get(languageId);
    if (!server) {
      const def = getLspRegistry().get(languageId);
      return { languageId, state: 'not_configured', displayName: def?.displayName };
    }
    return this.toStatus(languageId, server);
  }

  listStatuses(): LspServerStatus[] {
    return getLspRegistry()
      .list()
      .map((def) => this.getStatus(def.languageId));
  }

  private toStatus(languageId: string, server: ManagedServer): LspServerStatus {
    const def = getLspRegistry().get(languageId);
    return {
      languageId,
      state: server.state,
      proxyPort: server.proxyPort,
      detectedCommand: server.detectedCommand,
      detectedPort: server.detectedPort,
      errorMessage: server.errorMessage,
      displayName: def?.displayName,
    };
  }

  private setStatus(
    languageId: string,
    partial: Omit<ManagedServer, 'process' | 'proxyServer'>,
  ): LspServerStatus {
    const existing = this.servers.get(languageId) ?? {};
    const next: ManagedServer = { ...existing, ...partial };
    this.servers.set(languageId, next);

    const status = this.toStatus(languageId, next);
    this.broadcastStateChange(status);
    return status;
  }

  /** Push state changes to all renderer windows */
  private broadcastStateChange(status: LspServerStatus): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('lsp:state-change', status);
        }
      }
    } catch {
      // BrowserWindow may not be available during tests
    }
  }
}

let manager: LspServerManager | null = null;

export function getLspServerManager(): LspServerManager {
  if (!manager) {
    manager = new LspServerManager();
  }
  return manager;
}

export function resetLspServerManager(): void {
  manager = null;
}
