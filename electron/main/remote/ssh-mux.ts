/**
 * ssh-mux.ts — Run commands on a remote host over a multiplexed `ssh`
 * connection, and tell the interesting failures apart.
 *
 * Every remote interaction PDV performs after authentication — the bootstrap
 * probe, the bundle upload, the self-check, attaching to a session — is a
 * channel on one shared ControlMaster. Multiplexing is not an optimization
 * here: with the user's keys behind a 1Password agent, *every new master*
 * costs an approval tap, so one master per host turns "approve constantly"
 * into "approve once".
 *
 * Two rules drive the design and both come from observed behaviour rather
 * than from the manual:
 *
 * 1. **Reuse the user's own master when they have one.** A host configured
 *    with `ControlMaster auto` already has a socket; opening a competing one
 *    would authenticate a second time for nothing. {@link resolveSshControl}
 *    asks `ssh -O check` first and only falls back to a PDV-owned socket.
 * 2. **`ssh` exits 255 for both "I failed" and "the remote command exited
 *    255".** The two need completely different handling — one is a
 *    reconnect, the other is a remote error to surface — so commands are
 *    wrapped to print an exit sentinel, and an unexplained 255 is arbitrated
 *    by re-checking the master rather than by matching stderr text. stderr
 *    patterns only refine an answer the ladder already reached.
 *
 * Responsibilities
 * - Decide which control socket a host's channels should use.
 * - Probe master liveness (`-O check`) and tear a master down (`-O stop`).
 * - Run a remote command and report a trustworthy exit code, or a classified
 *   failure when the command never ran.
 *
 * What it does NOT do
 * - Authenticate. Establishing a master that needs a passphrase, a password
 *   or a Duo push requires a terminal; that is `ssh-pty.ts`'s job. Everything
 *   here assumes a master already exists, or that the host authenticates
 *   non-interactively.
 * - Carry the RPC stream. Session traffic gets its own long-lived channel
 *   with raw stdio, not the buffered request/response of {@link execViaSsh}.
 * - Interpret ssh config. See `ssh-config.ts` for why that stays with `ssh`.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.7
 */

import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Practical ceiling for an AF_UNIX socket path.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux; ssh fails
 * with a truncation error rather than a clear message when the ControlPath
 * exceeds it. Electron's userData path plus a cluster hostname gets close
 * enough that this needs an explicit guard, so PDV hashes the host and falls
 * back to the temp dir when even that does not fit.
 */
const MAX_CONTROL_PATH_BYTES = 100;

/** Default seconds to wait for a channel to reach the host. */
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 30;

/** Default milliseconds before a remote command is abandoned. */
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/** How a host's channels reach their ControlMaster. */
export interface SshControl {
  /** The alias or `user@host` destination passed to `ssh`. */
  host: string;
  /**
   * Explicit `-o ControlPath` for PDV's own master, or null to use whatever
   * the user's ssh config specifies (they already run a master for this
   * host and PDV should ride it rather than open a second one).
   */
  controlPath: string | null;
}

/** Whether a ControlMaster is currently answering. */
export type MasterState =
  /** `-O check` succeeded: a master is alive and usable. */
  | "alive"
  /** No socket, or a socket nothing is listening on. */
  | "absent"
  /** ssh declined to answer — e.g. no ControlPath configured at all. */
  | "unconfigured"
  /** `-O check` failed in a way that does not distinguish the above. */
  | "unknown";

/** Why a remote command did not produce a trustworthy exit code. */
export type SshFailureKind =
  /** The master is gone; the user must authenticate again. */
  | "master-lost"
  /** The master is alive but refused this channel — worth retrying. */
  | "channel-failed"
  /** ssh could not authenticate (and had no way to ask the user). */
  | "auth-required"
  /** The `ssh` binary could not be spawned at all. */
  | "spawn-failed"
  /** The command exceeded its deadline and was killed. */
  | "timeout";

/** Outcome of {@link execViaSsh}. */
export interface SshExecResult {
  /** True when the remote command ran and exited zero. */
  ok: boolean;
  /**
   * The remote command's exit status, or null when it never ran. Non-null
   * means the exit sentinel was seen, so this is the remote shell's status
   * and never ssh's own.
   */
  exitCode: number | null;
  /** Remote stdout with the exit sentinel line removed. */
  stdout: string;
  /** Remote stderr, including any login banner or module-system chatter. */
  stderr: string;
  /** Set when the command never ran; null when `exitCode` is authoritative. */
  failure: SshFailureKind | null;
}

