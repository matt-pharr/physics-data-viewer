/**
 * julia-discovery.ts — Julia runtime discovery, probing, shim bypass, and
 * one-click PDVKernel installation (ARCHITECTURE.md §10.7).
 *
 * Responsibilities:
 * - Enumerate installed Julia runtimes filesystem-only: juliaup channels from
 *   `juliaup.json`, the configured path, and well-known system locations —
 *   never by spawning Julia, so discovery is instant and immune to a wedged
 *   juliaup shim (§10.7.1).
 * - Resolve the juliaup shim (`julialauncher`) to the default channel's real
 *   versioned binary (§10.7.2).
 * - Probe a runtime with a single short-lived spawn for its Julia version,
 *   PDVKernel install status, and IJulia presence (§10.7.3).
 * - Install PDVKernel into a runtime's default environment: stage the bundled
 *   `pdv-julia` source into a stable writable directory, then
 *   `Pkg.develop` + `Pkg.add("IJulia")` with streamed output (§10.7.4).
 *
 * What this file does NOT do
 * - Spawn kernels (kernel-manager.ts) or run `Pkg.instantiate` in project
 *   environments (julia-env.ts).
 * - Register IPC handlers (ipc-register-environment.ts).
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BrowserWindow } from "electron";

import { coreVersion, getAppVersion } from "./pdv-protocol";
import type { EnvironmentInstallResult } from "./environment-detector";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classifier for the origin of a discovered Julia runtime. */
export type JuliaRuntimeKind = "juliaup" | "system" | "configured";

/**
 * A single Julia runtime discovered on the host machine, enriched with
 * PDVKernel/IJulia status for the environment selector UI (§10.7.1).
 */
export interface JuliaRuntimeInfo {
  /** Origin classifier for this runtime. */
  kind: JuliaRuntimeKind;
  /** Absolute path to the real Julia executable (never the juliaup shim). */
  juliaPath: string;
  /** Human-readable label for the environment selector UI. */
  label: string;
  /** Julia version string (e.g. `"1.11.6"`), or null when the probe failed to report one. */
  juliaVersion: string | null;
  /** juliaup channel name (`"release"`, `"1.10"`, ...); undefined for non-juliaup runtimes. */
  channel?: string;
  /** True when this is the juliaup default channel. */
  isDefault: boolean;
  /** True when PDVKernel resolves from this runtime's load path. */
  pdvKernelInstalled: boolean;
  /** Installed PDVKernel version, or null when not installed. */
  pdvKernelVersion: string | null;
  /** True when the installed PDVKernel version is protocol-compatible with this app. */
  pdvKernelCompatible: boolean;
  /** True when PDVKernel is installed but its version differs from the app version. */
  pdvKernelVersionMismatch: boolean;
  /** True when IJulia resolves from this runtime's load path. */
  ijuliaInstalled: boolean;
}

/** A juliaup channel entry parsed from `juliaup.json` (§10.7.1). */
export interface JuliaupChannel {
  /** Channel name (`"release"`, `"lts"`, `"1.10"`, a linked name, ...). */
  channel: string;
  /** Absolute path to the channel's Julia executable. */
  juliaPath: string;
  /**
   * Version string parsed from the channel's version entry (e.g. `"1.11.6"`),
   * or null for linked channels (whose command points at an arbitrary binary).
   */
  version: string | null;
  /** True when this is the `Default` channel. */
  isDefault: boolean;
}

