/**
 * ipc-register-launchers.ts — IPC handlers for the action-bar launcher buttons.
 *
 * Currently registers `launchers.openAgent`, which launches the configured AI
 * agent CLI in a terminal window pointed at PDV's MCP server.
 *
 * Non-responsibilities:
 * - Building the spawn spec (see `agent-launcher.ts`).
 * - Writing the MCP config file (see `mcp/mcp-config-writer.ts`).
 */

import { spawn } from "child_process";

import { ipcMain } from "electron";

import { buildAgentInvocation } from "./agent-launcher";
import type { PDVConfig } from "./config";
import { IPC, type McpStatus, type ScriptOperationResult } from "./ipc";
import { writeMcpConfigFile } from "./mcp/mcp-config-writer";

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

  ipcMain.handle(
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
        const child = spawn(spawnSpec.file, spawnSpec.args, {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (err) => {
          const msg =
            err && (err as NodeJS.ErrnoException).code === "ENOENT"
              ? `Agent launch failed: "${spawnSpec.file}" not found.`
              : `Agent launch failed: ${err.message}`;
          console.error("[pdv] agent spawn error:", msg);
        });
        child.unref();
        return { success: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("[pdv] launchers.openAgent failed:", error);
        return { success: false, error: `Failed to launch agent: ${error}` };
      }
    },
  );
}
