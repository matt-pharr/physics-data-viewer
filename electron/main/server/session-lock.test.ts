/**
 * session-lock.test.ts — one session, one daemon.
 *
 * The liveness probe and boot id are injected so the dangerous cases can be
 * constructed exactly: a recycled pid after a reboot, and a holder that is
 * merely unreachable rather than dead. Both are situations where clearing
 * the lock would split a user's work across two kernels.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSpawnLock,
  isHolderDead,
  readLockRecord,
  type LockRecord,
} from "./session-lock";

let workDir: string;
let lockPath: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-lock-test-"));
  lockPath = path.join(workDir, "spawn.lock");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const alive = (): boolean => true;
const dead = (): boolean => false;

/** Take a lock as some other process. */
function seedLock(over: Partial<LockRecord> = {}): LockRecord {
  const record: LockRecord = {
    pid: 4242,
    bootId: "boot-1",
    sockPath: "/tmp/s.sock",
    startedAt: "2026-07-25T00:00:00.000Z",
    ...over,
  };
  fs.writeFileSync(lockPath, JSON.stringify(record));
  return record;
}

describe("acquireSpawnLock", () => {
  it("acquires a free lock and records who holds it", () => {
    const result = acquireSpawnLock({
      lockPath,
      sockPath: "/tmp/s.sock",
      pid: 111,
      bootId: "boot-1",
      isProcessAlive: alive,
    });

    expect(result.acquired).toBe(true);
    expect(readLockRecord(lockPath)).toMatchObject({
      pid: 111,
      bootId: "boot-1",
      sockPath: "/tmp/s.sock",
    });
  });

  it("refuses when a live holder has it", () => {
    seedLock();
    const result = acquireSpawnLock({
      lockPath,
      sockPath: "/tmp/s.sock",
      pid: 111,
      bootId: "boot-1",
      isProcessAlive: alive,
    });

    expect(result.acquired).toBe(false);
    if (result.acquired) return;
    expect(result.reason).toBe("held");
    expect(result.holder?.pid).toBe(4242);
  });

  it("takes over from a provably dead holder", () => {
    seedLock();
    const result = acquireSpawnLock({
      lockPath,
      sockPath: "/tmp/s.sock",
      pid: 111,
      bootId: "boot-1",
      isProcessAlive: dead,
    });

    expect(result.acquired).toBe(true);
    expect(readLockRecord(lockPath)?.pid).toBe(111);
  });

  it("treats a reboot as decisive, without trusting the pid", () => {
    // The pid-reuse hole: after a reboot the recorded pid may belong to an
    // unrelated process, so a liveness probe would report the daemon alive
    // and the session would wait forever for something that does not exist.
    seedLock({ bootId: "boot-OLD" });
    const result = acquireSpawnLock({
      lockPath,
      sockPath: "/tmp/s.sock",
      pid: 111,
      bootId: "boot-NEW",
      isProcessAlive: alive, // a stranger now owns that pid
    });

    expect(result.acquired).toBe(true);
  });

  it("holds when the record is unreadable rather than guessing", () => {
    // A truncated write from a process that died mid-write. Clearing it
    // would be a coin flip on whether a live daemon is out there; a stuck
    // session is visible and retryable, two daemons are neither.
    fs.writeFileSync(lockPath, "{ this is not json");
    const result = acquireSpawnLock({
      lockPath,
      sockPath: "/tmp/s.sock",
      isProcessAlive: dead,
    });

    expect(result.acquired).toBe(false);
    if (result.acquired) return;
    expect(result.reason).toBe("unreadable");
  });

  it("serializes two racing acquirers", () => {
    // The case the socket alone cannot settle: both racers would see a
    // stale socket, both unlink, both listen.
    const opts = {
      lockPath,
      sockPath: "/tmp/s.sock",
      bootId: "boot-1",
      isProcessAlive: alive,
    };
    const first = acquireSpawnLock({ ...opts, pid: 1 });
    const second = acquireSpawnLock({ ...opts, pid: 2 });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
  });

  it("frees the lock on release, letting the next acquirer through", () => {
    const opts = {
      lockPath,
      sockPath: "/tmp/s.sock",
      bootId: "boot-1",
      isProcessAlive: alive,
    };
    const first = acquireSpawnLock({ ...opts, pid: 1 });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    first.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(acquireSpawnLock({ ...opts, pid: 2 }).acquired).toBe(true);
  });

  it("survives a double release", () => {
    const result = acquireSpawnLock({
      lockPath,
      sockPath: "/tmp/s.sock",
      isProcessAlive: alive,
    });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    result.release();
    expect(() => result.release()).not.toThrow();
  });

  it("creates the lock directory when the session is brand new", () => {
    const nested = path.join(workDir, "run", "sessions", "abc", "spawn.lock");
    const result = acquireSpawnLock({
      lockPath: nested,
      sockPath: "/tmp/s.sock",
      isProcessAlive: alive,
    });
    expect(result.acquired).toBe(true);
  });
});

describe("isHolderDead", () => {
  const record: LockRecord = {
    pid: 5,
    bootId: "boot-1",
    sockPath: "/tmp/s.sock",
    startedAt: "2026-07-25T00:00:00.000Z",
  };

  it("is decided by the boot id before the pid is consulted", () => {
    let probed = false;
    const probe = (): boolean => {
      probed = true;
      return true;
    };
    expect(isHolderDead(record, "boot-2", probe)).toBe(true);
    expect(probed).toBe(false);
  });

  it("falls back to the liveness probe within one boot", () => {
    expect(isHolderDead(record, "boot-1", alive)).toBe(false);
    expect(isHolderDead(record, "boot-1", dead)).toBe(true);
  });

  it("uses the probe when either boot id is unknown", () => {
    // macOS has no /proc, so bootId is null there; the check degrades to
    // kill(pid, 0) rather than declaring everything stale.
    expect(isHolderDead({ ...record, bootId: null }, "boot-9", alive)).toBe(false);
    expect(isHolderDead(record, null, alive)).toBe(false);
    expect(isHolderDead({ ...record, bootId: null }, null, dead)).toBe(true);
  });
});
