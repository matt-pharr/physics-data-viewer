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
 * Non-responsibilities:
 * - Kernel process lifecycle (kernel-manager.ts spawns the kernel itself).
 * - Environment/PDVKernel probing (environment-detector.ts).
 * - In-session package operations (`PDVKernel.install/remove/update` run
 *   inside the kernel, §10.6.8).
 */

import { spawn } from "child_process";
import { BrowserWindow } from "electron";

import type { UvOutputChunk } from "./uv-runner";

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
  /** Window to stream output chunks to. Omit to capture silently. */
  win?: BrowserWindow;
  /** IPC channel name for streamed output chunks (same shape as uv's). */
  pushChannel?: string;
  /** Abort signal; aborting kills the Julia subprocess. */
  signal?: AbortSignal;
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
 * @param workingDir - Project working directory holding `Project.toml`.
 * @param juliaPath - Julia executable to run (the session's kernel binary).
 * @param opts - Streaming/abort options; see {@link JuliaEnvOptions}.
 * @returns A {@link JuliaEnvResult}. A non-zero exit, spawn failure, or abort
 *   all resolve (never reject) with `success: false`.
 */
export function instantiateJuliaEnvironment(
  workingDir: string,
  juliaPath: string,
  opts: JuliaEnvOptions = {}
): Promise<JuliaEnvResult> {
  const code =
    `println("${VERSION_MARKER}", VERSION); ` +
    "import Pkg; Pkg.instantiate()";
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
    const proc = spawn(juliaPath, args, {
      cwd: workingDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    const sendChunk = (stream: "stdout" | "stderr", data: string): void => {
      chunks.push(data);
      if (opts.win && !opts.win.isDestroyed() && opts.pushChannel) {
        opts.win.webContents.send(opts.pushChannel, { stream, data } as UvOutputChunk);
      }
    };

    proc.stdout?.on("data", (buf: Buffer) => sendChunk("stdout", buf.toString()));
    proc.stderr?.on("data", (buf: Buffer) => sendChunk("stderr", buf.toString()));

    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
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
