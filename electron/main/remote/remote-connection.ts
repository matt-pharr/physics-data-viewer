/**
 * remote-connection.ts — Owns the ssh connection a remote session runs over.
 *
 * One host at a time, one attempt at a time. This is the piece that decides
 * whether a connection needs the user at all: if a usable ControlMaster
 * already exists — either one PDV made earlier or one the user runs
 * themselves — connecting is a socket check and nothing is asked of them.
 * Only when there is no master does the interactive pty path run.
 *
 * That ordering is the whole user-facing difference between "PDV reconnects
 * instantly" and "PDV demands a Duo push every time it wants something",
 * which is why {@link RemoteConnectionManager.connect} checks before it asks.
 *
 * Responsibilities
 * - Resolve which control socket a host should use, and reuse a live master.
 * - Drive the interactive auth flow and relay its prompts and output.
 * - Hold the current connection state and publish every change.
 * - Tear the connection down on request.
 *
 * What it does NOT do
 * - Start, stop or swap a pdv-server. Establishing an ssh connection and
 *   running a session over it are separate steps; this one stops once a
 *   master is up. Session replacement belongs to the caller, via
 *   `shell/session-router.ts`.
 * - Run remote commands. Callers use `ssh-mux.ts` with {@link
 *   RemoteConnectionManager.control} once connected.
 * - Persist anything. No credentials, and no connection state across
 *   restarts — a cold start is always disconnected.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §11.7
 */

import * as crypto from "crypto";

import type { RemoteConnectResult, RemoteHostAlias, RemoteStatus } from "../ipc";
import { listSshHostAliases } from "./ssh-config";
import {
  checkMaster,
  controlPathFor,
  ensureControlDir,
  execViaSsh,
  resolveSshControl,
  stopMaster,
  type SshControl,
  type SshMuxOptions,
} from "./ssh-mux";
import {
  establishMasterInteractive,
  isSecretPrompt,
  looksLikePrompt,
  type PtyMasterSession,
  type PtyModule,
} from "./ssh-pty";

/** Options for {@link RemoteConnectionManager}. */
export interface RemoteConnectionOptions {
  /** Directory for PDV-owned control sockets (typically under userData). */
  controlDir: string;
  /** Called on every state change, for the renderer push. */
  onStatus: (status: RemoteStatus) => void;
  /** `ssh` binary. Defaults to `ssh` on PATH. Injected by tests. */
  sshPath?: string;
  /** Injected `node-pty` replacement. Tests pass a fake; production omits it. */
  ptyModule?: PtyModule;
  /** Milliseconds for a whole interactive attempt, including human response time. */
  overallTimeoutMs?: number;
  /** Path to the ssh config to harvest aliases from. Defaults to `~/.ssh/config`. */
  sshConfigPath?: string;
}

/**
 * The ssh connection backing a remote session.
 *
 * Construct one per application, not per connection: it holds the current
 * state that the renderer hydrates from.
 */
export class RemoteConnectionManager {
  private status: RemoteStatus = { phase: "idle", host: null, attemptId: null };
  private attempt: PtyMasterSession | null = null;
  private activeControl: SshControl | null = null;
  /**
   * The held ssh process backing a connection PDV created. Null when the
   * connection was inherited from a master the user already ran — PDV does
   * not own that one and must not kill it.
   */
  private master: PtyMasterSession | null = null;

  constructor(private readonly options: RemoteConnectionOptions) {}

  /** The control socket of the live connection, or null when disconnected. */
  get control(): SshControl | null {
    return this.status.phase === "connected" ? this.activeControl : null;
  }

  /** The current state, safe to hand straight to the renderer. */
  getStatus(): RemoteStatus {
    // Without `output`: the accumulated log belongs to the attempt that
    // produced it, and replaying it into a fresh renderer would show a
    // finished conversation as though it were live.
    const { output: _output, ...rest } = this.status;
    return { ...rest };
  }

  /** Host aliases for the connect picker. Never throws. */
  async listHosts(): Promise<RemoteHostAlias[]> {
    const found = await listSshHostAliases({ configPath: this.options.sshConfigPath });
    return found.map(({ alias, hostName, user }) => ({ alias, hostName, user }));
  }

  /**
   * Publish a state change.
   *
   * `output` is deliberately not accumulated into the retained status —
   * it is a stream, and each push carries only the new bytes.
   */
  private emit(next: Partial<RemoteStatus> & Pick<RemoteStatus, "phase">): void {
    const { output, secret, ...retained } = next;
    this.status = {
      host: this.status.host,
      attemptId: this.status.attemptId,
      ...retained,
    };
    this.options.onStatus({ ...this.status, ...(output ? { output } : {}), ...(secret ? { secret } : {}) });
  }

  private muxOptions(): SshMuxOptions {
    return { sshPath: this.options.sshPath };
  }

