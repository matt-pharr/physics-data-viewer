/**
 * daemonize.ts — detach a session daemon from the SSH channel that started it.
 *
 * Node has no `fork()` to call, which sends implementers hunting for a shim
 * that does not exist. The three pieces that together make a daemon are:
 *
 *  - `detached: true` — `setsid(2)`: a new session with no controlling
 *    terminal, so no SIGHUP when the ssh channel goes away.
 *  - `child.unref()` plus the launcher exiting — orphaning, so the daemon is
 *    reparented to init and survives its parent.
 *  - `stdio: ["ignore", logFd, logFd]` — **mandatory**, and the piece whose
 *    absence is worst to diagnose. A daemon that inherits the SSH channel's
 *    stdout keeps the write end open, so sshd never sees EOF, and the ssh
 *    command that launched it hangs forever. The symptom looks like a
 *    network problem and is nothing of the sort.
 *
 * Verified on flux 2026-07-25: a `setsid`-detached process reparented to
 * init survived a full logout and the site's 45-minute idle timeout, with an
 * unbroken one-per-minute heartbeat and no reaping. That is what makes the
 * whole design viable, and it was measured rather than assumed.
 *
 * Log rotation is copytruncate: renaming a file while the daemon holds an
 * `O_APPEND` fd leaves it writing to the renamed inode, so the "rotated" log
 * silently keeps growing and the live one stays empty.
 *
 * This module does NOT decide paths (`session-paths.ts`) or take the spawn
 * lock (`session-lock.ts`) — the caller does both before detaching.
 */

import { spawn } from "child_process";
import * as fs from "fs";

/** Rotate the log once it passes this size (8 MB). */
export const LOG_ROTATE_BYTES = 8 * 1024 * 1024;

/** Options for {@link daemonize}. */
export interface DaemonizeOptions {
  /** Executable to run (normally `process.execPath`). */
  execPath: string;
  /** Arguments for the daemon process. */
  args: string[];
  /** Log file; stdout and stderr are both redirected here. */
  logPath: string;
  /** Working directory for the daemon. Defaults to the caller's. */
  cwd?: string;
  /** Environment for the daemon. Defaults to the caller's. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Rotate a log that has grown past {@link LOG_ROTATE_BYTES}.
 *
 * Copytruncate rather than rename: a live daemon holds an append-mode fd on
 * this inode, and renaming would leave it writing to the rotated file while
 * the current one stayed empty forever.
 *
 * @param logPath - Log file to rotate.
 * @param maxBytes - Size threshold. Defaults to {@link LOG_ROTATE_BYTES}.
 * @returns True if a rotation happened.
 */
export function rotateLogIfLarge(
  logPath: string,
  maxBytes: number = LOG_ROTATE_BYTES,
): boolean {
  let size: number;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return false; // No log yet.
  }
  if (size <= maxBytes) return false;

  try {
    fs.copyFileSync(logPath, `${logPath}.1`);
    fs.truncateSync(logPath, 0);
    return true;
  } catch {
    // Rotation is housekeeping. Failing it must never take a session down,
    // so the daemon keeps writing to an oversized log instead.
    return false;
  }
}

/**
 * Spawn a fully detached daemon and return its pid.
 *
 * @param opts - Executable, arguments, log path and environment.
 * @returns The daemon's pid.
 * @throws Error if the log cannot be opened or the process cannot be spawned.
 *   Both are fatal to the caller: without a log there is nowhere for the
 *   daemon's diagnostics to go, and silently discarding them would make a
 *   failed session unexplainable.
 */
export function daemonize(opts: DaemonizeOptions): number {
  rotateLogIfLarge(opts.logPath);
  const logFd = fs.openSync(opts.logPath, "a", 0o600);
  try {
    const child = spawn(opts.execPath, opts.args, {
      detached: true,
      // stdin is /dev/null: a daemon has no console, and leaving it attached
      // to the ssh channel would hold that channel open.
      stdio: ["ignore", logFd, logFd],
      cwd: opts.cwd,
      env: opts.env,
    });
    // Let the launcher exit without waiting: the daemon is reparented to
    // init and lives on.
    child.unref();
    if (child.pid === undefined) {
      throw new Error("[daemonize] spawn returned no pid");
    }
    return child.pid;
  } finally {
    // The child holds its own duplicate of this descriptor.
    fs.closeSync(logFd);
  }
}
