/**
 * kernel-manager.ts — Manages Jupyter kernel process lifecycle and JMP comms.
 *
 * Responsible for:
 * 1. Spawning a Jupyter kernel subprocess given a KernelSpec.
 * 2. Allocating ports and writing the connection file before launch.
 * 3. Opening ZeroMQ shell / iopub / control sockets and connecting them.
 * 4. Running a continuous background iopub reader loop that dispatches raw
 *    Jupyter messages to registered listeners (used by CommRouter).
 * 5. Running a continuous background shell-reply reader loop that correlates
 *    complete_reply and inspect_reply messages to waiting callers.
 * 6. Sending execute_request messages and correlating their output via iopub.
 * 7. Sending complete_request and inspect_request messages and correlating
 *    their shell-socket replies by msg_id.
 * 8. Graceful shutdown: shutdown_request → wait 3 s → SIGKILL.
 * 9. Crash detection: emits 'kernel:crashed' when a kernel exits unexpectedly.
 *
 * KernelManager does NOT know about the PDV comm protocol — it speaks only
 * raw Jupyter Messaging Protocol (JMP). All PDV traffic is handled by
 * CommRouter, which subscribes via onIopubMessage().
 *
 * See Also
 * --------
 * ARCHITECTURE.md §4 (startup sequence)
 * comm-router.ts — subscribes to onIopubMessage; calls sendCommMsg
 * pdv-protocol.ts — protocol envelope types used by CommRouter and IPC layers
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Describes which kernel binary to launch. */
export interface KernelSpec {
  /** Kernel identifier (for example, `python3`). */
  name: string;
  /** Human-readable kernel name shown in UI. */
  displayName: string;
  /** Programming language provided by the kernel runtime. */
  language: "python" | "julia";
  /** Argv template; use `{connection_file}` as a placeholder. */
  argv?: string[];
  /** Extra environment variables to pass to the subprocess. */
  env?: Record<string, string>;
}

/** Snapshot of a running kernel's identity and status. */
export interface KernelInfo {
  /** Runtime-generated kernel UUID. */
  id: string;
  /** Kernel identifier (for example, `python3`). */
  name: string;
  /** Programming language provided by the kernel runtime. */
  language: "python" | "julia";
  /** Current runtime state reported by the app. */
  status: "idle" | "busy" | "starting" | "error" | "dead";
}

/** Input to KernelManager.execute(). */
export interface KernelExecuteRequest {
  /** Python (or Julia) source code to execute. */
  code: string;
  /** If true, suppress history storage in the kernel. */
  silent?: boolean;
}

/** Output from KernelManager.execute(). */
export interface KernelExecuteResult {
  /** Concatenated stdout text, or undefined if none. */
  stdout?: string;
  /** Concatenated stderr text, or undefined if none. */
  stderr?: string;
  /** Return value of the last expression (parsed from execute_result). */
  result?: unknown;
  /** Error string if execution raised an exception. */
  error?: string;
  /** Raw traceback lines from the error message (ANSI codes stripped). */
  traceback?: string[];
  /** Wall-clock execution duration in milliseconds. */
  duration?: number;
  /** Inline images emitted via display_data (e.g. matplotlib Agg fallback). */
  images?: Array<{ mime: string; data: string }>;
}

/** Callback type for raw iopub message listeners. */
export type IopubCallback = (msg: JupyterMessage) => void;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

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

/** Internal representation of a managed kernel. */
interface JupyterMessageHeader {
  msg_id: string;
  username: string;
  session: string;
  msg_type: string;
  version: string;
  date: string;
}

/**
 * Parsed Jupyter Messaging Protocol envelope received from ZeroMQ frames.
 */
export interface JupyterMessage {
  /** Message header with msg_type, ids, and protocol version. */
  header: JupyterMessageHeader;
  /** Parent message header used for request/response correlation. */
  parent_header: Record<string, unknown>;
  /** Message metadata object (kernel-defined, may be empty). */
  metadata: Record<string, unknown>;
  /** Message content object whose shape depends on msg_type. */
  content: Record<string, unknown>;
}

