/**
 * process-stats.ts — Cross-platform process memory lookup.
 *
 * Provides resident-set-size (RSS) reads for an arbitrary OS process by PID.
 * Used by kernel-manager to surface live Python kernel memory usage in the
 * status bar without requiring kernel-side cooperation (no comm round-trip,
 * no psutil dependency).
 *
 * Strategy:
 * - darwin / linux: shell out to `ps -o rss= -p <pid>` (RSS in KB)
 * - win32: shell out to `tasklist /FI "PID eq <pid>" /NH /FO CSV`
 *
 * All failures (process gone, parse error, unsupported platform) resolve to
 * `null` so callers can degrade gracefully — the UI hides the indicator
 * instead of surfacing a noisy error.
 *
 * This file does NOT cache results, schedule polling, or maintain state;
 * scheduling is the caller's responsibility (see kernel-manager.ts).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Read the resident-set-size (RSS) of a process by PID, in bytes.
 *
 * @param pid - Operating-system process id to query.
 * @returns RSS in bytes, or `null` if the process cannot be queried (does not
 *   exist, command fails, output cannot be parsed, or platform is unsupported).
 * @throws Never — all errors are absorbed and returned as `null`.
 */
export async function getProcessRssBytes(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    if (process.platform === "darwin" || process.platform === "linux") {
      const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], {
        timeout: 2000,
      });
      const kb = parseInt(stdout.trim(), 10);
      if (!Number.isFinite(kb) || kb <= 0) return null;
      return kb * 1024;
    }

    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
        { timeout: 2000 },
      );
      // CSV columns: "Image","PID","Session","Session#","Mem Usage"
      // Mem Usage example: "123,456 K"
      const line = stdout.trim().split(/\r?\n/)[0];
      if (!line) return null;
      const cols = line.split(/","|^"|"$/).filter((s) => s.length > 0);
      const mem = cols[cols.length - 1];
      if (!mem) return null;
      const kb = parseInt(mem.replace(/[^0-9]/g, ""), 10);
      if (!Number.isFinite(kb) || kb <= 0) return null;
      return kb * 1024;
    }

    return null;
  } catch {
    return null;
  }
}
