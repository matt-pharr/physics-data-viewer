/**
 * ipc-register-launchers.ts — IPC handlers for local external-app launches.
 *
 * Registers:
 * - `launchers.openAgent` — launch the configured AI agent CLI in a terminal
 *   pointed at PDV's MCP server.
 * - `launchers.openWorkingDir` — open the active kernel's working directory in
 *   the configured editor/IDE.
 * - `launchers.checkAvailability` — probe whether a configured command exists.
 * - `script.edit` — open a script's backing file in the configured editor.
 *
 * These are shell channels: they spawn processes on the user's machine. The
 * session state they need (config, MCP status, active kernel context, tree
 * file resolution) lives in the pdv-server, so every accessor in the
 * dependency bag is async: each one is an invoke across the transport
 * (`index.ts` builds them over the server bridge).
 *
 * Non-responsibilities:
 * - Building the agent spawn spec (see `agent-launcher.ts`).
 * - Writing the MCP config file (see `mcp/mcp-config-writer.ts`).
 */

import { spawn } from "child_process";

import { handleIpc } from "./ipc-registry";

import { buildAgentInvocation } from "./agent-launcher";
import type { PDVConfig } from "./config";
import { buildEditorSpawn, resolveEditorSpawn } from "./editor-spawn";
import { IPC, type LauncherCheck, type McpStatus, type ScriptOperationResult } from "./ipc";
import { checkLauncherAvailability } from "./launcher-availability";
import { writeMcpConfigFile } from "./mcp/mcp-config-writer";

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
}

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

  handleIpc(
    IPC.launchers.openAgent,
    async (): Promise<ScriptOperationResult> => {
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
        const config = await getConfig();
        const { file, args } = buildEditorSpawn(
          config.launchers?.editor?.dirCommand,
          workingDir,
        );
        // Opening a directory in a GUI editor/IDE never needs a terminal wrap.
        const spawnSpec = resolveEditorSpawn(file, args, { wrapInTerminal: false });
        spawnDetached(spawnSpec, "editor");
        return { success: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("[pdv] launchers.openWorkingDir failed:", error);
        return { success: false, error: `Failed to open working directory: ${error}` };
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
    const config = await getConfig();

    const resolvedPath = await resolveTreeFile(scriptPath);
    if (typeof resolvedPath !== "string" || resolvedPath.length === 0) {
      return { success: false, error: `Could not resolve file path for "${scriptPath}".` };
    }

    const { file, args } = buildEditorSpawn(
      config.launchers?.editor?.fileCommand,
      resolvedPath,
    );
    const spawnSpec = resolveEditorSpawn(file, args, {
      wrapInTerminal: config.launchers?.editor?.isTuiEditor,
      terminal: config.launchers?.terminal,
    });
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
  });
}
