/**
 * server-main.ts — CLI entrypoint for the extracted pdv-server process.
 *
 * Runs under plain Node (the Electron binary with ELECTRON_RUN_AS_NODE=1):
 * builds the session managers exactly as the Electron shell's bootstrap
 * does, assembles the server core via `wireServer()`, and serves the
 * invoke registry over the stdio RPC transport (`transport/rpc-server.ts`).
 *
 * Invocations:
 * - `pdv-server serve --stdio` — serve a session over stdio RPC.
 * - `pdv-server self-check`    — verify this bundle works on this host and
 *   print one JSON verdict line. The one mode where stdout is *not* the
 *   protocol channel; it ships inside the bundle so it is version-locked to
 *   the code it vouches for.
 *
 * Environment contract for `serve`:
 * - `PDV_APP_VERSION`   (required) — unified app version for the hello push.
 * - `PDV_USER_DATA_DIR` (required) — Electron userData equivalent
 *   (consumed by `server-paths.ts`).
 * - `PDV_PDV_DIR`       (optional) — `~/.PDV` override.
 * - `PDV_RESOURCES_ROOT`(optional) — packaged-resources root for bundled
 *   binaries (consumed by `server-paths.ts`).
 *
 * stdout is protocol-only: the first statement rebinds `console.*` to
 * stderr, before any import can log, so no stray write can corrupt the
 * newline-delimited JSON framing.
 *
 * This module does NOT import Electron, register handlers itself (the
 * registrars do, via `wireServer`), or manage windows.
 */

// Rebind console to stderr BEFORE any imports execute (TypeScript's CJS
// emit preserves statement order relative to imports, mirroring the
// timestamp installer in bootstrap.ts). stdout carries only RPC frames.
(function rebindConsoleToStderr(): void {
  // Under vitest the global console is an intercepting shim with no Console
  // constructor; there the rebind is impossible and also pointless (nothing
  // parses the test process's stdout as RPC frames), so leave it alone.
  if (typeof console.Console !== "function") return;
  const stderrConsole = new console.Console({
    stdout: process.stderr,
    stderr: process.stderr,
  });
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    console[method] = stderrConsole[method].bind(stderrConsole);
  }
})();

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { CommRouter } from "../comm-router";
import { ConfigStore } from "../config";
import { KernelManager } from "../kernel-manager";
import { ProjectManager } from "../project-manager";
import { QueryRouter } from "../query-router";
import { setAppVersion } from "../pdv-protocol";
import { RPC_CHANNELS } from "../transport/protocol";
import { RpcServer } from "../transport/rpc-server";
import { runSelfCheck } from "./self-check";
import { applyLoginEnv, captureLoginEnv } from "./login-env";
import { attachToSession, proxyStdio } from "./attach-cli";
import { SessionHost } from "./session-host";
import { resolveSessionPaths } from "./session-paths";
import { touchHeartbeat, writeSessionMeta } from "./session-meta";
import { readBootId } from "./session-lock";
import { SessionIdlePolicy } from "./session-idle";
import { RPC_PROTOCOL_VERSION } from "../transport/protocol";
import { ShellConfirmBroker } from "./shell-confirm";
import { getWiredCellRpc, getWiredMcpServer, unwireServer, wireServer, type WireHandle } from "./wire";

/**
 * Parse arguments, build the server core, and start serving stdio RPC.
 *
 * @returns Nothing (the process runs until shutdown or stream close).
 * @throws {Error} Startup failures exit the process with a non-zero code
 *   rather than throwing to the caller.
 */
