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
import { attachToSession, proxyStdio } from "./attach-cli";
import { SessionHost } from "./session-host";
import { resolveSessionPaths } from "./session-paths";
import { writeSessionMeta } from "./session-meta";
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
  return path.join(os.homedir(), ".pdv-server");
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
  const version = process.env.PDV_APP_VERSION ?? "unknown";

  const paths = resolveSessionPaths({ sessionId, root });

  // The kernel is not wired into the daemon yet, so the policy sees a
  // session with no kernel: it exits 30 minutes after the last client
  // leaves rather than lingering on a login node forever. The predicates
  // become real when the daemon owns a kernel.
  // The two reference each other, which is safe because every callback
  // below fires long after both are constructed.
  const host: SessionHost = new SessionHost({
    paths,
    sessionId,
    version,
    onNoClients: () => idle.onClientsGone(),
    onClientAttached: () => idle.onClientAttached(),
  });
  const idle = new SessionIdlePolicy({
    hasKernel: () => false,
    isExecuting: () => false,
    autosave: async () => true,
    shutdown: () => {
      console.log("[session-host] idle; shutting down");
      void host.close().then(() => process.exit(0));
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
  });

  console.log(
    `[session-host] session ${sessionId} listening on ${paths.sockPath} ` +
      `(host ${paths.hostname}, runtime ${paths.runtimeSource})`
  );

  const stop = (signal: string): void => {
    console.log(`[session-host] ${signal}; shutting down`);
    idle.dispose();
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
