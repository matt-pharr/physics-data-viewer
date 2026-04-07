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
 * ARCHITECTURE.md §5.1, §10 (environment detection and package installation)
 * config.ts — source of user-configured paths
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { BrowserWindow } from "electron";
import { getAppVersion } from "./pdv-protocol";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classifier for the origin of a detected Python environment. */
type EnvironmentKind = "conda" | "venv" | "pyenv" | "system" | "configured";

/**
 * A detected Julia installation on the host machine.
 */
export interface DetectedJuliaEnvironment {
  /** Absolute path to the Julia executable. */
  juliaPath: string;
  /** Human-readable label for the environment selector UI. */
  label: string;
  /** Version string returned by ``julia --version``. */
  juliaVersion: string;
}

/**
 * A single Python environment discovered on the host machine.
 *
 * See ARCHITECTURE.md §10.1 for field semantics.
 */
interface DetectedEnvironment {
  kind: EnvironmentKind;
  pythonPath: string;
  /** Absolute path to the ``jupyter`` executable (or ``python -m jupyter``). */
  jupyterPath: string;
  /** Human-readable label for the environment selector UI. */
  label: string;
  /** Version string returned by ``python --version``. */
  pythonVersion: string;
}

/**
 * Result of checking whether ``pdv_kernel`` is installed in an environment.
 *
 * See ARCHITECTURE.md §10.3.
 */
interface PDVInstallStatus {
  /** True when ``pdv_kernel`` is importable in the given Python environment. */
  installed: boolean;
  /** The installed version string, or null when not installed. */
  version: string | null;
  /**
   * True when the installed version is protocol-compatible with this app.
   * Always false when ``installed`` is false.
   */
  compatible: boolean;
}

/**
 * Result of running ``pip install pdv-python``.
 *
 * See ARCHITECTURE.md §10.3.
 */
interface PDVInstallResult {
  /** True when pip exited with code 0. */
  success: boolean;
  /** Combined stdout + stderr from the pip process. */
  output: string;
}

/**
 * Enriched environment descriptor with package installation status.
 *
 * Returned by the `environment:list` and `environment:check` IPC channels
 * so the renderer can show status badges and install controls.
 */
export interface EnvironmentInfo {
  /** Origin classifier for this environment. */
  kind: EnvironmentKind;
  /** Absolute path to the Python executable. */
  pythonPath: string;
  /** Human-readable label for the environment selector UI. */
  label: string;
  /** Version string returned by ``python --version``. */
  pythonVersion: string;
  /** True when ``pdv_kernel`` is importable. */
  pdvInstalled: boolean;
  /** Installed ``pdv_kernel`` version, or null when not installed. */
  pdvVersion: string | null;
  /** True when the installed version is protocol-compatible. */
  pdvCompatible: boolean;
  /** True when the installed pdv-python version differs from the app version. */
  pdvVersionMismatch: boolean;
  /** True when ``ipykernel`` is importable. */
  ipykernelInstalled: boolean;
}

/**
 * Result of a streaming ``pip install`` operation.
 */
export interface EnvironmentInstallResult {
  /** True when pip exited with code 0. */
  success: boolean;
  /** Combined stdout + stderr from the pip process. */
  output: string;
}

/**
 * A single streaming output chunk from a pip install operation.
 */
