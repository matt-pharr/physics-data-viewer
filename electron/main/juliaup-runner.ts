/**
 * juliaup-runner.ts — The single entry point for invoking the user's
 * `juliaup` binary from the main process (ARCHITECTURE.md §10.7.5).
 *
 * PDV drives the *user's* juliaup and never bundles one: unlike uv (hot
 * path, stateless), juliaup is needed only for rare, explicit
 * version-acquisition events and owns persistent user-global state
 * (`<depot>/juliaup/juliaup.json`, shims, self-update) — a second binary
 * co-managing that state is the same wedge class the §10.7.2 shim bypass
 * exists to avoid.
 *
 * Responsibilities:
 *  - Locate the user's `juliaup` executable (PATH plus the official
 *    installer's `~/.juliaup/bin` and common Homebrew locations).
 *  - Acquire Julia versions: `juliaup add <channel>` with output streamed
 *    (ANSI-stripped, §10.8) to a renderer window over an IPC push channel.
 *  - One-click juliaup bootstrap when absent: run the official installer
 *    script (`curl -fsSL https://install.julialang.org | sh -s -- --yes`),
 *    which also installs a default Julia — covering the nothing-installed
 *    case with a single, standard, self-owned juliaup.
 *  - Assess a pkg-mode project's `Manifest.toml` `julia_version` against
 *    the installed channels for the load-time "Install Julia X.Y?" offer
 *    (§10.7.5).
 *  - Make a requested Julia minor fully launchable for the New-Julia-Project
 *    version choice (`ensureJuliaVersionReady`, §10.6.5): acquire it with
 *    `juliaup add` and give its default environment PDVKernel/IJulia via the
 *    §10.7.4 one-click install when needed.
 *
 * What this file does NOT do:
 *  - It does not discover/probe Julia runtimes (julia-discovery.ts) or run
 *    per-project `Pkg` work (julia-env.ts).
 *  - It does not decide *when* to acquire a version — the environment
 *    selector and the project-load flow own that policy.
 */

import * as fs from "fs";
import * as os from "os";
import { serverSpawn } from "./server/spawn";
import * as path from "path";
import type { PushSender } from "./server/invoke-registry";

import type { EnvironmentInstallResult } from "./environment-detector";
import {
  checkJuliaRuntime,
  installPDVKernel,
  listJuliaupChannels,
} from "./julia-discovery";
import { readManifestJuliaVersion } from "./julia-env";
import { plainStreamText } from "./kernel-error-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Presence report for the user's juliaup installation (§10.7.5). */
export interface JuliaupStatus {
  /** True when a juliaup executable was found. */
  installed: boolean;
  /** Absolute path to the juliaup executable, or null when absent. */
  juliaupPath: string | null;
}

/** Options controlling a streamed juliaup/installer subprocess. */
export interface JuliaupRunOptions {
  /** Push sender to stream output chunks to. Omit to capture silently. */
  push?: PushSender;
  /** IPC channel name for streamed output chunks (installOutput shape). */
  pushChannel?: string;
  /** Extra environment variables merged over `process.env` (tests). */
  env?: Record<string, string>;
  /** Override the resolved juliaup binary (tests / pre-resolved callers). */
  binaryPath?: string;
  /** Home-directory override for juliaup resolution (tests). */
  homeDir?: string;
}

/**
 * Load-time Julia version assessment for a pkg-mode project (§10.7.5):
 * the manifest's resolution version versus what juliaup has installed.
 * Only produced when the project's minor differs from the running session's.
 */