/** Options for {@link installPDVKernel}. */
export interface JuliaInstallOptions {
  /**
   * Directory to stage the bundled `pdv-julia` source into (the `Pkg.develop`
   * target). Must be stable and writable — typically
   * `<userData>/pdv-julia` (§10.7.4). The directory is replaced on every run.
   */
  stagingDir: string;
  /** Window to stream install output chunks to (optional). */
  win?: BrowserWindow;
  /** IPC channel name for streamed output chunks. */
  pushChannel?: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Timeout (ms) for the runtime probe spawn (§10.3's probe budget). */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Hard ceiling (ms) on the PDVKernel install subprocess. Downloading and
 * precompiling IJulia + PDVKernel dependencies takes minutes on a cold
 * machine; anything past this is treated as wedged.
 */
const INSTALL_TIMEOUT_MS = 20 * 60_000;

/** Output markers printed by the probe snippet (§10.7.3). */
const VERSION_MARKER = "PDV_JULIA_VERSION=";
const PDVKERNEL_MARKER = "PDV_PDVKERNEL_VERSION=";
const IJULIA_MARKER = "PDV_IJULIA=";

// ---------------------------------------------------------------------------
// juliaup metadata (filesystem-only — §10.7.1)
// ---------------------------------------------------------------------------

/**
 * Resolve the juliaup metadata directory (`<depot>/juliaup`).
 *
 * Honors the first entry of `JULIA_DEPOT_PATH` when set (an empty first entry
 * means "default depot", per Julia's semantics), falling back to `~/.julia`.
 *
 * @returns Absolute path to the juliaup directory (existence not checked).
 */
export function defaultJuliaupDir(): string {
  const depotVar = process.env.JULIA_DEPOT_PATH;
  const first = depotVar?.split(path.delimiter)[0];
  const depot = first ? first : path.join(os.homedir(), ".julia");
  return path.join(depot, "juliaup");
}

/** Platform-appropriate `bin/julia` inside a Julia installation root. */
function juliaInRoot(root: string): string {
  return process.platform === "win32"
    ? path.join(root, "bin", "julia.exe")
    : path.join(root, "bin", "julia");
}

/**
 * Parse `juliaup.json` and list the installed channels with their real
 * versioned binaries (§10.7.1). The default channel sorts first.
 *
 * @param juliaupDir - juliaup metadata directory; defaults to
 *   {@link defaultJuliaupDir}.
 * @returns Channels whose executable exists on disk; empty when juliaup is
 *   not installed or the metadata is unreadable. Never throws.
 */
export function listJuliaupChannels(
  juliaupDir: string = defaultJuliaupDir()
): JuliaupChannel[] {
  let parsed: {
    Default?: unknown;
    InstalledVersions?: Record<string, { Path?: unknown }>;
    InstalledChannels?: Record<
      string,
      { Version?: unknown; Command?: unknown }
    >;
  };
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(juliaupDir, "juliaup.json"), "utf8")
    );
  } catch {
    return [];
  }

  const defaultChannel =
    typeof parsed.Default === "string" ? parsed.Default : null;
  const versions = parsed.InstalledVersions ?? {};
  const results: JuliaupChannel[] = [];

  for (const [channel, entry] of Object.entries(
    parsed.InstalledChannels ?? {}
  )) {
    let juliaPath: string | null = null;
    let version: string | null = null;
    if (typeof entry.Version === "string") {
      const versionEntry = versions[entry.Version];
      if (typeof versionEntry?.Path === "string") {
        juliaPath = juliaInRoot(path.resolve(juliaupDir, versionEntry.Path));
      }
      // "1.11.6+0.aarch64.apple.darwin14" → "1.11.6"
      version = entry.Version.split("+")[0] ?? null;
    } else if (typeof entry.Command === "string") {
      // `juliaup link <name> <command>` — the command IS the executable.
      juliaPath = entry.Command;
    }
    if (!juliaPath || !fs.existsSync(juliaPath)) continue;
    results.push({
      channel,
      juliaPath,
      version,
      isDefault: channel === defaultChannel,
    });
  }

  results.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return results;
}

/**
 * Resolve a Julia executable path through the juliaup shim (§10.7.2).
 *
 * Follows symlinks; when the resolved target is `julialauncher` (the juliaup
 * shim, which stalls every invocation behind a wedged self-update), returns
 * the default channel's real versioned binary instead. Non-shim paths — and
 * shim paths when juliaup metadata is missing — are returned unchanged, so
 * this is always safe to apply.
 *
 * @param juliaPath - Executable path or bare command name (`"julia"`, resolved
 *   against `PATH`).
 * @param juliaupDir - juliaup metadata directory override (tests).
 * @returns The shim-bypassed absolute path, or the input when no bypass applies.
 */
