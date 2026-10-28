/**
 * attach-cli.ts — join a session, creating its daemon if asked to.
 *
 * `pdv-server attach --session <id> --stdio` is what an SSH channel runs. It
 * is a *proxy*, not a server: it connects to the session's Unix socket and
 * shuffles bytes between that socket and its own stdio. The daemon on the
 * other side is what holds the kernel, the journal and the settlements, and
 * it is already running (or is started here) independently of this process.
 *
 * That indirection is the whole point. The ssh channel can die at any
 * moment — lid closed, VPN dropped, cable pulled — and all that dies with it
 * is this proxy. The session keeps running, and the next channel starts a
 * new proxy that attaches to the same daemon and replays what was missed.
 *
 * **Creation is gated by the spawn lock, never by the socket.** Two channels
 * arriving together both find a stale socket, both get `ECONNREFUSED`, and
 * without the lock both would spawn a daemon — leaving one of them serving a
 * kernel and a Tree that nobody will ever connect to. See `session-lock.ts`.
 *
 * This module does NOT interpret the protocol flowing through it; it is a
 * pipe with a spawn path attached.
 */

import * as fs from "fs";
import * as net from "net";

import { daemonize } from "./daemonize";
import { acquireSpawnLock } from "./session-lock";
import { heartbeatAgeMs, readSessionMeta } from "./session-meta";
import { resolveSessionPaths, type SessionPaths } from "./session-paths";

/**
 * How long to wait for a freshly spawned daemon to bind its socket. Sized
 * to contain the daemon's startup login-environment capture — up to 15 s
 * when a setup script full of `module load` lines exists
 * (`login-env.ts`'s SETUP_CAPTURE_TIMEOUT_MS) — plus bundle require and
 * bind overhead on a contended login node. A successful start never waits
 * this long (the poll returns as soon as the socket answers); the budget
 * only delays the failure verdict.
 */
export const SPAWN_WAIT_MS = 25_000;

/** Poll interval while waiting for the socket to appear. */
const SPAWN_POLL_MS = 50;

/**
 * Machine-parseable token in the wrong-node refusal, scraped from the ssh
 * channel's stderr by the shell so it can pin the next connection to the
 * right node. Format: `PDV_WRONG_NODE node=<hostname>`.
 */
export const WRONG_NODE_MARKER = "PDV_WRONG_NODE";

/**
 * How fresh the recorded daemon's heartbeat must be for a WRONG-node attach
 * to refuse creation. The daemon touches its beacon every minute
 * (`server-main.ts`), so five minutes absorbs NFS attribute-cache lag and a
 * paused daemon without leaving a dead session unrecoverable for long.
 */
export const WRONG_NODE_HEARTBEAT_FRESH_MS = 5 * 60_000;

/** Options for {@link attachToSession}. */
export interface AttachToSessionOptions {
  /** Session identifier. */
  sessionId: string;
  /** PDV root (`~/.pdv-server`). */
  root: string;
  /** Create the session when no daemon is running. */
  create: boolean;
  /** Executable used to spawn the daemon. Defaults to `process.execPath`. */
  execPath?: string;
  /** Arguments preceding the daemon subcommand (e.g. the bundle entry). */
  execArgs?: string[];
  /** Environment for a spawned daemon. */
  env?: NodeJS.ProcessEnv;
  /** Spawn wait budget. Defaults to {@link SPAWN_WAIT_MS}. */
  spawnWaitMs?: number;
  /** This machine's hostname, for the wrong-node guard. Injected by tests. */
  hostname?: string;
}

