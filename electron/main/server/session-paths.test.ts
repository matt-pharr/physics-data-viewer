/**
 * session-paths.test.ts — socket placement and the path budget.
 *
 * Environment and uid are injected rather than read from the runner, so
 * these assertions describe the code and not the machine. (A previous test
 * in this branch asserted a macOS-only behaviour and failed on the Linux
 * runner; anything touching paths or platform gets named inputs.)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SOCKET_PATH_MAX_BYTES,
  ensurePrivateDir,
  resolveSessionPaths,
  runtimeDirCandidates,
} from "./session-paths";

let workDir: string;
let root: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-paths-test-"));
  root = path.join(workDir, ".pdv-server");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const SESSION = "3f2a1b9c-0000-4000-8000-abcdefabcdef";

describe("runtimeDirCandidates", () => {
  it("prefers the explicit override above everything", () => {
    const candidates = runtimeDirCandidates({
      root,
      env: { PDV_SERVER_RUNTIME_DIR: "/run/override", XDG_RUNTIME_DIR: "/run/user/42" },
      uid: 42,
    });
    expect(candidates[0]).toEqual({
      dir: "/run/override",
      source: "PDV_SERVER_RUNTIME_DIR",
    });
  });

  it("prefers XDG_RUNTIME_DIR over /tmp", () => {
    const sources = runtimeDirCandidates({
      root,
      env: { XDG_RUNTIME_DIR: "/run/user/42" },
      uid: 42,
    }).map((c) => c.source);
    expect(sources).toEqual(["XDG_RUNTIME_DIR", "tmp", "root-fallback"]);
  });

  it("namespaces the /tmp candidate by uid", () => {
    const tmp = runtimeDirCandidates({ root, env: {}, uid: 1234 }).find(
      (c) => c.source === "tmp",
    );
    expect(tmp?.dir).toBe(path.join(os.tmpdir(), "pdv-server-1234"));
  });

  it("keeps the NFS root only as a last resort", () => {
    const candidates = runtimeDirCandidates({ root, env: {}, uid: 42 });
    expect(candidates.at(-1)?.source).toBe("root-fallback");
  });
});

describe("resolveSessionPaths", () => {
  it("puts metadata under the root and the socket outside it", () => {
    const paths = resolveSessionPaths({
      sessionId: SESSION,
      root,
      env: { XDG_RUNTIME_DIR: path.join(workDir, "xdg") },
      uid: 42,
      hostname: "flux-login1.pppl.gov",
    });

    // The socket must not live on the (NFS) root — AF_UNIX is unreliable
    // there, which is the whole reason for the split.
    expect(paths.metaPath.startsWith(root)).toBe(true);
    expect(paths.logPath.startsWith(root)).toBe(true);
    expect(paths.sockPath.startsWith(root)).toBe(false);
    expect(paths.runtimeSource).toBe("XDG_RUNTIME_DIR");
  });

  it("records the concrete hostname, not a pool alias", () => {
    const paths = resolveSessionPaths({
      sessionId: SESSION,
      root,
      env: { XDG_RUNTIME_DIR: path.join(workDir, "xdg") },
      uid: 42,
      hostname: "flux-login1.pppl.gov",
    });
    expect(paths.hostname).toBe("flux-login1.pppl.gov");
  });

  it("creates the socket directory private to the user", () => {
    const xdg = path.join(workDir, "xdg");
    const paths = resolveSessionPaths({
      sessionId: SESSION,
      root,
      env: { XDG_RUNTIME_DIR: xdg },
      uid: 42,
    });

    const mode = fs.statSync(path.dirname(paths.sockPath)).mode & 0o777;
    expect(mode & 0o022).toBe(0);
  });

  it("skips a candidate whose socket path would blow the budget", () => {
    // sun_path is ~104 bytes and the limit applies to the whole path, so a
    // deep runtime dir must be rejected here — before a bind fails somewhere
    // far less legible.
    const tooDeep = path.join(workDir, "x".repeat(120));
    const paths = resolveSessionPaths({
      sessionId: SESSION,
      root,
      env: { PDV_SERVER_RUNTIME_DIR: tooDeep },
      uid: 42,
    });

    expect(paths.runtimeSource).not.toBe("PDV_SERVER_RUNTIME_DIR");
    expect(Buffer.byteLength(paths.sockPath)).toBeLessThanOrEqual(
      SOCKET_PATH_MAX_BYTES,
    );
  });

  it("throws an actionable error when nothing fits", () => {
    const deep = path.join(workDir, "y".repeat(120));
    expect(() =>
      resolveSessionPaths({
        sessionId: SESSION,
        root: deep,
        env: { PDV_SERVER_RUNTIME_DIR: deep, XDG_RUNTIME_DIR: deep },
        uid: 42,
        // Force the /tmp candidate to be too long as well, or it would
        // happily absorb every session and this path would be unreachable.
        tmpDir: deep,
      }),
    ).toThrow(/PDV_SERVER_RUNTIME_DIR/);
  });
});

describe("ensurePrivateDir", () => {
  it("creates a directory with owner-only access", () => {
    const dir = path.join(workDir, "private");
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o022).toBe(0);
  });

  it("refuses a directory writable by group or other", () => {
    const dir = path.join(workDir, "loose");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    expect(() => ensurePrivateDir(dir)).toThrow(/writable by group or other/);
  });

  it("is idempotent on an already-private directory", () => {
    const dir = path.join(workDir, "twice");
    ensurePrivateDir(dir);
    expect(() => ensurePrivateDir(dir)).not.toThrow();
  });
});