export function resolveJuliaShim(
  juliaPath: string,
  juliaupDir: string = defaultJuliaupDir()
): string {
  const absolute = path.isAbsolute(juliaPath)
    ? juliaPath
    : findOnPath(juliaPath);
  if (!absolute) return juliaPath;
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return juliaPath;
  }
  const base = path.basename(real).toLowerCase();
  if (base !== "julialauncher" && base !== "julialauncher.exe") {
    // Not the shim — keep the caller's path, upgraded to absolute when it
    // was a bare command name.
    return absolute;
  }
  // The default channel's real binary — a versioned install's Path or a
  // `juliaup link`ed channel's Command (version null; excluding it would
  // defeat the bypass exactly when the user linked their default, PR #347
  // review). Guard against a channel linked back to the shim itself.
  const fallback = listJuliaupChannels(juliaupDir).find((c) => c.isDefault);
  if (!fallback) return juliaPath;
  try {
    const fallbackBase = path
      .basename(fs.realpathSync(fallback.juliaPath))
      .toLowerCase();
    if (fallbackBase === "julialauncher" || fallbackBase === "julialauncher.exe") {
      return juliaPath;
    }
  } catch {
    return juliaPath;
  }
  return fallback.juliaPath;
}

/**
 * Return the juliaup default channel's real binary, or null when juliaup is
 * not installed. Used when no Julia path has been configured yet (§10.7.2) —
 * preferable to falling back to the `julia` PATH shim.
 *
 * @param juliaupDir - juliaup metadata directory override (tests).
 * @returns Absolute executable path, or null.
 */
export function discoverDefaultJulia(
  juliaupDir: string = defaultJuliaupDir()
): string | null {
  const channels = listJuliaupChannels(juliaupDir);
  return (channels.find((c) => c.isDefault) ?? channels[0])?.juliaPath ?? null;
}

// ---------------------------------------------------------------------------
// Probing (§10.7.3)
// ---------------------------------------------------------------------------

/**
 * Build the environment for PDV-managed Julia subprocesses (probes and the
 * PDVKernel install).
 *
 * Strips `JULIA_PROJECT` and `JULIA_LOAD_PATH`: PDV probes and mutates the
 * runtime's *default* environment (`@v#.#`, §10.6.1), and a shell-exported
 * project — common for cluster users — would otherwise redirect
 * `Pkg.develop`/`Pkg.add` into the user's own `Project.toml` (the §10.5.7
 * forbidden mutation) and skew probe results toward whatever that project
 * resolves (PR #347 review M8). Kernel spawns are NOT sanitized — an
 * explicitly exported project is honored for user code, and pkg-mode sets
 * its own `JULIA_PROJECT`.
 *
 * @param extra - Additional variables merged over the sanitized base.
 * @returns A copy of `process.env` without the Julia env-selection vars.
 */
export function sanitizedJuliaEnv(
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.JULIA_PROJECT;
  delete env.JULIA_LOAD_PATH;
  return env;
}

/**
 * The single-spawn probe snippet: prints the Julia version, the PDVKernel
 * version (resolved via `Base.locate_package` + its `Project.toml` — never
 * `using`, which recompiles when caches are stale), and IJulia presence.
 */
const PROBE_SNIPPET = [
  `println("${VERSION_MARKER}", VERSION)`,
  "import TOML",
  'id = Base.identify_package("PDVKernel")',
  "src = id === nothing ? nothing : Base.locate_package(id)",
  "if src !== nothing",
  '    proj = joinpath(dirname(dirname(src)), "Project.toml")',
  `    println("${PDVKERNEL_MARKER}", get(TOML.parsefile(proj), "version", ""))`,
  "end",
  `println("${IJULIA_MARKER}", Base.identify_package("IJulia") === nothing ? "missing" : "ok")`,
].join("; ");

/** Raw result of the combined runtime probe. */
export interface JuliaProbeResult {
  /** Julia `VERSION` string. */
  juliaVersion: string;
  /** Installed PDVKernel version, or null when PDVKernel does not resolve. */
  pdvKernelVersion: string | null;
  /** True when IJulia resolves from the runtime's load path. */
  ijuliaInstalled: boolean;
}

/**
 * Probe a Julia executable with a single short-lived spawn (§10.7.3).
 *
 * @param juliaPath - Path to the Julia executable to probe.
 * @returns Probe result, or null when the executable is missing, exits
 *   non-zero, times out, or prints no version marker. Never throws.
 */
