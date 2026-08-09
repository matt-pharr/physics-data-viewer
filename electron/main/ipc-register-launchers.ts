/**
 * ipc-register-launchers.ts — IPC handlers for external-app launches.
 *
 * Registers:
 * - `launchers.openAgent` — launch the configured AI agent CLI in a terminal
 *   pointed at PDV's MCP server. Refused in remote sessions (MCP is
 *   local-only, and the `.pdv-mcp.json` it writes targets the kernel's
 *   working directory — a cross-host write when the session is remote).
 * - `launchers.openWorkingDir` — open the active kernel's working directory in
 *   the configured editor/IDE (remotely: via the editor's Remote-SSH support
 *   or an ssh channel — see `remote/remote-launchers.ts`).
 * - `launchers.openTerminal` — open the user's terminal in the working
 *   directory (remotely: running `ssh -t` through PDV's ControlMaster).
 * - `launchers.checkAvailability` — probe whether a configured command exists.
 * - `script.edit` — open a script's backing file in the configured editor,
 *   with the same remote routing as `openWorkingDir`.
 *
 * These are shell channels: they spawn processes on the user's machine. The
 * session state they need (config, MCP status, active kernel context, tree
 * file resolution) lives in the pdv-server, so every accessor in the
 * dependency bag is async: each one is an invoke across the transport
 * (`index.ts` builds them over the server bridge). `getRemoteContext` is the
 * exception — remote identity is shell-owned state, read synchronously.
 *
 * Non-responsibilities:
 * - Building the agent spawn spec (see `agent-launcher.ts`).
 * - Writing the MCP config file (see `mcp/mcp-config-writer.ts`).
 * - Remote spawn-spec construction (see `remote/remote-launchers.ts`).
 */

import { spawn } from "child_process";

import { handleIpc } from "./ipc-registry";

import { buildAgentInvocation } from "./agent-launcher";
import type { PDVConfig } from "./config";
import {
  buildEditorSpawn,
  loginShellCommand,
  resolveEditorSpawn,
  wrapInTerminalPreset,
} from "./editor-spawn";
import { IPC, type LauncherCheck, type McpStatus, type ScriptOperationResult } from "./ipc";
import { checkLauncherAvailability } from "./launcher-availability";
import { writeMcpConfigFile } from "./mcp/mcp-config-writer";
import {
  buildSshLauncherCommand,
  remoteLoginShellCommand,
  resolveRemoteEditorSpawn,
} from "./remote/remote-launchers";
import type { SshControl } from "./remote/ssh-mux";

/**
 * Spawn a detached launcher process and never block on it. Errors are logged
 * (the child outlives this process), so callers treat a successful spawn as
 * success.
 *
 * @param spec - Executable and arguments to spawn.
 * @param label - Short label used in error logs (e.g. `"agent"`).
 */
