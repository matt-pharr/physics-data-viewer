/**
 * ssh-mux.test.ts — Control-socket resolution and remote command execution.
 *
 * Everything here runs against `__fixtures__/fake-ssh.cjs`, which really
 * executes the wrapped command under `/bin/sh`. That means the exit
 * sentinel, the banner tolerance and the exit-code plumbing are exercised
 * for real — no network, no cluster, no credentials.
 *
 * The tests that matter most are the classification ones. `ssh` reports both
 * "I could not connect" and "your command exited 255" as exit 255, so a
 * mistake there does not fail loudly: it turns a remote error into a
 * spurious reconnect, or a dropped connection into a bogus command failure.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  controlPathOption,
  checkMaster,
  controlPathFor,
  ensureControlDir,
  execViaSsh,
  resolveSshControl,
  stopMaster,
  type SshControl,
  type SshMuxOptions,
} from "./ssh-mux";

const FAKE_SSH = path.join(__dirname, "__fixtures__", "fake-ssh.cjs");

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

/** Set a fixture env var for the duration of one test. */
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Options pointing at the fixture, with a short deadline. */
function opts(extra: SshMuxOptions = {}): SshMuxOptions {
  return { sshPath: FAKE_SSH, timeoutMs: 10_000, ...extra };
}

const control: SshControl = { host: "feyn", controlPath: "/tmp/pdv-test-sock" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-ssh-mux-"));
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("controlPathOption", () => {
  it("quotes the path so a space survives ssh's parser", () => {
    // Regression: Electron's userData on macOS is
    // `~/Library/Application Support/...`, so the space is present on every
    // macOS install. Unquoted, ssh rejects the whole option with
    // "keyword controlpath extra arguments at end of line" and no
    // connection is possible at all. Found by driving the real UI.
    expect(controlPathOption("/Users/x/Library/Application Support/pdv/m-1")).toBe(
      'ControlPath="/Users/x/Library/Application Support/pdv/m-1"',
    );
  });

  it("quotes a path without spaces too, which ssh accepts", () => {
    expect(controlPathOption("/tmp/pdv/m-1")).toBe('ControlPath="/tmp/pdv/m-1"');
  });
});

describe("controlPathFor", () => {
  it("is stable per host and differs between hosts", () => {
    expect(controlPathFor("flux", dir)).toBe(controlPathFor("flux", dir));
    expect(controlPathFor("flux", dir)).not.toBe(controlPathFor("feyn", dir));
  });

  it("keeps the socket path inside the platform's sun_path budget", () => {
    const deep = path.join(dir, "a".repeat(60), "b".repeat(60));
    const result = controlPathFor("some.very.long.cluster.hostname.example.org", deep);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(104);
  });

  it("cannot escape the control directory via a hostile alias", () => {
    const result = controlPathFor("../../etc/evil", dir);
    expect(path.dirname(result)).toBe(dir);
  });

  it("ensureControlDir creates an owner-only directory", () => {
    const target = path.join(dir, "sockets");
    ensureControlDir(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });
});

describe("checkMaster", () => {
  it("reports a live master", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    await expect(checkMaster(control, opts())).resolves.toBe("alive");
  });

  it("reports a missing socket as absent", async () => {
    setEnv("FAKE_SSH_MASTER", "absent");
    await expect(checkMaster(control, opts())).resolves.toBe("absent");
  });

  it("reports a socket nothing listens on as absent", async () => {
    setEnv("FAKE_SSH_MASTER", "refused");
    await expect(checkMaster(control, opts())).resolves.toBe("absent");
  });

  it("distinguishes a host with no ControlPath configured at all", async () => {
    setEnv("FAKE_SSH_MASTER", "unconfigured");
    // This is what a plain `Host` entry answers, and it must not be confused
    // with "the master died" — nothing died, there was never one to begin with.
    await expect(
      checkMaster({ host: "feyn", controlPath: null }, opts()),
    ).resolves.toBe("unconfigured");
  });

  it("reports unknown when ssh cannot be spawned", async () => {
    await expect(
      checkMaster(control, opts({ sshPath: path.join(dir, "nope") })),
    ).resolves.toBe("unknown");
  });
});

describe("resolveSshControl", () => {
  it("inherits the user's own master when one is already running", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    const resolved = await resolveSshControl("flux", dir, opts());
    // A null controlPath means "use the config's own ControlPath" — PDV rides
    // the master the user already authenticated instead of opening a second
    // one, which on an agent-gated host would cost another approval tap.
    expect(resolved.control.controlPath).toBeNull();
    expect(resolved.masterState).toBe("alive");
  });

  it("falls back to a PDV-owned socket when the host has no mux configured", async () => {
    setEnv("FAKE_SSH_MASTER", "unconfigured");
    const resolved = await resolveSshControl("feyn", dir, opts());
    expect(resolved.control.controlPath).toBe(controlPathFor("feyn", dir));
    // The config names no ControlPath, and the socket PDV nominated does not
    // exist yet — so there is no master, and the caller must establish one
    // before it can run channels.
    expect(resolved.masterState).toBe("absent");
  });

  it("uses its own socket when the user's master is dead", async () => {
    setEnv("FAKE_SSH_MASTER", "absent");
    const resolved = await resolveSshControl("flux", dir, opts());
    expect(resolved.control.controlPath).toBe(controlPathFor("flux", dir));
    expect(resolved.masterState).toBe("absent");
  });
});

describe("stopMaster", () => {
  it("reports success when ssh accepts the stop", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    await expect(stopMaster(control, opts())).resolves.toBe(true);
  });

  it("reports failure when there is no master to stop", async () => {
    setEnv("FAKE_SSH_MASTER", "absent");
    await expect(stopMaster(control, opts())).resolves.toBe(false);
  });
});

