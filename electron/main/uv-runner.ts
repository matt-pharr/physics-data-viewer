/**
 * uv-runner.ts — The single entry point for invoking the `uv` binary from
 * the main process.
 *
 * Responsibilities:
 *  - Locate the `uv` executable: a `uv.binaryPath` config override if set,
 *    otherwise the per-platform binary bundled under the app resources
 *    (ARCHITECTURE.md §10.5.6).
 *  - Spawn `uv` subcommands, streaming stdout/stderr to a renderer window
 *    over an IPC push channel so progress is visible during long syncs.
 *  - Expose typed wrappers for the subcommands PDV uses: `uv sync`,
 *    `uv add`, `uv remove`, `uv lock --upgrade-package`, `uv pip install`,
 *    `uv python install`, `uv python list`.
 *
 * What this file does NOT do:
 *  - It does not own per-project environment orchestration (sync → install
 *    pdv-python → resolve the venv python); that is `uv-environment.ts`.
 *  - It does not override uv's own environment defaults (`UV_CACHE_DIR`,
 *    `UV_PYTHON_INSTALL_DIR`). Leaving them alone keeps the bundled binary
 *    interoperable with a system `uv`: they share a package cache and an
 *    interpreter pool (§10.5.6).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §10.5.6 (the uv binary), §10.5.18 (the uv-runner module)
 */

import * as path from "path";
import * as fs from "fs";
import { serverSpawn } from "./server/spawn";
import type { PushSender } from "./server/invoke-registry";
import { getResourcesRoot } from "./server/server-paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A streamed chunk of `uv` subprocess output. */
export interface UvOutputChunk {
  /** Which stream the chunk came from. */
  stream: "stdout" | "stderr";
  /** Raw text content of the chunk. */
  data: string;
}

/** Options controlling a single {@link runUv} invocation. */
export interface UvRunOptions {
  /** Working directory for the uv invocation. */
  cwd?: string;
  /** Push sender to stream {@link UvOutputChunk}s to. Omit to capture silently. */
  push?: PushSender;
  /** IPC channel name for streamed output chunks. */
  pushChannel?: string;
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>;
  /** Abort signal; aborting kills the uv subprocess. */
  signal?: AbortSignal;
  /** Override the resolved uv binary (typically `config.uv.binaryPath`). */
  binaryPath?: string;
}

/** Result of a completed (or failed) {@link runUv} invocation. */
export interface UvResult {
  /** True when uv exited with code 0. */
  success: boolean;
  /** Combined stdout+stderr captured across the whole run. */
  output: string;
  /** Process exit code, or null when the process was killed or never spawned. */
  exitCode: number | null;
}

/**
 * Thrown by {@link runUv} when no `uv` binary can be located — neither a
 * `uv.binaryPath` override nor a bundled binary.
 */
