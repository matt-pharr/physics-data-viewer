/**
 * uv-environment.ts — Per-project uv environment orchestration.
 *
 * Sits one layer above `uv-runner`: given a project working directory that
 * already holds `pyproject.toml` (and usually `uv.lock`), it materializes the
 * `.venv`, installs the app-managed `pdv-python` wheel into it, and resolves
 * the venv's interpreter path so the kernel can be launched against it.
 *
 * Responsibilities:
 *  - `materializeUvEnvironment()` — run `uv sync`, then install `pdv-python`
 *    (ARCHITECTURE.md §10.5.7), returning the venv interpreter or a failure.
 *  - `venvPythonPath()` — the platform-specific path to the venv interpreter.
 *  - Developer mode (§10.5.16): a `.pdv-dev` repo-root marker installs
 *    `pdv-python` editable from the repo checkout instead of from the wheel,
 *    so a contributor's edits to `pdv-python/` take effect live.
 *
 * What this file does NOT do:
 *  - It does not spawn `uv` directly — every invocation goes through
 *    `uv-runner`.
 *  - It does not own kernel startup or working-directory creation; the
 *    kernel-start path calls in here before spawning the kernel.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §10.5.7 (pdv-python handling), §10.5.9 (project open flow),
 * §10.5.16 (developer mode)
 */

import * as path from "path";
import * as fs from "fs";

import { EnvironmentDetector } from "./environment-detector";
import { runUv, uvSync, uvPipInstall, type UvRunOptions } from "./uv-runner";

/** Repo-root marker file that switches PDV into editable-`pdv-python` dev mode. */
const DEV_MARKER = ".pdv-dev";

/** Result of materializing a per-project uv environment. */
export interface UvEnvironmentResult {
  /** True when the venv is ready and `pdv-python` is importable. */
  success: boolean;
  /** Absolute path to the venv's Python interpreter (present on success). */
  venvPython?: string;
  /** Combined uv output — the diagnostic shown on failure. */
  output: string;
  /** Which step failed, for the Retry/Cancel UI. Absent on success. */
  failedStep?: "sync" | "pdv-python";
}

/** Options for {@link materializeUvEnvironment}. */
export interface MaterializeUvOptions extends UvRunOptions {
  /** Requested Python version (e.g. `"3.12"`), forwarded to `uv sync`. */
  pythonVersion?: string;
}

/**
 * Compute the path to a venv's Python interpreter.
 *
 * @param workingDir - The project working directory containing `.venv/`.
 * @returns Absolute path to the venv interpreter for the current platform.
 */
export function venvPythonPath(workingDir: string): string {
  return process.platform === "win32"
    ? path.join(workingDir, ".venv", "Scripts", "python.exe")
    : path.join(workingDir, ".venv", "bin", "python");
}

/**
 * Detect PDV developer mode — the presence of a `.pdv-dev` marker file at the
 * repository root (ARCHITECTURE.md §10.5.16).
 *
 * A packaged app has no repo root, so the upward walk simply finds no marker
 * and this returns false.
 *
 * @returns True when running from a checkout marked with `.pdv-dev`.
 */
export function isDeveloperMode(): boolean {
  for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, DEV_MARKER))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the `pdv-python/` project directory used for the editable install
 * in developer mode.
 *
 * @returns The `pdv-python/` directory, or null when it cannot be located.
 */
export function developerPdvPythonPath(): string | null {
  return EnvironmentDetector.resolveBundledPDVPath();
}

/**
 * Materialize a project's uv environment: `uv sync` to build `.venv`, then
 * install the app-managed `pdv-python` wheel into it (§10.5.7, §10.5.9).
 *
 * In developer mode the wheel install is skipped — the caller is expected to
 * put an editable `pdv-python` on `PYTHONPATH` instead (see
 * {@link developerPdvPythonPath}).
 *
 * @param workingDir - Project working directory containing `pyproject.toml`.
 * @param opts - Run options; `pythonVersion` is forwarded to `uv sync`.
 * @returns A {@link UvEnvironmentResult}. Never rejects — failures are
 *   reported via `success: false` with `output` and `failedStep` populated.
 * @throws {import("./uv-runner").UvBinaryNotFoundError} When no `uv` binary
 *   can be located.
 */
export async function materializeUvEnvironment(
  workingDir: string,
  opts: MaterializeUvOptions = {}
): Promise<UvEnvironmentResult> {
  const { pythonVersion, ...runOpts } = opts;

  const sync = await uvSync({ ...runOpts, cwd: workingDir, pythonVersion });
  if (!sync.success) {
    return { success: false, output: sync.output, failedStep: "sync" };
  }

  const venvPython = venvPythonPath(workingDir);

  // Install pdv-python into the venv: the bundled wheel in production, or an
  // editable install from the repo checkout in developer mode (§10.5.7,
  // §10.5.16). Either way pdv-python's own dependencies (ipykernel, numpy, …)
  // are resolved into the venv so the kernel can launch.
  let install;
  if (isDeveloperMode()) {
    const devDir = developerPdvPythonPath();
    if (!devDir) {
      return {
        success: false,
        output: `${sync.output}\nCould not locate the pdv-python source for developer mode.`,
        failedStep: "pdv-python",
      };
    }
    install = await runUv(
      ["pip", "install", "--python", venvPython, "-e", devDir],
      { ...runOpts, cwd: workingDir }
    );
  } else {
    const wheel = EnvironmentDetector.resolveBundledPDVWheelPath();
    if (!wheel) {
      return {
        success: false,
        output: `${sync.output}\nCould not locate the bundled pdv-python wheel.`,
        failedStep: "pdv-python",
      };
    }
    install = await uvPipInstall(venvPython, wheel, { ...runOpts, cwd: workingDir });
  }

  if (!install.success) {
    return {
      success: false,
      output: `${sync.output}\n${install.output}`,
      failedStep: "pdv-python",
    };
  }

  return { success: true, venvPython, output: `${sync.output}\n${install.output}` };
}
