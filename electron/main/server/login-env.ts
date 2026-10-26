/**
 * login-env.ts — Capture the host's login-shell environment for the daemon.
 *
 * A remote session daemon is spawned from an `ssh <host> '…attach…'` exec
 * channel, which runs a NON-login shell: `~/.bash_profile`, `/etc/profile.d`
 * (and with them Lmod's module system, juliaup's PATH entry, conda's hook)
 * never ran, so interpreters that every interactive shell on the cluster can
 * see are invisible to the daemon and to everything it spawns. This module
 * closes that gap by running ONE login shell at daemon startup —
 * `bash -lc '. setup.sh; env -0 > <file>'` — and applying the captured
 * environment to the daemon's own `process.env`. Every subprocess seam
 * (`server/spawn.ts`) call site already builds its env from `process.env`,
 * so kernels, probes, uv and Pkg all inherit the login environment with no
 * per-spawn cost.
 *
 * Why a one-shot capture instead of wrapping every spawn in `bash -lc`:
 * login shells PRINT — Lmod messages and profile chatter land on stdout
 * before any redirect inside the `-c` string takes effect, and interpreter
 * probes parse stdout with permissive regexes (`resolvePythonMajorMinor`
 * matches the first `\d+.\d+` it sees). Writing `env -0` to a FILE keeps
 * the capture immune to that chatter, and paying the login-shell cost once
 * per daemon rather than per spawn keeps probe latency flat.
 *
 * The optional per-session setup script (`sessions/<id>/setup.sh`, shipped
 * by the shell at session start) is sourced inside the same login shell, so
 * `module load …` lines work exactly as they would typed at a prompt. Its
 * output is discarded — diagnosis belongs to the explicit test channel, not
 * to interleaving with a capture. Environment mutations are the script's
 * entire contract; Lmod is implemented purely in environment variables, so
 * a capture loses nothing a wrapper would have kept. One reservation in
 * that contract: variables named `PDV_*` (and `ELECTRON_RUN_AS_NODE`) are
 * the daemon's own namespace and are silently discarded by
 * {@link applyLoginEnv} — a setup script must not use the prefix for its
 * own exports.
 *
 * This module does NOT run on the shell side, decide when to re-capture
 * (the daemon captures once at boot; edits to the setup script apply on the
 * next session start), or spawn user tools (`spawn.ts` does).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { serverExecFile } from "./spawn";

/** Environment keys the capture must never override or remove. */
const PROTECTED_ENV_PREFIXES = ["PDV_", "ELECTRON_RUN_AS_NODE"];

/**
 * Default budget for the login shell with no setup script. The capture runs
 * before the daemon binds its socket, so the budget must stay well inside
 * the attacher's socket wait (`SPAWN_WAIT_MS`) — a slow profile should
 * degrade to the inherited env, not fail the whole attach.
 */
export const CAPTURE_TIMEOUT_MS = 5_000;

/**
 * Budget when a setup script exists: `module load` lines legitimately take
 * multiple seconds on a contended login node, and a user who configured a
 * script has said the environment matters more than a fast boot. The
 * attacher's socket wait is sized to contain this plus bind overhead.
 */
export const SETUP_CAPTURE_TIMEOUT_MS = 15_000;

/**
 * Sentinel the capture shell exports after sourcing the setup script, so
 * "the script really ran" is evidence read from the capture itself — never
 * inferred from the file existing. Stripped from the returned map.
 */
const SETUP_SOURCED_SENTINEL = "PDV_SETUP_SOURCED";

/** Options for {@link captureLoginEnv}. */
export interface CaptureLoginEnvOptions {
  /**
   * Absolute path of a setup script to source inside the login shell.
   * Sourced only when the file exists; its stdout/stderr are discarded.
   */
  setupScriptPath?: string;
  /** Shell binary. Defaults to `bash` from PATH. Injected by tests. */
  shellPath?: string;
  /**
   * Capture budget in milliseconds. Defaults to {@link CAPTURE_TIMEOUT_MS},
   * or {@link SETUP_CAPTURE_TIMEOUT_MS} when the setup script exists.
   */
  timeoutMs?: number;
}

