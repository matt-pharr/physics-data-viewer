/**
 * ssh-pty.test.ts — Interactive ControlMaster establishment.
 *
 * Two layers of coverage, and both are load-bearing:
 *
 * 1. **A real pty driving a real `node-pty`.** The fixture prompts on the
 *    terminal and reads the reply, so these tests fail if the native module
 *    is missing, built for the wrong ABI, or — the case actually hit during
 *    development — shipped with a non-executable `spawn-helper`, which makes
 *    every spawn die with `posix_spawnp failed.` A mocked pty would have
 *    sailed straight past that.
 * 2. **An injected fake pty** for the paths a real one cannot reach
 *    reliably: deadlines, cancellation, and a native module that fails to load.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { controlPathFor } from "./ssh-mux";
import {
  establishMasterInteractive,
  isSecretPrompt,
  looksLikePrompt,
  type PtyModule,
  type PtyProcess,
} from "./ssh-pty";

const FAKE_SSH = path.join(__dirname, "__fixtures__", "fake-ssh.cjs");
/**
 * A binary that does not exist. The injected-pty tests still run the real
 * master poll, and pointing it here makes each check fail instantly instead
 * of spawning the machine's actual ssh.
 */
const MISSING_SSH = path.join(os.tmpdir(), "pdv-no-such-ssh");

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-ssh-pty-"));
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A controllable stand-in for a spawned pty. */
class FakePty implements PtyProcess {
  written: string[] = [];
  killed = false;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((event: { exitCode: number }) => void) | null = null;

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  kill(): void {
    this.killed = true;
  }
  emit(data: string): void {
    this.dataListener?.(data);
  }
  exit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

/** A PtyModule that hands back a controllable FakePty. */
function fakeModule(pty: FakePty): PtyModule {
  return { spawn: () => pty };
}

describe("isSecretPrompt", () => {
  it.each([
    "mpharr@flux.pppl.gov's password: ",
    "Enter passphrase for key '/Users/pharr/.ssh/id_ed25519': ",
    "Passcode or option (1-3): ",
    "Duo two-factor login\n\nverification code: ",
    "One-time password: ",
  ])("masks %j", (prompt) => {
    expect(isSecretPrompt(prompt)).toBe(true);
  });

  it.each([
    "Last login: Fri Jul 25 10:00:00 2026",
    "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
    "Pushed a login request to your device...",
  ])("does not mask %j", (text) => {
    expect(isSecretPrompt(text)).toBe(false);
  });

  it("only considers the tail, so an old prompt stops masking", () => {
    const stale = "password: \n" + "x".repeat(1000) + "\nLast login: today\n";
    expect(isSecretPrompt(stale)).toBe(false);
  });
});

describe("looksLikePrompt", () => {
  it.each([
    "mpharr@flux.pppl.gov's password: ",
    "Passcode or option (1-3): ",
    "Are you sure you want to continue connecting (yes/no)? ",
  ])("treats %j as awaiting input", (text) => {
    expect(looksLikePrompt(text)).toBe(true);
  });

  it.each([
    "Permission denied, please try again.\n",
    "Duo two-factor login for mpharr\n\n",
    "Pushed a login request to your device...\n",
    "",
  ])("treats %j as narration, not a question", (text) => {
    // ssh talking is not ssh asking. Getting this wrong puts an input box in
    // front of an error message and leaves the user typing into nothing.
    expect(looksLikePrompt(text)).toBe(false);
  });
});

describe("establishMasterInteractive (real pty)", () => {
  it("authenticates a host that needs no prompt", async () => {
    setEnv("FAKE_SSH_AUTH", "hold");
    setEnv("FAKE_SSH_MASTER", "stateful");
    const session = establishMasterInteractive({
      host: "feyn",
      controlPath: controlPathFor("feyn", dir),
      sshPath: FAKE_SSH,
    });
    await expect(session.result).resolves.toMatchObject({ ok: true, failure: null });
    // The held process *is* the master; leaving it running would leak.
    session.close();
  }, 30_000);

  it("carries a password prompt out and the answer back in", async () => {
    setEnv("FAKE_SSH_AUTH", "prompt");
    setEnv("FAKE_SSH_MASTER", "stateful");
    const chunks: string[] = [];
    const session = establishMasterInteractive({
      host: "flux",
      controlPath: controlPathFor("flux", dir),
      sshPath: FAKE_SSH,
      onOutput: (chunk) => {
        chunks.push(chunk);
        // This is the whole point of the pty: ssh reads from the terminal,
        // so the reply has to travel back the same way it came.
        if (isSecretPrompt(chunks.join(""))) session.respond("hunter2");
      },
    });
    const result = await session.result;
    expect(result).toMatchObject({ ok: true, failure: null });
    expect(result.transcript).toContain("password");
    session.close();
  }, 30_000);

  it("handles Duo's stateful two-stage prompt", async () => {
    setEnv("FAKE_SSH_AUTH", "duo");
    setEnv("FAKE_SSH_MASTER", "stateful");
    let seen = "";
    let answeredMenu = false;
    const session = establishMasterInteractive({
      host: "flux",
      controlPath: controlPathFor("flux", dir),
      sshPath: FAKE_SSH,
      onOutput: (chunk) => {
        seen += chunk;
        if (!answeredMenu && /option \(1-3\)/.test(seen)) {
          answeredMenu = true;
          session.respond("1");
        } else if (answeredMenu && /Password:/.test(seen)) {
          session.respond("hunter2");
        }
      },
    });
    const result = await session.result;
    // PDV models none of this exchange — the bytes simply flow both ways,
    // which is exactly why a pty was chosen over an askpass helper.
    expect(result).toMatchObject({ ok: true, failure: null });
    expect(result.transcript).toContain("Pushed a login request");
    session.close();
  }, 30_000);

  it("reports a wrong password as an auth failure", async () => {
    setEnv("FAKE_SSH_AUTH", "prompt");
    setEnv("FAKE_SSH_MASTER", "stateful");
    const session = establishMasterInteractive({
      host: "flux",
      controlPath: controlPathFor("flux", dir),
      sshPath: FAKE_SSH,
      onOutput: (chunk) => {
        if (isSecretPrompt(chunk)) session.respond("wrong-password");
      },
    });
    const result = await session.result;
    expect(result).toMatchObject({ ok: false, failure: "auth-failed" });
    expect(result.transcript).toContain("Permission denied");
  }, 30_000);

  it("reports a refused connection as an auth failure", async () => {
    setEnv("FAKE_SSH_AUTH", "fail");
    const session = establishMasterInteractive({
      host: "flux",
      controlPath: controlPathFor("flux", dir),
      sshPath: FAKE_SSH,
    });
    await expect(session.result).resolves.toMatchObject({
      ok: false,
      failure: "auth-failed",
    });
  }, 30_000);

  it("refuses to call it a success when ssh leaves no usable master", async () => {
    // Authenticates, then exits without publishing a socket.
    setEnv("FAKE_SSH_AUTH", "ok");
    setEnv("FAKE_SSH_MASTER", "absent");
    const session = establishMasterInteractive({
      host: "feyn",
      controlPath: controlPathFor("feyn", dir),
      sshPath: FAKE_SSH,
    });
    // ssh exited zero, so the exit status alone would have said "connected".
    // Verifying the socket is what turns that into an honest failure.
    await expect(session.result).resolves.toMatchObject({
      ok: false,
      failure: "no-master",
    });
  }, 30_000);
});

describe("establishMasterInteractive (injected pty)", () => {
  it("adds -o ForwardX11=yes to the master argv only when the per-host toggle asks", () => {
    const seenArgs: string[][] = [];
    const capturingModule = (pty: FakePty): PtyModule => ({
      spawn: (_file, args) => {
        seenArgs.push([...args]);
        return pty;
      },
    });

    const withToggle = establishMasterInteractive({
      host: "feyn",
      controlPath: "/tmp/x",
      forwardX11: true,
      sshPath: MISSING_SSH,
      ptyModule: capturingModule(new FakePty()),
    });
    withToggle.cancel();
    const without = establishMasterInteractive({
      host: "feyn",
      controlPath: "/tmp/x",
      sshPath: MISSING_SSH,
      ptyModule: capturingModule(new FakePty()),
    });
    without.cancel();

    const withJoined = seenArgs[0].join(" ");
    expect(withJoined).toContain("-o ForwardX11=yes");
    // As an -o pair, before the destination — where ssh reads options.
    // Guard the index first: indexOf's -1 would vacuously pass the
    // less-than comparison if the flag were missing.
    const x11At = seenArgs[0].indexOf("ForwardX11=yes");
    expect(x11At).toBeGreaterThan(0);
    expect(seenArgs[0][x11At - 1]).toBe("-o");
    expect(x11At).toBeLessThan(seenArgs[0].indexOf("feyn"));
    expect(seenArgs[1].join(" ")).not.toContain("ForwardX11");
  });

  it("appends the newline a prompt needs to complete", () => {
    const pty = new FakePty();
    const session = establishMasterInteractive({
      host: "feyn",
      controlPath: "/tmp/x",
      sshPath: MISSING_SSH,
      ptyModule: fakeModule(pty),
    });
    session.respond("secret");
    session.respond("already-terminated\n");
    expect(pty.written).toEqual(["secret\n", "already-terminated\n"]);
    session.cancel();
  });

  it("gives up after the overall deadline and reaps the process", async () => {
    const pty = new FakePty();
    const session = establishMasterInteractive({
      host: "feyn",
      controlPath: "/tmp/x",
      sshPath: MISSING_SSH,
      ptyModule: fakeModule(pty),
      overallTimeoutMs: 50,
    });
    const result = await session.result;
    expect(result).toMatchObject({ ok: false, failure: "timeout" });
    expect(pty.killed).toBe(true);
  });

  it("cancels cleanly", async () => {
    const pty = new FakePty();
    const session = establishMasterInteractive({
      host: "feyn",
      controlPath: "/tmp/x",
      sshPath: MISSING_SSH,
      ptyModule: fakeModule(pty),
    });
    session.cancel();
    const result = await session.result;
    expect(result).toMatchObject({ ok: false, failure: "cancelled" });
    expect(pty.killed).toBe(true);
  });

  it("keeps the transcript even when the attempt fails", async () => {
    const pty = new FakePty();
    const session = establishMasterInteractive({
      host: "feyn",
      controlPath: "/tmp/x",
      sshPath: MISSING_SSH,
      ptyModule: fakeModule(pty),
    });
    pty.emit("Permission denied (publickey).\n");
    pty.exit(255);
    const result = await session.result;
    expect(result.transcript).toContain("Permission denied");
  });

  it("ignores a late exit after cancellation", async () => {
    const pty = new FakePty();
    const session = establishMasterInteractive({
      host: "feyn",
      controlPath: "/tmp/x",
      sshPath: MISSING_SSH,
      ptyModule: fakeModule(pty),
    });
    session.cancel();
    pty.exit(0);
    await expect(session.result).resolves.toMatchObject({ failure: "cancelled" });
  });

  it("degrades to a clear message when the native module will not load", async () => {
    const broken: PtyModule = {
      spawn: () => {
        throw new Error("dlopen failed: wrong ABI");
      },
    };
    const session = establishMasterInteractive({
      host: "feyn",
      controlPath: "/tmp/x",
      ptyModule: broken,
    });
    const result = await session.result;
    // A native-module problem must surface as one failed connect, never as a
    // main-process crash — which is why the import is lazy.
    expect(result).toMatchObject({ ok: false, failure: "pty-unavailable" });
    expect(result.message).toContain("dlopen failed");
  });
});

describe("node-pty packaging", () => {
  it("ships an executable spawn-helper", () => {
    // node-pty publishes this 644 and its own postinstall does not fix the
    // prebuilds copy, which makes every pty.spawn() fail with
    // `posix_spawnp failed.` scripts/fix-node-pty-perms.mjs repairs it at
    // install time; this asserts the repair actually happened, in dev and CI
    // alike, rather than waiting for a remote connect to fail.
    if (process.platform === "win32") return;
    const prebuilds = path.join(__dirname, "..", "..", "node_modules", "node-pty", "prebuilds");
    if (!fs.existsSync(prebuilds)) return;
    const helpers = fs
      .readdirSync(prebuilds)
      .map((entry) => path.join(prebuilds, entry, "spawn-helper"))
      .filter((helper) => fs.existsSync(helper));
    expect(helpers.length).toBeGreaterThan(0);
    for (const helper of helpers) {
      expect(fs.statSync(helper).mode & 0o111).toBe(0o111);
    }
  });
});
