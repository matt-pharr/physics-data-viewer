/**
 * environment-detector.ts — Detect the Python environment and kernel command.
 *
 * Responsible for finding the correct Python / Jupyter kernel executable
 * to use for a PDV session. Resolution order:
 *
 * 1. User-configured path in PDV settings (via config.ts).
 * 2. Active conda environment (``CONDA_PREFIX``).
 * 3. Active virtualenv (``VIRTUAL_ENV``).
 * 4. System Python on PATH.
 *
 * All results are cached for the lifetime of the process.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §5.1 (environment detection)
 * config.ts — source of user-configured paths
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnvironmentKind = "conda" | "venv" | "system" | "configured";

export interface DetectedEnvironment {
  kind: EnvironmentKind;
  pythonPath: string;
  /** Absolute path to the ``jupyter`` executable (or ``python -m jupyter``). */
  jupyterPath: string;
  /** Human-readable label for the environment selector UI. */
  label: string;
  /** Version string returned by ``python --version``. */
  pythonVersion: string;
}

// ---------------------------------------------------------------------------
// EnvironmentDetector
// ---------------------------------------------------------------------------

export class EnvironmentDetector {
  /**
   * Return the best available Python environment, using the resolution order
   * described in ARCHITECTURE.md §5.1.
   *
   * The result is cached after the first call.
   *
   * @param configuredPath - Optional path from user settings. If provided and
   *   valid, it takes priority over all automatic detection.
   */
  static async detect(configuredPath?: string): Promise<DetectedEnvironment> {
    // TODO: implement in Step 4
    throw new Error("EnvironmentDetector.detect not yet implemented");
  }

  /**
   * List all detectable environments on this machine (for the Environment
   * Selector UI).
   *
   * Includes:
   * - The configured path (if any)
   * - All conda environments (if conda is on PATH)
   * - The active virtualenv (if VIRTUAL_ENV is set)
   * - System Python
   *
   * @returns Array of detected environments, ordered by priority.
   */
  static async listAll(): Promise<DetectedEnvironment[]> {
    // TODO: implement in Step 4
    throw new Error("EnvironmentDetector.listAll not yet implemented");
  }

  /**
   * Verify that a given Python executable has the ``pdv_kernel`` package
   * installed and that its version is compatible.
   *
   * @param pythonPath - Absolute path to the Python executable to check.
   * @returns true if the package is installed and version-compatible.
   */
  static async hasPDVKernel(pythonPath: string): Promise<boolean> {
    // TODO: implement in Step 4
    throw new Error("EnvironmentDetector.hasPDVKernel not yet implemented");
  }

  /** Clear the internal environment detection cache. */
  static clearCache(): void {
    // TODO: implement in Step 4
    throw new Error("EnvironmentDetector.clearCache not yet implemented");
  }
}
