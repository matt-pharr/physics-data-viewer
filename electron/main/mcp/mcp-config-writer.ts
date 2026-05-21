/**
 * mcp-config-writer.ts — Materialize a `.pdv-mcp.json` for external agents.
 *
 * The action-bar agent button launches an external agent CLI (Claude Code by
 * default) and points it at PDV's loopback MCP server via a config file. This
 * module writes that file.
 *
 * Why the per-kernel working directory (not the project directory):
 * - The file embeds the MCP bearer token. The working directory lives under
 *   `~/.PDV/working/pdv-<random>/`, is owned by the current user, and is
 *   deleted on kernel teardown — so the secret is ephemeral and never lands
 *   in a directory the user might commit to version control.
 * - It is written fresh immediately before each agent launch, so it always
 *   reflects the MCP server's current port and token.
 *
 * Security:
 * - The file is written with mode `0600` (owner read/write only) on POSIX.
 *   On Windows the mode bit is a no-op; the user-owned working directory is
 *   the protection boundary there.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { McpStatus } from "../ipc";

/** Filename written into the working directory. */
export const MCP_CONFIG_FILENAME = ".pdv-mcp.json";

/**
 * Write `.pdv-mcp.json` into `workingDir`, describing PDV's MCP server in the
 * `mcpServers` shape that Claude Code's `--mcp-config` flag consumes.
 *
 * @param workingDir - Absolute path of the active kernel's working directory.
 * @param status - Live MCP server status; must be `running` with a non-null
 *   `url` and `token`.
 * @returns Absolute path of the written config file.
 * @throws {Error} When the server is not running, or the file cannot be
 *   written. A stale temp file is removed before the error propagates.
 */
export async function writeMcpConfigFile(
  workingDir: string,
  status: McpStatus,
): Promise<string> {
  if (!status.running || !status.url || !status.token) {
    throw new Error("MCP server is not running; cannot write agent config.");
  }
  const configPath = path.join(workingDir, MCP_CONFIG_FILENAME);
  const body = JSON.stringify(
    {
      mcpServers: {
        pdv: {
          type: "http",
          url: status.url,
          headers: { Authorization: `Bearer ${status.token}` },
        },
      },
    },
    null,
    2,
  );

  // Atomic temp-then-rename, with the temp file created mode 0600 so the
  // bearer token is never briefly world-readable. `fs.writeFile`'s `mode`
  // only applies when the file is created; `chmod` defensively covers a
  // pre-existing temp file left by a crashed write.
  const tmp = `${configPath}.tmp`;
  try {
    await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, configPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return configPath;
}
