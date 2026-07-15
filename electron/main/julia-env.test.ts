/**
 * julia-env.test.ts — Tests for the Pkg-mode environment runner (§10.6).
 *
 * `instantiateJuliaEnvironment` is exercised against stub executables (shell
 * scripts standing in for `julia`) so the streaming/version-capture/failure
 * contracts are covered without a Julia install.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  instantiateJuliaEnvironment,
  juliaPackageSpecExpr,
  listJuliaProjectPackages,
  parseJuliaVersion,
  readManifestJuliaVersion,
} from "./julia-env";

describe("juliaPackageSpecExpr()", () => {
  it("wraps a bare name in a PackageSpec", () => {
    expect(juliaPackageSpecExpr("DataFrames")).toBe(
      'Pkg.PackageSpec(name="DataFrames")'
    );
  });

  it("translates a Name@version pin (Pkg.add(::String) rejects @)", () => {
    expect(juliaPackageSpecExpr("CSV@1.6")).toBe(
      'Pkg.PackageSpec(name="CSV", version="1.6")'
    );
  });
});

describe("parseJuliaVersion()", () => {
  it("extracts the version from the marker line", () => {
    expect(parseJuliaVersion("PDV_JULIA_VERSION=1.11.6\n  Installing...\n")).toBe("1.11.6");
  });

  it("keeps prerelease/build suffixes", () => {
    expect(parseJuliaVersion("PDV_JULIA_VERSION=1.12.0-rc1\n")).toBe("1.12.0-rc1");
  });

  it("returns undefined when the marker is absent (spawn failed early)", () => {
    expect(parseJuliaVersion("ERROR: could not load Pkg\n")).toBeUndefined();
  });
});

describe("instantiateJuliaEnvironment()", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-env-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Write an executable stub standing in for the julia binary. */
  async function writeStub(name: string, body: string): Promise<string> {
    const stub = path.join(dir, name);
    await fs.writeFile(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return stub;
  }

  it("captures output and the Julia version on success", async () => {
    const stub = await writeStub(
      "julia-ok",
      'echo "PDV_JULIA_VERSION=1.11.6"; echo "  No Changes to Manifest.toml"',
    );

    const result = await instantiateJuliaEnvironment(dir, stub);

    expect(result.success).toBe(true);
    expect(result.juliaVersion).toBe("1.11.6");
    expect(result.output).toContain("No Changes to Manifest.toml");
  });

  it("reports failure with the streamed output on a non-zero exit", async () => {
    const stub = await writeStub(
      "julia-fail",
      'echo "PDV_JULIA_VERSION=1.11.6"; echo "ERROR: Unsatisfiable requirements" >&2; exit 1',
    );

    const result = await instantiateJuliaEnvironment(dir, stub);

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unsatisfiable requirements");
    // The version prints before the instantiate, so it survives failures.
    expect(result.juliaVersion).toBe("1.11.6");
  });

  it("resolves (never rejects) when the executable does not exist", async () => {
    const result = await instantiateJuliaEnvironment(dir, path.join(dir, "no-such-julia"));

    expect(result.success).toBe(false);
    expect(result.juliaVersion).toBeUndefined();
  });

  it("passes --project=<workingDir> to the subprocess", async () => {
    const stub = await writeStub("julia-args", 'echo "$@"');

    const result = await instantiateJuliaEnvironment(dir, stub);

    expect(result.success).toBe(true);
    expect(result.output).toContain(`--project=${dir}`);
    expect(result.output).toContain("--startup-file=no");
  });

  it("runs Pkg.add with initial packages for a new project (§10.6.5)", async () => {
    const stub = await writeStub("julia-pkgs", 'echo "$@"');

    const result = await instantiateJuliaEnvironment(dir, stub, {
      packages: ["DataFrames", "CSV@1.6"],
    });

    expect(result.output).toContain(
      'Pkg.add([Pkg.PackageSpec(name="DataFrames"), Pkg.PackageSpec(name="CSV", version="1.6")])'
    );
    expect(result.output).not.toContain("Pkg.instantiate()");
  });
});