export function serverMain(): void {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === "self-check") {
    // Deliberately before every environment requirement below: a self-check
    // exists to diagnose a host, and refusing to run it because the session
    // variables are unset would withhold the diagnosis exactly when it is
    // needed. It also must not construct any manager — the point is to test
    // the *bundle*, not to start a session.
    void runSelfCheck().then((report) => {
      process.stdout.write(JSON.stringify(report) + "\n");
      process.exit(report.ok ? 0 : 1);
    });
    return;
  }

  if (subcommand === "session-host") {
    // The long-lived daemon. Already detached by whoever spawned it, so it
    // simply serves its socket until the idle policy or a signal ends it.
    void runSessionHost(args);
    return;
  }

  if (subcommand === "attach") {
    // A proxy over one ssh channel, not a server. It may die at any moment
    // without touching the session it is connected to.
    void runAttach(args);
    return;
  }

  if (subcommand !== "serve" || !args.includes("--stdio")) {
    console.error(
      "usage: pdv-server serve --stdio | pdv-server self-check | " +
        "pdv-server attach --session <id> --stdio [--create] | " +
        "pdv-server session-host --session <id> --root <dir>"
    );
    process.exit(2);
  }

  const version = process.env.PDV_APP_VERSION;
  if (!version) {
    console.error("[pdv-server] PDV_APP_VERSION is required (hello version check)");
    process.exit(2);
  }
  if (!process.env.PDV_USER_DATA_DIR) {
    console.error("[pdv-server] PDV_USER_DATA_DIR is required");
    process.exit(2);
  }
  // Baked into the bundle by scripts/build-server.mjs (esbuild --define).
  // Undefined in development, where the supervisor runs the tsc output that
  // was just compiled from the same tree and cannot be stale. In a packaged
  // build it is the only value not derived from the running app, so it is
  // what makes the hello version check meaningful: without it both sides
  // read app.getVersion() and a stale server bundle would pass.
  const buildVersion = process.env.PDV_BUILD_VERSION;
  if (buildVersion && buildVersion !== version) {
    console.error(
      `[pdv-server] bundle is stale: built for ${buildVersion}, shell is ${version}. ` +
        "Rebuild with `npm run build:server`."
    );
    process.exit(2);
  }
  setAppVersion(version);

  const pdvDir = process.env.PDV_PDV_DIR ?? path.join(os.homedir(), ".PDV");
  fs.mkdirSync(pdvDir, { recursive: true });

  const commRouter = new CommRouter();
  const queryRouter = new QueryRouter();
  const projectManager = new ProjectManager(commRouter);
  const kernelManager = new KernelManager();
  const configStore = new ConfigStore(pdvDir);

  let wire: WireHandle | null = null;
  let confirmBroker: ShellConfirmBroker | null = null;
  const rpcServer = new RpcServer(process.stdin, process.stdout, {
    version,
    onSessionReset: () => {
      wire?.sessionReset();
    },
    onConfirmResponse: (payload) => {
      confirmBroker?.deliver(payload);
    },
    onShutdown: async () => {
      console.log("[pdv-server] shutdown requested");
      confirmBroker?.cancelAll();
      try {
        await kernelManager.shutdownAll();
      } catch (error) {
        console.error("[pdv-server] kernel shutdown failed:", error);
      }
      try {
        await getWiredMcpServer()?.stop();
      } catch (error) {
        console.error("[pdv-server] MCP stop failed:", error);
      }
      getWiredCellRpc()?.stop();
      // Removes kernel working directories and detaches listeners.
      unwireServer();
      await rpcServer.flush();
      process.exit(0);
    },
  });

  confirmBroker = new ShellConfirmBroker(rpcServer.push);
  wire = wireServer({
    push: rpcServer.push,
    // Native confirms need the shell: reverse RPC via the broker
    // (confirmRequest push → shell dialog → confirmResponse invoke).
    confirm: confirmBroker.confirm,
    pdvDir,
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    configStore,
    // Child windows live in the shell; ask it to close them.
    closeChildWindows: () => {
      rpcServer.push(RPC_CHANNELS.closeChildWindows, undefined);
    },
    startMcp: true,
  });

  // The supervisor escalates to SIGTERM when the graceful shutdown invoke
  // overruns its budget. Without a handler the default disposition kills
  // this process instantly, orphaning every kernel child (they are spawned
  // non-detached with piped stdio, so they survive and are reparented to
  // init). Reap them synchronously, then exit.
  process.on("SIGTERM", () => {
    console.error("[pdv-server] SIGTERM; force-killing kernels and exiting");
    try {
      kernelManager.killAllNow();
    } catch (error) {
      console.error("[pdv-server] force-kill failed:", error);
    }
    process.exit(1);
  });

  // If the shell disappears without a shutdown invoke (crash, SIGKILL),
  // stdin closes — exit rather than lingering as an orphan.
  process.stdin.on("end", () => {
    console.log("[pdv-server] stdin closed; shutting down");
    confirmBroker?.cancelAll();
    void kernelManager
      .shutdownAll()
      .catch((error) => {
        console.error("[pdv-server] kernel shutdown failed:", error);
      })
      .finally(() => {
        unwireServer();
        process.exit(0);
      });
  });

  rpcServer.start();
  console.log(
    `[pdv-server] serving stdio RPC (pid ${process.pid}, version ${version})`
  );
}