interface ManagedKernel {
  info: KernelInfo;
  spec: KernelSpec;
  process: ChildProcess;
  connectionInfo: ConnectionInfo;
  connectionFile: string;
  /** Shell socket (Dealer). */
  shellSocket: import("zeromq").Dealer;
  /** IOPub socket (Subscriber). */
  iopubSocket: import("zeromq").Subscriber;
  /** Control socket (Dealer). */
  controlSocket: import("zeromq").Dealer;
  sessionId: string;
  startedAt: number;
  lastActivity: number;
  /** Set to true by stop() before killing to suppress 'kernel:crashed' emit. */
  shuttingDown: boolean;
  /** Promise that resolves when the background iopub loop exits. */
  iopubLoopDone: Promise<void>;
  /** Promise that resolves when the background shell reply loop exits. */
  shellLoopDone: Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a free TCP port on localhost by binding to port 0 and releasing. */
function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

/**
 * Build a signed Jupyter message and serialize it to ZMQ frames.
 *
 * Frame layout: [identity..., DELIM, sig, header, parent_header, metadata, content]
 */
function createMessage(
  msgType: string,
  content: Record<string, unknown>,
  sessionId: string
): JupyterMessage {
  return {
    header: {
      msg_id: crypto.randomUUID(),
      username: "pdv",
      session: sessionId,
      msg_type: msgType,
      version: "5.3",
      date: new Date().toISOString(),
    },
    parent_header: {},
    metadata: {},
    content,
  };
}

function serializeMessage(msg: JupyterMessage, key: string): Buffer[] {
  const header = Buffer.from(JSON.stringify(msg.header));
  const parentHeader = Buffer.from(JSON.stringify(msg.parent_header));
  const metadata = Buffer.from(JSON.stringify(msg.metadata));
  const content = Buffer.from(JSON.stringify(msg.content));

  const hmac = crypto.createHmac("sha256", key);
  hmac.update(header);
  hmac.update(parentHeader);
  hmac.update(metadata);
  hmac.update(content);
  const sig = hmac.digest("hex");

  return [
    Buffer.from("<IDS|MSG>"),
    Buffer.from(sig),
    header,
    parentHeader,
    metadata,
    content,
  ];
}

/**
 * Parse a Jupyter message from raw ZMQ frames, validating the HMAC signature.
 *
 * @param frames - Raw multipart message frames from a ZeroMQ socket.
 * @param key - HMAC signing key from the kernel connection file.
 * @returns The parsed JupyterMessage, or null if frames are invalid or the
 *   signature check fails.
 */
export function parseMessage(
  frames: Buffer[],
  key: string
): JupyterMessage | null {
  try {
    let delimIdx = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].toString() === "<IDS|MSG>") {
        delimIdx = i;
        break;
      }
    }
    if (delimIdx === -1 || frames.length < delimIdx + 6) return null;

    const receivedSig = frames[delimIdx + 1].toString();
    const headerBuf = frames[delimIdx + 2];
    const parentBuf = frames[delimIdx + 3];
    const metaBuf = frames[delimIdx + 4];
    const contentBuf = frames[delimIdx + 5];

    if (key) {
      const hmac = crypto.createHmac("sha256", key);
      hmac.update(headerBuf);
      hmac.update(parentBuf);
      hmac.update(metaBuf);
      hmac.update(contentBuf);
      const expected = hmac.digest("hex");
      const receivedBuf = Buffer.from(receivedSig, "hex");
      const expectedBuf = Buffer.from(expected, "hex");
      if (
        receivedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(receivedBuf, expectedBuf)
      ) {
        return null;
      }
    }

    const header = JSON.parse(headerBuf.toString()) as JupyterMessageHeader;
    const parent_header = JSON.parse(parentBuf.toString()) as Record<
      string,
      unknown
    >;
    const metadata = JSON.parse(metaBuf.toString()) as Record<string, unknown>;
    const content = JSON.parse(contentBuf.toString()) as Record<
      string,
      unknown
    >;

    return { header, parent_header, metadata, content };
  } catch {
    return null;
  }
}

