/**
 * remote-channel.ts — turn a live SSH master into a stream pair.
 *
 * One `ssh <host> pdv-server attach --session <id> --stdio` per channel. The
 * remote command is a *proxy* to the session daemon, so this process's
 * stdout/stdin are the RPC wire and nothing else may touch them.
 *
 * Three details decide whether this works or hangs:
 *
 *  - **stderr is separated and logged, never mixed into the protocol.** SSH
 *    puts banners, MOTD and Lmod chatter on stderr; folding that into stdout
 *    would inject unparseable lines into the frame stream. (`LineDecoder`
 *    would skip them, but only after they had already interleaved with a
 *    partial frame.)
 *  - **No TTY is requested.** A pty would echo, translate newlines, and
 *    inject escape sequences into a byte-exact protocol stream.
 *  - **`BatchMode=yes` on every reconnect.** A retry must succeed from the
 *    existing master or fail immediately; silently triggering a Duo push the
 *    user did not ask for is worse than an error they can act on.
 *
 * This module does NOT establish or own the master (`ssh-mux.ts` and
 * `remote-connection.ts` do); it rides one that already exists.
 */

import { spawn, type ChildProcess } from "child_process";
import type { Readable, Writable } from "stream";

import { baseSshArgs, type SshControl, type SshMuxOptions } from "./ssh-mux";

/** A channel to a remote session: the RPC streams plus a teardown. */
export interface RemoteSessionChannel {
  /** Server → client (the ssh process's stdout). */
  readable: Readable;
  /** Client → server (the ssh process's stdin). */
  writable: Writable;
  /** Kill the ssh process, closing the channel. */
  dispose: () => void;
  /** The underlying process, for diagnostics. */
  child: ChildProcess;
}

/** Options for {@link openSessionChannel}. */
export interface OpenSessionChannelOptions {
  /** The live master to ride. */
  control: SshControl;
  /** Session id to attach to. */
  sessionId: string;
  /**
   * Absolute path to `pdv-server` on the host. Shell-expandable (it usually
   * contains `$HOME`), so it is passed unquoted into the remote command and
   * expanded by the remote shell.
   */
  serverCommand: string;
  /** Create the session if no daemon is running. */
  create?: boolean;
  /** `ssh` binary. Injected by tests. */
  sshPath?: string;
  /** Extra mux options (timeouts, batch mode). */
  muxOptions?: SshMuxOptions;
  /** Receives ssh stderr lines, for the connection log. */
  onStderr?: (chunk: string) => void;
  /**
   * Request X11 forwarding on this channel (per-host toggle, issue #377).
   * The session daemon inherits the CHANNEL's environment when it is
   * spawned (`--create`), so this — not the master's own forwarding — is
   * what puts a DISPLAY in the daemon's env for kernels to use. Forwarding
   * requested here succeeds when the master (PDV's, with the same toggle,
   * or the user's own config) allows it.
   */
  forwardX11?: boolean;
}

/**
 * Open a channel to a remote session.
 *
 * @param opts - Control socket, session id, and the remote server command.
 * @returns The stream pair plus a teardown.
 * @throws Error if the ssh process cannot be spawned.
 */
export function openSessionChannel(
  opts: OpenSessionChannelOptions,
): RemoteSessionChannel {
  const muxOptions: SshMuxOptions = { batchMode: true, ...opts.muxOptions };
  const args = [
    ...baseSshArgs(opts.control, muxOptions),
    ...(opts.forwardX11 ? ["-o", "ForwardX11=yes"] : []),
    opts.control.host,
    // Double quotes so the remote shell expands $HOME in the install path;
    // single quotes would pass it through literally and the command would
    // not be found.
    `${opts.serverCommand} attach --session ${opts.sessionId} --stdio` +
      (opts.create ? " --create" : ""),
  ];

  const child = spawn(opts.sshPath ?? "ssh", args, {
    // stdin/stdout are the protocol; stderr is diagnostics and must stay
    // out of the frame stream.
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    opts.onStderr?.(chunk);
    console.error(`[remote-channel] ${chunk.trimEnd()}`);
  });

  if (!child.stdout || !child.stdin) {
    child.kill("SIGKILL");
    throw new Error("[remote-channel] ssh did not provide stdio pipes");
  }

  return {
    readable: child.stdout,
    writable: child.stdin,
    child,
    dispose: () => {
      // SIGKILL rather than SIGTERM: this only ends the *channel*. The
      // session daemon on the far side is a different process entirely and
      // keeps running with its kernel, which is the whole point.
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    },
  };
}
