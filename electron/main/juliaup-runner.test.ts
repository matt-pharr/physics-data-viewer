/**
 * juliaup-runner.test.ts — Tests for juliaup binary discovery, `juliaup add`
 * acquisition, the official-installer bootstrap, and the load-time Julia
 * version assessment (§10.7.5).
 *
 * All filesystem paths run against temp-dir fixtures and all spawns against
 * stub shell scripts (a fake `juliaup`, a fake `curl` feeding the installer
 * pipeline), so the suite needs no juliaup install and never touches the
 * network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import type { BrowserWindow } from "electron";

import {
  JULIAUP_INSTALL_COMMAND,
  checkJuliaVersionForLoad,
  ensureJuliaVersionReady,
  findJuliaupBinary,
  installJuliaup,
  juliaMinor,
  juliaupAdd,
  juliaupStatus,
} from "./juliaup-runner";
import { getAppVersion } from "./pdv-protocol";

let dir: string;
const origPath = process.env.PATH;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-juliaup-"));
});

afterEach(async () => {
  process.env.PATH = origPath;
  await fs.rm(dir, { recursive: true, force: true });
});

/** Write an executable stub script and return its absolute path. */
async function writeStub(relPath: string, body: string): Promise<string> {
  const stub = path.join(dir, relPath);
  await fs.mkdir(path.dirname(stub), { recursive: true });
  await fs.writeFile(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return stub;
}

/** Fake juliaup metadata dir with version-bearing channels (§10.7.1 shape). */
async function makeJuliaupDir(
  channels: Array<{ name: string; version: string }>
): Promise<string> {
  const juliaupDir = path.join(dir, "depot", "juliaup");
  await fs.mkdir(juliaupDir, { recursive: true });
  const installedVersions: Record<string, { Path: string }> = {};
  const installedChannels: Record<string, { Version: string }> = {};
  for (const ch of channels) {
    const versionDir = `julia-${ch.version}`;
    installedVersions[ch.version] = { Path: `./${versionDir}` };
    installedChannels[ch.name] = { Version: ch.version };
    const bin = path.join(juliaupDir, versionDir, "bin", "julia");
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  await fs.writeFile(
    path.join(juliaupDir, "juliaup.json"),
    JSON.stringify({
      Default: channels[0]?.name,
      InstalledVersions: installedVersions,
      InstalledChannels: installedChannels,
    })
  );
  return juliaupDir;
}

/** Minimal BrowserWindow double capturing webContents.send calls. */
function makeWin(): { win: BrowserWindow; sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push([channel, payload]);
      },
    },
  } as unknown as BrowserWindow;
  return { win, sent };
}

// ---------------------------------------------------------------------------
// findJuliaupBinary / juliaupStatus
// ---------------------------------------------------------------------------

describe("findJuliaupBinary()", () => {
  it("finds ~/.juliaup/bin/juliaup when PATH has none", async () => {
    process.env.PATH = path.join(dir, "empty-bin");
    const home = path.join(dir, "home");
    const stub = await writeStub("home/.juliaup/bin/juliaup", "exit 0");

    expect(findJuliaupBinary(home)).toBe(stub);
    expect(juliaupStatus(home)).toEqual({ installed: true, juliaupPath: stub });
  });

  it("prefers a PATH hit over the home-dir install", async () => {
    const onPath = await writeStub("path-bin/juliaup", "exit 0");
    await writeStub("home/.juliaup/bin/juliaup", "exit 0");
    process.env.PATH = path.dirname(onPath);

    expect(findJuliaupBinary(path.join(dir, "home"))).toBe(onPath);
  });

  it("returns null (status not installed) when juliaup is nowhere", async () => {
    process.env.PATH = path.join(dir, "empty-bin");
    const home = path.join(dir, "empty-home");
    await fs.mkdir(home, { recursive: true });

    expect(findJuliaupBinary(home)).toBeNull();
    expect(juliaupStatus(home)).toEqual({ installed: false, juliaupPath: null });
  });
});