export class UvBinaryNotFoundError extends Error {
  constructor() {
    super(
      "Could not locate the uv binary. Expected a bundled binary under the " +
        "app resources, or a uv.binaryPath override in PDV settings."
    );
    this.name = "UvBinaryNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/** Platform key for the bundled-binary directory layout (`<platform>-<arch>`). */
function hostPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** Basename of the uv executable for the current OS. */
function uvExecutableName(): string {
  return process.platform === "win32" ? "uv.exe" : "uv";
}

/**
 * Resolve the absolute path to the `uv` executable.
 *
 * Resolution order:
 *  1. An explicit `uv.binaryPath` override, when it points at a real file.
 *  2. Packaged build: `<resourcesPath>/uv/uv[.exe]` — electron-builder copies
 *     the per-platform binary there (see electron-builder.yml).
 *  3. Development: walk up from the compiled `electron/dist/main/` directory
 *     to find `resources/uv/<platform>-<arch>/uv[.exe]` produced by
 *     `scripts/fetch-uv.mjs`.
 *
 * @param binaryPathOverride - Optional explicit path (e.g. `config.uv.binaryPath`).
 * @returns Absolute path to the `uv` executable, or null when none is found.
 */
export function resolveUvBinary(binaryPathOverride?: string): string | null {
  if (binaryPathOverride && fs.existsSync(binaryPathOverride)) {
    return binaryPathOverride;
  }
  const exe = uvExecutableName();
  const resourcesRoot = getResourcesRoot();
  if (resourcesRoot) {
    const packaged = path.join(resourcesRoot, "uv", exe);
    if (fs.existsSync(packaged)) {
      return packaged;
    }
  }
  const platformDir = hostPlatformKey();
  for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "resources", "uv", platformDir, exe);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

/**
 * Run an arbitrary `uv` subcommand, streaming its output.
 *
 * uv's own environment defaults are deliberately left untouched so the
 * bundled binary stays interoperable with a system `uv` (§10.5.6).
 *
 * @param args - Arguments passed to `uv` (the subcommand and its flags).
 * @param opts - Invocation options; see {@link UvRunOptions}.
 * @returns A {@link UvResult}. A non-zero exit, spawn failure, or abort all
 *   resolve (never reject) with `success: false`.
 * @throws {UvBinaryNotFoundError} When no `uv` binary can be located.
 */
export function runUv(args: string[], opts: UvRunOptions = {}): Promise<UvResult> {
  const binary = resolveUvBinary(opts.binaryPath);
  if (!binary) {
    return Promise.reject(new UvBinaryNotFoundError());
  }
  return new Promise<UvResult>((resolve) => {
    const chunks: string[] = [];
    // uv emits ANSI colors + a redrawn progress spinner even on a piped
    // stdout (it consults the host TERM rather than isatty alone). The
    // streaming panels (EnvSyncModal, Packages tab) render plain text, so
    // colors arrive as visible escape characters and the spinner produces
    // garbled \r redraws. Forcing plain text at the env level keeps the
    // streams readable without per-call arg threading; callers can still
    // override via `opts.env`.
    const baseEnv: Record<string, string | undefined> = {
      ...process.env,
      NO_COLOR: "1",
      UV_NO_PROGRESS: "1",
    };
    const proc = serverSpawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...baseEnv, ...opts.env } : baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    const sendChunk = (stream: "stdout" | "stderr", data: string): void => {
      chunks.push(data);
      if (opts.push && opts.pushChannel) {
        opts.push(opts.pushChannel, { stream, data } as UvOutputChunk);
      }
    };

    proc.stdout?.on("data", (buf: Buffer) => sendChunk("stdout", buf.toString()));
    proc.stderr?.on("data", (buf: Buffer) => sendChunk("stderr", buf.toString()));

    let settled = false;
    const settle = (result: UvResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    proc.on("close", (code) => {
      settle({ success: code === 0, output: chunks.join(""), exitCode: code });
    });
    // spawn failure (binary not executable) or abort via opts.signal.
    proc.on("error", (err) => {
      sendChunk("stderr", err.message);
      settle({ success: false, output: chunks.join(""), exitCode: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Typed subcommand wrappers
// ---------------------------------------------------------------------------

/**
 * Run `uv sync` — materialize the project venv from `pyproject.toml` /
 * `uv.lock` in `opts.cwd`.
 *
 * `uv sync` is **exact** by default: it uninstalls anything not in the
 * lockfile. pdv-python lives in the venv via `uv pip install` — outside the
 * lock (§10.5.7) — so any in-place sync under a live kernel MUST pass
 * `inexact: true` or it strips pdv-python out from under the running
 * session. Only the initial materialization (which reinstalls pdv-python
 * immediately after) may sync exactly.
 *
 * @param opts - Run options; `pythonVersion` adds `--python <version>`,
 *   `inexact` adds `--inexact` (keep packages absent from the lockfile).
 * @returns The {@link UvResult} of the sync.
 * @throws {UvBinaryNotFoundError} When no `uv` binary can be located.
 */
export function uvSync(
  opts: UvRunOptions & { pythonVersion?: string; inexact?: boolean } = {}
): Promise<UvResult> {
  const { pythonVersion, inexact, ...runOpts } = opts;
  const args = ["sync"];
  if (pythonVersion) {
    args.push("--python", pythonVersion);
  }
  if (inexact) {
    args.push("--inexact");
  }
  return runUv(args, runOpts);
}

/**
 * Run `uv add` — add dependencies to `pyproject.toml` and re-lock.
 *
 * @param specs - PEP 508 dependency specifiers to add.
 * @param opts - Run options.
 * @returns The {@link UvResult} of the add.
 * @throws {UvBinaryNotFoundError} When no `uv` binary can be located.
 */
export function uvAdd(specs: string[], opts: UvRunOptions = {}): Promise<UvResult> {
  return runUv(["add", ...specs], opts);
}

/**
 * Run `uv remove` — drop dependencies from `pyproject.toml` and re-lock.
 *
 * @param names - Distribution names to remove.
 * @param opts - Run options.
 * @returns The {@link UvResult} of the remove.
 * @throws {UvBinaryNotFoundError} When no `uv` binary can be located.
 */
export function uvRemove(names: string[], opts: UvRunOptions = {}): Promise<UvResult> {
  return runUv(["remove", ...names], opts);
}

/**
 * Run `uv lock --upgrade-package <name>...` — re-lock, upgrading only the
 * named packages within their declared constraints.
 *
 * @param names - Distribution names to upgrade.
 * @param opts - Run options.
 * @returns The {@link UvResult} of the lock.
 * @throws {UvBinaryNotFoundError} When no `uv` binary can be located.
 */
export function uvLockUpgrade(names: string[], opts: UvRunOptions = {}): Promise<UvResult> {
  const args = ["lock"];
  for (const name of names) {
    args.push("--upgrade-package", name);
  }
  return runUv(args, opts);
}

/**
 * Run `uv pip install --python <venvPython> <target>` — install a package
 * or local artifact into a specific interpreter's environment.
 *
 * @param venvPython - Absolute path to the target interpreter.
 * @param target - A requirement specifier, wheel path, or source path.
 * @param opts - Run options.
 * @returns The {@link UvResult} of the install.
 * @throws {UvBinaryNotFoundError} When no `uv` binary can be located.
 */
export function uvPipInstall(
  venvPython: string,
  target: string,
  opts: UvRunOptions = {}
): Promise<UvResult> {
  return runUv(["pip", "install", "--python", venvPython, target], opts);
}

/**
 * Run `uv pip list --format json --python <venvPython>` — enumerate the
 * packages actually installed in a venv. Used by the Packages UI to pair
 * declared specs with their resolved versions (§10.5.13).
 *
 * @param venvPython - Absolute path to the venv's interpreter.
 * @param opts - Run options.
 * @returns The {@link UvResult}; `output` is the JSON package listing.
 * @throws {UvBinaryNotFoundError} When no `uv` binary can be located.
 */
export function uvPipList(venvPython: string, opts: UvRunOptions = {}): Promise<UvResult> {
  return runUv(["pip", "list", "--format", "json", "--python", venvPython], opts);
}
