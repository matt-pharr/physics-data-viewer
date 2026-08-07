/**
 * bootstrap.test.ts — probing a host and installing the server bundle.
 *
 * The fixture executes commands locally under `/bin/sh`, so the install
 * tests run the *real* flow — upload over stdin, `sha256sum -c`, `tar -xzf`,
 * the atomic rename, and a self-check — against a throwaway HOME. Only the
 * network is absent. That matters here more than usual: this code is a
 * sequence of shell one-liners whose quoting and ordering are exactly what
 * goes wrong, and a mocked exec would assert nothing about either.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installBundle, probeHost, remoteServerCommand, sha256File, uploadFile } from "./bootstrap";
import type { SshControl } from "./ssh-mux";
import { TEST_PDV_VERSION } from "../test-helpers";

const FAKE_SSH = path.join(__dirname, "__fixtures__", "fake-ssh.cjs");
const control: SshControl = { host: "feyn", controlPath: "/tmp/pdv-bootstrap-test.sock" };

let dir: string;
let home: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function opts(extra: Record<string, unknown> = {}) {
  return { sshPath: FAKE_SSH, version: TEST_PDV_VERSION, timeoutMs: 60_000, ...extra };
}

/**
 * Build a tarball shaped like a real bundle, with a stub `node` that emits a
 * self-check verdict — so the install path is exercised to its last step.
 */
function makeBundle(selfCheckOk = true): { tarball: string; sha256: string } {
  const stage = path.join(dir, "stage");
  fs.mkdirSync(path.join(stage, "node", "bin"), { recursive: true });
  fs.mkdirSync(path.join(stage, "node_modules", "zeromq"), { recursive: true });
  fs.writeFileSync(path.join(stage, "pdv-server.cjs"), "// server\n");
  const verdict = JSON.stringify({
    pdv: "self-check",
    ok: selfCheckOk,
    steps: [{ name: "zeromq", ok: selfCheckOk, detail: selfCheckOk ? "tcp://127.0.0.1:1" : "dlopen failed" }],
  });
  fs.writeFileSync(
    path.join(stage, "node", "bin", "node"),
    `#!/bin/sh\necho '${verdict}'\nexit ${selfCheckOk ? 0 : 1}\n`,
    { mode: 0o755 },
  );
  const tarball = path.join(dir, "bundle.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", stage, "."]);
  return { tarball, sha256: sha256File(tarball) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-bootstrap-"));
  home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  setEnv("HOME", home);
  setEnv("FAKE_SSH_EXEC", "local");
  setEnv("FAKE_SSH_MASTER", "alive");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("probeHost", () => {
  it("reports what the host is", async () => {
    const probe = await probeHost(control, opts());
    expect(probe.sys).toBe(os.platform() === "darwin" ? "Darwin" : "Linux");
    expect(probe.home).toBe(home);
    expect(probe.homeWritable).toBe(true);
    expect(probe.freeBytes).toBeGreaterThan(0);
  }, 30_000);

  it("reports an install as absent until a self-check is cached", async () => {
    expect((await probeHost(control, opts())).installed).toBe(false);
    fs.mkdirSync(path.join(home, ".pdv-server", TEST_PDV_VERSION), { recursive: true });
    fs.writeFileSync(path.join(home, ".pdv-server", TEST_PDV_VERSION, ".selfcheck.json"), "{}");
    expect((await probeHost(control, opts())).installed).toBe(true);
  }, 30_000);

  it("reports which bundle the host actually has", async () => {
    // Version alone cannot distinguish a rebuild from the build it replaced.
    // A same-version rebuild that was never reinstalled is exactly how a
    // successful connect ends in "server stream ended": the host answers with
    // a bundle that predates the subcommand the shell is about to use.
    const dir = path.join(home, ".pdv-server", TEST_PDV_VERSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".selfcheck.json"), "{}");
    fs.writeFileSync(path.join(dir, ".bundle-id"), "abc123");

    const probe = await probeHost(control, opts());
    expect(probe.installed).toBe(true);
    expect(probe.bundleId).toBe("abc123");
  }, 30_000);

  it("reports a null bundle id when the host recorded none", async () => {
    // An install from before ids were recorded. Null forces a reinstall
    // rather than being mistaken for a match.
    const dir = path.join(home, ".pdv-server", TEST_PDV_VERSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".selfcheck.json"), "{}");

    const probe = await probeHost(control, opts());
    expect(probe.installed).toBe(true);
    expect(probe.bundleId).toBeNull();
  }, 30_000);

  it("does not treat an unpacked-but-unverified directory as installed", async () => {
    // The directory exists but never passed a check. Believing it would skip
    // the install and fail later, opaquely.
    fs.mkdirSync(path.join(home, ".pdv-server", TEST_PDV_VERSION), { recursive: true });
    expect((await probeHost(control, opts())).installed).toBe(false);
  }, 30_000);

  it("survives a login banner before the reply", async () => {
    setEnv("FAKE_SSH_EXEC", "banner");
    const probe = await probeHost(control, opts());
    expect(probe.home).toBe(home);
  }, 30_000);

  it("reports an unreachable host rather than throwing", async () => {
    setEnv("FAKE_SSH_EXEC", "drop");
    setEnv("FAKE_SSH_MASTER", "absent");
    const probe = await probeHost(control, opts());
    expect(probe.ok).toBe(false);
    expect(probe.problem).toMatch(/Could not reach/);
  }, 30_000);
});