export interface InstallOutputChunk {
  /** Which output stream the chunk came from. */
  stream: "stdout" | "stderr";
  /** The text data of the chunk. */
  data: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Timeout (ms) for version/import probes (ARCHITECTURE.md §10.3). */
const PROBE_TIMEOUT_MS = 5_000;

/** Timeout (ms) for conda env list (may be slower on first run). */
const CONDA_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// EnvironmentDetector
// ---------------------------------------------------------------------------

/**
 * Module-level cache of detected environments.
 * Cleared by {@link EnvironmentDetector.clearCache}.
 */
let _cache: DetectedEnvironment[] | null = null;

/** Module-level cache of detected Julia environments. */
let _juliaCache: DetectedJuliaEnvironment[] | null = null;

/**
 * Detects Python environments and validates/install checks for `pdv_kernel`.
 *
 * This class only performs environment discovery and subprocess probes; it
 * does NOT start kernels or perform IPC registration.
 */
export class EnvironmentDetector {
  /**
   * Return the best available Python environment, using the resolution order
   * described in ARCHITECTURE.md §10.2.
   *
   * The result is cached after the first call. Call {@link clearCache} to
   * force re-detection (e.g. after the user changes settings).
   *
   * @param configuredPath - Optional path from user settings. If provided and
   *   valid, it takes priority over all automatic detection.
   * @returns The highest-priority detected environment.
   * @throws {Error} When no Python executable can be found anywhere.
   */
  static async detect(configuredPath?: string): Promise<DetectedEnvironment> {
    const all = await EnvironmentDetector.detectEnvironments(configuredPath);
    if (all.length === 0) {
      throw new Error(
        "No Python executable found. Install Python and try again."
      );
    }
    return all[0];
  }

  /**
   * Find all detectable Python environments on this machine.
   *
   * Detection order (ARCHITECTURE.md §10.2):
   * 1. User-configured path (``configuredPath`` argument).
   * 2. Active conda environment (``CONDA_PREFIX`` env var).
   * 3. Active virtualenv (``VIRTUAL_ENV`` env var).
   * 4. Conda environments from ``conda env list --json``.
   * 5. System Python / ``python3`` on PATH.
   *
   * Results are cached; call {@link clearCache} to refresh.
   *
   * @param configuredPath - Optional user-configured Python executable path.
   * @returns Array of detected environments, ordered by priority.
   */
  static async detectEnvironments(
    configuredPath?: string
  ): Promise<DetectedEnvironment[]> {
    if (_cache !== null) {
      return _cache;
    }

    const results: DetectedEnvironment[] = [];
    const seen = new Set<string>();

    const add = (env: DetectedEnvironment): void => {
      if (!seen.has(env.pythonPath)) {
        seen.add(env.pythonPath);
        results.push(env);
      }
    };

    // 1. User-configured path — infer the real kind so it gets the correct
    //    badge and label instead of always showing "Configured *".
    if (configuredPath) {
      const env = await _probeEnv(configuredPath, _inferKind(configuredPath));
      if (env) add(env);
    }

    // 2. Active conda environment.
    const condaPrefix = process.env.CONDA_PREFIX;
    if (condaPrefix) {
      const pythonPath = _pythonInPrefix(condaPrefix);
      const env = await _probeEnv(pythonPath, "conda");
      if (env) add(env);
    }

    // 3. Active virtualenv.
    const virtualEnv = process.env.VIRTUAL_ENV;
    if (virtualEnv) {
      const pythonPath = _pythonInPrefix(virtualEnv);
      const env = await _probeEnv(pythonPath, "venv");
      if (env) add(env);
    }

    // 4. Conda environments from ``conda env list --json``.
    const condaEnvs = await _listCondaEnvs();
    for (const prefix of condaEnvs) {
      if (prefix === condaPrefix) continue; // already added above
      const pythonPath = _pythonInPrefix(prefix);
      const env = await _probeEnv(pythonPath, "conda");
      if (env) add(env);
    }

    // 5. pyenv versions from ``~/.pyenv/versions/``.
    const pyenvVersions = _listPyenvVersions();
    for (const versionDir of pyenvVersions) {
      const pythonPath = path.join(versionDir, "bin", "python");
      const env = await _probeEnv(pythonPath, "pyenv");
      if (env) add(env);
    }

    // 6. System Python fallback.
    for (const candidate of ["python3", "python"]) {
      const env = await _probeEnv(candidate, "system");
      if (env) {
        add(env);
        break;
      }
    }

    _cache = results;
    return results;
  }

  /**
   * List all detectable environments on this machine (for the Environment
   * Selector UI).
   *
   * Delegates to {@link detectEnvironments} with no configured path.
   *
   * @returns Array of detected environments, ordered by priority.
   */
  static async listAll(): Promise<DetectedEnvironment[]> {
    return EnvironmentDetector.detectEnvironments();
  }

