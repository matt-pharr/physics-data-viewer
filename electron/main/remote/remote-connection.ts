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
import * as fs from "fs";
import * as path from "path";

import type { RemoteConnectResult, RemoteHostAlias, RemoteStatus } from "../ipc";
import {
  remoteServerCommand, installBundle, probeHost, sha256File, type BootstrapProgress } from "./bootstrap";
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
  type PtyAuthResult,
  type PtyMasterSession,
  type PtyModule,
} from "./ssh-pty";

/**
 * ssh's connection-level complaints — the node itself is unreachable, as
 * opposed to reachable-but-refusing-credentials.
 *
 * Matched against the pty transcript to decide whether a failed PINNED
 * attempt is worth retrying against the bare alias. This is stderr pattern
 * matching, normally forbidden here ("the -O check ladder gets it right") —
 * but no exit-code signal distinguishes a drained node from a mistyped
 * password (both end in a nonzero ssh exit), and the stakes are asymmetric:
 * a missed match means no retry (the user reconnects by hand), while
 * matching a credential failure would fire a surprise second password/Duo
 * prompt. So the match gates only the retry, and not matching is the safe
 * default. `timeout` never falls back either — it means a prompt sat
 * unanswered for the full budget, and a retry would silently double it.
 */
const CONNECTION_LEVEL_FAILURE = new RegExp(
  [
    "Could not resolve hostname",
    "Connection refused",
    "Connection timed out",
    "No route to host",
    "Network is unreachable",
    "Connection closed by remote host",
  ].join("|"),
  "i",
);

