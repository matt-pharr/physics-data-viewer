/**
 * python-versions.ts — Supported Python version range for PDV projects.
 *
 * Single source of truth for the CPython versions the New Project dialog
 * offers and `kernels.start` accepts for uv-managed projects. The range must
 * track `requires-python` in `pdv-python/pyproject.toml` (floor) and the
 * newest CPython pdv-python is tested against (ceiling).
 *
 * This file does NOT probe interpreters or talk to uv — it is pure constants
 * plus a version-string parser, safe to import from both the main process and
 * the preload script (the constants are re-exposed to the renderer as static
 * values under `window.pdv.system`).
 */

/**
 * CPython minor versions supported for uv-managed PDV projects, oldest first.
 * Keep in sync with `requires-python = ">=3.10"` in pdv-python/pyproject.toml.
 */
export const SUPPORTED_PYTHON_VERSIONS: readonly string[] = [
  "3.10",
  "3.11",
  "3.12",
  "3.13",
  "3.14",
];

/**
 * Default Python version preselected in the New Project dialog. One behind
 * the newest supported release so the scientific stack's wheels are reliably
 * available; users who want the newest pick it explicitly.
 */
export const DEFAULT_PYTHON_VERSION = "3.13";

/**
 * Parse a `python --version` style string down to its `major.minor` pair.
 *
 * Accepts the interpreter's stdout (e.g. `"Python 3.13.2"`) or a bare
 * version string (e.g. `"3.10.5rc1"`); anything after the minor component
 * is ignored.
 *
 * @param versionOutput - Raw version text to parse.
 * @returns The `"major.minor"` string (e.g. `"3.13"`), or `undefined` when
 *   no version number can be found.
 */
export function parseMajorMinor(versionOutput: string): string | undefined {
  const match = /(\d+)\.(\d+)/.exec(versionOutput);
  return match ? `${match[1]}.${match[2]}` : undefined;
}
