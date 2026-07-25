/**
 * ssh-pty.ts — Establish a ControlMaster interactively, over a real pty.
 *
 * PDV cannot authenticate a cluster host through a plain pipe. `ssh` reads
 * passphrases, passwords and keyboard-interactive prompts (Duo among them)
 * from its *controlling terminal*, not from stdin; with no terminal it falls
 * back to `SSH_ASKPASS`, and macOS ships no askpass binary. The observed
 * failure is exact and reproducible:
 *
 *     ssh_askpass: exec(/usr/X11R6/bin/ssh-askpass): No such file or directory
 *     Connection closed
 *
 * So PDV supplies the terminal itself. Running `ssh` under a pty makes
 * `readpassphrase()` behave exactly as it does in Terminal.app, and Duo's
 * stateful multi-prompt menu ("Passcode or option (1-3):") works without PDV
 * having to model any of it — the bytes simply flow both ways.
 *
 * Responsibilities
 * - Spawn `ssh` under a pty and hold it: the process PDV keeps *is* the
 *   ControlMaster, for as long as the connection lives.
 * - Stream the auth conversation out for display, and feed the user's
 *   replies back in.
 * - Report success only once the master is independently confirmed usable.
 *
 * What it does NOT do
 * - Store, log or persist anything the user types. Replies are written to
 *   the pty and dropped; the transcript this module returns is ssh's own
 *   output, which is why {@link isSecretPrompt} exists — so the UI can stop
 *   echoing a secret before it is ever rendered.
 * - Run remote commands. Once a master exists, everything else goes through
 *   `ssh-mux.ts`, which is cheaper and far easier to parse.
 * - Decide when to connect, or own connection state.
 *
 * **Success is not detected by scraping prompts, nor by a sentinel line, nor
 * by an exit status.** A pty stream carries terminal escape sequences and
 * echoes back everything typed into it, which makes any in-band marker
 * fragile in exactly the situation where reliability matters most. And the
 * process is *expected* to keep running, so it exiting is a failure, not a
 * result. Instead PDV polls `-O check` until the control socket answers.
 * That is a stronger claim than any marker in the byte stream: it proves the
 * socket is usable, not merely that some text appeared.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.7
 * remote/ssh-mux.ts — everything that happens after the master exists
 */

import { checkMaster, type SshMuxOptions } from "./ssh-mux";

/**
 * Default ceiling on the whole interactive attempt.
 *
 * Generous on purpose. This clock covers *human* time — approving a
 * 1Password prompt, finding a phone, answering a Duo push — and a user who
 * steps away mid-approval is indistinguishable from a hang for tens of
 * seconds. Measured against a real agent-gated host, a cold connect that
 * needed an approval tap took ~30 s while the same connect warm took 0.8 s.
 */
const DEFAULT_OVERALL_TIMEOUT_MS = 180_000;

/** Default `ConnectTimeout` for the ssh process itself, in seconds. */
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 90;

/** How often to ask whether the master socket has appeared. */
const MASTER_POLL_INTERVAL_MS = 250;

/** The subset of a spawned pty this module uses. */
export interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

/** The subset of the `node-pty` module this module uses. */
export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): PtyProcess;
}

/** Why an interactive connect did not produce a usable master. */
export type PtyAuthFailure =
  /** `node-pty` could not be loaded — a broken or missing native binary. */
  | "pty-unavailable"
  /** The overall deadline elapsed, most likely with a prompt unanswered. */
  | "timeout"
  /** {@link PtyMasterSession.cancel} was called. */
  | "cancelled"
  /** ssh exited non-zero: bad credentials, denied approval, refused host. */
  | "auth-failed"
  /** ssh exited without leaving a usable master behind. */
  | "no-master";