export async function probeJuliaRuntime(
  juliaPath: string
): Promise<JuliaProbeResult | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      juliaPath,
      ["--startup-file=no", "-e", PROBE_SNIPPET],
      { timeout: PROBE_TIMEOUT_MS, env: sanitizedJuliaEnv() }
    ));
  } catch {
    return null;
  }
  const juliaVersion = stdout
    .match(new RegExp(`${VERSION_MARKER}(\\S+)`))?.[1]
    ?.trim();
  if (!juliaVersion) return null;
  const pdvKernelVersion =
    stdout.match(new RegExp(`${PDVKERNEL_MARKER}(\\S+)`))?.[1]?.trim() ?? null;
  const ijuliaInstalled =
    stdout.match(new RegExp(`${IJULIA_MARKER}(\\S+)`))?.[1]?.trim() === "ok";
  return { juliaVersion, pdvKernelVersion, ijuliaInstalled };
}

// ---------------------------------------------------------------------------
// Discovery (assembled list for the selector — §10.7.1)
// ---------------------------------------------------------------------------

/**
 * Module-level cache of the enriched runtime list, mirroring the Python
 * detector's cache. Cleared by {@link clearJuliaRuntimeCache}.
 */
let _cache: JuliaRuntimeInfo[] | null = null;

/**
 * Clear the runtime discovery cache (the selector's Refresh button).
 *
 * @returns Nothing.
 */
export function clearJuliaRuntimeCache(): void {
  _cache = null;
}

/** Well-known non-juliaup Julia locations, checked as discovery fallbacks. */
function systemJuliaCandidates(): string[] {
  const candidates: string[] = [];
  const onPath = findOnPath(
    process.platform === "win32" ? "julia.exe" : "julia"
  );
  if (onPath) candidates.push(onPath);
  candidates.push("/opt/homebrew/bin/julia", "/usr/local/bin/julia");
  // macOS official DMG installs: /Applications/Julia-1.11.app
  if (process.platform === "darwin") {
    try {
      for (const entry of fs.readdirSync("/Applications")) {
        if (/^Julia-.*\.app$/.test(entry)) {
          candidates.push(
            path.join(
              "/Applications",
              entry,
              "Contents",
              "Resources",
              "julia",
              "bin",
              "julia"
            )
          );
        }
      }
    } catch {
      /* no /Applications — fine */
    }
  }
  return candidates;
}

/**
 * List all discovered Julia runtimes, enriched with probe status (§10.7.1).
 *
 * juliaup channels come first (default channel leading), then the configured
 * path and system locations, deduplicated by real executable path. Every
 * candidate is shim-resolved before probing; runtimes whose probe fails are
 * excluded (same policy as the Python detector). Results are cached; call
 * {@link clearJuliaRuntimeCache} to refresh.
 *
 * @param configuredPath - The `juliaPath` from app config, if set.
 * @param juliaupDir - juliaup metadata directory override (tests).
 * @returns Enriched runtime list, ordered by priority.
 */
export async function listJuliaRuntimes(
  configuredPath?: string,
  juliaupDir: string = defaultJuliaupDir()
): Promise<JuliaRuntimeInfo[]> {
  if (_cache !== null) return _cache;

  interface Candidate {
    kind: JuliaRuntimeKind;
    juliaPath: string;
    channel?: string;
    version: string | null;
    isDefault: boolean;
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate): void => {
    let key = c.juliaPath;
    try {
      key = fs.realpathSync(c.juliaPath);
    } catch {
      return; // nonexistent — skip
    }
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };

  for (const ch of listJuliaupChannels(juliaupDir)) {
    add({
      kind: "juliaup",
      juliaPath: ch.juliaPath,
      channel: ch.channel,
      version: ch.version,
      isDefault: ch.isDefault,
    });
  }
  if (configuredPath) {
    const resolved = resolveJuliaShim(configuredPath, juliaupDir);
    add({
      kind: "configured",
      juliaPath: resolved,
      version: null,
      isDefault: false,
    });
  }
  for (const candidate of systemJuliaCandidates()) {
    const resolved = resolveJuliaShim(candidate, juliaupDir);
    add({ kind: "system", juliaPath: resolved, version: null, isDefault: false });
  }

  const probed = await Promise.all(
    candidates.map(async (c) => {
      const probe = await probeJuliaRuntime(c.juliaPath);
      if (!probe) return null;
      return enrichRuntime(c, probe);
    })
  );
  _cache = probed.filter((r): r is JuliaRuntimeInfo => r !== null);
  return _cache;
}

