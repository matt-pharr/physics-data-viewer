/**
 * remote-launchers.test.ts — Unit tests for the remote launcher spawn
 * builders. Pure-function suite in the editor-spawn.test.ts style: no
 * mocks, explicit inputs, exact argv assertions.
 */

import { describe, expect, it } from "vitest";

import {
  buildSshLauncherCommand,
  remoteLoginShellCommand,
  resolveRemoteEditorSpawn,
} from "./remote-launchers";

describe("resolveRemoteEditorSpawn", () => {
  it("routes the default command (code) through --remote", () => {
    const res = resolveRemoteEditorSpawn(undefined, {
      host: "feyn",
      targetPath: "/u/mp/proj/tree/ab12/run.py",
    });
    expect(res).toEqual({
      kind: "local-spawn",
      file: "code",
      args: ["--remote", "ssh-remote+feyn", "/u/mp/proj/tree/ab12/run.py"],
    });
  });

  // No Windows-path case here: remote sessions are gated off on the
  // Windows client (no ControlMaster), and path.basename on the POSIX
  // platforms this runs on does not split backslash separators.
  it("recognises cursor and windsurf basenames, including full paths", () => {
    for (const cmd of [
      "cursor {}",
      "windsurf {}",
      "/usr/local/bin/code {}",
    ]) {
      const res = resolveRemoteEditorSpawn(cmd, { host: "flux", targetPath: "/tmp/f.py" });
      expect(res.kind).toBe("local-spawn");
      if (res.kind === "local-spawn") {
        expect(res.args).toEqual(["--remote", "ssh-remote+flux", "/tmp/f.py"]);
      }
    }
  });

  it("keeps user flags while dropping the local {} placeholder", () => {
    const res = resolveRemoteEditorSpawn("code -n --disable-gpu {}", {
      host: "feyn",
      targetPath: "/data/x.py",
    });
    expect(res).toEqual({
      kind: "local-spawn",
      file: "code",
      args: ["-n", "--disable-gpu", "--remote", "ssh-remote+feyn", "/data/x.py"],
    });
  });

  it("turns a TUI editor into an ssh-terminal command with quoted path", () => {
    const res = resolveRemoteEditorSpawn("vim {}", {
      host: "feyn",
      targetPath: "/u/mp/has space/run.py",
    });
    expect(res).toEqual({
      kind: "ssh-terminal",
      remoteCommand: `'vim' '/u/mp/has space/run.py'`,
    });
  });

  it("honours an explicit isTuiEditor=true over basename detection", () => {
    const res = resolveRemoteEditorSpawn("my-editor {}", {
      host: "feyn",
      targetPath: "/f.py",
      isTuiEditor: true,
    });
    expect(res.kind).toBe("ssh-terminal");
  });

  it("honours an explicit isTuiEditor=false: vim without a wrap is unsupported remotely", () => {
    const res = resolveRemoteEditorSpawn("vim {}", {
      host: "feyn",
      targetPath: "/f.py",
      isTuiEditor: false,
    });
    expect(res.kind).toBe("unsupported");
  });

  it("refuses editors with no remote story, naming the alternatives", () => {
    const res = resolveRemoteEditorSpawn("subl {}", { host: "feyn", targetPath: "/f.py" });
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") {
      expect(res.message).toContain("subl");
      expect(res.message).toContain("VS Code");
      expect(res.message).toContain("remoteFileCommand");
    }
  });

  it("a config template wins over everything, substituting {host} and {path}", () => {
    const res = resolveRemoteEditorSpawn("subl {}", {
      host: "flux",
      targetPath: "/scratch/f.py",
      template: "myeditor --open ssh://{host}{path}",
    });
    expect(res).toEqual({
      kind: "local-spawn",
      file: "myeditor",
      args: ["--open", "ssh://flux/scratch/f.py"],
    });
  });

  it("appends the path when the template has no {path} placeholder", () => {
    const res = resolveRemoteEditorSpawn(undefined, {
      host: "feyn",
      targetPath: "/f.py",
      template: "myeditor --host {host}",
    });
    expect(res).toEqual({
      kind: "local-spawn",
      file: "myeditor",
      args: ["--host", "feyn", "/f.py"],
    });
  });
});

describe("buildSshLauncherCommand", () => {
  it("builds a tty channel over PDV's master with a quoted ControlPath", () => {
    const spec = buildSshLauncherCommand(
      { host: "feyn", controlPath: "/Users/mp/Library/Application Support/pdv/m-ab" },
      `'vim' '/u/f.py'`,
    );
    expect(spec.file).toBe("ssh");
    expect(spec.args).toEqual([
      "-t",
      "-o",
      "RemoteCommand=none",
      "-o",
      `ControlPath="/Users/mp/Library/Application Support/pdv/m-ab"`,
      "feyn",
      `'vim' '/u/f.py'`,
    ]);
  });

  it("omits ControlPath for a borrowed master and honours sshPath", () => {
    const spec = buildSshLauncherCommand(
      { host: "flux", controlPath: null },
      "exec bash -l",
      { sshPath: "/opt/bin/ssh" },
    );
    expect(spec.file).toBe("/opt/bin/ssh");
    expect(spec.args).toEqual(["-t", "-o", "RemoteCommand=none", "flux", "exec bash -l"]);
  });

  it("never forces BatchMode — the terminal is a place a prompt can be answered", () => {
    const spec = buildSshLauncherCommand({ host: "feyn", controlPath: null }, "true");
    expect(spec.args.join(" ")).not.toContain("BatchMode");
  });
});

describe("remoteLoginShellCommand", () => {
  it("cds with ';' so a purged dir still opens a shell, and quotes the path", () => {
    const cmd = remoteLoginShellCommand("/scratch/local/mp/pdv work");
    expect(cmd).toBe(`cd '/scratch/local/mp/pdv work'; exec "\${SHELL:-sh}" -l`);
  });

  it("goes straight to the login shell without a working dir", () => {
    expect(remoteLoginShellCommand(null)).toBe(`exec "\${SHELL:-sh}" -l`);
  });
});
