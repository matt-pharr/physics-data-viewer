/**
 * session-paths.ts — where a session's socket, lock, log and metadata live.
 *
 * Splitting this out from the daemon is deliberate: the rules below were
 * settled by measurement on a real cluster, and each of them fails in a way
 * that is hard to diagnose from the symptom ("my session vanished").
 *
 * **Metadata goes under the PDV root; the socket does not.** `~/.pdv-server/`
 * is a shared NFS home on every cluster checked, and AF_UNIX on NFS is
 * unreliable. The socket therefore resolves to node-local storage, in order:
 * `$PDV_SERVER_RUNTIME_DIR` (escape hatch for sites where the rest is wrong)
 * → `$XDG_RUNTIME_DIR` → `/tmp/pdv-server-<uid>` → the PDV root as a last
 * resort. Measured on flux 2026-07-25: `/run/user/<uid>` survived a full
 * logout and the site's 45-minute idle timeout, because the daemon itself
 * keeps the user slice alive — the socket's lifetime is coupled to the
 * process that owns it, which is exactly the coupling we want.
 *
 * **The path budget is small and unforgiving.** `sun_path` is 104 bytes on
 * macOS and 108 on Linux, and the limit applies to the *whole* path. A
 * userData directory plus a cluster hostname plus a session id overflows it
 * easily, and the failure — `ControlPath too long`, or a silent bind failure
 * — arrives long after the path was chosen. So candidates are rejected here,
 * before anything tries to bind, and a candidate that cannot fit is skipped
 * rather than truncated.
 *
 * **`session.json` records the resolved socket path as the single source of
 * truth**, together with the concrete hostname. `flux.pppl.gov` round-robins
 * across login nodes and the socket is node-local, so a reattach must reach
 * *that* node rather than the pool alias.
 *
 * This module does NOT create sockets, spawn daemons, or take locks (see
 * `session-lock.ts`); it decides paths and creates the directories they need.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Conservative `sun_path` ceiling. macOS allows 104 bytes and Linux 108;
 * using the smaller everywhere keeps a session portable and costs nothing.
 * One byte is reserved for the NUL terminator.
 */
export const SOCKET_PATH_MAX_BYTES = 103;

/** A candidate directory for the session socket, with its provenance. */
export interface RuntimeDirCandidate {
  /** Absolute directory path. */
  dir: string;
  /** Where it came from, for diagnostics (`"XDG_RUNTIME_DIR"`, `"tmp"`, …). */
  source: string;
}

/** Inputs for {@link resolveSessionPaths}. */
export interface ResolveSessionPathsOptions {
  /** Session identifier. */
  sessionId: string;
  /** PDV root, normally `~/.pdv-server`. */
  root: string;
  /** Environment to read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Numeric uid used to namespace `/tmp`. Defaults to `process.getuid()`. */
  uid?: number;
  /** Host to record in metadata. Defaults to `os.hostname()`. */
  hostname?: string;
  /**
   * Base for the `/tmp` candidate. Injected by tests, which otherwise cannot
   * reach the "no candidate fits" path at all — the real `os.tmpdir()` is
   * short enough to always succeed, which is exactly what we want in
   * production and useless for exercising the failure.
   */
  tmpDir?: string;
}

/** Everything a session daemon needs to find its own files. */
export interface SessionPaths {
  /** PDV root (`~/.pdv-server`). */
  root: string;
  /** This session's metadata directory, under the root. */
  sessionDir: string;
  /** `session.json` — the authoritative record, including `sockPath`. */
  metaPath: string;
  /** `O_EXCL` spawn lock (see `session-lock.ts`). */
  lockPath: string;
  /** Daemon log (stdout/stderr are redirected here, never to the channel). */
  logPath: string;
  /**
   * Per-session setup script sourced into the daemon's login-env capture
   * (`login-env.ts`). Written by the shell at session start; absent when the
   * host has no script configured.
   */
  setupScriptPath: string;
  /**
   * Daemon liveness beacon, touched periodically while the daemon runs.
   *
   * Lives in the (NFS-shared) session directory on purpose — it is how an
   * attach on the WRONG login node judges whether the daemon recorded in
   * `session.json` is plausibly still alive on its node, where no direct
   * liveness check (`kill(pid, 0)`, socket connect) can reach.
   */
  heartbeatPath: string;
  /** The Unix socket clients attach to; node-local, never on NFS. */
  sockPath: string;
  /** Which candidate the socket directory came from. */
  runtimeSource: string;
  /** Concrete host — never the round-robin alias. */
  hostname: string;
}

