/**
 * server-supervisor.ts — Spawns and supervises the pdv-server child
 * process for local mode.
 *
 * Owns the server process lifecycle: spawning `process.execPath` with
 * `ELECTRON_RUN_AS_NODE=1` on the server entry, the hello handshake with
 * exact app-version check (one automatic retry at startup), the ping
 * liveness loop, crash handling (reject pending invokes, offer Restart),
 * and the graceful shutdown chain (`pdv.rpc.shutdown` → SIGTERM →
 * SIGKILL). Relays the server's stderr line-buffered with a
 * `[pdv-server]` prefix.
 *
 * The supervisor outlives any single window: the per-window server bridge
 * (`shell/server-bridge.ts`) plugs its push/confirm/child-window handlers
 * in via {@link ServerSupervisor.setBridgeHandlers} and the supervisor
 * routes traffic to whichever handlers are current.
 *
 * This module does NOT register ipcMain handlers (the bridge does), own
 * channel names, or contain server logic.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.4
 * server/server-main.ts — the child process this module spawns
 */

import { spawn, type ChildProcess } from "child_process";
import { app, dialog, type BrowserWindow } from "electron";
import * as path from "path";

import type { ConfirmFn } from "../server/confirm";
import type { PushSender } from "../server/invoke-registry";
import {
  RPC_CHANNELS,
  type RpcConfirmRequest,
  type RpcConfirmResponse,
} from "../transport/protocol";
import { RpcClient } from "../transport/rpc-client";

/** How long to wait for the server's hello push before giving up. */
const HELLO_TIMEOUT_MS = 10_000;
/** How long the graceful `pdv.rpc.shutdown` invoke may take. */
const SHUTDOWN_INVOKE_TIMEOUT_MS = 5_000;
/** How long SIGTERM may take before escalating to SIGKILL. */
const SIGTERM_TIMEOUT_MS = 3_000;

/**
 * Handlers the per-window server bridge plugs into the supervisor. All
 * routing is through these; when no bridge is attached (window closed),
 * pushes are dropped and confirms answer with their cancel choice.
 */
export interface BridgeHandlers {
  /** Forwards a server push to the renderer window(s). */
  onPush: PushSender;
  /** Shows the native confirm dialog for a reverse-RPC confirm request. */
  confirm: ConfirmFn;
  /** Closes child windows (module windows, GUI editor/viewer). */
  closeChildWindows: () => void;
}

/**
 * The narrow surface shell code uses to reach the server. `index.ts` and
 * `app.ts` depend on this interface (tests substitute an in-process fake);
 * `bootstrap.ts` owns the concrete {@link ServerSupervisor}.
 */
export interface ServerHandle {
  /** Invoke a server channel (an `ipc.ts` constant or `pdv.internal.*`). */
  invoke(channel: string, args?: unknown[]): Promise<unknown>;
  /** Full session reset (`pdv.rpc.sessionReset`), awaited. */
  sessionReset(): Promise<void>;
  /** Attach the current window's bridge handlers (replaces previous). */
  setBridgeHandlers(handlers: BridgeHandlers): void;
  /** Detach the bridge handlers (window gone); traffic is dropped. */
  clearBridgeHandlers(): void;
}

/** Constructor dependencies for {@link ServerSupervisor}. */
export interface ServerSupervisorOptions {
  /** Unified app version; the hello must match exactly. */
  version: string;
  /** Electron userData dir, passed as `PDV_USER_DATA_DIR`. */
  userDataDir: string;
  /** `~/.PDV` root, passed as `PDV_PDV_DIR`. */
  pdvDir: string;
  /** Packaged-resources root, passed as `PDV_RESOURCES_ROOT` (or unset). */
  resourcesRoot: string | null;
  /** Current main window for crash-recovery reloads (null when closed). */
  getWindow: () => BrowserWindow | null;
  /** Override the spawned executable (tests). Default: `process.execPath`. */
  execPath?: string;
  /** Override the server entry script (tests). */
  entryPath?: string;
  /** Override the extra CLI args after the entry script (tests). */
  entryArgs?: string[];
  /** Override the hello timeout (tests). */
  helloTimeoutMs?: number;
  /** Override the ping cadence (tests). */
  pingIntervalMs?: number;
  /** Override the graceful-shutdown invoke timeout (tests). */
  shutdownInvokeTimeoutMs?: number;
  /** Override the SIGTERM-to-SIGKILL escalation timeout (tests). */
  sigtermTimeoutMs?: number;
}