  /**
   * Check whether ``pdv_kernel`` is installed in the given Python environment
   * and whether its version is compatible with this app.
   *
   * Runs: ``<python> -c "import pdv_kernel; print(pdv_kernel.__version__)"``
   * with a 5-second timeout (ARCHITECTURE.md §10.3).
   *
   * @param pythonPath - Path to the Python executable to probe.
   * @returns Install status object.
   */
  static async checkPDVInstalled(
    pythonPath: string
  ): Promise<PDVInstallStatus> {
    try {
      const { stdout } = await execFileAsync(
        pythonPath,
        ["-c", "import pdv_kernel; print(pdv_kernel.__version__)"],
        { timeout: PROBE_TIMEOUT_MS }
      );
      const version = stdout.trim();
      // During 0.x, require an exact version match. Post-1.0 this could
      // relax to major-version compatibility.
      // NOTE: Same version policy is enforced in pdv-protocol.ts
      // (checkVersionCompatibility) and pdv_kernel/comms.py (check_version).
      const compatible = version === getAppVersion();
      return { installed: true, version, compatible };
    } catch {
      return { installed: false, version: null, compatible: false };
    }
  }

  /**
   * Verify that a given Python executable has the ``pdv_kernel`` package
   * installed and that its version is compatible.
   *
   * @param pythonPath - Absolute path to the Python executable to check.
   * @returns True if the package is installed and version-compatible.
   */
  static async hasPDVKernel(pythonPath: string): Promise<boolean> {
    const status = await EnvironmentDetector.checkPDVInstalled(pythonPath);
    return status.installed && status.compatible;
  }

  /**
   * Install ``pdv-python`` into the given Python environment using pip.
   *
   * Runs: ``<python> -m pip install pdv-python``
   * Streams stdout + stderr into the returned ``output`` string.
   *
   * @param pythonPath - Path to the target Python executable.
   * @param timeoutMs - Optional subprocess timeout in milliseconds.
   * @returns Install result with success flag and captured output.
   */
  static async installPDV(
    pythonPath: string,
    timeoutMs = 120_000
  ): Promise<PDVInstallResult> {
    try {
      const { stdout, stderr } = await execFileAsync(
        pythonPath,
        ["-m", "pip", "install", "pdv-python"],
        { timeout: timeoutMs }
      );
      return { success: true, output: stdout + stderr };
    } catch (err) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      const output =
        (error.stdout ?? "") + (error.stderr ?? "") || (error.message ?? "");
      return { success: false, output };
    }
  }

  /** Clear the internal environment detection cache. */
  static clearCache(): void {
    _cache = null;
    _juliaCache = null;
  }

  // -------------------------------------------------------------------------
  // Julia environment detection
  // -------------------------------------------------------------------------

  /**
   * Detect available Julia installations on this machine.
   *
   * Detection order:
   * 1. User-configured path (``configuredPath`` argument).
   * 2. ``julia`` on PATH.
   *
   * Results are cached; call {@link clearCache} to refresh.
   *
   * @param configuredPath - Optional user-configured Julia executable path.
   * @returns Array of detected Julia environments.
   */
  static async detectJuliaEnvironments(
    configuredPath?: string
  ): Promise<DetectedJuliaEnvironment[]> {
    if (_juliaCache !== null) {
      return _juliaCache;
    }

    const results: DetectedJuliaEnvironment[] = [];
    const seen = new Set<string>();

    const add = (env: DetectedJuliaEnvironment): void => {
      if (!seen.has(env.juliaPath)) {
        seen.add(env.juliaPath);
        results.push(env);
      }
    };

    if (configuredPath) {
      const env = await _probeJulia(configuredPath, "Configured");
      if (env) add(env);
    }

    const systemEnv = await _probeJulia("julia", "System");
    if (systemEnv) add(systemEnv);

    _juliaCache = results;
    return results;
  }