describe("execViaSsh", () => {
  it("runs a command and returns its output and exit code", async () => {
    const result = await execViaSsh(control, "echo hello", opts());
    expect(result).toMatchObject({ ok: true, exitCode: 0, failure: null });
    expect(result.stdout.trim()).toBe("hello");
  });

  it("strips the exit sentinel from stdout", async () => {
    const result = await execViaSsh(control, "echo hello", opts());
    expect(result.stdout).not.toContain('"pdv":"exit"');
  });

  it("reports a non-zero remote exit code", async () => {
    const result = await execViaSsh(control, "exit 3", opts());
    expect(result).toMatchObject({ ok: false, exitCode: 3, failure: null });
  });

  it("survives login banners and MOTD noise on both streams", async () => {
    setEnv("FAKE_SSH_EXEC", "banner");
    const result = await execViaSsh(control, "echo payload", opts());
    expect(result).toMatchObject({ ok: true, exitCode: 0, failure: null });
    expect(result.stdout).toContain("payload");
    expect(result.stderr).toContain("Lmod");
  });

  it("ignores a sentinel-shaped line that carries the wrong nonce", async () => {
    setEnv("FAKE_SSH_EXEC", "banner");
    const result = await execViaSsh(control, "exit 4", opts());
    // The banner prints a well-formed sentinel with someone else's nonce. It
    // must be treated as ordinary output, or a host whose MOTD happens to
    // echo JSON could dictate the exit code PDV believes.
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toContain("wrong-nonce");
  });

  it("trusts the sentinel when the remote command itself exited 255", async () => {
    setEnv("FAKE_SSH_EXEC", "exit255");
    setEnv("FAKE_SSH_MASTER", "alive");
    const result = await execViaSsh(control, "false", opts());
    // ssh also exits 255 here. The sentinel is what proves the remote shell
    // ran, so this is a command failure to surface — not a dropped connection.
    expect(result).toMatchObject({ ok: false, exitCode: 255, failure: null });
  });

  it("classifies a dropped channel with a live master as retryable", async () => {
    setEnv("FAKE_SSH_EXEC", "drop");
    setEnv("FAKE_SSH_MASTER", "alive");
    const result = await execViaSsh(control, "echo hi", opts());
    expect(result).toMatchObject({ exitCode: null, failure: "channel-failed" });
  });

  it("classifies a dropped channel with a dead master as master-lost", async () => {
    setEnv("FAKE_SSH_EXEC", "drop");
    setEnv("FAKE_SSH_MASTER", "absent");
    const result = await execViaSsh(control, "echo hi", opts());
    expect(result).toMatchObject({ exitCode: null, failure: "master-lost" });
  });

  it("classifies the macOS no-askpass failure as auth-required", async () => {
    setEnv("FAKE_SSH_EXEC", "askpass");
    setEnv("FAKE_SSH_MASTER", "absent");
    const result = await execViaSsh(control, "echo hi", opts());
    // Observed verbatim against flux: with no tty and no askpass binary, ssh
    // cannot ask for the Duo/passphrase response. The fix is to open the
    // interactive flow, not to retry.
    expect(result.failure).toBe("auth-required");
  });

  it("does not call an auth error master-lost just because stderr looks scary", async () => {
    setEnv("FAKE_SSH_EXEC", "drop");
    setEnv("FAKE_SSH_MASTER", "alive");
    const result = await execViaSsh(control, "echo 'Permission denied'", opts());
    // The master answers, so the channel is retryable regardless of what the
    // command printed. stderr text never overrides the -O check ladder.
    expect(result.failure).toBe("channel-failed");
  });

  it("reports a spawn failure distinctly", async () => {
    const result = await execViaSsh(
      control,
      "echo hi",
      opts({ sshPath: path.join(dir, "missing-ssh") }),
    );
    expect(result.failure).toBe("spawn-failed");
  });

  it("kills a command that overruns its deadline", async () => {
    setEnv("FAKE_SSH_EXEC", "hang");
    const result = await execViaSsh(control, "sleep 60", opts({ timeoutMs: 300 }));
    expect(result.failure).toBe("timeout");
  });

  it("passes the flags that keep a session predictable", async () => {
    const logPath = path.join(dir, "argv.log");
    setEnv("FAKE_SSH_LOG", logPath);
    await execViaSsh(control, "echo hi", opts());
    const argv = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as string[]).join(" "));
    const exec = argv.find((line) => line.includes("echo hi")) ?? "";
    // RemoteCommand=none: a host configured to launch a different login shell
    // would otherwise run that instead of the command PDV asked for.
    expect(exec).toContain("RemoteCommand=none");
    // ControlMaster=no: a stale socket must surface through the failure
    // ladder, never as a silent new connection (and an approval prompt).
    expect(exec).toContain("ControlMaster=no");
    // Quoted: ssh splits an -o value on whitespace, and PDV's socket lives
    // under a userData path that contains spaces on macOS.
    expect(exec).toContain('ControlPath="/tmp/pdv-test-sock"');
    expect(exec).toContain("RequestTTY=no");
  });

  it("only sends BatchMode when the caller is not prepared to prompt", async () => {
    const logPath = path.join(dir, "argv.log");
    setEnv("FAKE_SSH_LOG", logPath);
    await execViaSsh(control, "echo a", opts());
    await execViaSsh(control, "echo b", opts({ batchMode: false }));
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const withA = lines.find((l) => l.includes("echo a")) ?? "";
    const withB = lines.find((l) => l.includes("echo b")) ?? "";
    expect(withA).toContain("BatchMode=yes");
    expect(withB).not.toContain("BatchMode=yes");
  });
});