/** Shared options for the `ssh` invocations in this module. */
export interface SshMuxOptions {
  /** `ssh` binary to run. Defaults to `ssh` on PATH. Injected by tests. */
  sshPath?: string;
  /** Seconds passed as `ConnectTimeout`. */
  connectTimeoutSeconds?: number;
  /**
   * Refuse to prompt for credentials. Correct for automatic retries and
   * background probes; wrong for a user-initiated first connect, which
   * must be able to ask. Defaults to true — the interactive path goes
   * through a pty and does not use this module.
   */
  batchMode?: boolean;
  /** Milliseconds before {@link execViaSsh} kills the command. */
  timeoutMs?: number;
}

/** Result of a raw `ssh` spawn, before any interpretation. */
interface RawRun {
  /** ssh's own exit status, or null when it was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed for exceeding its deadline. */
  timedOut: boolean;
  /** Set when the binary could not be spawned. */
  spawnError: Error | null;
}

/**
 * Run `ssh` with the given arguments and collect its output.
 *
 * Resolves for every outcome, including a spawn failure — callers classify.
 * The environment is inherited unmodified on purpose: a host whose config
 * uses `ProxyCommand` runs a *local* helper script, and a sanitized PATH
 * would break the VPN hop before ssh ever reaches the network.
 *
 * @param args - Arguments after the binary name.
 * @param options - Binary path and timeout.
 * @returns The raw run, never rejected.
 */
