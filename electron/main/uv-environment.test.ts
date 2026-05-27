/**
 * uv-environment.test.ts — Unit tests for per-project uv environment
 * orchestration.
 *
 * Verifies that uv-environment:
 * 1. Resolves the venv interpreter path inside the working directory.
 * 2. Reports a `sync` failure when `uv sync` fails.
 * 3. Installs the bundled pdv-python wheel and resolves the venv interpreter.
 * 4. Reports a `pdv-python` failure when the wheel is missing or its install
 *    fails.
 *
 * `uv-runner` is mocked so no real `uv` binary is invoked. The tests assume
 * non-developer mode (no `.pdv-dev` marker), exercising the bundled-wheel path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "path";

import { EnvironmentDetector } from "./environment-detector";
import { materializeUvEnvironment, venvPythonPath } from "./uv-environment";
import * as uvRunner from "./uv-runner";

vi.mock("./uv-runner");

afterEach(() => {
  vi.restoreAllMocks();
});

const okResult = { success: true, output: "ok", exitCode: 0 };
const failResult = { success: false, output: "boom", exitCode: 1 };

describe("venvPythonPath", () => {
  it("points at the venv interpreter inside the working directory", () => {
    const resolved = venvPythonPath("/work");
    expect(resolved.startsWith(path.join("/work", ".venv"))).toBe(true);
    expect(resolved.endsWith("python") || resolved.endsWith("python.exe")).toBe(true);
  });
});

describe("materializeUvEnvironment", () => {
  it("reports a 'sync' failure when uv sync fails", async () => {
    vi.mocked(uvRunner.uvSync).mockResolvedValue(failResult);

    const result = await materializeUvEnvironment("/work");

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("sync");
    expect(result.output).toContain("boom");
  });

  it("installs the pdv-python wheel and resolves the venv interpreter", async () => {
    vi.mocked(uvRunner.uvSync).mockResolvedValue(okResult);
    vi.mocked(uvRunner.uvPipInstall).mockResolvedValue(okResult);
    vi.spyOn(EnvironmentDetector, "resolveBundledPDVWheelPath").mockReturnValue(
      "/bundle/pdv_python.whl"
    );

    const result = await materializeUvEnvironment("/work");

    expect(result.success).toBe(true);
    expect(result.venvPython).toBe(venvPythonPath("/work"));
    expect(uvRunner.uvPipInstall).toHaveBeenCalledWith(
      venvPythonPath("/work"),
      "/bundle/pdv_python.whl",
      expect.objectContaining({ cwd: "/work" })
    );
  });

  it("reports a 'pdv-python' failure when the bundled wheel is missing", async () => {
    vi.mocked(uvRunner.uvSync).mockResolvedValue(okResult);
    vi.spyOn(EnvironmentDetector, "resolveBundledPDVWheelPath").mockReturnValue(null);

    const result = await materializeUvEnvironment("/work");

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("pdv-python");
  });

  it("reports a 'pdv-python' failure when the wheel install fails", async () => {
    vi.mocked(uvRunner.uvSync).mockResolvedValue(okResult);
    vi.mocked(uvRunner.uvPipInstall).mockResolvedValue(failResult);
    vi.spyOn(EnvironmentDetector, "resolveBundledPDVWheelPath").mockReturnValue(
      "/bundle/pdv_python.whl"
    );

    const result = await materializeUvEnvironment("/work");

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("pdv-python");
  });

  it("forwards the requested Python version to uv sync", async () => {
    vi.mocked(uvRunner.uvSync).mockResolvedValue(okResult);
    vi.mocked(uvRunner.uvPipInstall).mockResolvedValue(okResult);
    vi.spyOn(EnvironmentDetector, "resolveBundledPDVWheelPath").mockReturnValue(
      "/bundle/pdv_python.whl"
    );

    await materializeUvEnvironment("/work", { pythonVersion: "3.12" });

    expect(uvRunner.uvSync).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/work", pythonVersion: "3.12" })
    );
  });
});
