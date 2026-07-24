/**
 * server-main.ts — CLI entrypoint for the extracted pdv-server process.
 *
 * Runs under plain Node (the Electron binary with ELECTRON_RUN_AS_NODE=1):
 * builds the session managers exactly as the Electron shell's bootstrap
 * does, assembles the server core via `wireServer()`, and serves the
 * invoke registry over the stdio RPC transport (`transport/rpc-server.ts`).
 *
 * Invocation: `pdv-server serve --stdio`, with the environment contract:
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
  if (args[0] !== "serve" || !args.includes("--stdio")) {
    console.error("usage: pdv-server serve --stdio");
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