export interface JuliaVersionLoadCheck {
  /** `julia_version` recorded in the project's `Manifest.toml` (e.g. `"1.10.4"`). */
  manifestVersion: string;
  /** The juliaup channel that would provide it (`"1.10"` — the `major.minor`). */
  channel: string;
  /** Julia version the session is running, when known. */
  runningVersion?: string;
  /** True when an installed juliaup channel already provides that minor. */
  channelInstalled: boolean;
  /** True when juliaup itself is installed (the offer needs it). */
  juliaupInstalled: boolean;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Hard ceiling (ms) on acquisition subprocesses. `juliaup add` downloads a
 * full Julia distribution and the installer script additionally bootstraps
 * juliaup itself; anything past this is treated as wedged.
 */
const ACQUIRE_TIMEOUT_MS = 20 * 60_000;

/**
 * The official juliaup installer invocation (https://julialang.org/install/).
 * `--yes` accepts the defaults non-interactively; the script installs
 * juliaup *and* a default Julia (`release` channel). Exported so the
 * settings UI and tests can show/verify exactly what will run.
 */
export const JULIAUP_INSTALL_COMMAND =
  "curl -fsSL https://install.julialang.org | sh -s -- --yes";

/**
 * Channel-name shape accepted by {@link juliaupAdd}: `release`, `lts`,
 * `rc`, `1.10`, `1.10.4`, `1.10~x64`, `nightly`, ... Rejects anything that
 * could not be a juliaup channel (defense against a malformed renderer
 * payload reaching the spawn argv).
 */
const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9.+~_-]*$/;

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Locate the user's `juliaup` executable.
 *
 * Checks `PATH` first, then the official installer's `~/.juliaup/bin`
 * (GUI apps on macOS often miss the shell-rc `PATH` entry the installer
 * adds), then Homebrew locations.
 *
 * @param homeDir - Home directory override (tests); defaults to `os.homedir()`.
 * @returns Absolute path to `juliaup`, or null when not installed.
 */
