/**
 * session-meta.ts — `session.json`, the authoritative record of a session.
 *
 * A reattaching client needs to know three things before it can reach a
 * session, and none of them can be guessed:
 *
 *  - **Which node it lives on.** `flux.pppl.gov` round-robins across login
 *    nodes and the session socket is node-local, so a reattach that follows
 *    the pool alias lands on login2 and reports "my session vanished" when
 *    it is alive and well on login1. The concrete hostname is recorded and
 *    is what a reconnect must ssh to.
 *  - **Where its socket is.** The resolution order can pick different
 *    directories on different hosts, so the resolved path is recorded rather
 *    than recomputed — recomputing risks disagreeing with the daemon that is
 *    actually listening.
 *  - **Which boot it belongs to.** A recorded pid from before a reboot is
 *    meaningless, and `kill(pid, 0)` against a recycled pid would report a
 *    stranger as the daemon.
 *
 * Writes are atomic (temp file plus `rename(2)` in the same directory). A
 * half-written `session.json` read by a concurrent attach would be worse
 * than none at all: it looks authoritative and is wrong.
 *
 * This module does NOT decide paths or liveness; it records what was decided.
 */

import * as fs from "fs";
import * as path from "path";

/** Contents of `session.json`. */
export interface SessionMeta {
  /** Session identifier. */
  sessionId: string;
  /** Unified app version the daemon runs. */
  version: string;
  /** RPC protocol version the daemon speaks. */
  protocol: number;
  /** Daemon pid. */
  pid: number;
  /** Boot id when the daemon started, or `null` where unavailable. */
  bootId: string | null;
  /** Concrete host — never the round-robin alias a client may have typed. */
  hostname: string;
  /** Resolved socket path; the single source of truth for reattach. */
  sockPath: string;
  /** Which candidate the socket directory came from, for diagnostics. */
  runtimeSource: string;
  /** ISO timestamp of daemon start. */
  startedAt: string;
  /**
   * True when a shipped setup script was really sourced by the startup
   * login-environment capture (evidence from the capture, not file
   * existence). Absent on daemons predating the field. False with a script
   * on disk means the capture failed — the session runs without the
   * configured environment.
   */
  setupScriptApplied?: boolean;
}

/**
 * Write `session.json` atomically.
 *
 * @param metaPath - Destination path.
 * @param meta - Record to write.
 * @returns Nothing.
 * @throws Error if the file cannot be written or renamed.
 */
export function writeSessionMeta(metaPath: string, meta: SessionMeta): void {
  const dir = path.dirname(metaPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Same directory, so the rename is atomic rather than a cross-device copy.
  const tmp = path.join(dir, `.session.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, metaPath);
}

/**
 * Read `session.json`.
 *
 * @param metaPath - Path to read.
 * @returns The record, or `null` when absent, unparseable, or structurally
 *   wrong. All three mean the same thing to a caller — this session cannot
 *   be reached from what is on disk — so they are not distinguished.
 */
export function readSessionMeta(metaPath: string): SessionMeta | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as SessionMeta).sessionId === "string" &&
      typeof (parsed as SessionMeta).sockPath === "string"
    ) {
      return parsed as SessionMeta;
    }
    return null;
  } catch {
    return null;
  }
}
