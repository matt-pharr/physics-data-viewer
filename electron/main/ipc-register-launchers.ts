/**
 * ipc-register-launchers.ts — IPC handlers for the action-bar launcher buttons.
 *
 * Registers:
 * - `launchers.openAgent` — launch the configured AI agent CLI in a terminal
 *   pointed at PDV's MCP server.
 * - `launchers.openWorkingDir` — open the active kernel's working directory in
 *   the configured editor/IDE.
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

/** Dependency bag for {@link registerLaunchersIpcHandlers}. */
export interface RegisterLaunchersIpcHandlersOptions {
  /** Per-kernel working-directory map (kernel id → absolute path). */
  kernelWorkingDirs: Map<string, string>;
  /** Accessor for the active kernel id. */
  getActiveKernelId: () => string | null;
  /** Accessor for the active project directory (`null` when unsaved). */
  getActiveProjectDir: () => string | null;
  /** Accessor for the current merged config snapshot. */
  getConfig: () => PDVConfig;
  /** Accessor for the live MCP server status (`null` before the server starts). */
  getMcpStatus: () => McpStatus | null;
}

/**
 * Register the `launchers.*` IPC handlers.
 *
 * @param options - Dependency bag; see {@link RegisterLaunchersIpcHandlersOptions}.
 * @returns Nothing.
 */
export function registerLaunchersIpcHandlers(
  options: RegisterLaunchersIpcHandlersOptions,
): void {
  const {
    kernelWorkingDirs,
    getActiveKernelId,
    getActiveProjectDir,
    getConfig,
    getMcpStatus,
  } = options;

  handleIpc(
    IPC.launchers.openAgent,
    async (): Promise<ScriptOperationResult> => {
      // Under E2E we never spawn an external terminal — the spawn is detached
      // and would outlive the Electron app being torn down by the test.
      if (process.env.PDV_E2E === "1") {
        return { success: true };
      }

      const kernelId = getActiveKernelId();
      if (!kernelId) {
        return { success: false, error: "No active kernel; start one first." };
      }
      const workingDir = kernelWorkingDirs.get(kernelId);
      if (!workingDir) {
        return { success: false, error: "No working directory for the active kernel." };
      }
      const mcpStatus = getMcpStatus();
      if (!mcpStatus || !mcpStatus.running) {
        return { success: false, error: "The MCP server is not running." };
      }

      try {
        const mcpConfigPath = await writeMcpConfigFile(workingDir, mcpStatus);
        const config = getConfig();
        const spawnSpec = buildAgentInvocation({
          agent: config.launchers?.agent,
          terminal: config.launchers?.terminal,
          mcpConfigPath,
          projectRoot: getActiveProjectDir(),
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

      const kernelId = getActiveKernelId();
      if (!kernelId) {
        return { success: false, error: "No active kernel; start one first." };
      }
      const workingDir = kernelWorkingDirs.get(kernelId);
      if (!workingDir) {
        return { success: false, error: "No working directory for the active kernel." };
      }

      try {
        const config = getConfig();
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
}