export function findJuliaupBinary(homeDir: string = os.homedir()): string | null {
  const exe = process.platform === "win32" ? "juliaup.exe" : "juliaup";
  const onPath = findOnPath(exe);
  if (onPath) return onPath;
  const candidates = [
    path.join(homeDir, ".juliaup", "bin", exe),
    "/opt/homebrew/bin/juliaup",
    "/usr/local/bin/juliaup",
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Report whether juliaup is installed and where (§10.7.5). The environment
 * selector gates its version-management affordances on this.
 *
 * @param homeDir - Home directory override (tests).
 * @returns The {@link JuliaupStatus}. Never throws.
 */
export function juliaupStatus(homeDir: string = os.homedir()): JuliaupStatus {
  const juliaupPath = findJuliaupBinary(homeDir);
  return { installed: juliaupPath !== null, juliaupPath };
}

// ---------------------------------------------------------------------------
// Acquisition (§10.7.5)
// ---------------------------------------------------------------------------

/**
 * Install a Julia version: `juliaup add <channel>`, streaming output.
 *
 * The subprocess runs with `NO_COLOR` and its output is additionally
 * normalized through {@link plainStreamText} (§10.8) — the streaming panes
 * are plain `<pre>` elements. The acquisition is an explicit, rare event;
 * the wedge-prone part of juliaup (the shim's implicit self-update) is
 * never involved.
 *
 * @param channel - juliaup channel to add (`"1.10"`, `"lts"`, `"1.10.4"`, ...).
 * @param opts - Streaming options and binary override.
 * @returns Install result; an unknown channel, missing juliaup, non-zero
 *   exit, or the 20-minute ceiling all resolve with `success: false`.
 *   Never rejects.
 */
export function juliaupAdd(
  channel: string,
  opts: JuliaupRunOptions = {}
): Promise<EnvironmentInstallResult> {
  if (!CHANNEL_RE.test(channel)) {
    return Promise.resolve({
      success: false,
      output: `Not a valid juliaup channel: ${JSON.stringify(channel)}`,
    });
  }
  const juliaup = opts.binaryPath ?? findJuliaupBinary(opts.homeDir);
  if (!juliaup) {
    return Promise.resolve({
      success: false,
      output:
        "juliaup is not installed. Install it from Settings → Runtime " +
        "(or https://julialang.org/install/) first.",
    });
  }
  return runStreamed(juliaup, ["add", channel], opts);
}

/**
 * Bootstrap juliaup via the official installer script
 * ({@link JULIAUP_INSTALL_COMMAND}), streaming output (§10.7.5).
 *
 * The script also installs a default Julia (`release`), so this covers the
 * nothing-installed first run. PDV never bundles juliaup — this hands the
 * machine a single, standard, self-owned installation.
 *
 * @param opts - Streaming options. `opts.env` can prepend a `PATH` (tests).
 * @returns Install result; on Windows resolves `success: false` with
 *   Microsoft Store guidance (the official Windows distribution channel).
 *   Never rejects.
 */
export function installJuliaup(
  opts: JuliaupRunOptions = {}
): Promise<EnvironmentInstallResult> {
  if (process.platform === "win32") {
    return Promise.resolve({
      success: false,
      output:
        "On Windows, install juliaup from the Microsoft Store or with " +
        "`winget install julia -s msstore`, then click Refresh.",
    });
  }
  return runStreamed("/bin/sh", ["-c", JULIAUP_INSTALL_COMMAND], opts);
}

/** Options for {@link ensureJuliaVersionReady}. */
export interface EnsureJuliaVersionOptions extends JuliaupRunOptions {
  /**
   * Staging directory for a PDVKernel install into a freshly-acquired
   * version's default environment (see {@link installPDVKernel}) —
   * typically `<userData>/pdv-julia`.
   */
  stagingDir: string;
  /** juliaup metadata directory override (tests). */
  juliaupDir?: string;
}

/**
 * Make a Julia minor version fully launchable, acquiring whatever is
 * missing (§10.6.5's New-Julia-Project version choice — the uv analog:
 * "downloaded automatically if not already installed"):
 *
 * 1. When no installed juliaup channel provides the minor, run
 *    `juliaup add <minor>` (streamed).
 * 2. When the version's default environment lacks a compatible PDVKernel or
 *    IJulia, run the one-click install into it (§10.7.4, streamed).
 *
 * @param minor - Requested Julia minor (e.g. `"1.10"`).
 * @param opts - Staging dir, streaming options, and test overrides.
 * @returns Absolute path to the ready version's real Julia binary.
 * @throws {Error} When juliaup is absent and the version is not installed,
 *   or when acquisition/PDVKernel installation fails — with the streamed
 *   output's tail in the message so the launch overlay shows the cause.
 */
export async function ensureJuliaVersionReady(
  minor: string,
  opts: EnsureJuliaVersionOptions
): Promise<string> {
  const findChannel = () =>
    listJuliaupChannels(opts.juliaupDir).find(
      (c) => c.version !== null && juliaMinor(c.version) === minor
    );

  let channel = findChannel();
  if (!channel) {
    // An explicit binaryPath counts as juliaup being available — it is what
    // juliaupAdd below will actually run. Gating on the home-dir/PATH probe
    // alone would refuse a configured (or test-stubbed) juliaup on machines
    // where the standard install locations are empty.
    if (opts.binaryPath === undefined && !juliaupStatus(opts.homeDir).installed) {
      throw new Error(
        `Julia ${minor} is not installed and juliaup was not found. ` +
          "Install juliaup from Settings → Runtime → Julia first."
      );
    }
    const added = await juliaupAdd(minor, opts);
    channel = findChannel();
    if (!added.success || !channel) {
      throw new Error(
        `juliaup add ${minor} failed:\n${tailOf(added.output)}`
      );
    }
  }

  // A freshly-acquired minor has its own default environment (`@v1.x`) —
  // give it PDVKernel/IJulia the same way the selector's one-click does.
  const info = await checkJuliaRuntime(channel.juliaPath, opts.juliaupDir);
  const ready =
    info?.pdvKernelInstalled && info.pdvKernelCompatible && info.ijuliaInstalled;
  if (!ready) {
    const installed = await installPDVKernel(channel.juliaPath, {
      stagingDir: opts.stagingDir,
      push: opts.push,
      pushChannel: opts.pushChannel,
    });
    if (!installed.success) {
      throw new Error(
        `Installing PDVKernel into Julia ${minor} failed:\n${tailOf(installed.output)}`
      );
    }
  }
  return channel.juliaPath;
}

/** Last ~15 lines of a streamed output blob, for error messages. */
function tailOf(output: string): string {
  return output.trim().split("\n").slice(-15).join("\n");
}

// ---------------------------------------------------------------------------
// Load-time version assessment (§10.7.5)
// ---------------------------------------------------------------------------

/**
 * Extract the `major.minor` prefix of a Julia version string.
 *
 * @param version - Full or partial version (`"1.10.4"`, `"1.10"`).
 * @returns `"major.minor"` (e.g. `"1.10"`), or null when the string does
 *   not start with `major.minor`.
 */
export function juliaMinor(version: string): string | null {
  const match = version.match(/^(\d+\.\d+)(?:\.|$|[+-])/);
  return match?.[1] ?? null;
}

/**
 * Compare a pkg-mode project's `Manifest.toml` `julia_version` against the
 * running session and the installed juliaup channels (§10.7.5).
 *
 * Drives the load-time offer: when the project was resolved with a Julia
 * minor that differs from the session's, the renderer either points the
 * user at the already-installed matching channel or offers to
 * `juliaup add` it. Julia re-resolves cross-version rather than breaking
 * (§10.6.6), so this never blocks the load.
 *
 * @param saveDir - Project save directory holding `Manifest.toml`.
 * @param runningVersion - Julia version of the live session, when known.
 * @param overrides - Test seams for the juliaup metadata dir and home dir.
 * @returns The assessment, or undefined when there is nothing to say (no
 *   manifest version, or the minor matches the session). Never throws.
 */
export async function checkJuliaVersionForLoad(
  saveDir: string,
  runningVersion?: string,
  overrides: { juliaupDir?: string; homeDir?: string } = {}
): Promise<JuliaVersionLoadCheck | undefined> {
  const manifestVersion = await readManifestJuliaVersion(saveDir);
  if (!manifestVersion) return undefined;
  const wantMinor = juliaMinor(manifestVersion);
  if (!wantMinor) return undefined;
  if (runningVersion && juliaMinor(runningVersion) === wantMinor) {
    return undefined;
  }
  const channels = listJuliaupChannels(overrides.juliaupDir);
  const channelInstalled = channels.some(
    (c) => c.version !== null && juliaMinor(c.version) === wantMinor
  );
  return {
    manifestVersion,
    channel: wantMinor,
    runningVersion,
    channelInstalled,
    juliaupInstalled: juliaupStatus(overrides.homeDir).installed,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a subprocess and stream its (ANSI-stripped) output, resolving with
 * an install-style result. Shared by {@link juliaupAdd} and
 * {@link installJuliaup}.
 */
function runStreamed(
  file: string,
  args: string[],
  opts: JuliaupRunOptions
): Promise<EnvironmentInstallResult> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const proc = serverSpawn(file, args, {
      env: { ...process.env, NO_COLOR: "1", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: ACQUIRE_TIMEOUT_MS,
    });

    const sendChunk = (stream: "stdout" | "stderr", data: string): void => {
      const plain = plainStreamText(data);
      if (!plain) return;
      chunks.push(plain);
      if (opts.push && opts.pushChannel) {
        opts.push(opts.pushChannel, { stream, data: plain });
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

/**
 * Resolve a bare command name against `PATH`.
 *
 * @param name - Command basename (e.g. `"juliaup"`).
 * @returns Absolute path to the first executable match, or null.
 */
function findOnPath(name: string): string | null {
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
