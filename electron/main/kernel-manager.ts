/**
 * Kernel Manager with direct kernel launching (no server required).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import type * as Zmq from 'zeromq';
import {
  KernelSpec,
  KernelInfo,
  KernelExecuteRequest,
  KernelExecuteResult,
  KernelCompleteResult,
  KernelInspectResult,
} from './ipc';
import { loadConfig } from './config';

interface ConnectionInfo {
  transport: string;
  ip: string;
  shell_port: number;
  iopub_port: number;
  stdin_port: number;
  control_port: number;
  hb_port: number;
  signature_scheme: string;
  key: string;
}

interface JupyterMessage {
  header: {
    msg_id: string;
    username: string;
    session: string;
    msg_type: string;
    version: string;
    date: string;
  };
  parent_header: Record<string, unknown> | object;
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
  buffers?: ArrayBuffer[];
}

interface ManagedKernel {
  info: KernelInfo;
  spec: KernelSpec;
  process: ChildProcess;
  connectionInfo: ConnectionInfo;
  connectionFile: string;
  shellSocket: Zmq.Dealer;
  iopubSocket: Zmq.Subscriber;
  controlSocket: Zmq.Dealer;
  sessionId: string;
  startedAt: number;
  lastActivity: number;
  executionCount: number;
  executing: boolean;
}

interface ExecutionOptions {
  silent?: boolean;
  storeHistory?: boolean;
  timeout?: number;
}

/**
 * Create a unique connection file for a kernel
 */
function createConnectionFile(): { file: string; info: ConnectionInfo } {
  const runtimeDir = path.join(os.tmpdir(), 'pdv-kernels');
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }

  const connectionFile = path.join(runtimeDir, `kernel-${crypto.randomUUID()}.json`);
  const connectionInfo: ConnectionInfo = {
    transport: 'tcp',
    ip: '127.0.0.1',
    shell_port: 0,
    iopub_port: 0,
    stdin_port: 0,
    control_port: 0,
    hb_port: 0,
    signature_scheme: 'hmac-sha256',
    key: crypto.randomUUID(),
  };

  fs.writeFileSync(connectionFile, JSON.stringify(connectionInfo, null, 2));
  return { file: connectionFile, info: connectionInfo };
}

/**
 * Read connection info from a connection file
 */
