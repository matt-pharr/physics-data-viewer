/**
 * julia-discovery.test.ts — Tests for Julia runtime discovery, shim bypass,
 * probing, and PDVKernel installation (§10.7).
 *
 * All filesystem paths run against temp-dir fixtures (a fake juliaup depot,
 * fake shim symlinks) and all spawns against stub shell scripts, so the suite
 * needs no Julia install.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";

import {
  checkJuliaRuntime,
  clearJuliaRuntimeCache,
  discoverDefaultJulia,
  installPDVKernel,
  listJuliaupChannels,
  probeJuliaRuntime,
  resolveJuliaShim,
  sanitizedJuliaEnv,
} from "./julia-discovery";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-disc-"));
  clearJuliaRuntimeCache();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Write an executable stub standing in for a julia binary. */
async function writeStub(relPath: string, body: string): Promise<string> {
  const stub = path.join(dir, relPath);
  await fs.mkdir(path.dirname(stub), { recursive: true });
  await fs.writeFile(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return stub;
}

/**
 * Build a fake juliaup metadata directory with one or more channels whose
 * binaries are stub scripts. Returns the juliaup dir path.
 */
async function makeJuliaupDir(options: {
  defaultChannel?: string;
  channels: Array<{
    name: string;
    version?: string; // e.g. "1.11.6+0.aarch64.apple.darwin14"
    command?: string; // linked channel
    stubBody?: string;
  }>;
}): Promise<string> {
  const juliaupDir = path.join(dir, "depot", "juliaup");
  await fs.mkdir(juliaupDir, { recursive: true });
  const installedVersions: Record<string, { Path: string }> = {};
  const installedChannels: Record<
    string,
    { Version?: string; Command?: string }
  > = {};
  for (const ch of options.channels) {
    if (ch.version) {
      const versionDir = `julia-${ch.version}`;
      installedVersions[ch.version] = { Path: `./${versionDir}` };
      installedChannels[ch.name] = { Version: ch.version };
      const bin = path.join(juliaupDir, versionDir, "bin", "julia");
      await fs.mkdir(path.dirname(bin), { recursive: true });
      await fs.writeFile(bin, `#!/bin/sh\n${ch.stubBody ?? "exit 0"}\n`, {
        mode: 0o755,
      });
    } else if (ch.command) {
      installedChannels[ch.name] = { Command: ch.command };
    }
  }
  await fs.writeFile(
    path.join(juliaupDir, "juliaup.json"),
    JSON.stringify({
      Default: options.defaultChannel ?? options.channels[0]?.name,
      InstalledVersions: installedVersions,
      InstalledChannels: installedChannels,
    })
  );
  return juliaupDir;
}

// ---------------------------------------------------------------------------
// listJuliaupChannels
// ---------------------------------------------------------------------------

describe("listJuliaupChannels()", () => {
  it("parses channels, resolves relative paths, and strips build metadata from versions", async () => {
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "release",
      channels: [
        { name: "release", version: "1.11.6+0.aarch64.apple.darwin14" },
        { name: "lts", version: "1.10.10+0.aarch64.apple.darwin14" },
      ],
    });

    const channels = listJuliaupChannels(juliaupDir);

    expect(channels).toHaveLength(2);
    const release = channels.find((c) => c.channel === "release");
    expect(release?.isDefault).toBe(true);
    expect(release?.version).toBe("1.11.6");
    expect(release?.juliaPath).toBe(
      path.join(
        juliaupDir,
        "julia-1.11.6+0.aarch64.apple.darwin14",
        "bin",
        "julia"
      )
    );
    expect(channels.find((c) => c.channel === "lts")?.isDefault).toBe(false);
  });

  it("sorts the default channel first", async () => {
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "lts",
      channels: [
        { name: "release", version: "1.11.6+0.x" },
        { name: "lts", version: "1.10.10+0.x" },
      ],
    });

    expect(listJuliaupChannels(juliaupDir)[0]?.channel).toBe("lts");
  });

  it("maps linked channels to their command path", async () => {
    const linked = await writeStub("custom/bin/julia", "exit 0");
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "release",
      channels: [
        { name: "release", version: "1.11.6+0.x" },
        { name: "mybuild", command: linked },
      ],
    });

    const mybuild = listJuliaupChannels(juliaupDir).find(
      (c) => c.channel === "mybuild"
    );
    expect(mybuild?.juliaPath).toBe(linked);
    expect(mybuild?.version).toBeNull();
  });

  it("skips channels whose binary is missing on disk", async () => {
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "release",
      channels: [{ name: "release", version: "1.11.6+0.x" }],
    });
    await fs.rm(
      path.join(juliaupDir, "julia-1.11.6+0.x", "bin", "julia")
    );

    expect(listJuliaupChannels(juliaupDir)).toEqual([]);
  });

  it("returns empty (never throws) without juliaup metadata", () => {
    expect(listJuliaupChannels(path.join(dir, "nowhere"))).toEqual([]);
  });

  it("returns empty on malformed juliaup.json", async () => {
    const juliaupDir = path.join(dir, "depot", "juliaup");
    await fs.mkdir(juliaupDir, { recursive: true });
    await fs.writeFile(path.join(juliaupDir, "juliaup.json"), "not json {");

    expect(listJuliaupChannels(juliaupDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveJuliaShim / discoverDefaultJulia
// ---------------------------------------------------------------------------

describe("resolveJuliaShim()", () => {
  it("resolves the julialauncher shim to the default channel binary", async () => {
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "release",
      channels: [{ name: "release", version: "1.11.6+0.x" }],
    });
    // ~/.juliaup/bin layout: julia -> julialauncher (symlink to real file).
    const launcher = await writeStub("shim/julialauncher", "exit 0");
    const shim = path.join(dir, "shim", "julia");
    await fs.symlink(launcher, shim);

    expect(resolveJuliaShim(shim, juliaupDir)).toBe(
      path.join(juliaupDir, "julia-1.11.6+0.x", "bin", "julia")
    );
  });

  it("returns non-shim paths unchanged", async () => {
    const real = await writeStub("real/julia", "exit 0");
    expect(resolveJuliaShim(real, path.join(dir, "no-juliaup"))).toBe(real);
  });

  it("returns the input when the shim has no juliaup metadata to resolve against", async () => {
    const launcher = await writeStub("shim2/julialauncher", "exit 0");
    const shim = path.join(dir, "shim2", "julia");
    await fs.symlink(launcher, shim);

    expect(resolveJuliaShim(shim, path.join(dir, "no-juliaup"))).toBe(shim);
  });

  it("returns the input for a nonexistent path", () => {
    const ghost = path.join(dir, "no-such-julia");
    expect(resolveJuliaShim(ghost, path.join(dir, "no-juliaup"))).toBe(ghost);
  });

  it("bypasses the shim to a LINKED default channel's command (review)", async () => {
    // `juliaup link mybuild <path>` + `juliaup default mybuild`: the default
    // channel has Command but no Version. Requiring a version here defeated
    // the bypass exactly when the user linked their default.
    const linked = await writeStub("custom/bin/julia", "exit 0");
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "mybuild",
      channels: [
        { name: "release", version: "1.11.6+0.x" },
        { name: "mybuild", command: linked },
      ],
    });
    const launcher = await writeStub("shim3/julialauncher", "exit 0");
    const shim = path.join(dir, "shim3", "julia");
    await fs.symlink(launcher, shim);

    expect(resolveJuliaShim(shim, juliaupDir)).toBe(linked);
  });

  it("refuses a default channel linked back to the shim itself", async () => {
    const launcher = await writeStub("shim4/julialauncher", "exit 0");
    const shim = path.join(dir, "shim4", "julia");
    await fs.symlink(launcher, shim);
    // Pathological: the default channel's Command IS the launcher.
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "loop",
      channels: [{ name: "loop", command: launcher }],
    });

    expect(resolveJuliaShim(shim, juliaupDir)).toBe(shim);
  });
});

