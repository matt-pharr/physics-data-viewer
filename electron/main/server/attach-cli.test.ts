/**
 * attach-cli.test.ts — joining a session, and creating one exactly once.
 *
 * Uses a real daemon over a real socket. The behaviour under test is
 * inherently about processes and files — who spawned what, which socket
 * survived — and a mock would only be able to confirm the arguments passed.
 */

import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachToSession, tryConnect } from "./attach-cli";
import { acquireSpawnLock } from "./session-lock";
import { readSessionMeta } from "./session-meta";
import { resolveSessionPaths } from "./session-paths";

const SESSION = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

let workDir: string;
let root: string;
const sockets: net.Socket[] = [];
const servers: net.Server[] = [];

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-attach-"));
  root = path.join(workDir, "root");
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const srv of servers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Stand in for a running daemon by listening on the session socket. */
function fakeDaemon(sockPath: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    // A client destroyed in teardown resets this end. Without a handler the
    // ECONNRESET is an unhandled 'error' event, which fails the whole run
    // *after* every test has passed — a green suite with a red exit code.
    socket.on("error", () => undefined);
    socket.write('{"event":"pdv.rpc.hello","payload":{},"seq":-1}\n');
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
}

describe("attachToSession", () => {
  it("joins a daemon that is already running", async () => {
    const paths = resolveSessionPaths({ sessionId: SESSION, root });
    await fakeDaemon(paths.sockPath);

    const result = await attachToSession({ sessionId: SESSION, root, create: false });
    result.socket.on("error", () => undefined);
    sockets.push(result.socket);

    expect(result.created).toBe(false);
    expect(result.socket.destroyed).toBe(false);
  });

  it("refuses to start one unless asked", async () => {
    await expect(
      attachToSession({ sessionId: SESSION, root, create: false }),
    ).rejects.toThrow(/Pass --create/);
  });

  it("prefers the socket session.json records over the recomputed one", async () => {
    // The daemon is the authority on where it actually listens; resolution
    // could pick a different candidate on a later run, and recomputing would
    // send the attach somewhere nobody is serving.
    const paths = resolveSessionPaths({ sessionId: SESSION, root });
    const elsewhere = path.join(workDir, "elsewhere.sock");
    await fakeDaemon(elsewhere);
    fs.writeFileSync(
      paths.metaPath,
      JSON.stringify({ sessionId: SESSION, sockPath: elsewhere }),
    );

    const result = await attachToSession({ sessionId: SESSION, root, create: false });
    sockets.push(result.socket);
    expect(result.created).toBe(false);
    expect(readSessionMeta(paths.metaPath)?.sockPath).toBe(elsewhere);
  });

  it("waits for the spawning process instead of racing it", async () => {
    // Another attach holds the spawn lock. Spawning a second daemon here is
    // the failure the lock exists to prevent: one of them would end up
    // serving a kernel and a Tree nobody will ever connect to.
    const paths = resolveSessionPaths({ sessionId: SESSION, root });
    const held = acquireSpawnLock({
      lockPath: paths.lockPath,
      sockPath: paths.sockPath,
      pid: process.pid,
      isProcessAlive: () => true,
    });
    expect(held.acquired).toBe(true);

    // The "other process" binds shortly after we start waiting.
    setTimeout(() => void fakeDaemon(paths.sockPath), 120);

    const result = await attachToSession({
      sessionId: SESSION,
      root,
      create: true,
      spawnWaitMs: 3000,
    });
    sockets.push(result.socket);

    // Joined the other daemon; did not create a second one.
    expect(result.created).toBe(false);
  });

  it("gives up with an actionable error when a spawn never binds", async () => {
    const paths = resolveSessionPaths({ sessionId: SESSION, root });
    const held = acquireSpawnLock({
      lockPath: paths.lockPath,
      sockPath: paths.sockPath,
      pid: process.pid,
      isProcessAlive: () => true,
    });
    expect(held.acquired).toBe(true);

    await expect(
      attachToSession({ sessionId: SESSION, root, create: true, spawnWaitMs: 150 }),
    ).rejects.toThrow(/no socket appeared/);
  });
});

describe("tryConnect", () => {
  it("returns null when nothing is listening", async () => {
    expect(await tryConnect(path.join(workDir, "absent.sock"))).toBeNull();
  });

  it("returns null for a stale socket file rather than throwing", async () => {
    // A leftover file from a daemon that died: ECONNREFUSED, not ENOENT.
    // Treating the two differently is what leads to a stale socket being
    // mistaken for a live session.
    const stale = path.join(workDir, "stale.sock");
    fs.writeFileSync(stale, "");
    expect(await tryConnect(stale)).toBeNull();
  });

  it("connects to a live socket", async () => {
    const live = path.join(workDir, "live.sock");
    await fakeDaemon(live);
    const socket = await tryConnect(live);
    if (socket) {
      socket.on("error", () => undefined);
      sockets.push(socket);
    }
    expect(socket).not.toBeNull();
  });
});