function readConnectionFile(filePath: string): ConnectionInfo {
  const data = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Create a Jupyter message
 */
function createMessage(
  msgType: string,
  content: Record<string, unknown>,
  sessionId: string,
  parentHeader: Record<string, unknown> | object = {},
): JupyterMessage {
  return {
    header: {
      msg_id: crypto.randomUUID(),
      username: 'pdv',
      session: sessionId,
      msg_type: msgType,
      version: '5.3',
      date: new Date().toISOString(),
    },
    parent_header: parentHeader,
    metadata: {},
    content,
  };
}

/**
 * Sign and serialize a Jupyter message for ZMQ
 */
function serializeMessage(msg: JupyterMessage, key: string): Buffer[] {
  const header = Buffer.from(JSON.stringify(msg.header));
  const parentHeader = Buffer.from(JSON.stringify(msg.parent_header));
  const metadata = Buffer.from(JSON.stringify(msg.metadata));
  const content = Buffer.from(JSON.stringify(msg.content));

  const hmac = crypto.createHmac('sha256', key);
  hmac.update(header);
  hmac.update(parentHeader);
  hmac.update(metadata);
  hmac.update(content);
  const signature = hmac.digest('hex');

  return [
    Buffer.from('<IDS|MSG>'),
    Buffer.from(signature),
    header,
    parentHeader,
    metadata,
    content,
  ];
}

/**
 * Parse a Jupyter message from ZMQ frames, validating the HMAC-SHA256 signature.
 * Returns null if the signature is invalid or parsing fails.
 */
export function parseMessage(frames: Buffer[], key: string): JupyterMessage | null {
  try {
    let delimiterIndex = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].toString() === '<IDS|MSG>') {
        delimiterIndex = i;
        break;
      }
    }

    if (delimiterIndex === -1 || frames.length < delimiterIndex + 6) {
      return null;
    }

    const receivedSig = frames[delimiterIndex + 1].toString();
    const headerBuf = frames[delimiterIndex + 2];
    const parentHeaderBuf = frames[delimiterIndex + 3];
    const metadataBuf = frames[delimiterIndex + 4];
    const contentBuf = frames[delimiterIndex + 5];

    // Validate HMAC-SHA256 signature
    if (key) {
      const hmac = crypto.createHmac('sha256', key);
      hmac.update(headerBuf);
      hmac.update(parentHeaderBuf);
      hmac.update(metadataBuf);
      hmac.update(contentBuf);
      const expectedSigHex = hmac.digest('hex');
      try {
        const receivedSigBuf = Buffer.from(receivedSig, 'hex');
        const expectedSigBuf = Buffer.from(expectedSigHex, 'hex');
        if (
          receivedSigBuf.length !== expectedSigBuf.length ||
          !crypto.timingSafeEqual(receivedSigBuf, expectedSigBuf)
        ) {
          console.error('[KernelManager] Signature validation failed — message rejected');
          return null;
        }
      } catch {
        console.error('[KernelManager] Signature validation failed — invalid signature encoding');
        return null;
      }
    }

    const header = safeJsonParse<JupyterMessage['header']>(headerBuf, 1024 * 1024);
    const parentHeader = safeJsonParse<Record<string, unknown>>(parentHeaderBuf, 1024 * 1024);
    const metadata = safeJsonParse<Record<string, unknown>>(metadataBuf, 1024 * 1024);
    const content = safeJsonParse<Record<string, unknown>>(contentBuf, 8 * 1024 * 1024);

    if (!header || !parentHeader || !metadata || !content) {
      console.error('[KernelManager] Failed to parse one or more message frames');
      return null;
    }

    return { header, parent_header: parentHeader, metadata, content };
  } catch (error) {
    console.error('[KernelManager] Failed to parse message:', error);
    return null;
  }
}

/** Exported for tests only */
export { serializeMessage };

function loadInitCell(language: 'python' | 'julia'): string {
  const filename = language === 'python' ? 'python-init.py' : 'julia-init.jl';
  const candidatePaths = [
    path.join(__dirname, 'init', filename),
    path.join(__dirname, '..', 'init', filename),
    path.join(process.cwd(), 'main', 'init', filename),
    path.join(process.cwd(), 'dist', 'main', 'init', filename),
  ];

  for (const initPath of candidatePaths) {
    try {
      if (fs.existsSync(initPath)) {
        return fs.readFileSync(initPath, 'utf-8');
      }
    } catch (error) {
      console.warn(`[KernelManager] Failed to read init cell at ${initPath}:`, error);
    }
  }

  // Fallback minimal definitions to avoid NameError in kernels
  if (language === 'python') {
    return `
def pdv_info(obj):
    return {'type': type(obj).__name__, 'preview': repr(obj)[:80]}

def pdv_namespace(*args, **kwargs):
    return {}
print("PDV Python kernel ready (fallback init)")`;
  }

  return `
pdv_info(obj) = Dict("type" => string(typeof(obj)), "preview" => repr(obj)[1:min(80, end)])
pdv_namespace(; kwargs...) = Dict{String, Any}()
println("PDV Julia kernel ready (fallback init)")`;
}

/**
 * Safely parse JSON with a maximum size limit to prevent DoS via huge payloads.
 * Returns null on parse failure or oversized input.
 */
export function safeJsonParse<T = unknown>(
  data: string | Buffer,
  maxSize: number = 10 * 1024 * 1024,
): T | null {
  try {
    if (typeof data === 'string') {
      const byteLength = Buffer.byteLength(data, 'utf8');
      if (byteLength > maxSize) {
        console.error(`[SafeJSON] Payload too large (string, bytes): ${byteLength} > ${maxSize}`);
        return null;
      }
      return JSON.parse(data) as T;
    } else {
      if (data.length > maxSize) {
        console.error(`[SafeJSON] Payload too large (buffer, bytes): ${data.length} > ${maxSize}`);
        return null;
      }
      const str = data.toString('utf8');
      return JSON.parse(str) as T;
    }
  } catch {
    return null;
  }
}