describe("uploadFile", () => {
  it("transfers a file and reports progress", async () => {
    const source = path.join(dir, "payload.bin");
    fs.writeFileSync(source, Buffer.alloc(256 * 1024, 7));
    const dest = path.join(dir, "arrived.bin");
    const seen: number[] = [];

    const ok = await uploadFile(
      control,
      source,
      dest,
      opts({ onProgress: (p: { transferred?: number }) => { if (p.transferred) seen.push(p.transferred); } }),
    );
    expect(ok).toBe(true);
    expect(fs.readFileSync(dest).equals(fs.readFileSync(source))).toBe(true);
    expect(seen.at(-1)).toBe(fs.statSync(source).size);
  }, 30_000);
});

describe("installBundle", () => {
  it("installs, verifies and self-checks", async () => {
    const { tarball, sha256 } = makeBundle();
    const stages: string[] = [];
    const result = await installBundle(
      control, tarball, sha256,
      opts({ onProgress: (p: { stage: string }) => stages.push(p.stage) }),
    );
    expect(result.ok).toBe(true);
    // Shell-expandable by design — later steps interpolate it into commands.
    expect(result.installDir).toBe(`$HOME/.pdv-server/${TEST_PDV_VERSION}`);
    expect(fs.existsSync(path.join(home, ".pdv-server", TEST_PDV_VERSION, "pdv-server.cjs"))).toBe(true);
    // The cached verdict is what lets a later connect confirm the install in
    // one round trip instead of re-running everything.
    expect(fs.existsSync(path.join(home, ".pdv-server", TEST_PDV_VERSION, ".selfcheck.json"))).toBe(true);
    expect(stages).toEqual(expect.arrayContaining(["uploading", "verifying", "installing", "checking"]));
  }, 60_000);

  it("leaves no staging or upload debris behind", async () => {
    const { tarball, sha256 } = makeBundle();
    await installBundle(control, tarball, sha256, opts());
    const leftovers = fs
      .readdirSync(path.join(home, ".pdv-server"))
      .filter((entry) => entry.startsWith(".tmp-") || entry.startsWith(".upload-"));
    expect(leftovers).toEqual([]);
  }, 60_000);

  it("refuses a tarball whose checksum does not match", async () => {
    const { tarball } = makeBundle();
    const result = await installBundle(control, tarball, "0".repeat(64), opts());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/checksum/i);
    // Nothing may be installed from an unverified transfer, and the partial
    // upload must not be left to be mistaken for a good one later.
    expect(fs.existsSync(path.join(home, ".pdv-server", TEST_PDV_VERSION))).toBe(false);
    expect(fs.readdirSync(path.join(home, ".pdv-server"))).toEqual([]);
  }, 60_000);

  it("reports a bundle that installs but cannot run", async () => {
    const { tarball, sha256 } = makeBundle(false);
    const result = await installBundle(control, tarball, sha256, opts());
    expect(result.ok).toBe(false);
    // The wording has to point at the host's libraries, not at PDV, because
    // that is the actual thing the user has to act on.
    expect(result.message).toMatch(/messaging library|do not run/i);
    // No cached verdict: a failed check must never look like a good install.
    expect(fs.existsSync(path.join(home, ".pdv-server", TEST_PDV_VERSION, ".selfcheck.json"))).toBe(false);
  }, 60_000);

  it("succeeds even when the replaced install cannot be deleted", async () => {
    // A still-running old daemon on an NFS home keeps its files open, so
    // removing the displaced install leaves .nfs* silly-rename ghosts and
    // rm exits nonzero (seen live on feyn as "Unpacking failed" AFTER the
    // new install was already in place). Simulated here with an
    // undeletable directory: old-install cleanup must be best-effort,
    // never part of the install's success.
    const { tarball, sha256 } = makeBundle();
    await installBundle(control, tarball, sha256, opts());
    const target = path.join(home, ".pdv-server", TEST_PDV_VERSION);
    const locked = path.join(target, "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "pin"), "");
    fs.chmodSync(locked, 0o555);
    try {
      const second = await installBundle(control, tarball, sha256, opts());
      expect(second.ok).toBe(true);
      // The new install is whole and in place, without the old debris.
      expect(fs.existsSync(path.join(target, "pdv-server.cjs"))).toBe(true);
      expect(fs.existsSync(locked)).toBe(false);
      // The undeletable old install was parked aside under a unique name.
      const leftovers = fs
        .readdirSync(path.join(home, ".pdv-server"))
        .filter((n) => n.startsWith(`${TEST_PDV_VERSION}.old`));
      expect(leftovers.length).toBe(1);
    } finally {
      // Unlock so afterEach teardown can delete the tree.
      for (const n of fs.readdirSync(path.join(home, ".pdv-server"))) {
        const p2 = path.join(home, ".pdv-server", n, "locked");
        if (fs.existsSync(p2)) fs.chmodSync(p2, 0o755);
      }
    }
  });

  it("replaces an existing install without leaving it half-written", async () => {
    const { tarball, sha256 } = makeBundle();
    await installBundle(control, tarball, sha256, opts());
    const marker = path.join(home, ".pdv-server", TEST_PDV_VERSION, "stale-file");
    fs.writeFileSync(marker, "from the previous version");

    const second = await installBundle(control, tarball, sha256, opts());
    expect(second.ok).toBe(true);
    // The directory was swapped wholesale, not merged into.
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(home, `.pdv-server`, `${TEST_PDV_VERSION}.old`))).toBe(false);
  }, 60_000);
});