/** Outcome of an interactive connect. */
export interface PtyAuthResult {
  ok: boolean;
  /** Null exactly when `ok` is true. */
  failure: PtyAuthFailure | null;
  /** Operator-facing explanation, safe to display. */
  message: string;
  /**
   * Everything ssh printed, for the connect log.
   *
   * Replies given at a secret prompt are stripped from this before it is
   * recorded: a pty echoes what is written to it, and while ssh disables
   * echo around its own password prompts, PDV does not rely on the far end
   * to do that.
   */
  transcript: string;
}

/** A connect attempt in progress. */
export interface PtyMasterSession {
  /**
   * Answer the prompt currently on screen. A trailing newline is added when
   * absent, since a prompt is only satisfied by a completed line.
   */
  respond(text: string): void;
  /** Abandon the attempt and reap the ssh process. */
  cancel(): void;
  /**
   * Tear down a *successful* connection. The held process is the master, so
   * this closes every channel riding on it. Callers must call it, or the ssh
   * process outlives the session.
   */
  close(): void;
  /** Settles once the attempt succeeds or fails. Never rejects. */
  readonly result: Promise<PtyAuthResult>;
}

/** Options for {@link establishMasterInteractive}. */
export interface EstablishMasterOptions {
  /** ssh destination (an alias, or `user@host`). */
  host: string;
  /** Control socket the new master must listen on. */
  controlPath: string;
  /** `ssh` binary. Defaults to `ssh` on PATH. Injected by tests. */
  sshPath?: string;
  /** Seconds ssh waits for the TCP connection. */
  connectTimeoutSeconds?: number;
  /** Milliseconds for the whole attempt, including human response time. */
  overallTimeoutMs?: number;
  /** Called with each chunk of ssh output, for live display. */
  onOutput?: (chunk: string) => void;
  /** Injected `node-pty` replacement. Tests pass a fake; production omits it. */
  ptyModule?: PtyModule;
  /** Environment for the ssh process. Defaults to the parent's, unmodified. */
  env?: Record<string, string>;
}

/**
 * Prompts that must never be echoed back to the screen.
 *
 * Matched against the tail of the output stream so the caller can switch its
 * input field to masked *before* the user starts typing.
 */
const SECRET_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bpassword\b\s*[:?]/i,
  /\bpassphrase\b/i,
  /\bpasscode\b/i,
  /\bverification code\b/i,
  /\bone-?time (?:password|code)\b/i,
  /\botp\b\s*[:?]/i,
  /\btoken\b\s*[:?]/i,
];

/**
 * Whether the tail of the stream looks like a prompt awaiting input.
 *
 * A prompt is text left on the line with no newline after it — `ssh` has
 * stopped and is waiting. Used to distinguish "the user must do something"
 * from "ssh is narrating", so a connection that is merely slow does not
 * present an input box, and an error message does not look like a question.
 *
 * @param recentOutput - The accumulated pty stream.
 * @returns True when the last line appears to be an unanswered prompt.
 */
export function looksLikePrompt(recentOutput: string): boolean {
  if (isSecretPrompt(recentOutput)) return true;
  const lastLine = recentOutput.slice(-200).split(/\r?\n/).pop() ?? "";
  return /[:?]\s*$/.test(lastLine) && lastLine.trim().length > 0;
}

/**
 * Whether the most recent output is asking for something secret.
 *
 * Used only to decide whether the connect UI masks its input. It is
 * deliberately eager: masking a prompt that turns out to be innocuous costs
 * the user nothing, while failing to mask a real one puts a password on
 * screen (and into a screen recording, or a screenshot in a bug report).
 *
 * Note that a Duo menu — "Passcode or option (1-3):" — matches, which is the
 * conservative choice: option numbers are not secret, but passcodes typed at
 * the same prompt are.
 *
 * @param recentOutput - The tail of the pty stream (a line or two suffices).
 * @returns True when the input field should be masked.
 */
