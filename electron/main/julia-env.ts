/**
 * julia-env.ts — Julia per-project environment runner (ARCHITECTURE.md §10.6).
 *
 * The single spawn site for main-process Julia *environment* work — the Pkg
 * sibling of `uv-runner.ts` (§10.5.18's one-module rule): running
 * `Pkg.instantiate` in a project working directory with output streamed over
 * an IPC push channel, and capturing the Julia version for the manifest's
 * `environment.julia_version` field. `Pkg` is a Julia stdlib, so unlike uv
 * there is no binary to bundle or resolve — the session's Julia executable
 * is the environment tooling.
 *
 * Also home to the pkg-mode env-file readers: `listJuliaProjectPackages`
 * (§10.6.8) parses the working directory's `Project.toml` (declared deps +
 * compat) and `Manifest.toml` (resolved versions), and
 * `readManifestJuliaVersion` (§10.7.5) reads the manifest's resolution
 * Julia version for the load-time version check.
 *
 * Non-responsibilities:
 * - Kernel process lifecycle (kernel-manager.ts spawns the kernel itself).
 * - Environment/PDVKernel probing (environment-detector.ts).
 * - In-session package operations (`PDVKernel.install/remove/update` run
 *   inside the kernel, §10.6.8 — dispatched by ipc-register-environment.ts).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { serverSpawn } from "./server/spawn";
import type { PushSender } from "./server/invoke-registry";

import type { ProjectPackage } from "./ipc";
import type { UvOutputChunk } from "./uv-runner";

// `smol-toml` is published as an ES module; the main process is CommonJS, so
// it is loaded via a dynamic `import()` (same pattern as pyproject.ts).
async function _loadTomlParse(): Promise<(text: string) => unknown> {
  const mod = await import("smol-toml");
  return mod.parse;
}

/** Result of a completed (or failed) {@link instantiateJuliaEnvironment}. */
export interface JuliaEnvResult {
  /** True when the instantiate subprocess exited with code 0. */
  success: boolean;
  /** Combined stdout+stderr captured across the whole run. */
  output: string;
  /** Julia `VERSION` reported by the subprocess (e.g. `"1.11.6"`), when it got far enough to print it. */
  juliaVersion?: string;
}

/** Options controlling {@link instantiateJuliaEnvironment}. */
export interface JuliaEnvOptions {
  /** Push sender to stream output chunks to. Omit to capture silently. */
  push?: PushSender;
  /** IPC channel name for streamed output chunks (same shape as uv's). */
  pushChannel?: string;
  /** Abort signal; aborting kills the Julia subprocess. */
  signal?: AbortSignal;
  /**
   * Initial packages for a new project (§10.6.5): when non-empty, the
   * subprocess runs `Pkg.add` with these instead of the bare instantiate,
   * recording them into the fresh project's `Project.toml`. Accepts bare
   * names and REPL-style `Name@version` pins (translated to
   * `Pkg.PackageSpec`, matching `PDVKernel.install`).
   */
  packages?: string[];
  /**
   * Maximum silence (no subprocess output) tolerated before the run is
   * declared hung and killed (§10.8 activity-based deadline). Generous by
   * default (10 min): progress bars are disabled on the piped stream, so a
   * single large artifact download prints nothing until it completes.
   */
  idleTimeoutMs?: number;
  /** Absolute cap on the whole run regardless of activity (default 60 min). */
  hardTimeoutMs?: number;
}

/**
 * Build the Julia `Pkg.PackageSpec(...)` expression for one package spec,
 * translating an optional `Name@version` pin (same contract as
 * `PDVKernel._package_spec` — `Pkg.add(::String)` rejects `@` pins).
 *
 * @param spec - Bare package name or `Name@version`.
 * @returns Julia source for the corresponding `Pkg.PackageSpec` call.
 */
export function juliaPackageSpecExpr(spec: string): string {
  const at = spec.indexOf("@");
  if (at > 0) {
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    return `Pkg.PackageSpec(name=${JSON.stringify(name)}, version=${JSON.stringify(version)})`;
  }
  return `Pkg.PackageSpec(name=${JSON.stringify(spec)})`;
}

/**
 * Sentinel printed by the instantiate snippet so the Julia version can be
 * parsed out of the stream without an extra `julia --version` spawn. Printed
 * *before* the instantiate so the version is captured even when resolution
 * fails.
 */
