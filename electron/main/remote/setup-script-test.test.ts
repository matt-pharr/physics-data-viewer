/**
 * setup-script-test.test.ts — the setup-script dry run, against a REAL shell.
 *
 * The generated command is executed through a real `/bin/sh` (which runs the
 * real `bash -l` inside it), because the failure modes worth catching live
 * in what the shell does with the bytes — quoting, sourcing semantics, an
 * `exit` killing the shell — not in string comparison of the command.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import type { execViaSsh, SshControl } from "./ssh-mux";
import { runSetupScriptTest } from "./setup-script-test";

const CONTROL: SshControl = { host: "testhost", controlPath: null };

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-script-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * An exec seam that runs the command on THIS machine through a real shell,
 * exactly as the remote side's shell would parse it.
 */
const localExec: typeof execViaSsh = async (_control, command) => {
  const run = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    ok: run.status === 0,
    exitCode: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    failure: null,
  };
};

describe("runSetupScriptTest against a real shell", () => {
  it("reports an interpreter the script makes visible", async () => {
    // A fake python3 in a private bin dir that only the script adds to PATH.
    const dir = tempDir();
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const shim = path.join(bin, "python3");
    fs.writeFileSync(shim, "#!/bin/sh\necho Fake Python 9.9.9\n", { mode: 0o755 });

    const result = await runSetupScriptTest({
      control: CONTROL,
      content: `export PATH="${bin}:$PATH"\n`,
      exec: localExec,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const after = result.after.find((i) => i.name === "python3");
    expect(after?.path).toBe(shim);
    expect(after?.version).toBe("Fake Python 9.9.9");
    // The baseline must NOT see the shim — the diff is the whole report.
    const before = result.before.find((i) => i.name === "python3");
    expect(before?.path).not.toBe(shim);
    // Both lists cover the same interpreters, in order.
    expect(result.before.map((i) => i.name)).toEqual(result.after.map((i) => i.name));
  });

  it("captures the script's own output and its exit status", async () => {
    const result = await runSetupScriptTest({
      control: CONTROL,
      content: "echo module loaded ok\necho warning: no gpu >&2\nfalse\n",
      exec: localExec,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("module loaded ok");
    expect(result.output).toContain("warning: no gpu");
  });

  it("passes quoting-hostile content through byte-exact", async () => {
    // The script prints a quoted heredoc of hostile text. If any quoting
    // layer between here and the shell broke, the `$(...)`/backtick text
    // would execute (or the heredoc would mangle) instead of printing.
    const hostile = "it's \"$(echo dangerous)\" `echo hostile` $HOME";
    const result = await runSetupScriptTest({
      control: CONTROL,
      content: `cat <<'PDVEOF'\n${hostile}\nPDVEOF\n`,
      exec: localExec,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(hostile);
    expect(result.output).not.toContain("it's \"dangerous\"");
  });

  it("explains an `exit` line instead of reporting garbage", async () => {
    const result = await runSetupScriptTest({
      control: CONTROL,
      content: "echo about to bail\nexit 0\necho never reached\n",
      exec: localExec,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/exit/);
    expect(result.message).toMatch(/sourced/);
  });

  it("normalizes CRLF before the content reaches the shell", async () => {
    const result = await runSetupScriptTest({
      control: CONTROL,
      content: "echo first\r\necho second\r\n",
      exec: localExec,
    });
    expect(result.exitCode).toBe(0);
    // A shipped `\r` would embed itself in the output as `first\r`.
    expect(result.output).toContain("first");
    expect(result.output).not.toMatch(/first\r/);
  });

  it("reports a transport failure as a message, not a throw", async () => {
    const deadExec: typeof execViaSsh = async () => ({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "Connection closed by remote host",
      failure: "master-lost",
    });
    const result = await runSetupScriptTest({
      control: CONTROL,
      content: "echo hi\n",
      exec: deadExec,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.message).toContain("Connection closed");
  });

  it("survives login-shell chatter around the markers", async () => {
    // Chatter is prepended by the exec seam rather than a doctored profile:
    // what matters is that parsing keys on markers, not on position.
    const chattyExec: typeof execViaSsh = async (control, command) => {
      const run = await localExec(control, command, {});
      return {
        ...run,
        stdout: `Welcome to the cluster!\nLmod: loading defaults\n${run.stdout}`,
      };
    };
    const result = await runSetupScriptTest({
      control: CONTROL,
      content: "echo payload\n",
      exec: chattyExec,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("payload");
    expect(result.output).not.toContain("Welcome to the cluster");
  });
});