describe("discoverDefaultJulia()", () => {
  it("returns the default channel binary", async () => {
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "lts",
      channels: [
        { name: "release", version: "1.11.6+0.x" },
        { name: "lts", version: "1.10.10+0.x" },
      ],
    });

    expect(discoverDefaultJulia(juliaupDir)).toBe(
      path.join(juliaupDir, "julia-1.10.10+0.x", "bin", "julia")
    );
  });

  it("returns null without juliaup", () => {
    expect(discoverDefaultJulia(path.join(dir, "nowhere"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// probeJuliaRuntime
// ---------------------------------------------------------------------------

/** Stub body emitting a full healthy probe response. */
const HEALTHY_PROBE =
  'echo "PDV_JULIA_VERSION=1.11.6"; echo "PDV_PDVKERNEL_VERSION=0.1.0"; echo "PDV_IJULIA=ok"';

describe("probeJuliaRuntime()", () => {
  it("parses version, PDVKernel version, and IJulia presence", async () => {
    const stub = await writeStub("probe/julia", HEALTHY_PROBE);

    const probe = await probeJuliaRuntime(stub);

    expect(probe).toEqual({
      juliaVersion: "1.11.6",
      pdvKernelVersion: "0.1.0",
      ijuliaInstalled: true,
    });
  });

  it("reports a bare runtime (no PDVKernel, no IJulia)", async () => {
    const stub = await writeStub(
      "probe-bare/julia",
      'echo "PDV_JULIA_VERSION=1.11.6"; echo "PDV_IJULIA=missing"'
    );

    const probe = await probeJuliaRuntime(stub);

    expect(probe?.pdvKernelVersion).toBeNull();
    expect(probe?.ijuliaInstalled).toBe(false);
  });

  it("returns null when the executable is missing or prints no version", async () => {
    expect(await probeJuliaRuntime(path.join(dir, "ghost"))).toBeNull();
    const silent = await writeStub("probe-silent/julia", "exit 0");
    expect(await probeJuliaRuntime(silent)).toBeNull();
  });

  it("returns null on a non-zero exit", async () => {
    const broken = await writeStub(
      "probe-broken/julia",
      'echo "PDV_JULIA_VERSION=1.11.6"; exit 1'
    );
    expect(await probeJuliaRuntime(broken)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sanitizedJuliaEnv (review M8)
// ---------------------------------------------------------------------------

describe("sanitizedJuliaEnv()", () => {
  it("strips JULIA_PROJECT/JULIA_LOAD_PATH and merges extras", () => {
    process.env.JULIA_PROJECT = "/cluster/user/project";
    process.env.JULIA_LOAD_PATH = "@:/cluster/user/project";
    try {
      const env = sanitizedJuliaEnv({ NO_COLOR: "1" });
      expect(env.JULIA_PROJECT).toBeUndefined();
      expect(env.JULIA_LOAD_PATH).toBeUndefined();
      expect(env.NO_COLOR).toBe("1");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.JULIA_PROJECT;
      delete process.env.JULIA_LOAD_PATH;
    }
  });

  it("probes ignore a shell-exported JULIA_PROJECT (review M8)", async () => {
    // A cluster user's exported project would otherwise redirect the probe
    // (and Pkg.develop in the installer, which uses the same env) into
    // their own Project.toml. The stub fails when either var leaks in.
    process.env.JULIA_PROJECT = "/cluster/user/project";
    try {
      const stub = await writeStub(
        "probe-clean/julia",
        '[ -z "$JULIA_PROJECT" ] || exit 3\n' +
          '[ -z "$JULIA_LOAD_PATH" ] || exit 3\n' +
          'echo "PDV_JULIA_VERSION=1.11.6"'
      );
      const probe = await probeJuliaRuntime(stub);
      expect(probe?.juliaVersion).toBe("1.11.6");
    } finally {
      delete process.env.JULIA_PROJECT;
    }
  });
});

// ---------------------------------------------------------------------------
// checkJuliaRuntime (single-path enrichment)
// ---------------------------------------------------------------------------

describe("checkJuliaRuntime()", () => {
  it("enriches a healthy probe with compatibility flags", async () => {
    const juliaupDir = await makeJuliaupDir({
      defaultChannel: "release",
      channels: [
        { name: "release", version: "1.11.6+0.x", stubBody: HEALTHY_PROBE },
      ],
    });
    const binary = path.join(juliaupDir, "julia-1.11.6+0.x", "bin", "julia");

    const info = await checkJuliaRuntime(binary, juliaupDir);

    expect(info?.kind).toBe("juliaup");
    expect(info?.channel).toBe("release");
    expect(info?.isDefault).toBe(true);
    expect(info?.juliaVersion).toBe("1.11.6");
    expect(info?.pdvKernelInstalled).toBe(true);
    expect(info?.pdvKernelVersion).toBe("0.1.0");
    expect(info?.label).toContain("juliaup: release (default)");
    // 0.1.0 vs the real app version — mismatch unless they happen to match.
    expect(typeof info?.pdvKernelCompatible).toBe("boolean");
  });

  it("classifies a non-juliaup path as configured", async () => {
    const stub = await writeStub("standalone/julia", HEALTHY_PROBE);

    const info = await checkJuliaRuntime(stub, path.join(dir, "no-juliaup"));

    expect(info?.kind).toBe("configured");
    expect(info?.label).toContain("Configured — Julia 1.11.6");
  });

  it("returns null for a broken runtime", async () => {
    expect(
      await checkJuliaRuntime(
        path.join(dir, "ghost"),
        path.join(dir, "no-juliaup")
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// installPDVKernel
// ---------------------------------------------------------------------------

describe("installPDVKernel()", () => {
  it("stages the bundled source and runs Pkg.develop + IJulia add against it", async () => {
    const stub = await writeStub("install/julia", 'echo "ARGS:$@"');
    const staging = path.join(dir, "staged", "pdv-julia");

    const result = await installPDVKernel(stub, { stagingDir: staging });

    expect(result.success).toBe(true);
    // The staged copy is a real pdv-julia source tree (dev resolution walks
    // up to the repo root).
    expect(fsSync.existsSync(path.join(staging, "Project.toml"))).toBe(true);
    expect(fsSync.existsSync(path.join(staging, "src", "PDVKernel.jl"))).toBe(
      true
    );
    expect(result.output).toContain("Pkg.develop(path=");
    expect(result.output).toContain(staging);
    expect(result.output).toContain('Pkg.add("IJulia")');
    expect(result.output).toContain("--startup-file=no");
  });

  it("replaces a previous staging directory", async () => {
    const stub = await writeStub("install2/julia", "exit 0");
    const staging = path.join(dir, "staged2", "pdv-julia");
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, "stale-file"), "old");

    const result = await installPDVKernel(stub, { stagingDir: staging });

    expect(result.success).toBe(true);
    expect(fsSync.existsSync(path.join(staging, "stale-file"))).toBe(false);
    expect(fsSync.existsSync(path.join(staging, "Project.toml"))).toBe(true);
  });

  it("reports failure with output on a non-zero exit", async () => {
    const stub = await writeStub(
      "install3/julia",
      'echo "ERROR: Unsatisfiable requirements" >&2; exit 1'
    );

    const result = await installPDVKernel(stub, {
      stagingDir: path.join(dir, "staged3", "pdv-julia"),
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unsatisfiable requirements");
  });

  it("resolves (never rejects) when the executable does not exist", async () => {
    const result = await installPDVKernel(path.join(dir, "ghost"), {
      stagingDir: path.join(dir, "staged4", "pdv-julia"),
    });

    expect(result.success).toBe(false);
  });
});