// ---------------------------------------------------------------------------
// juliaupAdd
// ---------------------------------------------------------------------------

describe("juliaupAdd()", () => {
  it("runs `juliaup add <channel>` and streams ANSI-stripped output", async () => {
    const stub = await writeStub(
      "bin/juliaup",
      'echo "adding $2"; printf \'\\033[92minstalled\\033[0m\\n\''
    );
    const { win, sent } = makeWin();

    const result = await juliaupAdd("1.10", {
      binaryPath: stub,
      win,
      pushChannel: "test:installOutput",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("adding 1.10");
    expect(result.output).toContain("installed");
    expect(result.output).not.toContain("[");
    // Streamed chunks arrive plain on the push channel too.
    const streamed = sent.map(([, p]) => (p as { data: string }).data).join("");
    expect(streamed).toContain("installed");
    expect(streamed).not.toContain("[");
  });

  it("maps a non-zero exit to success:false with the captured output", async () => {
    const stub = await writeStub(
      "bin/juliaup",
      'echo "ERROR: unknown channel" >&2; exit 1'
    );

    const result = await juliaupAdd("nope", { binaryPath: stub });

    expect(result.success).toBe(false);
    expect(result.output).toContain("unknown channel");
  });

  it("rejects a malformed channel without spawning", async () => {
    const result = await juliaupAdd("1.10; rm -rf /", {
      binaryPath: path.join(dir, "never-created"),
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Not a valid juliaup channel");
  });

  it("resolves success:false when juliaup is not installed at all", async () => {
    process.env.PATH = path.join(dir, "empty-bin");
    const home = path.join(dir, "empty-home");
    await fs.mkdir(home, { recursive: true });

    const result = await juliaupAdd("1.10", { homeDir: home });

    expect(result.success).toBe(false);
    expect(result.output).toContain("juliaup is not installed");
  });

  it("resolves success:false on a spawn failure (binary missing)", async () => {
    const result = await juliaupAdd("1.10", {
      binaryPath: path.join(dir, "missing", "juliaup"),
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// installJuliaup
// ---------------------------------------------------------------------------

describe("installJuliaup()", () => {
  it("runs the official installer pipeline (stubbed curl feeds sh)", async () => {
    // The real command is `curl -fsSL <url> | sh -s -- --yes`; the stub curl
    // emits a script instead of downloading, exercising the actual pipeline.
    const curl = await writeStub(
      "installer-bin/curl",
      "echo 'echo juliaup installer ran with' \"$@\""
    );

    const result = await installJuliaup({
      env: { PATH: `${path.dirname(curl)}:/bin:/usr/bin` },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("juliaup installer ran");
  });

  it("refuses on Windows with Microsoft Store guidance", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const result = await installJuliaup();
      expect(result.success).toBe(false);
      expect(result.output).toContain("Microsoft Store");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("pins the documented installer command (what the UI promises)", () => {
    expect(JULIAUP_INSTALL_COMMAND).toBe(
      "curl -fsSL https://install.julialang.org | sh -s -- --yes"
    );
  });
});

// ---------------------------------------------------------------------------
// juliaMinor / checkJuliaVersionForLoad
// ---------------------------------------------------------------------------

describe("ensureJuliaVersionReady()", () => {
  /** Probe stub body reporting a launch-ready runtime for the app version. */
  const readyProbeBody = [
    'echo "PDV_JULIA_VERSION=1.10.4"',
    `echo "PDV_PDVKERNEL_VERSION=${getAppVersion()}"`,
    'echo "PDV_IJULIA=ok"',
  ].join("; ");

  it("returns the installed channel's binary when it is already ready", async () => {
    const juliaupDir = path.join(dir, "depot", "juliaup");
    await fs.mkdir(path.join(juliaupDir, "julia-1.10.4", "bin"), { recursive: true });
    const bin = path.join(juliaupDir, "julia-1.10.4", "bin", "julia");
    await fs.writeFile(bin, `#!/bin/sh\n${readyProbeBody}\n`, { mode: 0o755 });
    await fs.writeFile(
      path.join(juliaupDir, "juliaup.json"),
      JSON.stringify({
        Default: "1.10",
        InstalledVersions: { "1.10.4": { Path: "./julia-1.10.4" } },
        InstalledChannels: { "1.10": { Version: "1.10.4" } },
      })
    );

    const result = await ensureJuliaVersionReady("1.10", {
      stagingDir: path.join(dir, "staging"),
      juliaupDir,
    });

    expect(result).toBe(bin);
    // Nothing was staged — no install was needed.
    expect(fsSyncExists(path.join(dir, "staging"))).toBe(false);
  });

  it("acquires a missing version via juliaup add, then returns its binary", async () => {
    const juliaupDir = path.join(dir, "depot", "juliaup");
    await fs.mkdir(juliaupDir, { recursive: true });
    await fs.writeFile(
      path.join(juliaupDir, "juliaup.json"),
      JSON.stringify({ Default: null, InstalledVersions: {}, InstalledChannels: {} })
    );
    // Stub juliaup whose `add` materializes the channel: binary + metadata.
    const binDir = path.join(juliaupDir, "julia-1.10.9", "bin");
    const afterJson = JSON.stringify({
      Default: "1.10",
      InstalledVersions: { "1.10.9": { Path: "./julia-1.10.9" } },
      InstalledChannels: { "1.10": { Version: "1.10.9" } },
    });
    const juliaup = await writeStub(
      "bin/juliaup",
      [
        `mkdir -p ${JSON.stringify(binDir)}`,
        `printf '#!/bin/sh\\n${readyProbeBody.replace(/"/g, '\\"')}\\n' > ${JSON.stringify(path.join(binDir, "julia"))}`,
        `chmod +x ${JSON.stringify(path.join(binDir, "julia"))}`,
        `printf '%s' '${afterJson}' > ${JSON.stringify(path.join(juliaupDir, "juliaup.json"))}`,
        'echo "installed channel $2"',
      ].join("\n")
    );

    const result = await ensureJuliaVersionReady("1.10", {
      stagingDir: path.join(dir, "staging"),
      juliaupDir,
      binaryPath: juliaup,
    });

    expect(result).toBe(path.join(binDir, "julia"));
  });

  it("throws when the version is missing and juliaup is not installed", async () => {
    process.env.PATH = path.join(dir, "empty-bin");
    const juliaupDir = path.join(dir, "no-depot");
    const home = path.join(dir, "empty-home");
    await fs.mkdir(home, { recursive: true });

    await expect(
      ensureJuliaVersionReady("1.10", {
        stagingDir: path.join(dir, "staging"),
        juliaupDir,
        homeDir: home,
      })
    ).rejects.toThrow(/juliaup was not found/);
  });

  it("installs PDVKernel into a channel whose default env lacks it", async () => {
    const juliaupDir = path.join(dir, "depot", "juliaup");
    await fs.mkdir(path.join(juliaupDir, "julia-1.10.4", "bin"), { recursive: true });
    const bin = path.join(juliaupDir, "julia-1.10.4", "bin", "julia");
    // Probe reports Julia + IJulia but no PDVKernel; any other invocation
    // (the install's `Pkg.develop` code) just exits 0.
    await fs.writeFile(
      bin,
      '#!/bin/sh\necho "PDV_JULIA_VERSION=1.10.4"; echo "PDV_IJULIA=ok"\n',
      { mode: 0o755 }
    );
    await fs.writeFile(
      path.join(juliaupDir, "juliaup.json"),
      JSON.stringify({
        Default: "1.10",
        InstalledVersions: { "1.10.4": { Path: "./julia-1.10.4" } },
        InstalledChannels: { "1.10": { Version: "1.10.4" } },
      })
    );
    const stagingDir = path.join(dir, "staging", "pdv-julia");

    const result = await ensureJuliaVersionReady("1.10", {
      stagingDir,
      juliaupDir,
    });

    expect(result).toBe(bin);
    // The install ran: bundled pdv-julia was staged for Pkg.develop.
    expect(fsSyncExists(path.join(stagingDir, "Project.toml"))).toBe(true);
  });
});

/** Shorthand used by the ensure tests. */
function fsSyncExists(p: string): boolean {
  return fsSync.existsSync(p);
}

describe("juliaMinor()", () => {
  it("extracts major.minor from full and partial versions", () => {
    expect(juliaMinor("1.10.4")).toBe("1.10");
    expect(juliaMinor("1.10")).toBe("1.10");
    expect(juliaMinor("1.11.0-rc1")).toBe("1.11");
    expect(juliaMinor("1.11.6+0.aarch64")).toBe("1.11");
  });

  it("returns null for non-version strings", () => {
    expect(juliaMinor("nightly")).toBeNull();
    expect(juliaMinor("")).toBeNull();
  });
});

describe("checkJuliaVersionForLoad()", () => {
  async function makeSaveDir(manifestBody: string | null): Promise<string> {
    const saveDir = path.join(dir, "save");
    await fs.mkdir(saveDir, { recursive: true });
    if (manifestBody !== null) {
      await fs.writeFile(path.join(saveDir, "Manifest.toml"), manifestBody, "utf8");
    }
    return saveDir;
  }

  it("returns undefined when the manifest minor matches the running session", async () => {
    const saveDir = await makeSaveDir('julia_version = "1.11.2"\n');

    expect(
      await checkJuliaVersionForLoad(saveDir, "1.11.6", {
        juliaupDir: path.join(dir, "no-depot"),
      })
    ).toBeUndefined();
  });

  it("returns undefined when the manifest is missing or has no julia_version", async () => {
    const noManifest = await makeSaveDir(null);
    expect(await checkJuliaVersionForLoad(noManifest, "1.11.6")).toBeUndefined();

    const noVersion = await makeSaveDir('manifest_format = "2.0"\n');
    expect(await checkJuliaVersionForLoad(noVersion, "1.11.6")).toBeUndefined();
  });

  it("reports an installed matching channel on a minor mismatch", async () => {
    const saveDir = await makeSaveDir('julia_version = "1.10.4"\n');
    const juliaupDir = await makeJuliaupDir([
      { name: "release", version: "1.11.6+0.aarch64.apple.darwin14" },
      { name: "lts", version: "1.10.10+0.aarch64.apple.darwin14" },
    ]);
    const home = path.join(dir, "home");
    await writeStub("home/.juliaup/bin/juliaup", "exit 0");

    const check = await checkJuliaVersionForLoad(saveDir, "1.11.6", {
      juliaupDir,
      homeDir: home,
    });

    expect(check).toEqual({
      manifestVersion: "1.10.4",
      channel: "1.10",
      runningVersion: "1.11.6",
      channelInstalled: true,
      juliaupInstalled: true,
    });
  });

  it("flags a missing channel (the renderer's juliaup-add offer)", async () => {
    process.env.PATH = path.join(dir, "empty-bin");
    const saveDir = await makeSaveDir('julia_version = "1.9.3"\n');
    const juliaupDir = await makeJuliaupDir([
      { name: "release", version: "1.11.6+0.aarch64.apple.darwin14" },
    ]);
    const home = path.join(dir, "empty-home");
    await fs.mkdir(home, { recursive: true });

    const check = await checkJuliaVersionForLoad(saveDir, "1.11.6", {
      juliaupDir,
      homeDir: home,
    });

    expect(check).toMatchObject({
      manifestVersion: "1.9.3",
      channel: "1.9",
      channelInstalled: false,
      juliaupInstalled: false,
    });
  });
});
