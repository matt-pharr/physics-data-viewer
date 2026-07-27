/**
 * session-meta.test.ts — session.json round-trips and refuses to half-answer.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSessionMeta, writeSessionMeta, type SessionMeta } from "./session-meta";

let workDir: string;
let metaPath: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-meta-"));
  metaPath = path.join(workDir, "session.json");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const meta: SessionMeta = {
  sessionId: "abc",
  version: "9.9.9-test",
  protocol: 2,
  pid: 4242,
  bootId: "boot-1",
  hostname: "flux-login1.pppl.gov",
  sockPath: "/run/user/42/pdv/s-abc.sock",
  runtimeSource: "XDG_RUNTIME_DIR",
  startedAt: "2026-07-25T00:00:00.000Z",
};

describe("session meta", () => {
  it("round-trips", () => {
    writeSessionMeta(metaPath, meta);
    expect(readSessionMeta(metaPath)).toEqual(meta);
  });

  it("records the concrete node, not the alias the user typed", () => {
    // flux.pppl.gov round-robins and the socket is node-local; a reattach
    // that follows the alias lands on login2 and reports a vanished session.
    writeSessionMeta(metaPath, meta);
    expect(readSessionMeta(metaPath)?.hostname).toBe("flux-login1.pppl.gov");
  });

  it("creates the session directory when it is new", () => {
    const nested = path.join(workDir, "run", "sessions", "abc", "session.json");
    writeSessionMeta(nested, meta);
    expect(readSessionMeta(nested)).toEqual(meta);
  });

  it("leaves no temp file behind", () => {
    writeSessionMeta(metaPath, meta);
    const strays = fs.readdirSync(workDir).filter((f) => f.includes("tmp"));
    expect(strays).toEqual([]);
  });

  it("overwrites a previous record in place", () => {
    writeSessionMeta(metaPath, meta);
    writeSessionMeta(metaPath, { ...meta, pid: 9999 });
    expect(readSessionMeta(metaPath)?.pid).toBe(9999);
  });

  it("reports a missing file as unreachable rather than throwing", () => {
    expect(readSessionMeta(metaPath)).toBeNull();
  });

  it("rejects a truncated record instead of half-trusting it", () => {
    // A half-written session.json looks authoritative and is wrong, which is
    // worse than none at all — hence the atomic write, and this guard for
    // anything that predates it.
    fs.writeFileSync(metaPath, '{"sessionId": "abc"');
    expect(readSessionMeta(metaPath)).toBeNull();
  });

  it("rejects a structurally wrong record", () => {
    fs.writeFileSync(metaPath, JSON.stringify({ sessionId: "abc" }));
    expect(readSessionMeta(metaPath)).toBeNull();
  });
});
