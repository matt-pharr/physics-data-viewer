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
 * - Spawn `ssh` under a pty to create a backgrounded ControlMaster.
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
 * **Success is not detected by scraping prompts, and deliberately not by a
 * sentinel line either.** A pty stream carries terminal escape sequences and
 * echoes back everything typed into it, which makes any in-band marker
 * fragile in exactly the situation where reliability matters most. Instead
 * `ssh -f` exits zero only after authentication has completed, and PDV then
 * confirms the master answers `-O check` before calling it a success. That
 * is a stronger claim than any marker in the byte stream: it proves the
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

/** Default `ControlPersist`, in seconds, for the master PDV creates. */
const DEFAULT_CONTROL_PERSIST_SECONDS = 600;

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
  /** ssh exited zero but no usable master appeared. */
  | "no-master";

/** Outcome of an interactive connect. */
export interface PtyAuthResult {
  ok: boolean;
  /** Null exactly when `ok` is true. */
  failure: PtyAuthFailure | null;
  /** Operator-facing explanation, safe to display. */
  message: string;
  /**
   * Everything ssh printed, for the connect log. This is ssh's own output;
   * it never contains what the user typed, because prompts are not echoed
   * by the remote and PDV does not add an echo of its own.
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
  /** Seconds the master lingers after its last channel closes. */
  controlPersistSeconds?: number;
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
 * `-f` is what makes success observable: ssh forks to the background only
 * *after* authentication succeeds, so the foreground process exiting zero
 * means the credentials were accepted. `-N` runs no remote command, so
 * nothing about the remote shell — a slow profile, an MOTD, an Lmod banner —
 * can affect whether the connection is judged successful.
 *
 * @param options - Host, socket and timeouts.
 * @returns Arguments to pass to `ssh`.
 */
function buildMasterArgs(options: EstablishMasterOptions): string[] {
  return [
    "-f",
    "-N",
    "-M",
    "-o",
    `ControlPath=${options.controlPath}`,
    "-o",
    `ControlPersist=${options.controlPersistSeconds ?? DEFAULT_CONTROL_PERSIST_SECONDS}`,
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

  child.onData((chunk) => {
    transcript += chunk;
    options.onOutput?.(chunk);
  });

  child.onExit(({ exitCode }) => {
    if (settled) return;
    if (exitCode !== 0) {
      finish({
        ok: false,
        failure: "auth-failed",
        message:
          `Authentication to ${options.host} failed (ssh exited ${exitCode}). ` +
          "See the connection log for what ssh reported.",
      });
      return;
    }
    // ssh reported success. Confirm the master is genuinely usable rather
    // than trusting the exit status alone — this is the claim every later
    // channel depends on, and it is cheap to verify.
    void checkMaster({ host: options.host, controlPath: options.controlPath }, muxOptions)
      .then((state) => {
        if (state === "alive") {
          finish({ ok: true, failure: null, message: `Connected to ${options.host}.` });
          return;
        }
        finish({
          ok: false,
          failure: "no-master",
          message:
            `ssh signed in to ${options.host} but left no usable connection ` +
            `(control socket reported "${state}"). This usually means the host ` +
            "forbids connection sharing.",
        });
      })
      .catch(() => {
        finish({
          ok: false,
          failure: "no-master",
          message: `Could not verify the connection to ${options.host}.`,
        });
      });
  });

  return {
    respond(text: string): void {
      if (settled) return;
      child.write(text.endsWith("\n") ? text : `${text}\n`);
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
    result,
  };
}