/**
 * Probe a single Julia path and return enriched runtime info, bypassing the
 * cache — used to re-check a selection (post-install badge refresh, Browse).
 *
 * @param juliaPath - Path to the Julia executable (shim-resolved first).
 * @param juliaupDir - juliaup metadata directory override (tests).
 * @returns Enriched runtime info, or null when the path is not a working Julia.
 */
export async function checkJuliaRuntime(
  juliaPath: string,
  juliaupDir: string = defaultJuliaupDir()
): Promise<JuliaRuntimeInfo | null> {
  const resolved = resolveJuliaShim(juliaPath, juliaupDir);
  const probe = await probeJuliaRuntime(resolved);
  if (!probe) return null;
  // Recover the juliaup channel identity when the path is a channel binary,
  // so re-checks keep the same label/kind the discovery list showed.
  const channel = listJuliaupChannels(juliaupDir).find((c) => {
    try {
      return fs.realpathSync(c.juliaPath) === fs.realpathSync(resolved);
    } catch {
      return false;
    }
  });
  return enrichRuntime(
    channel
      ? {
          kind: "juliaup",
          juliaPath: resolved,
          channel: channel.channel,
          version: channel.version,
          isDefault: channel.isDefault,
        }
      : { kind: "configured", juliaPath: resolved, version: null, isDefault: false },
    probe
  );
}

/** Build the enriched {@link JuliaRuntimeInfo} from a candidate + probe. */
function enrichRuntime(
  candidate: {
    kind: JuliaRuntimeKind;
    juliaPath: string;
    channel?: string;
    version: string | null;
    isDefault: boolean;
  },
  probe: JuliaProbeResult
): JuliaRuntimeInfo {
  const appVersion = getAppVersion();
  const installed = probe.pdvKernelVersion !== null;
  const compatible =
    installed &&
    coreVersion(probe.pdvKernelVersion ?? "") === coreVersion(appVersion);
  const juliaVersion = probe.juliaVersion ?? candidate.version;
  return {
    kind: candidate.kind,
    juliaPath: candidate.juliaPath,
    label: makeLabel(candidate, juliaVersion),
    juliaVersion,
    channel: candidate.channel,
    isDefault: candidate.isDefault,
    pdvKernelInstalled: installed,
    pdvKernelVersion: probe.pdvKernelVersion,
    pdvKernelCompatible: compatible,
    pdvKernelVersionMismatch: installed && !compatible,
    ijuliaInstalled: probe.ijuliaInstalled,
  };
}

/** Construct the selector row label for a runtime. */
function makeLabel(
  candidate: { kind: JuliaRuntimeKind; channel?: string; isDefault: boolean },
  juliaVersion: string | null
): string {
  const version = juliaVersion ?? "?";
  switch (candidate.kind) {
    case "juliaup":
      return `juliaup: ${candidate.channel}${candidate.isDefault ? " (default)" : ""} — Julia ${version}`;
    case "configured":
      return `Configured — Julia ${version}`;
    case "system":
      return `System — Julia ${version}`;
  }
}

// ---------------------------------------------------------------------------
// One-click PDVKernel installation (§10.7.4)
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the bundled `pdv-julia` source directory.
 *
 * Packaged builds carry it in `process.resourcesPath`; in development it sits
 * at the repository root (walked up from the compiled `electron/dist/main`).
 *
 * @returns Absolute path to `pdv-julia`, or null when not found.
 */
export function resolveBundledPDVJuliaPath(): string | null {
  if (process.resourcesPath) {
    const candidate = path.join(process.resourcesPath, "pdv-julia");
    if (fs.existsSync(path.join(candidate, "Project.toml"))) return candidate;
  }
  for (let dir = __dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "pdv-julia");
    if (fs.existsSync(path.join(candidate, "Project.toml"))) return candidate;
  }
  return null;
}