async function loadZmq(): Promise<typeof import("zeromq")> {
  return import("zeromq");
}

// ---------------------------------------------------------------------------
// KernelManager
// ---------------------------------------------------------------------------

/**
 * KernelManager — spawns and manages Jupyter kernel subprocesses.
 *
 * Emits:
 * - `'kernel:crashed'` — `(kernelId: string)` when a kernel exits unexpectedly.
 */
export class KernelManager extends EventEmitter {
  private readonly kernels = new Map<string, ManagedKernel>();

  /** Per-kernel sets of iopub message listeners. */
  private readonly iopubListeners = new Map<string, Set<IopubCallback>>();

  /** Per-kernel, per-msgId one-shot shell reply listeners for complete/inspect. */
  private readonly shellReplyListeners = new Map<
    string,
    Map<string, (msg: JupyterMessage) => void>
  >();

  constructor() {
    super();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a new kernel subprocess and wait until it responds to a
   * kernel_info_request (i.e. the iopub reports `status: idle`).
   *
   * @param spec - Optional partial KernelSpec.  Defaults to Python 3.
   * @returns KernelInfo with status `'idle'` once the kernel is ready.
   * @throws If the kernel fails to start within 30 seconds.
   */
  async start(spec?: Partial<KernelSpec>): Promise<KernelInfo> {
    const language = spec?.language ?? "python";
    const kernelName = spec?.name ?? (language === "python" ? "python3" : "julia");
    const kernelId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    const kernelInfo: KernelInfo = {
      id: kernelId,
      name: kernelName,
      language,
      status: "starting",
    };

    // Allocate 5 ports before writing the connection file.
    const [shellPort, iopubPort, stdinPort, controlPort, hbPort] =
      await Promise.all([
        findAvailablePort(),
        findAvailablePort(),
        findAvailablePort(),
        findAvailablePort(),
        findAvailablePort(),
      ]);

    const runtimeDir = path.join(os.tmpdir(), "pdv-kernels");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const connectionFile = path.join(runtimeDir, `kernel-${kernelId}.json`);
    const key = crypto.randomUUID();

    const connectionInfo: ConnectionInfo = {
      transport: "tcp",
      ip: "127.0.0.1",
      shell_port: shellPort,
      iopub_port: iopubPort,
      stdin_port: stdinPort,
      control_port: controlPort,
      hb_port: hbPort,
      signature_scheme: "hmac-sha256",
      key,
    };
    fs.writeFileSync(connectionFile, JSON.stringify(connectionInfo, null, 2));

    // Build the argv for the kernel process.
    const pythonExec = spec?.env?.PYTHON_PATH ?? "python3";
    let argv: string[] =
      spec?.argv ?? [pythonExec, "-m", "ipykernel_launcher", "-f", connectionFile];
    argv = argv.map((a) => a.replace("{connection_file}", connectionFile));

    const kernelProcess = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...(spec?.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    kernelProcess.stdout?.on("data", (d: Buffer) => {
      process.stdout.write(`[kernel:${kernelId.slice(0, 8)}] ${d.toString()}`);
    });
    kernelProcess.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[kernel:${kernelId.slice(0, 8)}] ${d.toString()}`);
    });

    const zmq = await loadZmq();
    const shellSocket = new zmq.Dealer();
    const iopubSocket = new zmq.Subscriber();
    const controlSocket = new zmq.Dealer();

    // linger=0 so sockets close immediately without waiting to flush.
    shellSocket.linger = 0;
    iopubSocket.linger = 0;
    controlSocket.linger = 0;

    const base = `${connectionInfo.transport}://${connectionInfo.ip}`;
    await shellSocket.connect(`${base}:${shellPort}`);
    await iopubSocket.connect(`${base}:${iopubPort}`);
    await controlSocket.connect(`${base}:${controlPort}`);
    iopubSocket.subscribe(); // subscribe to all topics

    // Deferred that resolves when the background iopub loop exits.
    let resolveLoopDone!: () => void;
    const iopubLoopDone = new Promise<void>((r) => { resolveLoopDone = r; });

    // Deferred that resolves when the background shell reply loop exits.
    let resolveShellLoopDone!: () => void;
    const shellLoopDone = new Promise<void>((r) => { resolveShellLoopDone = r; });

    const managed: ManagedKernel = {
      info: kernelInfo,
      spec: {
        name: kernelName,
        displayName: spec?.displayName ?? kernelName,
        language,
        argv: spec?.argv,
        env: spec?.env,
      },
      process: kernelProcess,
      connectionInfo,
      connectionFile,
      shellSocket,
      iopubSocket,
      controlSocket,
      sessionId,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      shuttingDown: false,
      iopubLoopDone,
      shellLoopDone,
    };

    this.kernels.set(kernelId, managed);
    this.iopubListeners.set(kernelId, new Set());
    this.shellReplyListeners.set(kernelId, new Map());

    // Start the background iopub reader *before* waiting for ready so that
    // any status messages arriving during startup are dispatched.
    // Resolve iopubLoopDone when the loop exits (normally or on error).
    this.runIopubLoop(managed).finally(resolveLoopDone);

    // Start the background shell reply loop for complete_reply / inspect_reply.
    this.runShellLoop(managed).finally(resolveShellLoopDone);

    // Emit 'kernel:crashed' when the process exits unexpectedly.
    // Do NOT remove from kernels map here: stop() needs the managed object
    // to close sockets (which unblocks the iopub loop). afterEach's
    // shutdownAll() will call stop() and do the cleanup.
    kernelProcess.on("exit", () => {
      managed.info.status = "dead";
      if (!managed.shuttingDown) {
        this.emit("kernel:crashed", kernelId);
      }
    });

    // Wait for the kernel to become responsive.
    await this.waitForKernelReady(managed);

    kernelInfo.status = "idle";
    return { ...kernelInfo };
  }

  /**
   * Shut down a kernel gracefully.
   *
   * Sends shutdown_request on the control socket, waits up to 3 seconds for
   * a clean process exit, then force-kills with SIGKILL if needed.
   *
   * @param id - Kernel ID returned by start().
   */
  async stop(id: string): Promise<void> {
    const managed = this.kernels.get(id);
    if (!managed) return;

    // Signal the iopub loop to exit (it polls this flag every 100 ms).
    managed.shuttingDown = true;

    // Attempt a graceful JMP shutdown.
    try {
      const msg = createMessage(
        "shutdown_request",
        { restart: false },
        managed.sessionId
      );
      await managed.controlSocket.send(
        serializeMessage(msg, managed.connectionInfo.key)
      );
    } catch {
      // Socket may already be closed; proceed to force-kill.
    }

    // Wait for the iopub loop to exit completely before touching the sockets.
    // With receiveTimeout=100 ms, this takes at most ~100 ms.
    // Doing this BEFORE socket.close() prevents the use-after-free crash where
    // close() destroys the native socket while receive() is still in flight.
    await managed.iopubLoopDone;

    // Wait for the shell reply loop to exit for the same reason.
    await managed.shellLoopDone;

    // Close sockets (safe — no pending receive operations remain).
    for (const sock of [
      managed.shellSocket,
      managed.iopubSocket,
      managed.controlSocket,
    ] as unknown as Array<{ close(): Promise<void> | void }>) {
      try {
        await Promise.resolve(sock.close());
      } catch {
        // ignored
      }
    }

    // Wait up to 3 seconds for the process to exit on its own.
    // If it has already exited (e.g. crashed), skip the wait.
    if (managed.process.exitCode === null && !managed.process.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        managed.process.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    // Force-kill if it is still alive.
    if (!managed.process.killed) {
      managed.process.kill("SIGKILL");
    }

    // Remove connection file.
    try {
      fs.unlinkSync(managed.connectionFile);
    } catch {
      // ignored
    }

    this.kernels.delete(id);
    this.iopubListeners.delete(id);
    this.shellReplyListeners.delete(id);
  }

  /**
   * Execute code in the named kernel and collect output.
   *
   * Resolves once the kernel reports `status: idle` on iopub (i.e. execution
   * finished), or after a 30-second timeout.
   *
   * @param id - Kernel ID.
   * @param request - Code and options.
   * @returns Collected stdout, result, and any error.
   */
  async execute(
    id: string,
    request: KernelExecuteRequest
  ): Promise<KernelExecuteResult> {
    const managed = this.kernels.get(id);
    if (!managed) {
      return { error: `Kernel not found: ${id}`, duration: 0 };
    }

    const startTime = Date.now();
    const result: KernelExecuteResult = {};

    const msg = createMessage(
      "execute_request",
      {
        code: request.code,
        silent: request.silent ?? false,
        store_history: !(request.silent ?? false),
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      },
      managed.sessionId
    );
    const msgId = msg.header.msg_id;

    return new Promise<KernelExecuteResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        result.duration = Date.now() - startTime;
        if (result.stdout === "") delete result.stdout;
        if (result.stderr === "") delete result.stderr;
        if (result.images?.length === 0) delete result.images;
        resolve(result);
      };

      const cleanup = this.onIopubMessage(id, (jupMsg) => {
        const ph = jupMsg.parent_header;
        if (ph.msg_id !== msgId) return;

        const msgType = jupMsg.header.msg_type;
        const content = jupMsg.content;

        if (msgType === "stream") {
          if (content.name === "stdout") {
            result.stdout = (result.stdout ?? "") + String(content.text ?? "");
          } else if (content.name === "stderr") {
            result.stderr = (result.stderr ?? "") + String(content.text ?? "");
          }
        } else if (msgType === "execute_result") {
          const data = content.data as Record<string, unknown> | undefined;
          if (data && "application/json" in data) {
            result.result = data["application/json"];
          } else {
            // Try to parse text/plain as JSON so that integers become numbers.
            const plain = data?.["text/plain"];
            if (typeof plain === "string") {
              try {
                result.result = JSON.parse(plain);
              } catch {
                result.result = plain;
              }
            }
          }
        } else if (msgType === "display_data" || msgType === "execute_result") {
          const data = content.data as Record<string, unknown> | undefined;
          if (msgType === "display_data") {
            // Collect inline images (Agg fallback or explicit IPython display())
            const png = data?.["image/png"];
            const svg = data?.["image/svg+xml"];
            if (typeof png === "string") {
              result.images = result.images ?? [];
              result.images.push({ mime: "image/png", data: png });
            } else if (typeof svg === "string") {
              result.images = result.images ?? [];
              result.images.push({ mime: "image/svg+xml", data: svg });
            }
          } else {
            // execute_result — extract the return value
            if (data && "application/json" in data) {
              result.result = data["application/json"];
            } else {
              const plain = data?.["text/plain"];
              if (typeof plain === "string") {
                try {
                  result.result = JSON.parse(plain);
                } catch {
                  result.result = plain;
                }
              }
            }
          }
        } else if (msgType === "error") {
          result.error = `${String(content.ename ?? "Error")}: ${String(
            content.evalue ?? ""
          )}`;
          // Capture and ANSI-strip the traceback so the renderer can extract line numbers.
          const tb = content.traceback;
          if (Array.isArray(tb)) {
            // eslint-disable-next-line no-control-regex
            result.traceback = (tb as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
          }
        } else if (
          msgType === "status" &&
          content.execution_state === "idle"
        ) {
          finish();
        }
      });

      timer = setTimeout(() => {
        result.error = "Execution timed out";
        finish();
      }, 30_000);

      managed.shellSocket
        .send(serializeMessage(msg, managed.connectionInfo.key))
        .catch((err: Error) => {
          result.error = err.message;
          finish();
        });
    });
  }

  /**
   * Send a SIGINT to the kernel process (interrupt a running computation).
   *
   * @param id - Kernel ID.
   */
  async interrupt(id: string): Promise<void> {
    const managed = this.kernels.get(id);
    if (!managed) return;
    managed.process.kill("SIGINT");
  }

  /**
   * Return a snapshot of all currently running kernels.
   */
  list(): KernelInfo[] {
    return Array.from(this.kernels.values()).map((k) => ({ ...k.info }));
  }

  /**
   * Return the KernelInfo for a specific kernel, or undefined if not found.
   *
   * @param id - Kernel ID.
   */
  getKernel(id: string): KernelInfo | undefined {
    return this.kernels.get(id)?.info;
  }

  /**
   * Gracefully shut down every running kernel.
   */
  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.kernels.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /**
   * Register a listener for all raw iopub messages from the named kernel.
   *
   * Used by CommRouter to subscribe to the PDV comm channel. The callback
   * is invoked for every Jupyter message received on the iopub socket
   * (stream, status, comm_msg, etc.).
   *
   * @param id - Kernel ID.
   * @param callback - Invoked with each parsed JupyterMessage.
   * @returns A function that, when called, removes the listener.
   */
  onIopubMessage(id: string, callback: IopubCallback): () => void {
    let listeners = this.iopubListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.iopubListeners.set(id, listeners);
    }
    listeners.add(callback);
    return () => {
      this.iopubListeners.get(id)?.delete(callback);
    };
  }