// CLI entry: run only when executed directly, never on import (tests and
// the future supervisor import types from this module).
if (require.main === module) {
  serverMain();
}

/** Read `--flag value` from an argv slice. */
function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * Default PDV root for sessions: `~/.pdv-server`.
 *
 * @returns The root directory path.
 */
function defaultRoot(): string {
  // Must agree with REMOTE_ROOT in remote/bootstrap.ts — the shell's
  // remoteServerCommand cd's into the same directory it installed to.
  return path.join(os.homedir(), ".pdv-server");
}

/** Dependencies for {@link wireSessionIdle}. */
export interface WireSessionIdleOptions {
  /** The daemon's kernel manager (source of execution-state events). */
  kernelManager: KernelManager;
  /**
   * The wire whose `autosaveForShutdown` gates the shutdown. Taken as the
   * handle — not a bare callback — so THIS function owns the delegation
   * and its test covers it; a bare callback left the two lines joining the
   * policy to the real autosave invisible to every test, which is exactly
   * how the original always-true stub survived 14 green tests.
   */
  wire: Pick<WireHandle, "autosaveForShutdown">;
  /** Stop the session. Called only after a successful autosave. */
  shutdown: () => void;
  /** Timer factory, injected by tests. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  /** Timer canceller, injected by tests. */
  clearTimer?: (handle: NodeJS.Timeout) => void;
}

/**
 * Build the daemon's idle policy and connect it to the kernel manager.
 *
 * The connection is the point: `SessionIdlePolicy` is only as good as what
 * drives it, and a policy whose `onExecutionIdle` nobody calls silently
 * degrades "the cap counts idle time" into "no cap at all while executing".
 * This function owns that coupling — the `kernel:executionState` event
 * feeds both hooks, and the predicates read the live kernel list — so it
 * can be tested as a unit (`server-main.test.ts`) instead of trusting the
 * policy's own tests to vouch for wiring they never see.
 *
 * @param opts - Kernel manager, autosave gate, and shutdown action.
 * @returns The armed policy; the caller drives attach/detach transitions.
 */
export function wireSessionIdle(opts: WireSessionIdleOptions): SessionIdlePolicy {
  const { kernelManager } = opts;
  const idle = new SessionIdlePolicy({
    hasKernel: () => kernelManager.list().length > 0,
    // A dead kernel's executionState is frozen at whatever it was doing
    // when it died — a crash mid-run stays "busy" forever. Counting it as
    // executing would suspend the cap permanently and leak the daemon on
    // the login node, the exact outcome the policy exists to prevent.
    isExecuting: () =>
      kernelManager
        .list()
        .some(
          (k) =>
            kernelManager.getExecutionState(k.id) === "busy" &&
            kernelManager.getKernel(k.id)?.status !== "dead",
        ),
    autosave: () => opts.wire.autosaveForShutdown(),
    shutdown: opts.shutdown,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
  });
  // Any kernel's transition re-evaluates the aggregate: the policy's
  // predicates re-check every kernel, so a spurious call is harmless while
  // a missed one would let the cap fire mid-run or never re-arm.
  kernelManager.on(
    "kernel:executionState",
    (_kernelId: string, state: "idle" | "busy") => {
      if (state === "idle") idle.onExecutionIdle();
      else idle.onExecutionBusy();
    },
  );
  // A kernel dying IS an execution-idle transition as far as the cap is
  // concerned — no further executionState event will ever arrive from it.
  kernelManager.on("kernel:crashed", () => idle.onExecutionIdle());
  return idle;
}