describe("listJuliaProjectPackages() (§10.6.8)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-pkgs-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("pairs [deps] names with compat bounds and manifest versions, sorted", async () => {
    await fs.writeFile(
      path.join(dir, "Project.toml"),
      [
        "[deps]",
        'NPZ = "15e1cf62-19bd-5c73-a2f2-91e7b3e1f5c8"',
        'DataFrames = "a93c6f00-e57d-5684-b7b6-d8193f3e46c0"',
        'LinearAlgebra = "37e2e46d-f89d-539d-b4ee-838fcccc9c8e"',
        "",
        "[compat]",
        'DataFrames = "1.6"',
      ].join("\n")
    );
    await fs.writeFile(
      path.join(dir, "Manifest.toml"),
      [
        'julia_version = "1.11.6"',
        'manifest_format = "2.0"',
        "",
        "[[deps.DataFrames]]",
        'uuid = "a93c6f00-e57d-5684-b7b6-d8193f3e46c0"',
        'version = "1.7.0"',
        "",
        "[[deps.NPZ]]",
        'uuid = "15e1cf62-19bd-5c73-a2f2-91e7b3e1f5c8"',
        'version = "0.4.3"',
        "",
        "[[deps.LinearAlgebra]]",
        'uuid = "37e2e46d-f89d-539d-b4ee-838fcccc9c8e"',
      ].join("\n")
    );

    const packages = await listJuliaProjectPackages(dir);

    expect(packages).toEqual([
      { name: "DataFrames", spec: "DataFrames 1.6", installedVersion: "1.7.0" },
      // Stdlib entries carry no version in the manifest.
      { name: "LinearAlgebra", spec: "LinearAlgebra", installedVersion: undefined },
      { name: "NPZ", spec: "NPZ", installedVersion: "0.4.3" },
    ]);
  });

  it("lists declared deps with no versions when the manifest is missing", async () => {
    await fs.writeFile(
      path.join(dir, "Project.toml"),
      '[deps]\nNPZ = "15e1cf62-19bd-5c73-a2f2-91e7b3e1f5c8"\n'
    );

    const packages = await listJuliaProjectPackages(dir);

    expect(packages).toEqual([
      { name: "NPZ", spec: "NPZ", installedVersion: undefined },
    ]);
  });

  it("returns empty for a missing or empty Project.toml", async () => {
    expect(await listJuliaProjectPackages(dir)).toEqual([]);
    await fs.writeFile(path.join(dir, "Project.toml"), "");
    expect(await listJuliaProjectPackages(dir)).toEqual([]);
  });

  it("returns empty (never throws) on malformed TOML", async () => {
    await fs.writeFile(path.join(dir, "Project.toml"), "[deps\nbroken");
    expect(await listJuliaProjectPackages(dir)).toEqual([]);
  });

  it("survives a malformed manifest (versions just stay undefined)", async () => {
    await fs.writeFile(
      path.join(dir, "Project.toml"),
      '[deps]\nNPZ = "15e1cf62-19bd-5c73-a2f2-91e7b3e1f5c8"\n'
    );
    await fs.writeFile(path.join(dir, "Manifest.toml"), "not [ toml");

    const packages = await listJuliaProjectPackages(dir);

    expect(packages).toEqual([
      { name: "NPZ", spec: "NPZ", installedVersion: undefined },
    ]);
  });
});

describe("readManifestJuliaVersion() (§10.7.5)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-manifest-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads the top-level julia_version", async () => {
    await fs.writeFile(
      path.join(dir, "Manifest.toml"),
      'julia_version = "1.10.4"\nmanifest_format = "2.0"\n\n[[deps.NPZ]]\nversion = "0.4.3"\n'
    );
    expect(await readManifestJuliaVersion(dir)).toBe("1.10.4");
  });

  it("returns null when the manifest is missing, malformed, or predates the field", async () => {
    expect(await readManifestJuliaVersion(dir)).toBeNull();

    await fs.writeFile(path.join(dir, "Manifest.toml"), "not [ toml");
    expect(await readManifestJuliaVersion(dir)).toBeNull();

    await fs.writeFile(path.join(dir, "Manifest.toml"), 'manifest_format = "2.0"\n');
    expect(await readManifestJuliaVersion(dir)).toBeNull();
  });
});