async function loadZmq(): Promise<typeof import('zeromq')> {
  return import('zeromq');
}

export class KernelManager {
  private kernels: Map<string, ManagedKernel> = new Map();
  private executionLocks: Map<string, Promise<void>> = new Map();

  constructor() {
    // No server connection needed!
  }

  async listSpecs(): Promise<KernelSpec[]> {
    // For now, return default specs for python and julia
    return [
      {
        name: 'python3',
        displayName: 'Python 3',
        language: 'python',
        argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      },
      {
        name: 'julia',
        displayName: 'Julia',
        language: 'julia',
        argv: ['julia', '-i', '--startup-file=yes', '--color=yes', '-e', 
               'using IJulia; IJulia.kernel_main("{connection_file}")'],
      },
    ];
  }

  async list(): Promise<KernelInfo[]> {
    return Array.from(this.kernels.values()).map((k) => ({ ...k.info }));
  }

  async start(spec?: Partial<KernelSpec>): Promise<KernelInfo> {
    const language = spec?.language || 'python';
    const kernelName = spec?.name || (language === 'python' ? 'python3' : 'julia');
    const config = loadConfig();
    const captureMode = config.plotMode === 'capture';

    const kernelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    const kernelInfo: KernelInfo = {
      id: kernelId,
      name: kernelName,
      language,
      status: 'starting',
    };

    try {
      // Create connection file
      const { file: connectionFile, info: connectionInfo } = createConnectionFile();

      // Build kernel command
      let argv = spec?.argv;
      if (!argv) {
        if (language === 'python') {
          const pythonExec = spec?.env?.PYTHON_PATH || 'python';
          argv = [pythonExec, '-m', 'ipykernel_launcher', '-f', connectionFile];
        } else {
          const juliaExec = spec?.env?.JULIA_PATH || 'julia';
          argv = [juliaExec, '-i', '--startup-file=yes', '--color=yes', 
                  '-e', `using IJulia; IJulia.kernel_main("${connectionFile}")`];
        }
      } else {
        // Replace {connection_file} placeholder
        argv = argv.map((arg) => arg.replace('{connection_file}', connectionFile));
      }

      console.log('[KernelManager] Launching kernel:', argv);

      // Calculate project root for PDVTree
      // If treeRoot is set, use its parent directory
      // Otherwise, use the configured project root
      let projectRoot: string;
      if (config.treeRoot) {
        projectRoot = path.dirname(config.treeRoot);
      } else {
        projectRoot = config.projectRoot || config.cwd || process.cwd();
      }

      // Spawn kernel process
      const env = {
        ...process.env,
        ...spec?.env,
        PDV_CAPTURE_MODE: captureMode ? 'true' : 'false',
        PDV_PROJECT_ROOT: projectRoot,
      };

      const kernelProcess = spawn(argv[0], argv.slice(1), {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: config.cwd || process.cwd(),
      });

      // Log kernel output for debugging
      kernelProcess.stdout?.on('data', (data) => {
        console.log(`[Kernel ${kernelId}] stdout:`, data.toString());
      });

      kernelProcess.stderr?.on('data', (data) => {
        console.error(`[Kernel ${kernelId}] stderr:`, data.toString());
      });

      kernelProcess.on('exit', (code) => {
        console.log(`[Kernel ${kernelId}] exited with code ${code}`);
        const managed = this.kernels.get(kernelId);
        if (managed) {
          managed.info.status = 'dead';
        }
      });

      // Wait for connection file to be updated with ports
      await this.waitForConnectionFile(connectionFile, 10000);

      // Read updated connection info
      const updatedConnectionInfo = readConnectionFile(connectionFile);

      // Create ZMQ sockets
      const zmq = await loadZmq();
      const shellSocket = new zmq.Dealer();
      const iopubSocket = new zmq.Subscriber();
      const controlSocket = new zmq.Dealer();

      const baseUrl = `${updatedConnectionInfo.transport}://${updatedConnectionInfo.ip}`;
      await shellSocket.connect(`${baseUrl}:${updatedConnectionInfo.shell_port}`);
      await iopubSocket.connect(`${baseUrl}:${updatedConnectionInfo.iopub_port}`);
      await controlSocket.connect(`${baseUrl}:${updatedConnectionInfo.control_port}`);

      // Subscribe to all IOPub messages
      iopubSocket.subscribe();

      const managed: ManagedKernel = {
        info: kernelInfo,
        spec: {
          name: kernelName,
          displayName: spec?.displayName || kernelName,
          language,
          argv: spec?.argv,
          env: spec?.env,
        },
        process: kernelProcess,
        connectionInfo: updatedConnectionInfo,
        connectionFile,
        shellSocket,
        iopubSocket,
        controlSocket,
        sessionId,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        executionCount: 0,
        executing: false,
      };

      this.kernels.set(kernelId, managed);

      // Send kernel_info_request to verify connection
      await this.sendKernelInfoRequest(managed);

      // Execute init cell
      const initCell = loadInitCell(language);
      await this.executeInternal(kernelId, initCell, { silent: true, storeHistory: false });

      managed.info.status = 'idle';
      managed.lastActivity = Date.now();
      return { ...managed.info };
    } catch (error) {
      kernelInfo.status = 'error';
      console.error('[KernelManager] Failed to start kernel:', error);
      throw error;
    }
  }