/** A socket connected to a live session. */
export interface AttachedSession {
  socket: net.Socket;
  paths: SessionPaths;
  /** True when this call started the daemon rather than joining one. */
  created: boolean;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect to a session socket.
 *
 * @param sockPath - Socket to connect to.
 * @returns The connected socket, or `null` when nothing is listening
 *   (`ECONNREFUSED` on a stale file, or `ENOENT` when there is none).
 */
export function tryConnect(sockPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath);
    const fail = (): void => {
      socket.destroy();
      resolve(null);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

/**
 * Join a session, starting its daemon when asked to and none is running.
 *
 * @param opts - Session identity, root, and whether creation is permitted.
 * @returns The connected socket and resolved paths.
 * @throws Error when no daemon is running and `create` is false, when
 *   another process holds the spawn lock, or when a spawned daemon does not
 *   bind within the wait budget.
 */
export async function attachToSession(
  opts: AttachToSessionOptions,
): Promise<AttachedSession> {
  const paths = resolveSessionPaths({
    sessionId: opts.sessionId,
    root: opts.root,
    hostname: opts.hostname,
  });

  // Prefer the recorded socket over the recomputed one: the daemon is the
  // authority on where it actually listens, and resolution could differ.
  const meta = readSessionMeta(paths.metaPath);
  const sockPath = meta?.sockPath ?? paths.sockPath;

  const existing = await tryConnect(sockPath);
  if (existing) return { socket: existing, paths, created: false };

  // The wrong-node guard. The session directory is on a shared home, so an
  // attach that round-robined onto a different login node finds the
  // session.json of a daemon it can never reach (the socket is node-local)
  // — and with `--create` it would happily fork a second daemon for the
  // same session, stranding the first with the user's kernel and Tree.
  // Refuse instead, loudly enough for the shell to aim its next connection
  // at the right node. A stale heartbeat means the daemon is plausibly dead
  // (a node reboot, a purge) — then creation here is recovery, not a fork.
  if (meta?.hostname && meta.hostname !== paths.hostname) {
    const age = heartbeatAgeMs(paths.heartbeatPath);
    if (age !== null && age < WRONG_NODE_HEARTBEAT_FRESH_MS) {
      throw new Error(
        `${WRONG_NODE_MARKER} node=${meta.hostname} — session ` +
          `${opts.sessionId} is running on ${meta.hostname}, but this ` +
          `connection landed on ${paths.hostname}. Reconnect to ` +
          `${meta.hostname}.`,
      );
    }
    if (opts.create) {
      console.error(
        `[attach] session ${opts.sessionId} was last served on ` +
          `${meta.hostname} but its heartbeat is ` +
          `${age === null ? "absent" : `${String(Math.round(age / 1000))}s old`}; ` +
          `treating that daemon as dead and serving from ${paths.hostname}.`,
      );
    }
  }

  if (!opts.create) {
    throw new Error(
      `[attach] no daemon is serving session ${opts.sessionId}. ` +
        "Pass --create to start one.",
    );
  }

  const lock = acquireSpawnLock({
    lockPath: paths.lockPath,
    sockPath: paths.sockPath,
  });
  if (!lock.acquired) {
    // Someone else is mid-spawn. Wait for their socket rather than racing
    // them — two daemons for one session is the failure this prevents.
    const socket = await waitForSocket(paths.sockPath, opts.spawnWaitMs);
    if (socket) return { socket, paths, created: false };
    throw new Error(
      `[attach] session ${opts.sessionId} is being started by pid ` +
        `${lock.holder?.pid ?? "unknown"} (${lock.reason}), but no socket appeared.`,
    );
  }

  try {
    // A leftover socket file from a dead daemon would block bind(2).
    try {
      fs.unlinkSync(paths.sockPath);
    } catch {
      // Nothing to remove.
    }

    daemonize({
      execPath: opts.execPath ?? process.execPath,
      args: [
        ...(opts.execArgs ?? []),
        "session-host",
        "--session",
        opts.sessionId,
        "--root",
        opts.root,
      ],
      logPath: paths.logPath,
      env: opts.env,
    });

    const socket = await waitForSocket(paths.sockPath, opts.spawnWaitMs);
    if (!socket) {
      throw new Error(
        `[attach] the session daemon did not start. See ${paths.logPath}.`,
      );
    }
    return { socket, paths, created: true };
  } finally {
    // Released either way: the daemon owns the socket now, and holding the
    // lock past the spawn would block every later attach.
    lock.release();
  }
}

/** Poll until a daemon binds the socket, or the budget runs out. */
async function waitForSocket(
  sockPath: string,
  budgetMs = SPAWN_WAIT_MS,
): Promise<net.Socket | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const socket = await tryConnect(sockPath);
    if (socket) return socket;
    await delay(SPAWN_POLL_MS);
  }
  return null;
}

/**
 * Pipe this process's stdio to a session socket until either end closes.
 *
 * @param socket - The connected session socket.
 * @returns Resolves with the exit code the proxy should use.
 */
export function proxyStdio(socket: net.Socket): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    process.stdin.pipe(socket);
    socket.pipe(process.stdout);

    // The channel going away is the ordinary case, not an error: it is what
    // a closed lid looks like. The daemon carries on regardless.
    socket.once("close", () => finish(0));
    socket.once("error", () => finish(1));
    process.stdin.once("end", () => socket.end());
  });
}
