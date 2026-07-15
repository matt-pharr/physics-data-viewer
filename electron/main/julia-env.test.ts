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

import { instantiateJuliaEnvironment, parseJuliaVersion } from "./julia-env";

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
});
