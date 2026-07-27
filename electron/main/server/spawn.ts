/**
 * spawn.ts — The single subprocess seam for server-side tool execution.
 *
 * Every server-destined module that runs an external tool — interpreter
 * probes, kernel launch, uv/juliaup/Pkg provisioning, git, ps — routes its
 * subprocess through this module instead of importing `child_process`
 * directly (enforced by `spawn.test.ts`'s import guard). Centralizing the
 * spawn point exists for remote mode: this seam is where a Slurm launch
 * path (`srun`-wrapped kernels, per-host allocation config) can be added
 * without touching any call site. Login-shell environment (Lmod modules,
 * the per-host setup script) deliberately does NOT ride here as a per-spawn
 * wrapper — `login-env.ts` captures it once at daemon startup and applies
 * it to `process.env`, which every call site already builds from; see that
 * file's header for why a per-spawn `bash -lc` wrap was rejected.
 *
 * Today both helpers are thin, behavior-preserving delegates to
 * `child_process`: `serverExecFile` keeps promisified `execFile`'s exact
 * resolution and rejection shapes (callers rely on `stdout`/`stderr` being
 * attached to the rejection error), and `serverSpawn` returns the raw
 * `ChildProcess` so callers keep their own streaming, deadline, and
 * kill logic.
 *
 * This file does NOT decide *what* to run or interpret tool output — env
 * forcing (e.g. `NO_COLOR`, `sanitizedJuliaEnv`), timeouts, and output
 * parsing stay with the callers. Shell-side spawns (launchers, ssh, the
 * server supervisor) and `daemonize.ts` (which spawns pdv-server itself,
 * not a user tool) deliberately do not go through this seam.
 */

import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";

/** Re-exported so call sites can type children without importing child_process. */
export type { ChildProcess } from "child_process";

const execFileAsync = promisify(execFile);

/** Options accepted by {@link serverExecFile}. */
export interface ServerExecFileOptions {
  /** Kill the process and reject after this many milliseconds. */
  timeout?: number;
  /** Working directory for the command. */
  cwd?: string;
  /** Full environment for the command (replaces, not merges). */
  env?: NodeJS.ProcessEnv;
}

/** Options accepted by {@link serverSpawn}. */
export interface ServerSpawnOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Full environment for the command (replaces, not merges). */
  env?: NodeJS.ProcessEnv;
  /** stdio disposition; callers virtually always use ["ignore","pipe","pipe"]. */
  stdio?: Array<"ignore" | "pipe" | "inherit">;
  /** Kill the process after this many milliseconds. */
  timeout?: number;
  /** Abort signal that kills the process when fired. */
  signal?: AbortSignal;
}

/**
 * Run a server-side command to completion and capture its output.
 *
 * Identical semantics to `promisify(child_process.execFile)`: resolves with
 * the decoded `stdout`/`stderr` on exit 0, rejects on non-zero exit,
 * timeout, or spawn failure with an error that carries the captured
 * `stdout`/`stderr` fields.
 *
 * @param file - Executable path or command name (PATH-resolved).
 * @param args - Argument vector.
 * @param options - Timeout / cwd / env options.
 * @returns The command's decoded standard streams.
 * @throws {Error} When the command exits non-zero, times out, or cannot be
 *   spawned; the error object additionally exposes `stdout` and `stderr`.
 */
export async function serverExecFile(
  file: string,
  args: string[],
  options?: ServerExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  // Explicit utf8 (the runtime default) selects the string-typed overload
  // of promisified execFile; behavior is unchanged.
  return execFileAsync(file, args, { encoding: "utf8" as const, ...options });
}

/**
 * Spawn a server-side command and return the live child process.
 *
 * Identical semantics to `child_process.spawn`; the caller owns stream
 * consumption, exit handling, and any deadline/kill logic.
 *
 * @param file - Executable path or command name (PATH-resolved).
 * @param args - Argument vector.
 * @param options - cwd / env / stdio / timeout / signal options.
 * @returns The spawned child process.
 * @throws Never directly — spawn failures surface as an `error` event on
 *   the returned child.
 */
export function serverSpawn(
  file: string,
  args: string[],
  options?: ServerSpawnOptions
): ChildProcess {
  return spawn(file, args, options ?? {});
}
