/**
 * session-lock.ts — gate session-daemon creation so one session never gets
 * two daemons.
 *
 * **The socket alone cannot do this job**, which is the trap worth stating
 * plainly: two clients attaching at once both find a stale socket, both get
 * `ECONNREFUSED`, both conclude the daemon is dead, both unlink it, and both
 * listen. One of them wins the file and the other serves a socket nobody
 * will ever connect to — with its own kernel, its own Tree, and no way for
 * the user to tell which one their work went into. So creation is gated by
 * an `O_EXCL` lockfile, which is atomic on every filesystem including NFS,
 * and the socket is demoted to a liveness probe.
 *
 * **`bootId` closes the pid-reuse hole.** A lock left by a daemon that died
 * in a crash or a reboot records a pid that the OS is free to hand to an
 * unrelated process. `kill(pid, 0)` then reports that stranger as alive, and
 * the session hangs forever waiting for a daemon that does not exist. After
 * a reboot the boot id differs, which is decisive: every recorded pid from
 * the previous boot is meaningless, no liveness check required.
 *
 * A lock is only ever removed when it is *provably* stale. When liveness
 * cannot be established either way the lock stands — a session that refuses
 * to start is a visible, retryable problem; two daemons silently splitting a
 * user's work is not.
 *
 * This module does NOT create sockets or spawn daemons; it answers "may I
 * create this session?" and records who holds the answer.
 */

import * as fs from "fs";
import * as path from "path";

/** Contents of a spawn lockfile. */
export interface LockRecord {
  /** Pid of the process that took the lock. */
  pid: number;
  /**
   * Kernel boot id when the lock was taken, or `null` where unavailable
   * (macOS has no `/proc`). A differing boot id proves the holder is dead.
   */
  bootId: string | null;
  /** Socket the holder intends to serve, for diagnostics. */
  sockPath: string;
  /** ISO timestamp, for humans reading a stuck session. */
  startedAt: string;
}

/** Outcome of {@link acquireSpawnLock}. */
export type LockResult =
  | {
      acquired: true;
      /** Remove the lock. Idempotent, and safe to call after a crash. */
      release: () => void;
    }
  | {
      acquired: false;
      /** The live holder, when its record could be read. */
      holder: LockRecord | null;
      /** Why the lock was not taken, for the surfaced error. */
      reason: "held" | "unreadable";
    };

/** Options for {@link acquireSpawnLock}. */
export interface AcquireSpawnLockOptions {
  /** Lockfile path (normally `SessionPaths.lockPath`). */
  lockPath: string;
  /** Socket the caller intends to serve. */
  sockPath: string;
  /** Pid to record. Defaults to `process.pid`. */
  pid?: number;
  /** Boot id to record. Defaults to {@link readBootId}. */
  bootId?: string | null;
  /** Liveness probe. Injected by tests; defaults to `kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** Timestamp for the record. Injected by tests. */
  startedAt?: string;
}

/**
 * Read this machine's kernel boot id.
 *
 * @returns The boot id, or `null` where the platform does not expose one
 *   (macOS). A null boot id degrades the staleness check to `kill(pid, 0)`,
 *   which is correct but cannot survive pid reuse across a reboot.
 */
export function readBootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

/** Default liveness probe: signal 0 tests existence without delivering. */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — alive for our
    // purposes, and certainly not ours to clear.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock's holder is provably dead.
 *
 * @param record - The lock record read from disk.
 * @param currentBootId - This machine's boot id, or `null`.
 * @param isProcessAlive - Liveness probe.
 * @returns True only when the holder is *known* dead. Anything ambiguous
 *   returns false, leaving the lock in place.
 */
export function isHolderDead(
  record: LockRecord,
  currentBootId: string | null,
  isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
): boolean {
  // Decisive: the machine rebooted, so every pid from before it is gone.
  // Checked first, because kill(pid, 0) against a recycled pid would
  // otherwise report a stranger as our daemon.
  if (record.bootId && currentBootId && record.bootId !== currentBootId) {
    return true;
  }
  return !isProcessAlive(record.pid);
}

/**
 * Try to become the process that creates this session's daemon.
 *
 * @param opts - Lock path, intended socket, and injectable probes.
 * @returns {@link LockResult} — `acquired` with a `release`, or the live
 *   holder and why.
 * @throws Error if the lock directory cannot be created or written for a
 *   reason other than the lock already existing.
 */
export function acquireSpawnLock(opts: AcquireSpawnLockOptions): LockResult {
  const {
    lockPath,
    sockPath,
    pid = process.pid,
    isProcessAlive = defaultIsProcessAlive,
  } = opts;
  const bootId = opts.bootId !== undefined ? opts.bootId : readBootId();
  const record: LockRecord = {
    pid,
    bootId,
    sockPath,
    startedAt: opts.startedAt ?? new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  // One retry, and only one: the sole reason to loop is that we cleared a
  // provably-stale lock. Retrying further would mean racing whoever took it
  // after we cleared it, which is exactly the race the lock exists to settle.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // "wx" is O_CREAT|O_EXCL — atomic even on NFS.
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(record));
      } finally {
        fs.closeSync(fd);
      }
      return {
        acquired: true,
        release: () => {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Already gone: released twice, or cleared as stale by another
            // process. Either way there is nothing to undo.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = readLockRecord(lockPath);
    if (!holder) {
      // Present but unreadable: a truncated write from a process that died
      // mid-write, or garbage. Treated as held rather than cleared — a
      // human-visible stuck session beats a coin-flip on someone's kernel.
      return { acquired: false, holder: null, reason: "unreadable" };
    }
    if (!isHolderDead(holder, bootId, isProcessAlive)) {
      return { acquired: false, holder, reason: "held" };
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Someone else cleared it first; the next attempt settles who wins.
    }
  }

  const holder = readLockRecord(lockPath);
  return { acquired: false, holder, reason: holder ? "held" : "unreadable" };
}

/**
 * Read a lock record from disk.
 *
 * @param lockPath - Lockfile path.
 * @returns The parsed record, or `null` when absent, unparseable, or
 *   structurally wrong.
 */
export function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockRecord).pid === "number"
    ) {
      return parsed as LockRecord;
    }
    return null;
  } catch {
    return null;
  }
}