  private async waitForConnectionFile(filePath: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const info = readConnectionFile(filePath);
        if (info.shell_port > 0) {
          return;
        }
      } catch (e) {
        // File not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timeout waiting for kernel connection file');
  }

  private async sendKernelInfoRequest(managed: ManagedKernel): Promise<void> {
    const msg = createMessage('kernel_info_request', {}, managed.sessionId);
    const frames = serializeMessage(msg, managed.connectionInfo.key);
    await managed.shellSocket.send(frames);
    
    // Wait for reply
    const reply = await managed.shellSocket.receive();
    console.log('[KernelManager] Kernel info reply received');
  }

  async stop(id: string): Promise<boolean> {
    const managed = this.kernels.get(id);
    if (!managed) {
      console.warn(`[KernelManager] Kernel not found: ${id}`);
      return false;
    }

    try {
      // Send shutdown request
      const msg = createMessage('shutdown_request', { restart: false }, managed.sessionId);
      const frames = serializeMessage(msg, managed.connectionInfo.key);
      
      try {
        await managed.controlSocket.send(frames);
      } catch (e) {
        // Socket might already be closed
      }

      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Close sockets safely
      try {
        await managed.shellSocket.close();
      } catch (e) {
        // Ignore errors during close
      }
      try {
        await managed.iopubSocket.close();
      } catch (e) {
        // Ignore errors during close
      }
      try {
        await managed.controlSocket.close();
      } catch (e) {
        // Ignore errors during close
      }

      // Kill process
      if (!managed.process.killed) {
        managed.process.kill('SIGTERM');
        
        // Give it time to exit gracefully
        await new Promise((resolve) => setTimeout(resolve, 200));
        
        if (!managed.process.killed) {
          managed.process.kill('SIGKILL');
        }
      }

      // Clean up connection file
      if (fs.existsSync(managed.connectionFile)) {
        try {
          fs.unlinkSync(managed.connectionFile);
        } catch (e) {
          // Ignore file deletion errors
        }
      }
    } catch (error) {
      console.error('[KernelManager] Error during shutdown:', error);
    } finally {
      this.kernels.delete(id);
    }
    return true;
  }

  async restart(id: string): Promise<KernelInfo> {
    const managed = this.kernels.get(id);
    if (!managed) {
      throw new Error(`Kernel not found: ${id}`);
    }

    managed.info.status = 'starting';

    // Send restart request
    const msg = createMessage('shutdown_request', { restart: true }, managed.sessionId);
    const frames = serializeMessage(msg, managed.connectionInfo.key);
    await managed.controlSocket.send(frames);

    // Wait for kernel to restart
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const initCell = loadInitCell(managed.spec.language);
    await this.executeInternal(id, initCell, { silent: true, storeHistory: false });

    managed.info.status = 'idle';
    managed.executionCount = 0;
    return { ...managed.info };
  }