describe("remoteServerCommand", () => {
  it("hands the server every bundled-path variable, $HOME-expanded", () => {
    // Executed under a real shell against a staged install, because the env
    // the *server process* receives is the contract — not the string. The
    // missing PDV_RESOURCES_ROOT was exactly this class of bug: the command
    // looked complete, and on a real cluster every bundled asset (uv, the
    // pdv-python wheel) was invisible, so no kernel could ever start.
    const target = path.join(home, ".pdv-server", TEST_PDV_VERSION);
    fs.mkdirSync(path.join(target, "node", "bin"), { recursive: true });
    fs.writeFileSync(path.join(target, "pdv-server.cjs"), "// server\n");
    fs.writeFileSync(
      path.join(target, "node", "bin", "node"),
      "#!/bin/sh\nenv | grep '^PDV_' | sort\npwd\n",
      { mode: 0o755 },
    );

    const out = execFileSync("/bin/sh", ["-c", remoteServerCommand(TEST_PDV_VERSION)], {
      env: { ...process.env, HOME: home },
    }).toString();

    expect(out).toContain(`PDV_APP_VERSION=${TEST_PDV_VERSION}`);
    expect(out).toContain(`PDV_ZEROMQ_PATH=${path.join(target, "node_modules", "zeromq")}`);
    expect(out).toContain(`PDV_RESOURCES_ROOT=${path.join(target, "resources")}`);
    // The trailing pwd proves the cd into the install dir took effect.
    expect(out.trim().split("\n").pop()).toBe(target);
  });
});