  /**
   * Check whether ``PDVKernel`` is installed in the given Julia environment
   * and return its version.
   *
   * Runs: ``julia -e 'using PDVKernel; println(PDVKernel.VERSION)'``
   * with a 5-second timeout.
   *
   * @param juliaPath - Path to the Julia executable to probe.
   * @returns Install status object.
   */
  static async checkJuliaPDVInstalled(
    juliaPath: string
  ): Promise<PDVInstallStatus> {
    try {
      const { stdout } = await execFileAsync(
        juliaPath,
        ["-e", 'using PDVKernel; println(PDVKernel.VERSION)'],
        { timeout: PROBE_TIMEOUT_MS }
      );
      const version = stdout.trim();
      const major = version.split(".")[0];
      const compatible = major === "1";
      return { installed: true, version, compatible };
    } catch {
      return { installed: false, version: null, compatible: false };
    }
  }

  /**
   * Verify that a given Julia executable has the ``PDVKernel`` package
   * installed and that its version is compatible.
   *
   * @param juliaPath - Absolute path to the Julia executable to check.
   * @returns True if the package is installed and version-compatible.
   */
  static async hasJuliaPDVKernel(juliaPath: string): Promise<boolean> {
    const status = await EnvironmentDetector.checkJuliaPDVInstalled(juliaPath);
    return status.installed && status.compatible;
  }

  // -------------------------------------------------------------------------
  // Enriched environment info (for environment picker UI)
  // -------------------------------------------------------------------------