/** Result of a successful {@link captureLoginEnv}. */
export interface CapturedLoginEnv {
  /** The captured environment map. */
  env: Record<string, string>;
  /**
   * True when the setup script was really sourced — evidence from a
   * sentinel the capture shell exports after the `.` line, not a guess
   * from the file existing on disk.
   */
  setupScriptSourced: boolean;
}

/**
 * Run one login shell and capture the environment it ends with.
 *
 * @param options - Setup script and timeout options.
 * @returns The captured environment plus sourcing evidence, or `null` when
 *   the capture failed (no bash, profile hung past the budget, unwritable
 *   temp dir, win32). Failure is survivable by design: the daemon then runs
 *   with its inherited environment, exactly as it did before this module
 *   existed — but the caller must surface it when a setup script was
 *   configured, because then the user explicitly asked for an environment
 *   they are not getting.
 */
export async function captureLoginEnv(
  options: CaptureLoginEnvOptions = {},
): Promise<CapturedLoginEnv | null> {
  if (process.platform === "win32") return null;

  const outPath = path.join(
    os.tmpdir(),
    `pdv-login-env-${process.pid}-${Date.now()}.tmp`,
  );
  const setupScriptExists =
    !!options.setupScriptPath && fs.existsSync(options.setupScriptPath);
  // The script and output paths travel as environment variables, never
  // spliced into the shell string: quoting inside a nested shell is exactly
  // the class of computed-vs-OS bug the remote work keeps hitting.
  const script =
    'if [ -n "$PDV_SETUP_SCRIPT" ] && [ -f "$PDV_SETUP_SCRIPT" ]; then' +
    ` . "$PDV_SETUP_SCRIPT" >/dev/null 2>&1; export ${SETUP_SOURCED_SENTINEL}=1;` +
    ' fi; env -0 > "$PDV_ENV_OUT"';

  try {
    await serverExecFile(options.shellPath ?? "bash", ["-lc", script], {
      timeout:
        options.timeoutMs ??
        (setupScriptExists ? SETUP_CAPTURE_TIMEOUT_MS : CAPTURE_TIMEOUT_MS),
      env: {
        ...process.env,
        PDV_SETUP_SCRIPT: options.setupScriptPath ?? "",
        PDV_ENV_OUT: outPath,
      },
    });
    const env = parseNulEnv(fs.readFileSync(outPath, "utf8"));
    const setupScriptSourced = env[SETUP_SOURCED_SENTINEL] === "1";
    delete env[SETUP_SOURCED_SENTINEL];
    // The capture's own plumbing variables must not read as "the login
    // environment" (they would be discarded by applyLoginEnv anyway, but
    // returning them would mislead any other consumer of the map).
    delete env.PDV_SETUP_SCRIPT;
    delete env.PDV_ENV_OUT;
    return { env, setupScriptSourced };
  } catch (err) {
    console.error(
      `[login-env] capture failed; continuing with the inherited environment: ` +
        `${(err as Error).message}`,
    );
    return null;
  } finally {
    try {
      fs.unlinkSync(outPath);
    } catch {
      // Never written, or already gone.
    }
  }
}

/**
 * Apply a captured environment to this process.
 *
 * Every captured variable is assigned onto `process.env` except protected
 * keys (`PDV_*`, `ELECTRON_RUN_AS_NODE`): those carry the daemon's own
 * contract (resources root, zeromq path, version) and a user profile that
 * exports one must lose to the values the daemon was started with.
 * Variables present in `process.env` but absent from the capture are left
 * alone — a profile cannot *remove* daemon state, only add to it.
 *
 * @param captured - Map from {@link captureLoginEnv}.
 * @returns The number of variables that were added or changed.
 */
export function applyLoginEnv(captured: Record<string, string>): number {
  let changed = 0;
  for (const [key, value] of Object.entries(captured)) {
    if (PROTECTED_ENV_PREFIXES.some((p) => key === p || key.startsWith(p))) {
      continue;
    }
    if (process.env[key] !== value) {
      process.env[key] = value;
      changed += 1;
    }
  }
  return changed;
}

/**
 * Parse `env -0` output into a map.
 *
 * NUL separation is what makes this parse exact: environment values may
 * contain newlines (bash functions exported via `BASH_FUNC_*`, multi-line
 * module variables), so a line-based parse would corrupt them.
 *
 * @param raw - Raw `env -0` output.
 * @returns Map of environment variables.
 */
export function parseNulEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}
