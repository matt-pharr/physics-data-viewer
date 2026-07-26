/**
 * server-files.ts — The list of server-destined main-process source files.
 *
 * These are the files that run inside the Electron-free pdv-server child
 * process. They must not import Electron: their only window/dialog/paths
 * access is through the injected seams (`PushSender`, `ConfirmFn`,
 * `server-paths.ts`, `getAppVersion()`). An Electron import here is not a
 * type error — it fails at runtime, in the packaged app, when the plain
 * Node child cannot resolve the Electron module.
 *
 * `electron-free.test.ts` greps every listed file and fails on any
 * `from "electron"` / `require("electron")`, so a rebound coupling is
 * caught at unit-test time rather than in a packaged build.
 *
 * The list must cover the server entry point's whole *value*-import
 * closure, not just the files conceptually "owned" by the server —
 * `editor-spawn.ts` is listed because `config.ts` imports
 * `TERMINAL_PRESET_LIST` from it, which pulls it into the child at
 * runtime even though the launchers that use it stay in the shell.
 *
 * NOT listed (deliberately, they stay in the shell): window managers, menu,
 * auto-updater, bootstrap/app/index wiring, ipc-registry, the shell
 * registrars (app-state, launchers, module-windows, gui-editor), and
 * agent-launcher.
 */

/** Server-destined source files, relative to `electron/main/`. */
export const SERVER_DESTINED_FILES: readonly string[] = [
  // Shared protocol / registry seams
  "ipc.ts",
  "pdv-protocol.ts",
  "server/invoke-registry.ts",
  "server/confirm.ts",
  "server/server-paths.ts",
  "server/shell-confirm.ts",
  "server/wire.ts",
  "server/self-check.ts",
  "server/session-paths.ts",
  "server/session-lock.ts",
  "server/server-main.ts",
  // Stdio RPC transport
  "transport/protocol.ts",
  "transport/line-codec.ts",
  "transport/push-journal.ts",
  "transport/response-store.ts",
  "transport/attach.ts",
  "transport/rpc-client.ts",
  "transport/rpc-server.ts",
  // Core managers
  "comm-router.ts",
  "query-router.ts",
  "kernel-manager.ts",
  "kernel-session.ts",
  "kernel-error-parser.ts",
  "process-stats.ts",
  "config.ts",
  // Pulled in by config.ts (TERMINAL_PRESET_LIST), so it ships in the child.
  "editor-spawn.ts",
  "project-manager.ts",
  "project-file-sync.ts",
  "autosave-sidecars.ts",
  "atomic-write.ts",
  "tree-create.ts",
  "module-manager.ts",
  "module-runtime.ts",
  "module-manifest-writer.ts",
  "modules/manifest-utils.ts",
  // Environment / interpreter tooling
  "pyproject.ts",
  "python-versions.ts",
  "julia-versions.ts",
  "uv-runner.ts",
  "uv-environment.ts",
  "julia-env.ts",
  "juliaup-runner.ts",
  "julia-discovery.ts",
  "environment-detector.ts",
  // Push/console plumbing
  "handler-invoke-tracker.ts",
  "wake-handler.ts",
  // Server-side IPC registrars
  "ipc-register-kernels.ts",
  "ipc-register-environment.ts",
  "ipc-register-project.ts",
  "ipc-register-autosave.ts",
  "ipc-register-modules.ts",
  "ipc-register-tree-namespace-script.ts",
  "ipc-register-config.ts",
  "ipc-register-gui-files.ts",
  // MCP
  "mcp/mcp-server.ts",
  "mcp/cell-rpc.ts",
  "mcp/mcp-context.ts",
  "mcp/mcp-auth.ts",
  "mcp/mcp-config-writer.ts",
  "mcp/mcp-instructions.ts",
  "mcp/transcript.ts",
  "mcp/generation-guard.ts",
  "mcp/tools/index.ts",
  "mcp/tools/_helpers.ts",
  "mcp/tools/execution.ts",
  "mcp/tools/introspection.ts",
  "mcp/tools/translation.ts",
  "mcp/tools/tree-read.ts",
  "mcp/tools/tree-mutate.ts",
];