/**
 * Install PDVKernel (and IJulia) into a Julia runtime's default environment,
 * streaming output to the renderer (§10.7.4).
 *
 * Stages the bundled `pdv-julia` source into `opts.stagingDir` (replacing any
 * previous staging — an app update re-stages new source in place, and the
 * dev-path pickup is automatic), then runs `Pkg.develop(path=<staged>)`,
 * `Pkg.add("IJulia")`, and a targeted `Pkg.precompile` so the first kernel
 * boot doesn't pay the compile cost blind.
 *
 * Concurrent calls are serialized on a module-level chain: the staging dir
 * is shared, and it is reachable from two uncoordinated paths — a
 * `kernels.start` acquiring a fresh Julia version (under the start lock)
 * and the selector's `environment:juliaInstall` (no lock) — so an
 * unserialized second call could `rmSync` the staged tree out from under a
 * running `Pkg.develop` (second review).
 *
 * @param juliaPath - Target Julia executable (shim-resolve before calling).
 * @param opts - Staging directory and streaming options.
 * @returns Install result; a non-zero exit, spawn failure, staging failure,
 *   or the {@link INSTALL_TIMEOUT_MS} ceiling all resolve with
 *   `success: false`. Never rejects.
 */
export function installPDVKernel(
  juliaPath: string,
  opts: JuliaInstallOptions
): Promise<EnvironmentInstallResult> {
  const run = _installChain.then(() => _installPDVKernelExclusive(juliaPath, opts));
  // The chain must survive a (never-expected) rejection without wedging
  // every later install behind it.
  _installChain = run.catch(() => undefined);
  return run;
}

/** Serialization chain for {@link installPDVKernel} (shared staging dir). */
let _installChain: Promise<unknown> = Promise.resolve();

function _installPDVKernelExclusive(
  juliaPath: string,
  opts: JuliaInstallOptions
): Promise<EnvironmentInstallResult> {
  const bundled = resolveBundledPDVJuliaPath();
  if (!bundled) {
    return Promise.resolve({
      success: false,
      output: "Could not locate the bundled pdv-julia source directory.",
    });
  }
  try {
    fs.rmSync(opts.stagingDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(opts.stagingDir), { recursive: true });
    fs.cpSync(bundled, opts.stagingDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Promise.resolve({
      success: false,
      output: `Failed to stage pdv-julia source into ${opts.stagingDir}: ${msg}`,
    });
  }

  const code = [
    "import Pkg",
    `Pkg.develop(path=${JSON.stringify(opts.stagingDir)})`,
    'Pkg.add("IJulia")',
    'Pkg.precompile(["PDVKernel", "IJulia"])',
  ].join("; ");

  return new Promise((resolve) => {
    const chunks: string[] = [];
    // sanitizedJuliaEnv: a shell-exported JULIA_PROJECT would redirect
    // Pkg.develop/Pkg.add into the user's own project (review M8).
    const proc = spawn(juliaPath, ["--startup-file=no", "-e", code], {
      env: sanitizedJuliaEnv({
        NO_COLOR: "1",
        JULIA_PKG_PROGRESS_BARS: "0",
      }),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: INSTALL_TIMEOUT_MS,
    });

    const sendChunk = (stream: "stdout" | "stderr", data: string): void => {
      chunks.push(data);
      if (opts.win && !opts.win.isDestroyed() && opts.pushChannel) {
        opts.win.webContents.send(opts.pushChannel, { stream, data });
      }
    };

    proc.stdout?.on("data", (buf: Buffer) => sendChunk("stdout", buf.toString()));
    proc.stderr?.on("data", (buf: Buffer) => sendChunk("stderr", buf.toString()));

    proc.on("close", (exitCode) => {
      resolve({ success: exitCode === 0, output: chunks.join("") });
    });
    proc.on("error", (err) => {
      sendChunk("stderr", err.message);
      resolve({ success: false, output: chunks.join("") });
    });
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a bare command name against `PATH`.
 *
 * @param name - Command basename (e.g. `"julia"`).
 * @returns Absolute path to the first existing match, or null.
 */
function findOnPath(name: string): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