function spawnDetached(spec: { file: string; args: string[] }, label: string): void {
  const child = spawn(spec.file, spec.args, { detached: true, stdio: "ignore" });
  child.on("error", (err) => {
    const msg =
      err && (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `${label} launch failed: "${spec.file}" not found.`
        : `${label} launch failed: ${err.message}`;
    console.error(`[pdv] ${label} spawn error:`, msg);
  });
  child.unref();
}

/** Active session context needed to target a launch. */
export interface LauncherContext {
  /** Active kernel id, or null when no kernel is running. */
  kernelId: string | null;
  /** Active kernel's working directory, or null when unknown. */
  workingDir: string | null;
  /** Active project directory, or null when the project is unsaved. */
  projectDir: string | null;
}

/** Remote session identity, for routing launches to the session's host. */
export interface RemoteLauncherContext {
  /** The ssh alias/destination of the remote session's host. */
  host: string;
  /**
   * The host + control socket for opening ssh channels to the session, or
   * null while the connection is down (reconnecting / auth-required).
   * Launches that need an ssh channel refuse then; launches where the
   * editor makes its own connection (`code --remote`) still work.
   */
  control: SshControl | null;
}

/** Dependency bag for {@link registerLaunchersIpcHandlers}. */
export interface RegisterLaunchersIpcHandlersOptions {
  /** Async accessor for the active kernel/project context. */
  getLauncherContext: () => Promise<LauncherContext>;
  /** Async accessor for the current merged config snapshot. */
  getConfig: () => Promise<PDVConfig>;
  /** Async accessor for the live MCP server status (`null` before start). */
  getMcpStatus: () => Promise<McpStatus | null>;
  /**
   * Resolve a tree path to its backing file's absolute path via the kernel.
   * Returns null when the node has no backing file.
   */
  resolveTreeFile: (treePath: string) => Promise<string | null>;
  /**
   * The active remote session's identity, or null when the session is
   * local. Synchronous: remote identity is shell-owned state (the session
   * router + connection manager), no transport round trip involved.
   */
  getRemoteContext?: () => RemoteLauncherContext | null;
}

/** Refusal returned when an ssh-carried launch has no usable connection. */
const REMOTE_CONNECTION_DOWN_ERROR =
  "The remote connection is not available right now — reconnect to the host first.";

/** Refusal returned when a launch needs a terminal but the preset is 'none'. */
const TERMINAL_DISABLED_ERROR =
  "This launch needs a terminal window, but the terminal application is set " +
  "to 'None' (Settings → General → Terminal application).";

/**
 * Register the `launchers.*` and `script.edit` IPC handlers.
 *
 * @param options - Dependency bag; see {@link RegisterLaunchersIpcHandlersOptions}.
 * @returns Nothing.
 */
export function registerLaunchersIpcHandlers(
  options: RegisterLaunchersIpcHandlersOptions,
): void {
  const {
    getLauncherContext,
    getConfig,
    getMcpStatus,
    resolveTreeFile,
  } = options;
  const getRemoteContext = options.getRemoteContext ?? (() => null);

  /**
   * Open `resolvedPath` (a session-host path) in the configured editor,
   * routing by session kind. Shared by `script.edit` (file) and
   * `openWorkingDir` (directory).
   */
  const openInEditor = async (
    resolvedPath: string,
    target: "file" | "dir",
  ): Promise<ScriptOperationResult> => {
    const config = await getConfig();
    const editor = config.launchers?.editor;
    const remote = getRemoteContext();

    let spawnSpec: { file: string; args: string[] };
    if (remote) {
      if (!remote.host) {
        // Router says remote but the manager has no host — a transient
        // window that must never degrade into local spawning of a cluster
        // path.
        return { success: false, error: REMOTE_CONNECTION_DOWN_ERROR };
      }
      const resolution = resolveRemoteEditorSpawn(
        target === "file" ? editor?.fileCommand : editor?.dirCommand,
        {
          host: remote.host,
          targetPath: resolvedPath,
          template:
            target === "file" ? editor?.remoteFileCommand : editor?.remoteDirCommand,
          // For directories, auto-detect: unlike the local no-wrap rule, a
          // TUI dirCommand (vim + netrw) is genuinely usable over ssh.
          isTuiEditor: target === "file" ? editor?.isTuiEditor : undefined,
        },
      );
      if (resolution.kind === "unsupported") {
        return { success: false, error: resolution.message };
      }
      if (resolution.kind === "ssh-terminal") {
        if (config.launchers?.terminal?.preset === "none") {
          return { success: false, error: TERMINAL_DISABLED_ERROR };
        }
        if (!remote.control) {
          return { success: false, error: REMOTE_CONNECTION_DOWN_ERROR };
        }
        const ssh = buildSshLauncherCommand(remote.control, resolution.remoteCommand);
        spawnSpec = wrapInTerminalPreset(ssh.file, ssh.args, {
          terminal: config.launchers?.terminal,
        });
      } else {
        spawnSpec = { file: resolution.file, args: resolution.args };
      }
    } else {
      const { file, args } = buildEditorSpawn(
        target === "file" ? editor?.fileCommand : editor?.dirCommand,
        resolvedPath,
      );
      spawnSpec = resolveEditorSpawn(file, args, {
        // Opening a directory in a GUI editor/IDE never needs a terminal wrap.
        wrapInTerminal: target === "file" ? editor?.isTuiEditor : false,
        terminal: config.launchers?.terminal,
      });
    }

    try {
      const child = spawn(spawnSpec.file, spawnSpec.args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        const msg = err && (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `Editor command not found: "${spawnSpec.file}". Configure your editor in Settings → General.`
          : `Failed to launch editor: ${err.message}`;
        console.error("[pdv] editor spawn error:", msg);
      });
      child.unref();
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to launch editor: ${error}` };
    }
  };

  handleIpc(
    IPC.launchers.openAgent,
    async (): Promise<ScriptOperationResult> => {
      // Remote guard BEFORE the E2E short-circuit so the refusal is
      // observable in the fake-ssh e2e suite. This is also the fix for the
      // cross-host write: the `.pdv-mcp.json` write below targets the
      // kernel's working directory, which in a remote session is a cluster
      // path — refusing here makes that write unreachable.
      const remoteAgent = getRemoteContext();
      if (remoteAgent) {
        return {
          success: false,
          error:
            "AI agent launch isn't available in remote sessions — PDV's MCP " +
            "server runs on this machine only.",
        };
      }

      // Under E2E we never spawn an external terminal — the spawn is detached
      // and would outlive the Electron app being torn down by the test.
      if (process.env.PDV_E2E === "1") {
        return { success: true };
      }

      const { kernelId, workingDir, projectDir } = await getLauncherContext();
      if (!kernelId) {
        return { success: false, error: "No active kernel; start one first." };
      }
      if (!workingDir) {
        return { success: false, error: "No working directory for the active kernel." };
      }
      const mcpStatus = await getMcpStatus();
      if (!mcpStatus || !mcpStatus.running) {
        return { success: false, error: "The MCP server is not running." };
      }

      try {
        const mcpConfigPath = await writeMcpConfigFile(workingDir, mcpStatus);
        const config = await getConfig();
        const spawnSpec = buildAgentInvocation({
          agent: config.launchers?.agent,
          terminal: config.launchers?.terminal,
          mcpConfigPath,
          projectRoot: projectDir,
          workingDir,
        });
        spawnDetached(spawnSpec, "agent");
        return { success: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("[pdv] launchers.openAgent failed:", error);
        return { success: false, error: `Failed to launch agent: ${error}` };
      }
    },
  );

  handleIpc(
    IPC.launchers.openWorkingDir,
    async (): Promise<ScriptOperationResult> => {
      if (process.env.PDV_E2E === "1") {
        return { success: true };
      }

      const { kernelId, workingDir } = await getLauncherContext();
      if (!kernelId) {
        return { success: false, error: "No active kernel; start one first." };
      }
      if (!workingDir) {
        return { success: false, error: "No working directory for the active kernel." };
      }

      try {
        return await openInEditor(workingDir, "dir");
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("[pdv] launchers.openWorkingDir failed:", error);
        return { success: false, error: `Failed to open working directory: ${error}` };
      }
    },
  );

  handleIpc(
    IPC.launchers.openTerminal,
    async (): Promise<ScriptOperationResult> => {
      if (process.env.PDV_E2E === "1") {
        return { success: true };
      }

      const { kernelId, workingDir } = await getLauncherContext();
      if (!kernelId) {
        return { success: false, error: "No active kernel; start one first." };
      }
      if (!workingDir) {
        return { success: false, error: "No working directory for the active kernel." };
      }

      try {
        const config = await getConfig();
        if (config.launchers?.terminal?.preset === "none") {
          return { success: false, error: TERMINAL_DISABLED_ERROR };
        }
        const remote = getRemoteContext();
        if (remote && !remote.control) {
          return { success: false, error: REMOTE_CONNECTION_DOWN_ERROR };
        }
        const inner = remote?.control
          ? buildSshLauncherCommand(remote.control, remoteLoginShellCommand(workingDir))
          : loginShellCommand(workingDir);
        const spawnSpec = wrapInTerminalPreset(inner.file, inner.args, {
          terminal: config.launchers?.terminal,
        });
        spawnDetached(spawnSpec, "terminal");
        return { success: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("[pdv] launchers.openTerminal failed:", error);
        return { success: false, error: `Failed to open terminal: ${error}` };
      }
    },
  );

  handleIpc(
    IPC.launchers.checkAvailability,
    async (_event, check: LauncherCheck): Promise<boolean> => {
      try {
        return await checkLauncherAvailability(check);
      } catch (err) {
        console.error("[pdv] launchers.checkAvailability failed:", err);
        return false;
      }
    },
  );

  handleIpc(IPC.script.edit, async (_event, _kernelId: string, scriptPath: string) => {
    // Under E2E we never spawn an external editor — the spawn is detached
    // (`detached: true`, `child.unref()`) so a real VS Code instance launched
    // by a test would outlive the Electron app being torn down.
    if (process.env.PDV_E2E === "1") {
      return { success: true };
    }
    const resolvedPath = await resolveTreeFile(scriptPath);
    if (typeof resolvedPath !== "string" || resolvedPath.length === 0) {
      return { success: false, error: `Could not resolve file path for "${scriptPath}".` };
    }

    return openInEditor(resolvedPath, "file");
  });
}