  /**
   * Connect to a host, asking the user only when necessary.
   *
   * @param host - ssh destination (an alias, or `user@host`).
   * @returns The outcome. Resolves for every path, including failure.
   */
  async connect(host: string): Promise<RemoteConnectResult> {
    if (this.attempt) {
      return {
        ok: false,
        failure: "busy",
        message: "A connection attempt is already in progress.",
      };
    }
    if (this.status.phase === "connected" && this.status.host === host && this.activeControl) {
      const state = await checkMaster(this.activeControl, this.muxOptions());
      if (state === "alive") {
        return { ok: true, failure: null, message: `Already connected to ${host}.` };
      }
      // The master died while PDV believed it was connected. Fall through
      // and reconnect rather than reporting a connection that is not there.
    }

    const attemptId = crypto.randomBytes(8).toString("hex");
    this.status = { phase: "connecting", host, attemptId };
    this.emit({ phase: "connecting", host, attemptId, message: `Connecting to ${host}…` });

    try {
      ensureControlDir(this.options.controlDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.fail(host, attemptId, "control-dir", `PDV could not create its connection directory. ${detail}`);
    }

    // Reuse before asking. A live master — PDV's own from earlier, or one the
    // user already runs for this host — means no prompt and no approval tap.
    const { control, masterState } = await resolveSshControl(
      host,
      this.options.controlDir,
      this.muxOptions(),
    );
    if (masterState === "alive") {
      this.activeControl = control;
      const node = await this.resolveNode(control);
      this.emit({
        phase: "connected",
        host,
        attemptId,
        node,
        message: `Reusing the existing connection to ${host}.`,
      });
      return { ok: true, failure: null, message: `Connected to ${host}.` };
    }

    return await this.authenticate(host, attemptId, control);
  }

  /**
   * Run the interactive auth flow for a host with no usable master.
   *
   * @param host - ssh destination.
   * @param attemptId - Identifier for this attempt.
   * @param control - The control socket the new master must listen on.
   * @returns The outcome.
   */
  private async authenticate(
    host: string,
    attemptId: string,
    control: SshControl,
  ): Promise<RemoteConnectResult> {
    const controlPath = control.controlPath ?? controlPathFor(host, this.options.controlDir);
    let seen = "";

    const session = establishMasterInteractive({
      host,
      controlPath,
      sshPath: this.options.sshPath,
      ptyModule: this.options.ptyModule,
      overallTimeoutMs: this.options.overallTimeoutMs,
      onOutput: (chunk) => {
        seen += chunk;
        // Only claim the user is being prompted when ssh has actually stopped
        // and is waiting. Treating any output as a prompt would put an input
        // box in front of a banner or an error message.
        this.emit({
          phase: looksLikePrompt(seen) ? "prompting" : "connecting",
          host,
          attemptId,
          output: chunk,
          secret: isSecretPrompt(seen),
        });
      },
    });
    this.attempt = session;

    const result = await session.result;
    this.attempt = null;

    if (!result.ok) {
      session.close();
      return this.fail(host, attemptId, result.failure ?? "unknown", result.message);
    }
    this.activeControl = { host, controlPath };
    this.master = session;
    const node = await this.resolveNode(this.activeControl);
    this.emit({ phase: "connected", host, attemptId, node, message: result.message });
    return { ok: true, failure: null, message: result.message };
  }

  /**
   * Ask which machine actually answered.
   *
   * A load-balanced alias (`flux.pppl.gov` round-robins between login
   * nodes) resolves to whichever node the master happened to reach. Every
   * channel then multiplexes over that one connection, so a session is
   * pinned to that node for its lifetime — but a later reconnect can land
   * somewhere else, stranding anything left behind. Recording the concrete
   * node is what lets that be *noticed* rather than surfacing later as
   * "my files vanished".
   *
   * @param control - The live control socket.
   * @returns The remote hostname, or null when it cannot be determined.
   */
  private async resolveNode(control: SshControl): Promise<string | null> {
    const result = await execViaSsh(control, "hostname", {
      ...this.muxOptions(),
      timeoutMs: 15_000,
    });
    if (!result.ok) return null;
    const node = result.stdout.trim().split(/\s+/)[0];
    return node || null;
  }

  /** Record a failed attempt and shape the result. */
  private fail(
    host: string,
    attemptId: string,
    failure: string,
    message: string,
  ): RemoteConnectResult {
    this.activeControl = null;
    this.emit({ phase: "failed", host, attemptId, message });
    return { ok: false, failure, message };
  }

  /**
   * Answer the prompt currently on screen.
   *
   * @param text - The user's reply. Written to the pty and not retained.
   * @returns Nothing. A reply with no attempt in flight is ignored.
   */
  respond(text: string): void {
    this.attempt?.respond(text);
  }

  /** Abandon the in-flight attempt, if any. */
  cancel(): void {
    this.attempt?.cancel();
  }

  /**
   * Disconnect, stopping the ControlMaster when PDV owns it.
   *
   * A master inherited from the user's own ssh config is left alone: PDV did
   * not create it, other terminals may be riding it, and stopping it would
   * be a surprising side effect of closing a PDV session.
   *
   * @returns Nothing.
   */
  async disconnect(): Promise<void> {
    this.cancel();
    const control = this.activeControl;
    const master = this.master;
    this.activeControl = null;
    this.master = null;
    if (master) {
      // PDV holds this master's process, so ask ssh to stop first (clean
      // channel shutdown) and then reap the process, which also takes any
      // ProxyCommand helper with it.
      if (control?.controlPath) await stopMaster(control, this.muxOptions());
      master.close();
    }
    // A master PDV merely borrowed is left running: other terminals may be
    // using it, and stopping it would be a surprising side effect.
    this.emit({ phase: "idle", host: null, attemptId: null, node: null, message: "Disconnected." });
  }
}