/**
 * Create a directory and assert it is private to this user.
 *
 * @param dir - Directory to create (recursively) and check.
 * @returns Nothing.
 * @throws Error if the directory exists but is group- or world-writable —
 *   another user could then replace the socket or the lock, and a session is
 *   not something to hand over quietly.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = fs.statSync(dir).mode;
  if (mode & 0o022) {
    throw new Error(
      `[session] refusing to use ${dir}: mode ${(mode & 0o777).toString(8)} ` +
        "is writable by group or other",
    );
  }
}

/**
 * Ordered candidate directories for the session socket.
 *
 * @param opts - Environment, uid and root to derive candidates from.
 * @returns Candidates in preference order; callers take the first usable one.
 */
export function runtimeDirCandidates(
  opts: Pick<ResolveSessionPathsOptions, "root" | "env" | "uid" | "tmpDir">,
): RuntimeDirCandidate[] {
  const env = opts.env ?? process.env;
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const candidates: RuntimeDirCandidate[] = [];

  const override = env.PDV_SERVER_RUNTIME_DIR;
  if (override) candidates.push({ dir: override, source: "PDV_SERVER_RUNTIME_DIR" });

  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg) candidates.push({ dir: path.join(xdg, "pdv"), source: "XDG_RUNTIME_DIR" });

  const tmpBase = opts.tmpDir ?? os.tmpdir();
  candidates.push({ dir: path.join(tmpBase, `pdv-server-${uid}`), source: "tmp" });

  // Last resort. Documented as such: the root is usually an NFS home, where
  // AF_UNIX may not work at all — but a socket that might fail beats no
  // session, and the failure is immediate and legible rather than subtle.
  candidates.push({ dir: path.join(opts.root, "run"), source: "root-fallback" });

  return candidates;
}

/**
 * Build the socket filename for a session.
 *
 * Kept short on purpose — the whole path must fit
 * {@link SOCKET_PATH_MAX_BYTES}, and a session id is a UUID.
 */
function socketNameFor(sessionId: string): string {
  return `s-${sessionId.replace(/-/g, "").slice(0, 12)}.sock`;
}

/**
 * Resolve every path a session daemon needs, creating the directories.
 *
 * @param opts - Session id, PDV root, and optional env/uid/hostname overrides.
 * @returns The resolved {@link SessionPaths}.
 * @throws Error if no candidate directory is usable within the socket path
 *   budget, or if a directory exists with group/other write permission.
 */
export function resolveSessionPaths(
  opts: ResolveSessionPathsOptions,
): SessionPaths {
  const { sessionId, root } = opts;
  const sessionDir = path.join(root, "run", "sessions", sessionId);
  ensurePrivateDir(root);
  ensurePrivateDir(sessionDir);

  const socketName = socketNameFor(sessionId);
  const rejected: string[] = [];

  for (const candidate of runtimeDirCandidates(opts)) {
    const sockPath = path.join(candidate.dir, socketName);
    if (Buffer.byteLength(sockPath, "utf8") > SOCKET_PATH_MAX_BYTES) {
      rejected.push(`${candidate.source} (path too long: ${sockPath.length}B)`);
      continue;
    }
    try {
      ensurePrivateDir(candidate.dir);
    } catch (err) {
      rejected.push(`${candidate.source} (${(err as Error).message})`);
      continue;
    }
    return {
      root,
      sessionDir,
      metaPath: path.join(sessionDir, "session.json"),
      lockPath: path.join(sessionDir, "spawn.lock"),
      logPath: path.join(sessionDir, "session.log"),
      setupScriptPath: path.join(sessionDir, "setup.sh"),
      heartbeatPath: path.join(sessionDir, "heartbeat"),
      sockPath,
      runtimeSource: candidate.source,
      hostname: opts.hostname ?? os.hostname(),
    };
  }

  throw new Error(
    `[session] no usable runtime directory for the session socket. Tried: ${rejected.join("; ")}. ` +
      "Set PDV_SERVER_RUNTIME_DIR to a short, node-local, writable path.",
  );
}