  /**
   * Check whether ``ipykernel`` is importable in a Python environment.
   *
   * @param pythonPath - Path to the Python executable to probe.
   * @returns True when ipykernel is importable.
   */
  static async checkIpykernelInstalled(pythonPath: string): Promise<boolean> {
    try {
      await execFileAsync(
        pythonPath,
        ["-c", "import ipykernel"],
        { timeout: PROBE_TIMEOUT_MS }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the absolute path to the bundled ``pdv-python`` source directory.
   *
   * In packaged builds, ``pdv-python/`` is in ``process.resourcesPath``.
   * In development (``npm run dev``), it is at the repository root, which
   * is two directories above the compiled ``electron/main/`` output.
   *
   * @returns Absolute path to the ``pdv-python`` directory, or null if not found.
   */
  static resolveBundledPDVPath(): string | null {
    // Packaged: pdv-python/ is copied into the resources directory.
    if (process.resourcesPath) {
      const resourcesCandidate = path.join(process.resourcesPath, "pdv-python");
      if (fs.existsSync(path.join(resourcesCandidate, "pyproject.toml"))) {
        return resourcesCandidate;
      }
    }
    // Dev: __dirname is electron/dist/main. Walk upward to find pdv-python/.
    for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const candidate = path.join(dir, "pdv-python");
      if (fs.existsSync(path.join(candidate, "pyproject.toml"))) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Read the version of the bundled ``pdv-python`` package from its
   * ``pyproject.toml`` in the app Resources directory.
   *
   * @param resourcesPath - ``process.resourcesPath`` at runtime.
   * @returns Bundled version string, or null if not found.
   */
  static getBundledPDVVersion(pdvPythonPath?: string | null): string | null {
    const resolved = pdvPythonPath ?? EnvironmentDetector.resolveBundledPDVPath();
    if (!resolved) return null;
    try {
      const pyprojectPath = path.join(resolved, "pyproject.toml");
      const content = fs.readFileSync(pyprojectPath, "utf8");
      const match = content.match(/^version\s*=\s*"([^"]+)"/m);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Build an enriched {@link EnvironmentInfo} for a detected environment
   * by probing pdv-python and ipykernel installation status.
   *
   * @param env - Base detected environment.
   * @returns Enriched environment info.
   */
  static async enrichEnvironment(
    env: DetectedEnvironment
  ): Promise<EnvironmentInfo> {
    const [pdvStatus, ipykernelInstalled] = await Promise.all([
      EnvironmentDetector.checkPDVInstalled(env.pythonPath),
      EnvironmentDetector.checkIpykernelInstalled(env.pythonPath),
    ]);

    const appVersion = getAppVersion();
    let pdvVersionMismatch = false;
    if (pdvStatus.installed && pdvStatus.version && appVersion) {
      pdvVersionMismatch = pdvStatus.version !== appVersion;
    }

    return {
      kind: env.kind,
      pythonPath: env.pythonPath,
      label: env.label,
      pythonVersion: env.pythonVersion,
      pdvInstalled: pdvStatus.installed,
      pdvVersion: pdvStatus.version,
      pdvCompatible: pdvStatus.compatible,
      pdvVersionMismatch,
      ipykernelInstalled,
    };
  }

  /**
   * List all detected Python environments with enriched package status.
   *
   * @param configuredPath - Optional user-configured Python path.
   * @returns Array of enriched environment info objects.
   */
  static async listEnvironmentInfo(
    configuredPath?: string
  ): Promise<EnvironmentInfo[]> {
    const envs = await EnvironmentDetector.detectEnvironments(configuredPath);
    return Promise.all(
      envs.map((env) => EnvironmentDetector.enrichEnvironment(env))
    );
  }

  /**
   * Probe a single Python path and return enriched environment info.
   *
   * Bypasses the cache — used for re-checking a selected environment.
   *
   * @param pythonPath - Path to the Python executable.
   * @returns Enriched environment info, or null if the path is invalid.
   */
  static async checkEnvironment(
    pythonPath: string
  ): Promise<EnvironmentInfo | null> {
    const env = await _probeEnv(pythonPath, _inferKind(pythonPath));
    if (!env) return null;
    return EnvironmentDetector.enrichEnvironment(env);
  }

  /**
   * Install ``pdv-python`` from the bundled source into a Python environment,
   * streaming pip output to a BrowserWindow via a push channel.
   *
   * @param pythonPath - Target Python executable.
   * @param win - BrowserWindow to stream output chunks to (optional).
   * @param pushChannel - IPC channel name for output chunks.
   * @returns Install result with success flag and full output.
   */
  static installPDVFromBundle(
    pythonPath: string,
    win?: BrowserWindow,
    pushChannel?: string
  ): Promise<EnvironmentInstallResult> {
    const bundledPath = EnvironmentDetector.resolveBundledPDVPath();
    if (!bundledPath) {
      return Promise.resolve({
        success: false,
        output: "Could not locate bundled pdv-python source directory.",
      });
    }

    // pip needs to write build artifacts (egg-info) into the source tree.
    // When the bundled source is read-only (macOS App Translocation, Linux
    // dpkg install to /opt, etc.), copy it to a temp directory first.
    let installPath = bundledPath;
    let tempDir: string | null = null;
    const probeFile = path.join(bundledPath, ".pdv-write-test");
    let needsCopy = false;
    try {
      fs.writeFileSync(probeFile, "", { flag: "wx" });
      fs.unlinkSync(probeFile);
    } catch {
      needsCopy = true;
    }
    if (needsCopy) {
      try {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-install-"));
        const tempPdvPython = path.join(tempDir, "pdv-python");
        fs.cpSync(bundledPath, tempPdvPython, { recursive: true });
        installPath = tempPdvPython;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Promise.resolve({
          success: false,
          output: `Failed to copy bundled source to a temporary directory: ${msg}`,
        });
      }
    }

    return new Promise((resolve) => {
      const chunks: string[] = [];
      const proc = spawn(pythonPath, ["-m", "pip", "install", "--no-color", installPath], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });

      const sendChunk = (stream: "stdout" | "stderr", data: string): void => {
        chunks.push(data);
        if (win && pushChannel) {
          win.webContents.send(pushChannel, { stream, data } as InstallOutputChunk);
        }
      };

      proc.stdout?.on("data", (buf: Buffer) => sendChunk("stdout", buf.toString()));
      proc.stderr?.on("data", (buf: Buffer) => sendChunk("stderr", buf.toString()));

      const cleanup = (): void => {
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      };

      proc.on("close", (code) => {
        cleanup();
        resolve({
          success: code === 0,
          output: chunks.join(""),
        });
      });

      proc.on("error", (err) => {
        cleanup();
        sendChunk("stderr", err.message);
        resolve({ success: false, output: chunks.join("") });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return the platform-appropriate Python path inside a virtualenv / conda
 * prefix directory.
 *
 * @param prefix - Root directory of the environment.
 * @returns Absolute path to the Python executable.
 */
function _pythonInPrefix(prefix: string): string {
  return process.platform === "win32"
    ? path.join(prefix, "python.exe")
    : path.join(prefix, "bin", "python");
}

/**
 * Infer the environment kind from a Python executable path by checking whether
 * it lives inside a conda prefix, virtualenv, pyenv version directory, etc.
 *
 * Falls back to ``"configured"`` when no known layout matches.
 *
 * @param pythonPath - Absolute path to a Python executable.
 * @returns The inferred {@link EnvironmentKind}.
 */
function _inferKind(pythonPath: string): EnvironmentKind {
  const resolved = path.resolve(pythonPath);

  // pyenv: ~/.pyenv/versions/<name>/bin/python
  const pyenvRoot = path.join(os.homedir(), ".pyenv", "versions");
  if (resolved.startsWith(pyenvRoot + path.sep)) return "pyenv";

  // conda: check if the prefix contains conda-meta/
  const prefix = path.dirname(path.dirname(resolved)); // strip bin/python
  if (fs.existsSync(path.join(prefix, "conda-meta"))) return "conda";

  // venv: check for pyvenv.cfg in the prefix
  if (fs.existsSync(path.join(prefix, "pyvenv.cfg"))) return "venv";

  return "configured";
}

/**
 * Probe a Python executable and return a {@link DetectedEnvironment} if valid.
 *
 * Runs ``python --version`` with {@link PROBE_TIMEOUT_MS}. Returns null if the
 * executable does not exist or exits non-zero.
 *
 * @param pythonPath - Path or command name for the Python executable.
 * @param kind - Environment kind label.
 * @returns Populated environment object, or null on failure.
 */
async function _probeEnv(
  pythonPath: string,
  kind: EnvironmentKind
): Promise<DetectedEnvironment | null> {
  try {
    const { stdout, stderr } = await execFileAsync(
      pythonPath,
      ["--version"],
      { timeout: PROBE_TIMEOUT_MS }
    );
    // Python 2 prints to stderr; Python 3 prints to stdout.
    const raw = (stdout + stderr).trim();
    const pythonVersion = raw.replace(/^Python\s+/i, "");
    const label = _makeLabel(kind, pythonPath, pythonVersion);
    const jupyterPath = _resolveJupyterPath(pythonPath);
    return { kind, pythonPath, jupyterPath, label, pythonVersion };
  } catch {
    return null;
  }
}

/**
 * List all conda environment prefixes via ``conda env list --json``.
 *
 * Returns an empty array if conda is not on PATH or the command fails.
 *
 * @returns Array of absolute conda prefix directory paths.
 */
/**
 * Well-known conda installation directories on macOS and Linux.
 *
 * Checked as a fallback when the ``conda`` command is not on PATH
 * (common in packaged GUI apps launched from Finder/dock).
 */
const CONDA_ROOT_CANDIDATES = [
  path.join(os.homedir(), "miniconda3"),
  path.join(os.homedir(), "miniforge3"),
  path.join(os.homedir(), "mambaforge"),
  path.join(os.homedir(), "anaconda3"),
  "/opt/miniconda3",
  "/opt/miniforge3",
  "/opt/anaconda3",
];

async function _listCondaEnvs(): Promise<string[]> {
  // Try the conda command first (works in dev / terminal launches).
  const fromCommand = await _listCondaEnvsViaCommand();
  if (fromCommand.length > 0) return fromCommand;

  // Fallback: scan well-known filesystem locations.
  return _listCondaEnvsViaFilesystem();
}

/**
 * List conda environments by running ``conda env list --json``.
 */
async function _listCondaEnvsViaCommand(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "conda",
      ["env", "list", "--json"],
      { timeout: CONDA_TIMEOUT_MS }
    );
    const parsed = JSON.parse(stdout) as { envs?: unknown[] };
    const envs = parsed.envs;
    if (!Array.isArray(envs)) return [];
    return envs.filter((e): e is string => typeof e === "string");
  } catch {
    return [];
  }
}

/**
 * List conda environments by scanning well-known root directories.
 *
 * For each root, includes the base env (root itself) and all named envs
 * in ``<root>/envs/``.
 */
function _listCondaEnvsViaFilesystem(): string[] {
  const results: string[] = [];
  for (const root of CONDA_ROOT_CANDIDATES) {
    if (!fs.existsSync(path.join(root, "bin", "python"))) continue;
    // Base environment.
    results.push(root);
    // Named environments.
    const envsDir = path.join(root, "envs");
    try {
      const entries = fs.readdirSync(envsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const envPath = path.join(envsDir, entry.name);
        if (fs.existsSync(path.join(envPath, "bin", "python"))) {
          results.push(envPath);
        }
      }
    } catch {
      // envs/ might not exist — that's fine.
    }
  }
  return results;
}

/**
 * Construct a human-readable label for the environment selector UI.
 *
 * @param kind - Environment kind.
 * @param pythonPath - Path to the Python executable.
 * @param version - Python version string.
 * @returns Display label string.
 */
function _makeLabel(
  kind: EnvironmentKind,
  pythonPath: string,
  version: string
): string {
  switch (kind) {
    case "configured":
      return `Configured — Python ${version} (${pythonPath})`;
    case "conda": {
      // Try to extract the env name from the prefix path.
      const envName = path.basename(path.dirname(path.dirname(pythonPath)));
      return `conda: ${envName} — Python ${version}`;
    }
    case "venv":
      return `venv — Python ${version} (${pythonPath})`;
    case "pyenv": {
      const versionName = path.basename(path.dirname(path.dirname(pythonPath)));
      return `pyenv: ${versionName} — Python ${version}`;
    }
    case "system":
      return `System — Python ${version}`;
  }
}

/**
 * Resolve the ``jupyter`` executable path relative to a Python executable.
 *
 * @param pythonPath - Path to the Python executable.
 * @returns Sibling ``jupyter`` path, or ``python -m jupyter`` placeholder.
 */
function _resolveJupyterPath(pythonPath: string): string {
  // If pythonPath is just a command name (e.g. "python3"), return placeholder.
  if (!path.isAbsolute(pythonPath)) {
    return "jupyter";
  }
  const binDir = path.dirname(pythonPath);
  return process.platform === "win32"
    ? path.join(binDir, "jupyter.exe")
    : path.join(binDir, "jupyter");
}

/**
 * List pyenv version directories from ``~/.pyenv/versions/``.
 *
 * Returns an empty array if pyenv is not installed or the directory
 * does not exist.
 *
 * @returns Array of absolute version directory paths.
 */
function _listPyenvVersions(): string[] {
  try {
    const pyenvRoot = path.join(os.homedir(), ".pyenv", "versions");
    const entries = fs.readdirSync(pyenvRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(pyenvRoot, e.name));
  } catch {
    return [];
  }
}

/**
 * Compare two semver-like version strings.
 *
 * @param newer - Candidate newer version.
 * @param older - Candidate older version.
 * @returns True when ``newer`` is strictly greater than ``older``.
 */
function _isNewerVersion(newer: string, older: string): boolean {
  const a = newer.split(".").map(Number);
  const b = older.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

/**
 * Probe a Julia executable and return a {@link DetectedJuliaEnvironment} if valid.
 *
 * Runs ``julia --version`` with {@link PROBE_TIMEOUT_MS}.
 *
 * @param juliaPath - Path or command name for the Julia executable.
 * @param kindLabel - Label prefix (e.g. "Configured", "System").
 * @returns Populated environment object, or null on failure.
 */
async function _probeJulia(
  juliaPath: string,
  kindLabel: string
): Promise<DetectedJuliaEnvironment | null> {
  try {
    const { stdout, stderr } = await execFileAsync(
      juliaPath,
      ["--version"],
      { timeout: PROBE_TIMEOUT_MS }
    );
    const raw = (stdout + stderr).trim();
    // Julia prints "julia version 1.x.y"
    const juliaVersion = raw.replace(/^julia\s+version\s+/i, "");
    const label = `${kindLabel} — Julia ${juliaVersion}${path.isAbsolute(juliaPath) ? ` (${juliaPath})` : ""}`;
    return { juliaPath, label, juliaVersion };
  } catch {
    return null;
  }
}