/**
 * Serve one session until the process is told to stop.
 *
 * @param args - argv slice beginning with `session-host`.
 * @returns Resolves when the socket is listening; the process stays alive.
 * @throws Error if the session id is missing or the socket cannot be bound.
 */
async function runSessionHost(args: string[]): Promise<void> {
  const sessionId = flagValue(args, "--session");
  if (!sessionId) {
    console.error("[session-host] --session <id> is required");
    process.exit(2);
    return;
  }
  const root = flagValue(args, "--root") ?? defaultRoot();
  // Required, exactly as in serve mode — and MORE dangerous to default here:
  // the attach handshake gates on the RPC protocol version (by design, so an
  // app upgrade never orphans a live daemon), which means a daemon running
  // as version "unknown" starts fine, attaches fine, and then the comm
  // router silently rejects every kernel message as version-incompatible.
  // A daemon that can never accept a kernel must refuse to start instead.
  const version = process.env.PDV_APP_VERSION;
  if (!version) {
    console.error("[session-host] PDV_APP_VERSION is required (kernel comm version check)");
    process.exit(2);
    return;
  }

  const paths = resolveSessionPaths({ sessionId, root });
  const pdvDir = process.env.PDV_PDV_DIR ?? path.join(os.homedir(), ".PDV");
  fs.mkdirSync(pdvDir, { recursive: true });
  setAppVersion(version);

  // A daemon spawned over an ssh exec channel never ran a login shell, so
  // Lmod/juliaup/conda PATH entries are invisible to it and to every kernel
  // and probe it spawns. Capture the login environment (sourcing the
  // session's setup script when one was shipped) BEFORE any manager exists —
  // process.env is what every spawn call site builds from. A failed capture
  // is survived (the daemon then behaves exactly as before this existed),
  // but when a setup script was shipped the failure is loud and recorded in
  // session.json: the user explicitly asked for an environment they are not
  // getting, and "interpreters silently missing" is the harder bug.
  const setupScriptShipped = fs.existsSync(paths.setupScriptPath);
  const captured = await captureLoginEnv({
    setupScriptPath: paths.setupScriptPath,
  });
  const setupScriptApplied = captured?.setupScriptSourced ?? false;
  if (captured) {
    const changed = applyLoginEnv(captured.env);
    console.log(
      `[session-host] applied login environment (${changed} variables ` +
        `added or changed${captured.setupScriptSourced ? "; setup script sourced" : ""})`,
    );
  }
  if (setupScriptShipped && !setupScriptApplied) {
    console.error(
      `[session-host] SETUP SCRIPT NOT APPLIED: ${paths.setupScriptPath} was ` +
        "shipped but the login-environment capture did not source it " +
        "(capture failed or timed out). Kernels in this session run WITHOUT " +
        "the configured environment.",
    );
  }

  const commRouter = new CommRouter();
  const queryRouter = new QueryRouter();
  const projectManager = new ProjectManager(commRouter);
  const kernelManager = new KernelManager();
  const configStore = new ConfigStore(pdvDir);

  // These reference each other, which is safe because every callback below
  // fires long after all of them are constructed.
  const host: SessionHost = new SessionHost({
    paths,
    sessionId,
    version,
    // Reported to every attaching client, so the shell can warn when a
    // configured setup script is not in effect (capture failed, or the
    // script arrived after this daemon booted).
    setupScriptApplied,
    onNoClients: () => idle.onClientsGone(),
    onClientAttached: () => idle.onClientAttached(),
    onSessionReset: () => wire.sessionReset(),
    onConfirmResponse: (payload) => confirmBroker.deliver(payload),
    // The explicit "Shut Down Remote Session" action: graceful, like the
    // serve-mode shutdown — kernels get their shutdown sequence (not the
    // SIGTERM force-kill), then the socket is unlinked and the process ends.
    onShutdown: async () => {
      console.log("[session-host] shutdown requested by client");
      idle.dispose();
      confirmBroker.cancelAll();
      try {
        await kernelManager.shutdownAll();
      } catch (error) {
        console.error("[session-host] kernel shutdown failed:", error);
      }
      unwireServer();
      await host.close();
      process.exit(0);
    },
  });

  // Session-scoped, not connection-scoped: handlers must push through the
  // session so their output is journalled even when nobody is attached.
  const confirmBroker = new ShellConfirmBroker(host.push);
  const wire = wireServer({
    push: host.push,
    confirm: confirmBroker.confirm,
    pdvDir,
    kernelManager,
    commRouter,
    queryRouter,
    projectManager,
    configStore,
    closeChildWindows: () => {
      host.push(RPC_CHANNELS.closeChildWindows, undefined);
    },
    // MCP is local-only: it binds a loopback port for editors running on the
    // user's own machine, and a copy on the cluster would be unreachable.
    startMcp: false,
  });

  const idle = wireSessionIdle({
    kernelManager,
    // Real snapshot through the same performAutosave core the timer and
    // pre-restart paths use; false blocks the shutdown and retries.
    wire,
    shutdown: () => {
      console.log("[session-host] idle; shutting down");
      idle.dispose();
      void kernelManager
        .shutdownAll()
        .catch((error) => {
          console.error("[session-host] kernel shutdown failed:", error);
        })
        .finally(() => {
          unwireServer();
          void host.close().then(() => process.exit(0));
        });
    },
  });

  await host.listen();

  // Written only after the socket is listening: a session.json pointing at a
  // socket nobody is serving would send every attach to a dead end.
  writeSessionMeta(paths.metaPath, {
    sessionId,
    version,
    protocol: RPC_PROTOCOL_VERSION,
    pid: process.pid,
    bootId: readBootId(),
    hostname: paths.hostname,
    sockPath: paths.sockPath,
    runtimeSource: paths.runtimeSource,
    startedAt: new Date().toISOString(),
    setupScriptApplied,
  });

  console.log(
    `[session-host] session ${sessionId} listening on ${paths.sockPath} ` +
      `(host ${paths.hostname}, runtime ${paths.runtimeSource})`
  );

  // Liveness beacon for cross-node attaches: the session dir is on a shared
  // home, but this daemon's socket (and pid) are only meaningful on THIS
  // node, so a beacon file is the one liveness signal another login node
  // can read. Touched every minute; the wrong-node guard in `attach-cli.ts`
  // treats a beacon older than five minutes as a dead daemon. `unref` so a
  // shutdown never waits on it, and a failed touch is swallowed inside —
  // the beacon is advisory and must never take the session down.
  touchHeartbeat(paths.heartbeatPath);
  setInterval(() => touchHeartbeat(paths.heartbeatPath), 60_000).unref();

  const stop = (signal: string): void => {
    console.log(`[session-host] ${signal}; shutting down`);
    idle.dispose();
    confirmBroker.cancelAll();
    // Kernels are spawned non-detached with piped stdio, so killing this
    // process without reaping them would orphan them onto init — on a login
    // node that is someone else's problem to clean up.
    try {
      kernelManager.killAllNow();
    } catch (error) {
      console.error("[session-host] force-kill failed:", error);
    }
    unwireServer();
    void host.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

}

/**
 * Proxy this channel's stdio to a session, starting it if asked.
 *
 * @param args - argv slice beginning with `attach`.
 * @returns Resolves when the proxy has finished; exits the process.
 */
async function runAttach(args: string[]): Promise<void> {
  const sessionId = flagValue(args, "--session");
  if (!sessionId || !args.includes("--stdio")) {
    console.error("usage: pdv-server attach --session <id> --stdio [--create]");
    process.exit(2);
    return;
  }
  const root = flagValue(args, "--root") ?? defaultRoot();

  try {
    const { socket } = await attachToSession({
      sessionId,
      root,
      create: args.includes("--create"),
      execPath: process.execPath,
      execArgs: process.argv.slice(1, 2),
      env: process.env,
    });
    const code = await proxyStdio(socket);
    process.exit(code);
  } catch (err) {
    console.error(`[attach] ${(err as Error).message}`);
    process.exit(1);
  }
}