export function isSecretPrompt(recentOutput: string): boolean {
  const tail = recentOutput.slice(-400);
  return SECRET_PROMPT_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * Load `node-pty` lazily.
 *
 * Deferred to first use on purpose: a native module that fails to load at
 * import time would take the whole main process down at startup, turning a
 * remote-only problem into "PDV does not launch". Loading it here means a
 * broken binary surfaces as one failed connect with an explanation.
 *
 * **Require it by module name, never by an explicit `app.asar.unpacked`
 * path.** node-pty locates its `spawn-helper` by rewriting its own install
 * directory with `.replace('app.asar', 'app.asar.unpacked')`, so a path that
 * already says `app.asar.unpacked` becomes `app.asar.unpacked.unpacked` and
 * every spawn dies with `posix_spawnp failed.` This is the opposite of the
 * convention PDV uses for zeromq (`PDV_ZEROMQ_PATH`, an explicit unpacked
 * path), which is exactly what makes the mistake easy to make — verified
 * against a packaged build.
 *
 * @returns The node-pty module.
 * @throws {Error} When the native module cannot be loaded.
 */
function loadPtyModule(): PtyModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node-pty") as PtyModule;
}

/**
 * Build the argv for the master-establishing ssh invocation.
 *
 * The master runs in the **foreground** and PDV holds the process for as
 * long as the connection lives. The obvious alternative — `ssh -f`, letting
 * ssh background itself — was tried first and is not reliable: on a host
 * reached through a `ProxyCommand`, the local proxy helper is a child of
 * that process, and once ssh forks away the proxy can be orphaned and torn
 * down, taking the connection with it. Observed exactly that on a host with
 * a VPN `ProxyCommand`, where the master vanished the instant it was
 * created, while an otherwise identical connection to a direct host
 * survived.
 *
 * Holding the process instead makes the lifetime explicit: the master and
 * its proxy live exactly as long as PDV wants them to, and nothing outlives
 * the app. `ControlPersist=no` is passed for the same reason and must be
 * explicit — a host config that sets `ControlPersist yes` would otherwise
 * background the master straight back into the failure above.
 *
 * The cost is that a PDV restart re-authenticates. Within one run, a single
 * sign-in still serves every channel, which is where the pain actually was.
 *
 * `-N` runs no remote command, so nothing about the remote shell — a slow
 * profile, an MOTD, an Lmod banner — can affect the connection.
 *
 * @param options - Host, socket and timeouts.
 * @returns Arguments to pass to `ssh`.
 */
function buildMasterArgs(options: EstablishMasterOptions): string[] {
  return [
    "-N",
    "-M",
    "-o",
    `ControlPath=${options.controlPath}`,
    "-o",
    "ControlPersist=no",
    "-o",
    `ConnectTimeout=${options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS}`,
    // A host whose config sets RemoteCommand would otherwise conflict with
    // -N and refuse to start the session at all.
    "-o",
    "RemoteCommand=none",
    // This is the interactive path; refusing to prompt is the one thing it
    // must not do.
    "-o",
    "BatchMode=no",
    options.host,
  ];
}

/**
 * Authenticate to a host and leave a usable ControlMaster behind.
 *
 * Returns immediately with a live session: read {@link PtyMasterSession.result}
 * for the outcome, call {@link PtyMasterSession.respond} to answer prompts,
 * and {@link PtyMasterSession.cancel} to give up.
 *
 * The environment is inherited unmodified. That matters for any host whose
 * config uses `ProxyCommand`: that helper is a *local* script, and a
 * sanitized PATH breaks the hop before ssh reaches the network.
 *
 * @param options - Host, control socket, timeouts and output sink.
 * @returns The in-progress session.
 */