/** Supervisor lifecycle phase, gating crash-vs-shutdown interpretation. */
type Phase = "stopped" | "starting" | "running" | "stopping";

/**
 * Resolve the server entry script for the current install layout.
 *
 * @returns Absolute path to the server's JS entry.
 */
function defaultEntryPath(): string {
  if (app.isPackaged) {
    // Packaged: the esbuild server bundle shipped via extraResources
    // (a real file on disk — plain Node cannot require from asar).
    return path.join(process.resourcesPath, "pdv-server", "pdv-server.cjs");
  }
  // Dev / E2E: the tsc output next to this file's compiled location
  // (dist/main/shell/ → dist/main/server/server-main.js).
  return path.join(__dirname, "..", "server", "server-main.js");
}

/**
 * Resolve the `PDV_ZEROMQ_PATH` override for the packaged layout, where
 * zeromq's native module is asar-unpacked and the server bundle (built
 * with `--external:zeromq`) cannot resolve it relatively.
 *
 * @returns The unpacked zeromq path, or null when normal resolution works.
 */
function defaultZeromqPath(): string | null {
  if (!app.isPackaged) return null;
  return path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "zeromq"
  );
}

/** Await a promise with a timeout; rejects with `label` on expiry. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Spawns and supervises the pdv-server child (see the file header).
 *
 * Lifecycle: `await start()` once at app startup (before the first
 * window), then `invoke()` freely; `await shutdown()` on quit. A crash
 * mid-run rejects pending invokes and shows a Restart/Quit dialog.
 */
export class ServerSupervisor implements ServerHandle {
  private readonly opts: ServerSupervisorOptions;
  private child: ChildProcess | null = null;
  private client: RpcClient | null = null;
  private phase: Phase = "stopped";
  private bridge: BridgeHandlers | null = null;
  /** Buffers a partial stderr line between chunks. */
  private stderrRemainder = "";

  /**
   * @param opts - Paths, version, and test overrides; see
   *   {@link ServerSupervisorOptions}.
   */
  constructor(opts: ServerSupervisorOptions) {
    this.opts = opts;
  }

  /**
   * Spawn the server and complete the hello handshake. Retries the spawn
   * once automatically; a second failure propagates to the caller (which
   * surfaces it and quits — the app cannot run without its server).
   *
   * @returns Resolves when the server answered hello with a matching version.
   * @throws {Error} When both spawn attempts fail hello or the versions
   *   mismatch.
   */
  async start(): Promise<void> {
    try {
      await this.startAttempt();
    } catch (firstError) {
      console.error(
        "[pdv] pdv-server failed to start, retrying once:",
        firstError
      );
      await this.startAttempt();
    }
  }