const VERSION_MARKER = "PDV_JULIA_VERSION=";

/**
 * Run `Pkg.instantiate()` for the project environment at `workingDir`
 * (§10.6.6), streaming output.
 *
 * Spawns `<julia> --project=<workingDir> --startup-file=no -e '...'`. With a
 * satisfied `Manifest.toml` this verifies and exits in about a second; on a
 * cold open it downloads the manifest's package set into the shared depot and
 * precompiles it, streaming progress the whole way (which is why callers run
 * it behind the EnvSyncModal, overlapped with the kernel boot). The snippet
 * prints `VERSION` first so the result carries the Julia version for the
 * manifest's `environment.julia_version` even when instantiate itself fails.
 *
 * The run is bounded by an activity-based deadline (§10.8, PR #347 review):
 * the idle timer resets on every output chunk, so a visibly-working
 * instantiate never times out, but a silently hung one (wedged registry
 * lock, dead network) is killed instead of wedging the caller — the start
 * handler awaits this promise under the launch lock, so an unbounded hang
 * would block every later start/stop/restart until app relaunch.
 *
 * @param workingDir - Project working directory holding `Project.toml`.
 * @param juliaPath - Julia executable to run (the session's kernel binary).
 * @param opts - Streaming/abort/deadline options; see {@link JuliaEnvOptions}.
 * @returns A {@link JuliaEnvResult}. A non-zero exit, spawn failure, abort,
 *   or deadline kill all resolve (never reject) with `success: false`.
 */
export function instantiateJuliaEnvironment(
  workingDir: string,
  juliaPath: string,
  opts: JuliaEnvOptions = {}
): Promise<JuliaEnvResult> {
  // A new project with initial packages runs `Pkg.add` instead of the bare
  // instantiate (§10.6.5) — add resolves, installs, and precompiles, so a
  // separate instantiate would be redundant.
  const pkgOp = opts.packages?.length
    ? `Pkg.add([${opts.packages.map(juliaPackageSpecExpr).join(", ")}])`
    : "Pkg.instantiate()";
  const code =
    `println("${VERSION_MARKER}", VERSION); ` +
    `import Pkg; ${pkgOp}`;
  const args = [`--project=${workingDir}`, "--startup-file=no", "-e", code];

  return new Promise<JuliaEnvResult>((resolve) => {
    const chunks: string[] = [];
    // Plain-text output for the streaming panel, same rationale as uv-runner:
    // Pkg emits ANSI colors and \r-redrawn progress bars on a piped stream.
    const env: Record<string, string | undefined> = {
      ...process.env,
      NO_COLOR: "1",
      JULIA_PKG_PROGRESS_BARS: "0",
    };
    const proc = serverSpawn(juliaPath, args, {
      cwd: workingDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    let settled = false;
    const sendChunk = (stream: "stdout" | "stderr", data: string): void => {
      // A deadline kill settles before the process dies; late chunks from
      // the dying process would stream stale envActivity into whatever the
      // overlay is showing next.
      if (settled) return;
      chunks.push(data);
      resetIdleTimer();
      if (opts.push && opts.pushChannel) {
        opts.push(opts.pushChannel, { stream, data } as UvOutputChunk);
      }
    };

    // Activity-based deadline (§10.8): idle timer resets on every chunk;
    // the hard cap runs regardless. Either firing kills the subprocess and
    // settles the promise immediately — the caller holds the start lock, so
    // waiting for the (possibly unkillable) process to exit is not an option.
    const idleTimeoutMs = opts.idleTimeoutMs ?? 600_000;
    const hardTimeoutMs = opts.hardTimeoutMs ?? 3_600_000;
    let idleTimer: NodeJS.Timeout;
    const onDeadline = (kind: "idle" | "hard"): void => {
      const limit = kind === "idle" ? idleTimeoutMs : hardTimeoutMs;
      sendChunk(
        "stderr",
        `\nPkg.instantiate ${kind === "idle" ? "produced no output for" : "exceeded"} ` +
          `${Math.round(limit / 60_000)} minutes — giving up.\n`
      );
      settle(false);
      proc.kill("SIGTERM");
      // A wedged Pkg (stuck registry lock) can ignore SIGTERM; make sure the
      // orphan actually dies. unref so this never holds the app open.
      setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
    };
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => onDeadline("idle"), idleTimeoutMs);
    };
    resetIdleTimer();
    const hardTimer = setTimeout(() => onDeadline("hard"), hardTimeoutMs);

    proc.stdout?.on("data", (buf: Buffer) => sendChunk("stdout", buf.toString()));
    proc.stderr?.on("data", (buf: Buffer) => sendChunk("stderr", buf.toString()));

    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      const output = chunks.join("");
      resolve({ success, output, juliaVersion: parseJuliaVersion(output) });
    };

    proc.on("close", (exitCode) => settle(exitCode === 0));
    // spawn failure (binary missing/not executable) or abort via opts.signal.
    proc.on("error", (err) => {
      sendChunk("stderr", err.message);
      settle(false);
    });
  });
}