  async interrupt(id: string): Promise<boolean> {
    const managed = this.kernels.get(id);
    if (!managed) {
      console.warn(`[KernelManager] Kernel not found: ${id}`);
      return false;
    }

    // Send SIGINT to kernel process
    managed.process.kill('SIGINT');
    managed.info.status = 'idle';
    managed.lastActivity = Date.now();
    return true;
  }

  async execute(id: string, request: KernelExecuteRequest): Promise<KernelExecuteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { error: `Kernel not found: ${id}`, duration: 0 };
    }

    return this.executeInternal(id, request.code, {
      storeHistory: true,
      timeout: 30000,
      silent: false,
      capture: request.capture,
    });
  }

  private async executeInternal(
    id: string,
    code: string,
    options: ExecutionOptions & { capture?: boolean } = {},
  ): Promise<KernelExecuteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      throw new Error(`Kernel not found: ${id}`);
    }

    // Per-kernel mutex: wait for any in-flight execution to finish before acquiring.
    // This eliminates the TOCTOU race in the previous busy-wait approach.
    const waitTimeout = options.timeout ?? 5000;
    const startWait = Date.now();
    while (this.executionLocks.has(id)) {
      if (Date.now() - startWait >= waitTimeout) {
        return { error: 'Kernel busy; please wait for the current execution to finish.', duration: 0 };
      }
      await this.executionLocks.get(id);
    }

    let releaseLock!: () => void;
    this.executionLocks.set(id, new Promise<void>((resolve) => { releaseLock = resolve; }));

    const startTime = Date.now();
    managed.info.status = 'busy';
    managed.lastActivity = startTime;
    managed.executing = true;

    const result: KernelExecuteResult = {
      stdout: '',
      stderr: '',
      images: [],
      rich: {},
      result: undefined,
    };

    // Create execute request
    const msg = createMessage(
      'execute_request',
      {
        code,
        silent: options.silent === true,
        store_history: options.storeHistory !== false,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      },
      managed.sessionId,
    );

    const msgId = msg.header.msg_id;
    const frames = serializeMessage(msg, managed.connectionInfo.key);

    // Listen for replies on IOPub
    const timeoutMs = options.timeout ?? 30000;
    const deadline = Date.now() + timeoutMs;
    let executionComplete = false;

    try {
      // Send execute request — inside try/finally so the lock is always released
      await managed.shellSocket.send(frames);

      // Use socket-level timeout to avoid overlapping receive calls that cause
      // "Socket is busy reading" errors when we poll for messages.
      (managed.iopubSocket as any).receiveTimeout = 100;

      while (Date.now() < deadline && !executionComplete) {
        let replyFrames: Buffer[];
        try {
          replyFrames = (await managed.iopubSocket.receive()) as Buffer[];
        } catch (e) {
          // zmq throws different timeout flavors; ignore and keep polling
          const msg = e instanceof Error ? e.message : String(e);
          if (
            msg.includes('Resource temporarily unavailable') ||
            msg.includes('EAGAIN') ||
            msg.includes('Operation was not possible or timed out')
          ) {
            continue;
          }
          throw e;
        }

        const reply = parseMessage(replyFrames, managed.connectionInfo.key);

        if (!reply || !reply.parent_header || (reply.parent_header as any).msg_id !== msgId) {
          continue;
        }

        const msgType = reply.header.msg_type;
        const content = reply.content;

        if (msgType === 'stream') {
          const streamContent = content as { name: string; text: string };
          if (streamContent.name === 'stdout') {
            result.stdout = (result.stdout || '') + streamContent.text;
          } else if (streamContent.name === 'stderr') {
            result.stderr = (result.stderr || '') + streamContent.text;
          }
        } else if (msgType === 'execute_result') {
          const data = (content as any).data;
          // Prefer structured JSON when available to avoid fragile string parsing
          if (data && Object.prototype.hasOwnProperty.call(data, 'application/json')) {
            result.result = (data as any)['application/json'];
          } else {
            result.result = (data as any)?.['text/plain'] ?? data;
          }
        } else if (msgType === 'display_data') {
          const data = (content as any).data;
          const hasPng = data?.['image/png'];
          const hasSvg = data?.['image/svg+xml'];
          if (hasPng || hasSvg) {
            result.images = result.images || [];
            if (hasPng) {
              result.images.push({ mime: 'image/png', data: data['image/png'] });
            }
            if (hasSvg) {
              result.images.push({ mime: 'image/svg+xml', data: data['image/svg+xml'] });
            }
          }
          if (data?.['text/html']) {
            result.rich = { ...(result.rich || {}), 'text/html': data['text/html'] };
          }
          if (Object.prototype.hasOwnProperty.call(data, 'application/json')) {
            result.result = data['application/json'];
          }
        } else if (msgType === 'error') {
          const errorContent = content as { ename: string; evalue: string; traceback: string[] };
          result.error = `${errorContent.ename}: ${errorContent.evalue}`;
          if (errorContent.traceback && errorContent.traceback.length > 0) {
            result.stderr = (result.stderr || '') + errorContent.traceback.join('\n');
          }
        } else if (msgType === 'status' && (content as any).execution_state === 'idle') {
          executionComplete = true;
        }
      }

      if (!executionComplete) {
        result.error = 'Execution timed out';
      }

      managed.executionCount++;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      managed.info.status = 'idle';
      managed.lastActivity = Date.now();
      managed.executing = false;
      result.duration = Date.now() - startTime;

      // Release the per-kernel execution lock
      this.executionLocks.delete(id);
      releaseLock();

      if (result.stdout === '') result.stdout = undefined;
      if (result.stderr === '') result.stderr = undefined;
      if (result.images && result.images.length === 0) result.images = undefined;
      if (result.rich && Object.keys(result.rich).length === 0) result.rich = undefined;
    }

    return result;
  }

  async complete(id: string, code: string, cursorPos: number): Promise<KernelCompleteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    const msg = createMessage(
      'complete_request',
      { code, cursor_pos: cursorPos },
      managed.sessionId,
    );
    const frames = serializeMessage(msg, managed.connectionInfo.key);
    await managed.shellSocket.send(frames);

    // Wait for reply
    const replyFrames = await managed.shellSocket.receive();
    const reply = parseMessage(replyFrames as Buffer[], managed.connectionInfo.key);

    if (reply && reply.content.status === 'ok') {
      const content = reply.content as any;
      return {
        matches: content.matches ?? [],
        cursor_start: content.cursor_start,
        cursor_end: content.cursor_end,
        metadata: content.metadata,
      };
    }

    return { matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
  }

  async inspect(id: string, code: string, cursorPos: number): Promise<KernelInspectResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { found: false };
    }

    const msg = createMessage(
      'inspect_request',
      { code, cursor_pos: cursorPos, detail_level: 0 },
      managed.sessionId,
    );
    const frames = serializeMessage(msg, managed.connectionInfo.key);
    await managed.shellSocket.send(frames);

    // Wait for reply
    const replyFrames = await managed.shellSocket.receive();
    const reply = parseMessage(replyFrames as Buffer[], managed.connectionInfo.key);

    if (reply && reply.content.status === 'ok' && (reply.content as any).found) {
      return {
        found: true,
        data: (reply.content as any).data,
      };
    }

    return { found: false };
  }

  getKernel(id: string): KernelInfo | undefined {
    return this.kernels.get(id)?.info;
  }

  hasKernel(id: string): boolean {
    return this.kernels.has(id);
  }

  getExecutionCount(id: string): number {
    return this.kernels.get(id)?.executionCount || 0;
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.kernels.keys());
    for (const id of ids) {
      await this.stop(id);
    }
  }
}

let instance: KernelManager | null = null;

export function getKernelManager(): KernelManager {
  if (!instance) {
    instance = new KernelManager();
  }
  return instance;
}

export function resetKernelManager(): void {
  if (instance) {
    void instance.shutdownAll();
    instance = null;
  }
}