function runSsh(args: string[], options: SshMuxOptions): Promise<RawRun> {
  const binary = options.sshPath ?? "ssh";
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  return new Promise<RawRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const settle = (run: RawRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString();
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on("error", (error: Error) => {
      settle({ code: null, stdout, stderr, timedOut, spawnError: error });
    });
    child.on("close", (code) => {
      settle({ code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

/**
 * Build the `-o` flags every PDV-issued ssh command carries.
 *
 * `RemoteCommand=none` is the non-obvious one: a host whose config sets
 * `RemoteCommand` (to launch a different login shell, say) would otherwise
 * run *that* instead of the command PDV asked for, turning a probe into a
 * hung interactive shell.
 *
 * Exported so the bootstrap's file upload — which needs its own spawn to
 * stream stdin — reaches the host over the same multiplexed connection with
 * the same guarantees, rather than opening a second one.
 *
 * @param control - The host and its control socket.
 * @param options - Timeout and batch-mode preferences.
 * @returns Flags in `-o key=value` form, ready to precede the destination.
 */
export function baseSshArgs(control: SshControl, options: SshMuxOptions): string[] {
  const args = [
    "-o",
    `ConnectTimeout=${options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS}`,
    "-o",
    "RemoteCommand=none",
    "-o",
    "RequestTTY=no",
  ];
  if (options.batchMode !== false) {
    args.push("-o", "BatchMode=yes");
  }
  if (control.controlPath) {
    args.push("-o", controlPathOption(control.controlPath));
  }
  return args;
}

/**
 * Compute the path of PDV's own ControlMaster socket for a host.
 *
 * The host is hashed rather than embedded so the path length is fixed and
 * independent of how long a cluster's alias is, and so an alias containing a
 * path separator cannot escape the directory.
 *
 * @param host - The ssh destination.
 * @param controlDir - Preferred directory (typically under Electron userData).
 * @returns An absolute socket path that fits the platform's `sun_path` limit.
 */
export function controlPathFor(host: string, controlDir: string): string {
  const digest = crypto.createHash("sha256").update(host).digest("hex").slice(0, 16);
  const name = `m-${digest}`;
  const preferred = path.join(controlDir, name);
  if (Buffer.byteLength(preferred) <= MAX_CONTROL_PATH_BYTES) {
    return preferred;
  }
  // A userData path deep enough to overflow is rare but real (long macOS
  // user names, redirected profiles). Falling back keeps the connection
  // working; the socket is per-uid and recreated on demand either way.
  return path.join(os.tmpdir(), `pdv-${process.getuid?.() ?? 0}-${name}`);
}

/**
 * Build the `-o ControlPath=…` argument for a socket path.
 *
 * ssh parses an `-o` value as config-file syntax and splits it on
 * whitespace, so an unquoted path containing a space is rejected outright:
 *
 *   command-line line 0: keyword controlpath extra arguments at end of line
 *
 * That is not an exotic case. PDV's control sockets live under Electron's
 * userData directory, which on macOS is `~/Library/Application Support/…` —
 * so every macOS install hits it. Quoting is what ssh_config specifies for
 * values containing spaces, and is harmless for values without.
 *
 * @param controlPath - Absolute path to the control socket.
 * @returns The option string, quoted so spaces survive ssh's parser.
 */
export function controlPathOption(controlPath: string): string {
  return `ControlPath="${controlPath}"`;
}

/**
 * Create the directory that will hold PDV's control sockets.
 *
 * @param controlDir - Directory to create (owner-only).
 * @returns Nothing.
 * @throws {Error} When the directory cannot be created.
 */
export function ensureControlDir(controlDir: string): void {
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
}

/**
 * Ask whether a ControlMaster is alive.
 *
 * @param control - Host and control socket to check. A null `controlPath`
 *   checks whatever the user's own ssh config specifies.
 * @param options - Binary path and timeouts.
 * @returns The master's state; `unconfigured` when the host has no
 *   ControlPath at all, which is how a plain host answers.
 */
export async function checkMaster(
  control: SshControl,
  options: SshMuxOptions = {},
): Promise<MasterState> {
  const args = [...baseSshArgs(control, options), "-O", "check", control.host];
  const run = await runSsh(args, options);
  if (run.spawnError || run.timedOut) return "unknown";
  if (run.code === 0) return "alive";
  const stderr = run.stderr;
  if (/No ControlPath specified/i.test(stderr)) return "unconfigured";
  if (
    /Control socket connect\(/i.test(stderr) ||
    /No such file or directory/i.test(stderr) ||
    /Connection refused/i.test(stderr)
  ) {
    return "absent";
  }
  return "unknown";
}

/**
 * Decide which control socket a host's channels should use.
 *
 * Prefers a master the user already runs, so PDV inherits an authenticated
 * connection instead of prompting for a second one.
 *
 * @param host - The ssh destination.
 * @param controlDir - Directory for PDV's own socket, used when the user has none.
 * @param options - Binary path and timeouts.
 * @returns The control to use, and whether an authenticated master already answers.
 */
export async function resolveSshControl(
  host: string,
  controlDir: string,
  options: SshMuxOptions = {},
): Promise<{ control: SshControl; masterState: MasterState }> {
  const inherited: SshControl = { host, controlPath: null };
  const userState = await checkMaster(inherited, options);
  if (userState === "alive") {
    return { control: inherited, masterState: "alive" };
  }
  const own: SshControl = { host, controlPath: controlPathFor(host, controlDir) };
  const ownState = await checkMaster(own, options);
  return { control: own, masterState: ownState };
}

/**
 * Shut down a ControlMaster PDV owns.
 *
 * @param control - Host and control socket.
 * @param options - Binary path and timeouts.
 * @returns True when ssh reported the master stopped.
 */
export async function stopMaster(
  control: SshControl,
  options: SshMuxOptions = {},
): Promise<boolean> {
  const args = [...baseSshArgs(control, options), "-O", "stop", control.host];
  const run = await runSsh(args, options);
  return run.code === 0;
}

/**
 * Wrap a remote command so its exit status arrives in-band.
 *
 * The wrapper prints one JSON line after the command finishes. Matching on
 * that line (and its nonce) rather than on ssh's exit status is what makes
 * "the remote command exited 255" distinguishable from "ssh itself failed",
 * and it is immune to login banners and module-system chatter because those
 * never carry the nonce.
 *
 * The command runs inside a subshell so that a script ending in `exit` —
 * which every self-respecting probe script does — terminates the subshell
 * rather than the login shell, leaving the sentinel to print. Without this,
 * an explicit exit reports as "the command never ran".
 *
 * @param command - The remote shell command.
 * @param nonce - A unique token echoed in the sentinel.
 * @returns Shell source to pass to `ssh`.
 */
function wrapWithSentinel(command: string, nonce: string): string {
  return [
    "(",
    command,
    ")",
    "__pdv_rc=$?",
    `printf '{"pdv":"exit","n":"%s","code":%d}\\n' '${nonce}' "$__pdv_rc"`,
  ].join("\n");
}

/**
 * Pull the exit sentinel out of a command's stdout.
 *
 * @param stdout - Raw remote stdout.
 * @param nonce - The nonce the sentinel must carry.
 * @returns The remaining stdout and the reported exit code (null when absent).
 */
function extractSentinel(
  stdout: string,
  nonce: string,
): { stdout: string; exitCode: number | null } {
  const lines = stdout.split("\n");
  let exitCode: number | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (exitCode === null && trimmed.startsWith("{") && trimmed.includes(nonce)) {
      try {
        const parsed = JSON.parse(trimmed) as {
          pdv?: unknown;
          n?: unknown;
          code?: unknown;
        };
        if (parsed.pdv === "exit" && parsed.n === nonce && typeof parsed.code === "number") {
          exitCode = parsed.code;
          continue;
        }
      } catch {
        // Not our sentinel after all — it is ordinary output, keep it.
      }
    }
    kept.push(line);
  }
  return { stdout: kept.join("\n"), exitCode };
}

/**
 * Classify an ssh run whose command produced no exit sentinel.
 *
 * The ladder is deliberate: re-checking the master is authoritative about
 * whether a reconnect is needed, so stderr matching only runs when the
 * check itself was inconclusive. Doing it the other way round misreads a
 * remote command that happened to print "Permission denied".
 *
 * @param run - The raw ssh run.
 * @param control - Host and control socket, for the arbitrating re-check.
 * @param options - Binary path and timeouts.
 * @returns The failure kind to report.
 */
async function classifyFailure(
  run: RawRun,
  control: SshControl,
  options: SshMuxOptions,
): Promise<SshFailureKind> {
  if (run.spawnError) return "spawn-failed";
  if (run.timedOut) return "timeout";

  const state = await checkMaster(control, options);
  if (state === "alive") return "channel-failed";

  // The master is gone or unreadable. Distinguish "needs credentials" from a
  // plain drop, because the two have different UI: one opens the auth flow,
  // the other retries silently first.
  const stderr = run.stderr;
  if (
    /Permission denied/i.test(stderr) ||
    /ssh_askpass/i.test(stderr) ||
    /Host key verification failed/i.test(stderr) ||
    /no matching host key/i.test(stderr) ||
    /Too many authentication failures/i.test(stderr)
  ) {
    return "auth-required";
  }
  return "master-lost";
}

/**
 * Run a command on the remote host over the multiplexed connection.
 *
 * Resolves for every outcome. A non-null `exitCode` means the remote shell
 * ran the command and this is its status; a non-null `failure` means it
 * never ran and the value says what to do about it. Exactly one of the two
 * is set.
 *
 * @param control - Host and control socket to use.
 * @param command - Remote shell command (runs under the login shell).
 * @param options - Binary path, batch mode and timeouts.
 * @returns The classified result; never rejects.
 */
export async function execViaSsh(
  control: SshControl,
  command: string,
  options: SshMuxOptions = {},
): Promise<SshExecResult> {
  const nonce = `pdv${crypto.randomBytes(8).toString("hex")}`;
  const args = [
    ...baseSshArgs(control, options),
    // Never become a master on an exec channel: if the socket has gone
    // stale, PDV must hear about it through the failure ladder rather than
    // have ssh quietly open a fresh connection — which on an agent-gated
    // host means an approval prompt appearing out of nowhere.
    "-o",
    "ControlMaster=no",
    control.host,
    wrapWithSentinel(command, nonce),
  ];
  const run = await runSsh(args, options);
  const { stdout, exitCode } = extractSentinel(run.stdout, nonce);

  if (exitCode !== null) {
    return { ok: exitCode === 0, exitCode, stdout, stderr: run.stderr, failure: null };
  }
  const failure = await classifyFailure(run, control, options);
  return { ok: false, exitCode: null, stdout, stderr: run.stderr, failure };
}