/**
 * Extract the Julia version printed by the {@link VERSION_MARKER} line.
 *
 * @param output - Combined subprocess output.
 * @returns The version string (e.g. `"1.11.6"`), or undefined when absent.
 */
export function parseJuliaVersion(output: string): string | undefined {
  const match = output.match(
    new RegExp(`${VERSION_MARKER}(\\d+\\.\\d+\\.\\d+[^\\s]*)`)
  );
  return match?.[1];
}

/**
 * List a pkg-mode Julia project's declared dependencies for the Packages tab
 * (§10.6.8): names from `Project.toml`'s `[deps]`, the spec enriched with the
 * `[compat]` bound when one is declared, and the installed version from
 * `Manifest.toml` (manifest format 2.0, `[[deps.<Name>]]` entries — stdlib
 * entries carry no version and report undefined).
 *
 * Read-only: every mutation goes through `PDVKernel.install`/`remove`/
 * `update` inside the kernel, which keeps the live session and the files
 * consistent (§10.6.8).
 *
 * @param workingDir - Project working directory holding the env files.
 * @returns Alphabetically sorted package list; empty when `Project.toml` is
 *   missing or unparseable. Never throws.
 */
export async function listJuliaProjectPackages(
  workingDir: string
): Promise<ProjectPackage[]> {
  let project: {
    deps?: Record<string, unknown>;
    compat?: Record<string, unknown>;
  };
  try {
    const parse = await _loadTomlParse();
    project = parse(
      await fs.readFile(path.join(workingDir, "Project.toml"), "utf8")
    ) as typeof project;
  } catch {
    return [];
  }

  // Resolved versions from the manifest — best-effort (a fresh project may
  // not have one yet, and a truncated file must not break the listing).
  const installed = new Map<string, string>();
  try {
    const parse = await _loadTomlParse();
    const manifest = parse(
      await fs.readFile(path.join(workingDir, "Manifest.toml"), "utf8")
    ) as { deps?: Record<string, Array<{ version?: unknown }>> };
    for (const [name, entries] of Object.entries(manifest.deps ?? {})) {
      const version = entries?.[0]?.version;
      if (typeof version === "string") installed.set(name, version);
    }
  } catch {
    /* no manifest yet — versions stay undefined */
  }

  const compat = project.compat ?? {};
  return Object.keys(project.deps ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const bound = compat[name];
      return {
        name,
        spec: typeof bound === "string" ? `${name} ${bound}` : name,
        installedVersion: installed.get(name),
      };
    });
}

/**
 * Read the top-level `julia_version` a project's `Manifest.toml` was
 * resolved with (manifest format 2.0). Feeds the load-time version check
 * (§10.7.5) — juliaup-runner.ts compares it against the installed channels.
 *
 * @param dir - Directory holding `Manifest.toml` (save dir or working dir).
 * @returns The version string (e.g. `"1.10.4"`), or null when the manifest
 *   is missing, unparseable, or predates the field. Never throws.
 */
export async function readManifestJuliaVersion(dir: string): Promise<string | null> {
  try {
    const parse = await _loadTomlParse();
    const manifest = parse(
      await fs.readFile(path.join(dir, "Manifest.toml"), "utf8")
    ) as { julia_version?: unknown };
    return typeof manifest.julia_version === "string" ? manifest.julia_version : null;
  } catch {
    return null;
  }
}