  /** One spawn + hello attempt. */
  private async startAttempt(): Promise<void> {
    if (this.phase !== "stopped") {
      throw new Error(`cannot start pdv-server while ${this.phase}`);
    }
    this.phase = "starting";
    const execPath = this.opts.execPath ?? process.execPath;
    const entryPath = this.opts.entryPath ?? defaultEntryPath();
    const entryArgs = this.opts.entryArgs ?? ["serve", "--stdio"];
    const zeromqPath = defaultZeromqPath();

    const child = spawn(execPath, [entryPath, ...entryArgs], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PDV_APP_VERSION: this.opts.version,
        PDV_USER_DATA_DIR: this.opts.userDataDir,
        PDV_PDV_DIR: this.opts.pdvDir,
        ...(this.opts.resourcesRoot
          ? { PDV_RESOURCES_ROOT: this.opts.resourcesRoot }
          : {}),
        ...(zeromqPath ? { PDV_ZEROMQ_PATH: zeromqPath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => this.relayStderr(chunk));
    child.on("exit", (code, signal) => this.onChildExit(code, signal));
    child.on("error", (err) => {
      // Spawn failure (e.g. missing entry). The exit handler won't fire
      // with a live client; close() rejects the hello wait below.
      console.error("[pdv] pdv-server spawn error:", err);
      this.client?.close(`pdv-server spawn error: ${err.message}`);
    });

    if (!child.stdout || !child.stdin) {
      this.disposeChild();
      throw new Error("pdv-server spawn produced no stdio streams");
    }
    const client = new RpcClient(child.stdout, child.stdin, {
      onPush: (event, payload) => {
        this.bridge?.onPush(event, payload);
      },
      onReservedPush: (event, payload) => {
        void this.onReservedPush(event, payload);
      },
      onUnresponsive: () => {
        console.error("[pdv] pdv-server unresponsive; killing it");
        // SIGKILL trips the exit handler, which runs the crash flow.
        this.child?.kill("SIGKILL");
      },
      pingIntervalMs: this.opts.pingIntervalMs,
    });
    this.client = client;

    try {
      const hello = await client.waitForHello(
        this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS
      );
      if (hello.version !== this.opts.version) {
        throw new Error(
          `pdv-server version mismatch: shell ${this.opts.version}, server ${hello.version}`
        );
      }
    } catch (err) {
      this.disposeChild();
      throw err instanceof Error ? err : new Error(String(err));
    }
    client.startPing();
    this.phase = "running";
  }

  /**
   * Invoke a server channel over the transport.
   *
   * @param channel - Channel name (`ipc.ts` constant or `pdv.internal.*`).
   * @param args - Arguments as the renderer passed them.
   * @returns The handler's result.
   * @throws {Error} The server's rejection (renderer-visible message
   *   preserved), or a connection error when the server is not running.
   */
  invoke(channel: string, args: unknown[] = []): Promise<unknown> {
    if (!this.client || this.phase !== "running") {
      return Promise.reject(new Error("pdv-server is not running"));
    }
    return this.client.invoke(channel, args);
  }

  /**
   * Full server-side session reset (`pdv.rpc.sessionReset`), awaited so
   * callers can sequence it before the renderer loads.
   *
   * @returns Resolves when the server acked the reset.
   * @throws {Error} When the server is not running.
   */
  async sessionReset(): Promise<void> {
    await this.invoke(RPC_CHANNELS.sessionReset);
  }

  /** @inheritdoc */
  setBridgeHandlers(handlers: BridgeHandlers): void {
    this.bridge = handlers;
  }

  /** @inheritdoc */
  clearBridgeHandlers(): void {
    this.bridge = null;
  }

  /**
   * Graceful shutdown chain: `pdv.rpc.shutdown` (the server stops kernels,
   * MCP, and exits), then SIGTERM, then SIGKILL. Idempotent; safe to call
   * with no server running.
   *
   * @returns Resolves when the child process has exited.
   */
  async shutdown(): Promise<void> {
    if (this.phase === "stopped" || this.phase === "stopping") return;
    const child = this.child;
    const client = this.client;
    this.phase = "stopping";
    if (!child || !client) {
      this.phase = "stopped";
      return;
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });
    try {
      await withTimeout(
        client.invoke(RPC_CHANNELS.shutdown).then(() => exited),
        this.opts.shutdownInvokeTimeoutMs ?? SHUTDOWN_INVOKE_TIMEOUT_MS,
        "pdv-server graceful shutdown timed out"
      );
    } catch (err) {
      console.warn("[pdv] escalating pdv-server shutdown to SIGTERM:", err);
      child.kill("SIGTERM");
      try {
        await withTimeout(
          exited,
          this.opts.sigtermTimeoutMs ?? SIGTERM_TIMEOUT_MS,
          "pdv-server did not exit on SIGTERM"
        );
      } catch {
        console.warn("[pdv] escalating pdv-server shutdown to SIGKILL");
        child.kill("SIGKILL");
        await exited;
      }
    }
    this.disposeChild();
  }

  /** Route a reserved `pdv.rpc.*` push from the server. */
  private async onReservedPush(event: string, payload: unknown): Promise<void> {
    switch (event) {
      case RPC_CHANNELS.confirmRequest: {
        const request = payload as RpcConfirmRequest;
        let response: number;
        if (this.bridge) {
          try {
            response = await this.bridge.confirm(request.options);
          } catch (err) {
            console.error("[pdv] confirm dialog failed:", err);
            response = request.options.cancelId ?? 0;
          }
        } else {
          // No window to ask — answer with the safe cancel choice.
          response = request.options.cancelId ?? 0;
        }
        const reply: RpcConfirmResponse = {
          requestId: request.requestId,
          response,
        };
        try {
          await this.invoke(RPC_CHANNELS.confirmResponse, [reply]);
        } catch (err) {
          console.error("[pdv] confirmResponse delivery failed:", err);
        }
        return;
      }
      case RPC_CHANNELS.closeChildWindows: {
        this.bridge?.closeChildWindows();
        return;
      }
      default:
        console.warn(`[pdv] unhandled reserved push from pdv-server: ${event}`);
    }
  }

  /** Line-buffer the server's stderr into prefixed console lines. */
  private relayStderr(chunk: Buffer): void {
    const text = this.stderrRemainder + chunk.toString("utf8");
    const lines = text.split("\n");
    this.stderrRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) console.error(`[pdv-server] ${line}`);
    }
  }

  /** Child exit handler: expected during stop, a crash otherwise. */
  private onChildExit(code: number | null, signal: string | null): void {
    const wasRunning = this.phase === "running";
    // During "starting" the hello wait surfaces the failure; during
    // "stopping" the exit is the goal. Either way just settle pending work.
    this.client?.close(
      `pdv-server exited (code ${String(code)}, signal ${String(signal)})`
    );
    if (!wasRunning) return;
    console.error(
      `[pdv] pdv-server crashed (code ${String(code)}, signal ${String(signal)})`
    );
    this.disposeChild();
    void this.offerRestartAfterCrash();
  }

  /** Crash dialog: Restart respawns the server and reloads the renderer. */
  private async offerRestartAfterCrash(): Promise<void> {
    const win = this.opts.getWindow();
    const options = {
      type: "error" as const,
      title: "PDV backend crashed",
      message: "The PDV backend process stopped unexpectedly.",
      detail:
        "Unsaved changes since the last save or autosave are lost. " +
        "Restart the backend to continue working.",
      buttons: ["Restart", "Quit"],
      defaultId: 0,
      cancelId: 1,
    };
    const { response } =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    if (response !== 0) {
      app.exit(1);
      return;
    }
    try {
      await this.start();
    } catch (err) {
      console.error("[pdv] pdv-server restart failed:", err);
      await dialog.showMessageBox({
        type: "error",
        message: "The PDV backend could not be restarted.",
        detail: err instanceof Error ? err.message : String(err),
        buttons: ["Quit"],
      });
      app.exit(1);
      return;
    }
    const reloadWin = this.opts.getWindow();
    if (reloadWin && !reloadWin.isDestroyed()) {
      reloadWin.reload();
    }
  }

  /** Drop the child/client references and return to "stopped". */
  private disposeChild(): void {
    this.client?.close("pdv-server supervisor disposed the connection");
    this.client = null;
    this.child = null;
    this.phase = "stopped";
  }
}
