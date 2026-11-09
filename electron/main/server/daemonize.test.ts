/**
 * daemonize.test.ts — detachment and log handling.
 *
 * The detachment test spawns a real process and checks it is a session
 * leader with no controlling terminal, because that is the property the
 * whole remote design rests on and a mock could only restate the arguments
 * we passed. It reaps what it spawns.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { daemonize, rotateLogIfLarge, LOG_ROTATE_BYTES } from "./daemonize";

let workDir: string;
let logPath: string;
const spawned: number[] = [];

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-daemon-"));
  logPath = path.join(workDir, "session.log");
});

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("daemonize", () => {
  it("detaches into its own session with no controlling terminal", async () => {
    const pid = daemonize({
      execPath: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      logPath,
    });
    spawned.push(pid);
    await delay(300);

    // pgid === pid means setsid took: the daemon leads its own process group
    // and session, so the ssh channel closing cannot SIGHUP it.
    //
    // pgid rather than sess deliberately — `ps -o sess=` prints a session
    // pointer on macOS (0 for a detached process) and a session id on Linux,
    // so asserting on it would describe the runner rather than the code.
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)])
      .toString()
      .trim();
    const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pid)])
      .toString()
      .trim();

    expect(Number(pgid)).toBe(pid);
    expect(tty === "?" || tty === "??" || tty === "-").toBe(true);
  });

  it("sends the daemon's output to the log, not to the caller's stdout", async () => {
    // The mandatory part: a daemon inheriting the ssh channel's stdout keeps
    // its write end open, sshd never sees EOF, and the launching ssh command
    // hangs forever.
    const pid = daemonize({
      execPath: process.execPath,
      args: ["-e", "console.log('from the daemon'); setInterval(() => {}, 1000)"],
      logPath,
    });
    spawned.push(pid);
    await delay(400);

    expect(fs.readFileSync(logPath, "utf8")).toContain("from the daemon");
  });

  it("appends to an existing log rather than truncating it", async () => {
    fs.writeFileSync(logPath, "earlier session\n");
    const pid = daemonize({
      execPath: process.execPath,
      args: ["-e", "console.log('later session'); setInterval(() => {}, 1000)"],
      logPath,
    });
    spawned.push(pid);
    await delay(400);

    const log = fs.readFileSync(logPath, "utf8");
    expect(log).toContain("earlier session");
    expect(log).toContain("later session");
  });

  it("passes the environment through to the daemon", async () => {
    const pid = daemonize({
      execPath: process.execPath,
      args: ["-e", "console.log(process.env.PDV_TEST_MARKER); setInterval(() => {}, 1000)"],
      logPath,
      env: { ...process.env, PDV_TEST_MARKER: "marker-value" },
    });
    spawned.push(pid);
    await delay(400);

    expect(fs.readFileSync(logPath, "utf8")).toContain("marker-value");
  });
});

describe("rotateLogIfLarge", () => {
  it("leaves a small log alone", () => {
    fs.writeFileSync(logPath, "small\n");
    expect(rotateLogIfLarge(logPath)).toBe(false);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });

  it("does nothing when there is no log yet", () => {
    expect(rotateLogIfLarge(logPath)).toBe(false);
  });

  it("copies then truncates, keeping the same inode", () => {
    // Copytruncate, not rename: a live daemon holds an O_APPEND fd on this
    // inode. Renaming would leave it writing to the rotated file while the
    // current log stayed empty forever.
    fs.writeFileSync(logPath, "x".repeat(200));
    const inodeBefore = fs.statSync(logPath).ino;

    expect(rotateLogIfLarge(logPath, 100)).toBe(true);

    expect(fs.statSync(logPath).size).toBe(0);
    expect(fs.statSync(logPath).ino).toBe(inodeBefore);
    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toHaveLength(200);
  });

  it("keeps a daemon's open fd writing to the live log after rotation", async () => {
    // The property the inode check stands for, verified end to end.
    fs.writeFileSync(logPath, "y".repeat(200));
    const pid = daemonize({
      execPath: process.execPath,
      args: [
        "-e",
        "setInterval(() => console.log('still here'), 50)",
      ],
      logPath,
    });
    spawned.push(pid);
    await delay(200);

    rotateLogIfLarge(logPath, 100);
    await delay(300);

    expect(fs.readFileSync(logPath, "utf8")).toContain("still here");
  });

  it("uses a sane default threshold", () => {
    expect(LOG_ROTATE_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