export function establishMasterInteractive(
  options: EstablishMasterOptions,
): PtyMasterSession {
  let settle: (result: PtyAuthResult) => void;
  const result = new Promise<PtyAuthResult>((resolve) => {
    settle = resolve;
  });

  let transcript = "";
  let settled = false;
  const finish = (partial: Omit<PtyAuthResult, "transcript">): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle({ ...partial, transcript });
  };

  let pty: PtyModule;
  try {
    pty = options.ptyModule ?? loadPtyModule();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      respond: () => {},
      cancel: () => {},
      close: () => {},
      result: Promise.resolve({
        ok: false,
        failure: "pty-unavailable",
        message:
          "PDV could not load its terminal component, which is required to " +
          `sign in to a remote host. ${detail}`,
        transcript: "",
      }),
    };
  }

  const muxOptions: SshMuxOptions = {
    sshPath: options.sshPath,
    connectTimeoutSeconds: options.connectTimeoutSeconds,
    timeoutMs: 20_000,
  };

  let child: PtyProcess;
  try {
    child = pty.spawn(options.sshPath ?? "ssh", buildMasterArgs(options), {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      env: options.env ?? (process.env as Record<string, string>),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      respond: () => {},
      cancel: () => {},
      close: () => {},
      result: Promise.resolve({
        ok: false,
        failure: "pty-unavailable",
        message: `PDV could not start a terminal for ssh. ${detail}`,
        transcript: "",
      }),
    };
  }

  const timer = setTimeout(() => {
    // Nothing has authenticated, so no master exists yet and killing the
    // process group cannot take one down.
    child.kill();
    finish({
      ok: false,
      failure: "timeout",
      message:
        "The connection attempt timed out. If an approval prompt or Duo push " +
        "was waiting, it may have expired — try connecting again.",
    });
  }, options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS);

  // A pty echoes what is written to it. `ssh` turns echo off around a real
  // password prompt, but PDV must not depend on the far end doing that — a
  // Duo passcode typed at an echoing menu prompt would otherwise be streamed
  // straight to the renderer and into the transcript. So a reply given at a
  // secret prompt is remembered just long enough to delete its echo.
  let pendingEcho: string | null = null;

  child.onData((chunk) => {
    let visible = chunk;
    if (pendingEcho) {
      const at = visible.indexOf(pendingEcho);
      if (at >= 0) {
        visible = visible.slice(0, at) + visible.slice(at + pendingEcho.length);
        pendingEcho = null;
      } else if (visible.includes("\n")) {
        // The line the echo would have appeared on is over; stop filtering
        // rather than carrying a stale needle that could clip real output.
        pendingEcho = null;
      }
    }
    transcript += visible;
    if (visible) options.onOutput?.(visible);
  });

  // The master runs in the foreground, so it exiting means the attempt is
  // over — never that it succeeded.
  child.onExit(({ exitCode }) => {
    if (settled) return;
    if (exitCode === 0) {
      finish({
        ok: false,
        failure: "no-master",
        message:
          `ssh exited cleanly without leaving a usable connection to ` +
          `${options.host}. This usually means the host forbids connection sharing.`,
      });
      return;
    }
    finish({
      ok: false,
      failure: "auth-failed",
      message:
        `Could not connect to ${options.host} (ssh exited ${exitCode}). ` +
        "See the connection log for what ssh reported.",
    });
  });

  // Success is the control socket answering, not anything in the byte stream
  // and not an exit status. The process is expected to keep running, so
  // polling is what tells us authentication is behind us.
  const poll = async (): Promise<void> => {
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, MASTER_POLL_INTERVAL_MS));
      if (settled) return;
      const state = await checkMaster(
        { host: options.host, controlPath: options.controlPath },
        muxOptions,
      );
      if (state === "alive") {
        finish({ ok: true, failure: null, message: `Connected to ${options.host}.` });
        return;
      }
    }
  };
  void poll();

  return {
    respond(text: string): void {
      if (settled) return;
      const reply = text.endsWith("\n") ? text.slice(0, -1) : text;
      if (reply && isSecretPrompt(transcript)) {
        pendingEcho = reply;
      }
      child.write(`${reply}\n`);
    },
    cancel(): void {
      if (settled) return;
      child.kill();
      finish({
        ok: false,
        failure: "cancelled",
        message: "Connection cancelled.",
      });
    },
    close(): void {
      // Ends the connection: this process *is* the master, so killing it
      // closes every channel riding on it and reaps the ProxyCommand helper
      // with it.
      child.kill();
    },
    result,
  };
}