  /**
   * Send raw data as a comm_msg on the kernel's shell socket.
   *
   * CommRouter calls this to deliver PDV protocol messages to the kernel.
   * The data object is placed in the `data` field of the comm_msg content.
   *
   * @param id - Kernel ID.
   * @param commId - The comm identifier (from the kernel's comm_open). Pass
   *   null during tests where the comm channel is mocked.
   * @param data - PDV protocol envelope to transmit.
   */
  async sendCommMsg(
    id: string,
    commId: string | null,
    data: Record<string, unknown>
  ): Promise<void> {
    const managed = this.kernels.get(id);
    if (!managed) throw new Error(`Kernel not found: ${id}`);

    const msg = createMessage(
      "comm_msg",
      { comm_id: commId ?? "", data },
      managed.sessionId
    );
    await managed.shellSocket.send(
      serializeMessage(msg, managed.connectionInfo.key)
    );
  }

  /**
   * Request code completions from the kernel via `complete_request`.
   *
   * Uses the Jupyter Messaging Protocol shell channel to ask ipykernel
   * (Jedi) for completions at the given cursor position. ipykernel inspects
   * the live namespace, so completions reflect runtime objects (including
   * `pdv_tree`, variables from prior executions, and method chains on live
   * objects) — not just what is statically visible in the editor buffer.
   *
   * @param id - Kernel ID.
   * @param code - Full source text of the editor buffer.
   * @param cursorPos - Byte offset of the cursor in `code`.
   * @returns Completion matches and the cursor range they should replace.
   * @throws If the kernel is not found.
   */
  async complete(
    id: string,
    code: string,
    cursorPos: number
  ): Promise<{ matches: string[]; cursor_start: number; cursor_end: number; metadata?: Record<string, unknown> }> {
    const managed = this.kernels.get(id);
    if (!managed) throw new Error(`Kernel not found: ${id}`);

    const msg = createMessage(
      "complete_request",
      { code, cursor_pos: cursorPos },
      managed.sessionId
    );
    const msgId = msg.header.msg_id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.shellReplyListeners.get(id)?.delete(msgId);
        resolve({ matches: [], cursor_start: cursorPos, cursor_end: cursorPos });
      }, 5_000);

      const cleanup = this.registerShellReply(id, msgId, (reply) => {
        clearTimeout(timer);
        if (reply.content.status === "error") {
          resolve({ matches: [], cursor_start: cursorPos, cursor_end: cursorPos });
          return;
        }
        resolve({
          matches: (reply.content.matches as string[]) ?? [],
          cursor_start: (reply.content.cursor_start as number) ?? cursorPos,
          cursor_end: (reply.content.cursor_end as number) ?? cursorPos,
          metadata: reply.content.metadata as Record<string, unknown> | undefined,
        });
      });

      managed.shellSocket
        .send(serializeMessage(msg, managed.connectionInfo.key))
        .catch((err: Error) => {
          clearTimeout(timer);
          cleanup();
          reject(err);
        });
    });
  }

  /**
   * Request symbol documentation from the kernel via `inspect_request`.
   *
   * Returns the docstring or repr for the symbol at the cursor position.
   * The renderer uses this to populate Monaco hover popups.
   *
   * @param id - Kernel ID.
   * @param code - Full source text of the editor buffer.
   * @param cursorPos - Byte offset of the cursor in `code`.
   * @returns Inspection result with `found` flag and a mime-bundle `data` map.
   * @throws If the kernel is not found.
   */
  async inspect(
    id: string,
    code: string,
    cursorPos: number
  ): Promise<{ found: boolean; data?: Record<string, string> }> {
    const managed = this.kernels.get(id);
    if (!managed) throw new Error(`Kernel not found: ${id}`);

    const msg = createMessage(
      "inspect_request",
      { code, cursor_pos: cursorPos, detail_level: 0 },
      managed.sessionId
    );
    const msgId = msg.header.msg_id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.shellReplyListeners.get(id)?.delete(msgId);
        resolve({ found: false });
      }, 5_000);

      const cleanup = this.registerShellReply(id, msgId, (reply) => {
        clearTimeout(timer);
        if (reply.content.status === "error" || !reply.content.found) {
          resolve({ found: false });
          return;
        }
        resolve({
          found: true,
          data: reply.content.data as Record<string, string> | undefined,
        });
      });

      managed.shellSocket
        .send(serializeMessage(msg, managed.connectionInfo.key))
        .catch((err: Error) => {
          clearTimeout(timer);
          cleanup();
          reject(err);
        });
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Register a one-shot listener for a shell reply with the given parent msg_id.
   *
   * @param kernelId - Kernel ID.
   * @param msgId - The msg_id of the request being awaited.
   * @param callback - Invoked once when the reply arrives; then auto-removed.
   * @returns A cleanup function that removes the listener without calling it.
   */
  private registerShellReply(
    kernelId: string,
    msgId: string,
    callback: (msg: JupyterMessage) => void
  ): () => void {
    let map = this.shellReplyListeners.get(kernelId);
    if (!map) {
      map = new Map();
      this.shellReplyListeners.set(kernelId, map);
    }
    map.set(msgId, callback);
    return () => {
      this.shellReplyListeners.get(kernelId)?.delete(msgId);
    };
  }

  /**
   * Dispatch a shell reply to the one-shot listener registered for its parent
   * msg_id. Silently ignores messages with no registered listener (e.g.
   * execute_reply, kernel_info_reply which we do not need to consume).
   *
   * @param kernelId - Kernel ID.
   * @param msg - Parsed shell reply message.
   */
  private dispatchShellReply(kernelId: string, msg: JupyterMessage): void {
    const parentMsgId = msg.parent_header.msg_id as string | undefined;
    if (!parentMsgId) return;
    const map = this.shellReplyListeners.get(kernelId);
    const cb = map?.get(parentMsgId);
    if (cb) {
      map!.delete(parentMsgId);
      try {
        cb(msg);
      } catch (err) {
        console.error("[KernelManager] shell reply listener threw:", err);
      }
    }
  }

  /**
   * Background async loop that reads shell replies and dispatches them.
   *
   * Reads complete_reply, inspect_reply (and silently discards execute_reply,
   * kernel_info_reply, etc.). Runs until managed.shuttingDown is set.
   *
   * @param managed - The kernel whose shell socket to read.
   */
  private async runShellLoop(managed: ManagedKernel): Promise<void> {
    (managed.shellSocket as unknown as { receiveTimeout: number }).receiveTimeout = 100;

    while (!managed.shuttingDown) {
      try {
        const frames = await managed.shellSocket.receive();
        const msg = parseMessage(frames as Buffer[], managed.connectionInfo.key);
        if (msg) {
          this.dispatchShellReply(managed.info.id, msg);
        }
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === "EAGAIN") continue; // receive timeout — check shuttingDown
        break; // socket closed or unexpected error
      }
    }
  }

  /**
   * Dispatch a parsed iopub message to all registered listeners for a kernel.
   */
  private dispatchIopub(id: string, msg: JupyterMessage): void {
    const listeners = this.iopubListeners.get(id);
    if (!listeners) return;
    // Iterate over a snapshot so that listeners added during dispatch are safe.
    for (const cb of [...listeners]) {
      try {
        cb(msg);
      } catch (err) {
        console.error("[KernelManager] iopub listener threw:", err);
      }
    }
  }

  /**
   * Background async loop that reads the iopub socket and dispatches messages.
   *
   * Runs until the socket is closed (i.e. stop() is called).
   */
  private async runIopubLoop(managed: ManagedKernel): Promise<void> {
    // Use receiveTimeout so the loop periodically wakes up and can check
    // managed.shuttingDown without requiring socket.close() to interrupt it.
    // This eliminates the race condition where close() destroys the native
    // socket while receive() still has a pending operation on it (→ SIGSEGV).
    (managed.iopubSocket as unknown as { receiveTimeout: number }).receiveTimeout = 100;

    while (!managed.shuttingDown) {
      try {
        const frames = await managed.iopubSocket.receive();
        const msg = parseMessage(frames as Buffer[], managed.connectionInfo.key);
        if (msg) {
          this.dispatchIopub(managed.info.id, msg);
        }
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === "EAGAIN") continue; // receive timeout — check shuttingDown
        break; // socket closed or unexpected error
      }
    }
  }

  /**
   * Wait for the kernel to emit `status: idle` on iopub, which signals that
   * it has finished initializing and is ready to accept execute_request.
   *
   * Sends periodic kernel_info_request messages to provoke a status reply.
   *
   * @param managed - The kernel to wait for.
   * @param timeoutMs - Maximum wait time (default 30 s).
   */
  private async waitForKernelReady(
    managed: ManagedKernel,
    timeoutMs = 30_000
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let finished = false;

      const done = (err?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(pingInterval);
        cleanup();
        err ? reject(err) : resolve();
      };

      const cleanup = this.onIopubMessage(managed.info.id, (jupMsg) => {
        if (
          jupMsg.header.msg_type === "status" &&
          jupMsg.content.execution_state === "idle"
        ) {
          done();
        }
      });

      const timer = setTimeout(
        () => done(new Error("Kernel startup timed out")),
        timeoutMs
      );

      const sendPing = () => {
        if (finished) return;
        const msg = createMessage(
          "kernel_info_request",
          {},
          managed.sessionId
        );
        managed.shellSocket
          .send(serializeMessage(msg, managed.connectionInfo.key))
          .catch(() => {
            // Ignore send errors during startup.
          });
      };

      // Send immediately and then retry every second.
      sendPing();
      const pingInterval = setInterval(sendPing, 1000);
    });
  }
}