/** Whether a failed pinned attempt should be retried against the alias. */
function pinFallbackWorthwhile(result: PtyAuthResult): boolean {
  if (result.failure === "cancelled" || result.failure === "pty-unavailable") return false;
  if (result.failure === "timeout") return false;
  return CONNECTION_LEVEL_FAILURE.test(result.transcript);
}

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
  /**
   * App version, which names the install directory on the host so several
   * PDV versions can coexist there.
   */
  appVersion?: string;
  /**
   * Directory holding `index.json` and the per-arch tarballs built by
   * `scripts/build-server-bundle.mjs`.
   *
   * Injected rather than discovered so this class stays free of Electron
   * path lookups. Omitting it skips the bootstrap entirely and connects
   * anyway — useful while the session cannot move to the host yet, and the
   * honest behaviour when no bundle has been built.
   */
  bundleDir?: string;
  /**
   * The concrete login node a host's session daemon was last seen on, or
   * null when none is recorded. When set, a master PDV creates for that
   * host is pinned there with `-o HostName=` — a load-balanced alias
   * round-robins while the session socket is node-local, so an unpinned
   * reconnect can land beside a session it cannot reach. A master the user
   * already runs is never re-pointed (PDV does not own it); the attach
   * guard on the host is the backstop for that case.
   */
  sessionNodeFor?: (host: string) => string | null;
  /**
   * Whether the per-host "Forward X11" toggle is on for a host (issue
   * #377). Applied to masters PDV creates; a master the user already runs
   * is not PDV's to reconfigure (the channel-level request in
   * `remote-channel.ts` still applies there, and succeeds exactly when the
   * user's own config enabled forwarding on it).
   */
  forwardX11For?: (host: string) => boolean;
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
  /** Where the bundle lives on the connected host; see {@link serverCommand}. */
  private installedServerPath: string | null = null;
  /**
   * The held ssh process backing a connection PDV created. Null when the
   * connection was inherited from a master the user already ran — PDV does
   * not own that one and must not kill it.
   */
  private master: PtyMasterSession | null = null;

  /**
   * Whether the held PDV-created master was established with X11
   * forwarding. Meaningless while {@link master} is null. Compared against
   * the per-host toggle on reconnect so a toggle flip rebuilds the master
   * instead of being silently ignored.
   */
  private masterForwardX11 = false;

  constructor(private readonly options: RemoteConnectionOptions) {}

  /**
   * Stop and reap PDV's own master, leaving state ready for a fresh
   * establish. No-op when PDV holds no master (borrowed connections are
   * never PDV's to stop).
   *
   * @returns Nothing.
   */
  private async teardownOwnMaster(): Promise<void> {
    const control = this.activeControl;
    const master = this.master;
    this.activeControl = null;
    this.master = null;
    if (master) {
      if (control?.controlPath) await stopMaster(control, this.muxOptions());
      master.close();
    }
  }

  /** The control socket of the live connection, or null when disconnected. */
  get control(): SshControl | null {
    return this.status.phase === "connected" ? this.activeControl : null;
  }

  /**
   * Path to `pdv-server` on the connected host, or null when unknown.
   *
   * Shell-expandable rather than resolved (it contains `$HOME`), so it must
   * be passed unquoted into a remote command for the far-side shell to
   * expand — quoting it would produce a literal `$HOME` and a command not
   * found.
   */
  get serverCommand(): string | null {
    return this.status.phase === "connected" ? this.installedServerPath : null;
  }

  /** The current state, safe to hand straight to the renderer. */
  getStatus(): RemoteStatus {
    // Without `output`: the accumulated log belongs to the attempt that
    // produced it, and replaying it into a fresh renderer would show a
    // finished conversation as though it were live.
    const { output: _output, ...rest } = this.status;
    return { ...rest };
  }

  /**
   * Locate the tarball for a host's architecture.
   *
   * Reads the `index.json` the bundle builder writes, which is also where
   * the sha256 comes from — the digest is produced at build time and
   * verified on the host, so a corrupted transfer cannot be mistaken for a
   * good one.
   *
   * @param arch - Architecture the host reported.
   * @returns The tarball and its digest, or null when none is available.
   */
  private resolveBundle(arch: string): { path: string; sha256: string } | null {
    const dir = this.options.bundleDir;
    if (!dir) return null;
    const indexPath = path.join(dir, "index.json");
    if (!fs.existsSync(indexPath)) return null;
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
        bundles?: Array<{ arch?: string; file?: string; sha256?: string }>;
      };
      const entry = index.bundles?.find((b) => b.arch === arch);
      if (!entry?.file) return null;
      const tarball = path.join(dir, entry.file);
      if (!fs.existsSync(tarball)) return null;
      // Prefer the recorded digest; fall back to hashing so a hand-placed
      // bundle still installs rather than failing on a missing field.
      return { path: tarball, sha256: entry.sha256 ?? sha256File(tarball) };
    } catch {
      return null;
    }
  }

  /**
   * Make sure the host has a working pdv-server before reporting `connected`.
   *
   * Skipped when no bundle directory is configured: connecting is still
   * useful on its own, and claiming a failure because a build artifact is
   * missing would block a flow that otherwise works.
   *
   * @param host - ssh destination, for messages.
   * @param attemptId - The attempt these updates belong to.
   * @param control - The live control socket.
   * @returns An error message when the host cannot be prepared, else null.
   */
  private async prepareHost(
    host: string,
    attemptId: string,
    control: SshControl,
  ): Promise<string | null> {
    const version = this.options.appVersion;
    if (!this.options.bundleDir || !version) return null;

    // Upload byte-counts arrive once per 64 KB stream chunk — thousands per
    // second over a fast link, each one an IPC message and a renderer
    // render. Throttle mid-upload updates to ~10 Hz; stage changes and the
    // final 100% update always pass.
    let lastProgressAt = 0;
    const onProgress = (progress: BootstrapProgress): void => {
      const hasBytes =
        progress.total !== undefined && progress.transferred !== undefined;
      const midUpload =
        hasBytes &&
        progress.stage === "uploading" &&
        progress.transferred! < progress.total!;
      if (midUpload) {
        const now = Date.now();
        if (now - lastProgressAt < 100) return;
        lastProgressAt = now;
      }
      this.emit({
        phase: "preparing",
        host,
        attemptId,
        message: progress.message,
        ...(hasBytes
          ? { progress: { transferred: progress.transferred!, total: progress.total! } }
          : {}),
      });
    };

    const probe = await probeHost(control, { ...this.muxOptions(), version, onProgress });
    if (!probe.ok) return probe.problem ?? `PDV could not inspect ${host}.`;
    if (!probe.arch) return `PDV has no components for ${probe.machine ?? "this architecture"}.`;

    const bundle = this.resolveBundle(probe.arch);
    // Installed *and* the same bytes. Comparing only the version would let a
    // rebuild at an unchanged version keep serving the old bundle, which
    // fails later and far less legibly than reinstalling now.
    if (probe.installed && bundle && probe.bundleId === bundle.sha256) {
      this.installedServerPath = remoteServerCommand(version);
      return null;
    }
    if (probe.installed && (!bundle || probe.bundleId !== bundle.sha256)) {
      console.log(
        `[remote] reinstalling on ${host}: installed bundle ${probe.bundleId ?? "unknown"} ` +
          `does not match ${bundle?.sha256 ?? "the bundle this build ships"}`,
      );
    }
    if (!bundle) {
      return (
        `PDV has no remote components for linux-${probe.arch} to install. ` +
        "Build them with `npm run build:server-bundle`."
      );
    }

    const result = await installBundle(control, bundle.path, bundle.sha256, {
      ...this.muxOptions(),
      version,
      onProgress,
    });
    if (result.ok) this.installedServerPath = remoteServerCommand(version);
    return result.ok ? null : result.message;
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
    const wantX11 = this.options.forwardX11For?.(host) ?? false;
    if (this.status.phase === "connected" && this.status.host === host && this.activeControl) {
      const state = await checkMaster(this.activeControl, this.muxOptions());
      if (state === "alive") {
        if (this.master && this.masterForwardX11 !== wantX11) {
          // The per-host Forward X11 toggle changed since this master was
          // established. X11 forwarding is a property of the master's
          // connection, so reusing it would silently ignore the toggle —
          // the "applies to the next session" promise in the settings copy
          // depends on tearing the old master down here. Only PDV's own
          // master is rebuilt; a borrowed one is the user's to configure.
          await this.teardownOwnMaster();
        } else {
          return { ok: true, failure: null, message: `Already connected to ${host}.` };
        }
      }
      // The master died while PDV believed it was connected (or was torn
      // down above). Fall through and reconnect rather than reporting a
      // connection that is not there.
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
    if (masterState === "alive" && wantX11 && control.controlPath && !this.master) {
      // An alive master at PDV's own socket path that THIS manager does
      // not hold (a previous instance's leftover) has unknowable X11
      // state. With the toggle on, guessing wrong silently produces
      // sessions with no DISPLAY — stop it and establish fresh; it is
      // PDV's socket, never the user's.
      await stopMaster(control, this.muxOptions());
      return await this.authenticate(host, attemptId, control);
    }
    if (masterState === "alive") {
      this.activeControl = control;
      const node = await this.resolveNode(control);
      const problem = await this.prepareHost(host, attemptId, control);
      if (problem) return this.fail(host, attemptId, "bootstrap", problem);
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

    // Aim at the recorded session node when there is one (see the option's
    // JSDoc). The pin is best-effort: a node that stopped answering must
    // not brick the alias, so a pinned attempt that failed AT THE
    // CONNECTION LEVEL falls back to the alias below — where the
    // wrong-node attach guard keeps a live session from being forked, and
    // a dead one is simply recreated wherever the alias lands.
    const pin = this.options.sessionNodeFor?.(host) ?? null;
    let result = await this.runAuthAttempt(host, attemptId, controlPath, pin);
    if (!result.ok && pin && pinFallbackWorthwhile(result)) {
      this.emit({
        phase: "connecting",
        host,
        attemptId,
        output: `\r\nCould not reach ${pin} (where your session was running); trying ${host} directly…\r\n`,
        message: `Connecting to ${host}…`,
      });
      result = await this.runAuthAttempt(host, attemptId, controlPath, null);
    }

    if (!result.ok) {
      return this.fail(host, attemptId, result.failure ?? "unknown", result.message);
    }
    this.activeControl = { host, controlPath };
    this.master = result.session;
    this.masterForwardX11 = this.options.forwardX11For?.(host) ?? false;
    const node = await this.resolveNode(this.activeControl);
    const problem = await this.prepareHost(host, attemptId, this.activeControl);
    if (problem) return this.fail(host, attemptId, "bootstrap", problem);
    this.emit({ phase: "connected", host, attemptId, node, message: result.message });
    return { ok: true, failure: null, message: result.message };
  }

  /**
   * One interactive establishment attempt, optionally pinned to a node.
   *
   * @param host - ssh destination.
   * @param attemptId - Identifier for this attempt.
   * @param controlPath - Control socket the new master must listen on.
   * @param pin - Concrete node to pass as `-o HostName=`, or null.
   * @returns The pty outcome plus the live session (already closed when the
   *   attempt failed, so callers only manage the successful one).
   */
  private async runAuthAttempt(
    host: string,
    attemptId: string,
    controlPath: string,
    pin: string | null,
  ): Promise<PtyAuthResult & { session: PtyMasterSession }> {
    let seen = "";
    const session = establishMasterInteractive({
      host,
      controlPath,
      hostNameOverride: pin ?? undefined,
      forwardX11: this.options.forwardX11For?.(host) ?? false,
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
    if (!result.ok) session.close();
    return { ...result, session };
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
    // `-f` first: the recorded node becomes an `-o HostName=` target on the
    // NEXT connect, and a short name (`flux-login1`) that only resolves
    // inside the cluster makes every pinned attempt DNS-fail from the
    // laptop. Clusters whose `hostname` has no `-f` fall back to the short
    // form — the pin ladder tolerates it, just less efficiently.
    const result = await execViaSsh(control, "hostname -f 2>/dev/null || hostname", {
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
    // PDV holds its own master's process: ask ssh to stop first (clean
    // channel shutdown), then reap the process, which also takes any
    // ProxyCommand helper with it. A master PDV merely borrowed is left
    // running: other terminals may be using it, and stopping it would be
    // a surprising side effect.
    await this.teardownOwnMaster();
    this.emit({ phase: "idle", host: null, attemptId: null, node: null, message: "Disconnected." });
  }
}
