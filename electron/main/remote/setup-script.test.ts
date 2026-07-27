/**
 * setup-script.test.ts — Shipping the per-host setup script.
 *
 * The write-command test executes the generated shell command through a
 * REAL `/bin/sh` with `$HOME` pointed at a temp directory and asserts the
 * exact bytes that land on disk — quoting bugs live in the gap between what
 * PDV computes and what the shell does with it, and an assertion on the
 * command string alone would test the computation against itself.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SshExecResult } from "./ssh-mux";
import { localSetupScriptPath, shipSetupScript } from "./setup-script";

const CONTROL = { host: "feyn", controlPath: "/tmp/pdv-test.sock" };

const okResult: SshExecResult = {
  ok: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  failure: null,
};

let tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-setup-script-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("localSetupScriptPath", () => {
  it("keys the master copy on the sanitized host alias", () => {
    expect(localSetupScriptPath("/d", "feyn")).toBe("/d/feyn.sh");
    expect(localSetupScriptPath("/d", "flux.pppl.gov")).toBe("/d/flux.pppl.gov.sh");
    expect(localSetupScriptPath("/d", "evil/../host name")).toBe(
      "/d/evil_.._host_name.sh",
    );
  });
});

describe("shipSetupScript", () => {
  const itUnix = it.skipIf(process.platform === "win32");

  itUnix("the generated command writes the exact script bytes under $HOME", async () => {
    const scriptDir = makeTempDir();
    const fakeHome = makeTempDir();
    // Content chosen to break naive quoting: single quotes, double quotes,
    // dollar expansion, backticks, newlines, and no trailing newline.
    const content =
      "module load python/3.12\n" +
      "export MSG='it''s \"quoted\" $HOME `here`'\n" +
      "echo done";
    fs.writeFileSync(path.join(scriptDir, "feyn.sh"), content);

    const exec = vi.fn(async (_control, command: string) => {
      const run = spawnSync("/bin/sh", ["-c", command], {
        env: { ...process.env, HOME: fakeHome },
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      return okResult;
    });

    const result = await shipSetupScript({
      control: CONTROL,
      host: "feyn",
      sessionId: "pdv-matt",
      setupScriptDir: scriptDir,
      exec,
    });

    expect(result).toEqual({ ok: true, shipped: true });
    const landed = path.join(
      fakeHome,
      ".pdv-server",
      "run",
      "sessions",
      "pdv-matt",
      "setup.sh",
    );
    expect(fs.readFileSync(landed, "utf8")).toBe(content);
    // The temp file did not survive the atomic rename.
    expect(fs.existsSync(`${landed}.tmp`)).toBe(false);
  });

  itUnix("removes the remote script when no master copy exists", async () => {
    const scriptDir = makeTempDir();
    const fakeHome = makeTempDir();
    const remoteDir = path.join(fakeHome, ".pdv-server", "run", "sessions", "pdv-matt");
    fs.mkdirSync(remoteDir, { recursive: true });
    fs.writeFileSync(path.join(remoteDir, "setup.sh"), "stale\n");

    const exec = vi.fn(async (_control, command: string) => {
      const run = spawnSync("/bin/sh", ["-c", command], {
        env: { ...process.env, HOME: fakeHome },
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      return okResult;
    });

    const result = await shipSetupScript({
      control: CONTROL,
      host: "feyn",
      sessionId: "pdv-matt",
      setupScriptDir: scriptDir,
      exec,
    });

    expect(result).toEqual({ ok: true, shipped: false });
    expect(fs.existsSync(path.join(remoteDir, "setup.sh"))).toBe(false);
  });

  it("treats a whitespace-only master copy as unconfigured", async () => {
    const scriptDir = makeTempDir();
    fs.writeFileSync(path.join(scriptDir, "feyn.sh"), "  \n\t\n");
    const exec = vi.fn(async (_control: unknown, _command: string) => okResult);
    const result = await shipSetupScript({
      control: CONTROL,
      host: "feyn",
      sessionId: "pdv-matt",
      setupScriptDir: scriptDir,
      exec,
    });
    expect(result).toEqual({ ok: true, shipped: false });
    expect(exec.mock.calls[0]?.[1]).toContain("rm -f");
  });

  it("fails loudly when a configured script cannot be delivered", async () => {
    const scriptDir = makeTempDir();
    fs.writeFileSync(path.join(scriptDir, "feyn.sh"), "module load python\n");
    const exec = vi.fn(
      async (): Promise<SshExecResult> => ({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "mkdir: cannot create directory",
        failure: null,
      }),
    );
    const result = await shipSetupScript({
      control: CONTROL,
      host: "feyn",
      sessionId: "pdv-matt",
      setupScriptDir: scriptDir,
      exec,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("feyn");
      expect(result.message).toContain("mkdir: cannot create directory");
      expect(result.message).toContain(localSetupScriptPath(scriptDir, "feyn"));
    }
  });

  it("reports success when only the removal of an unconfigured script fails", async () => {
    const scriptDir = makeTempDir();
    const exec = vi.fn(
      async (): Promise<SshExecResult> => ({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "boom",
        failure: null,
      }),
    );
    const result = await shipSetupScript({
      control: CONTROL,
      host: "feyn",
      sessionId: "pdv-matt",
      setupScriptDir: scriptDir,
      exec,
    });
    expect(result).toEqual({ ok: true, shipped: false });
  });
});
