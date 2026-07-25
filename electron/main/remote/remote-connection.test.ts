/**
 * remote-connection.test.ts — Connection state machine.
 *
 * The behaviour worth protecting here is *not prompting when a connection
 * already exists*. On a host whose keys sit behind an agent, every new
 * ControlMaster costs the user an approval tap, so a manager that reconnects
 * instead of reusing turns a working feature into a nagging one. Several
 * tests below exist purely to pin that ordering.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RemoteStatus } from "../ipc";
import { RemoteConnectionManager } from "./remote-connection";

const FAKE_SSH = path.join(__dirname, "__fixtures__", "fake-ssh.cjs");

let dir: string;
let statuses: RemoteStatus[];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function makeManager(overrides: Record<string, unknown> = {}): RemoteConnectionManager {
  return new RemoteConnectionManager({
    controlDir: path.join(dir, "sockets"),
    sshPath: FAKE_SSH,
    onStatus: (status) => statuses.push(status),
    ...overrides,
  });
}

/**
 * Make the local machine answer the probe like a linux x86_64 host.
 *
 * The fixture executes the probe script here, so `uname` reports this Mac
 * and the probe rightly refuses it. Shadowing `uname` on PATH is the
 * smallest way to exercise the bootstrap paths that only run on a supported
 * host, without weakening the platform check itself.
 */
function fakeLinuxHost(): void {
  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in\n  -m) echo x86_64 ;;\n  *) echo Linux ;;\nesac\n',
    { mode: 0o755 },
  );
  setEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
}

/** The sequence of phases observed, for order assertions. */
function phases(): string[] {
  return statuses.map((s) => s.phase);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-remote-conn-"));
  statuses = [];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("listHosts", () => {
  it("returns aliases without leaking the config file path", async () => {
    const configPath = path.join(dir, "sshconfig");
    fs.writeFileSync(configPath, "Host feyn\n\tHostname feynman.ap.columbia.edu\n\tUser mcp2198\n");
    const manager = makeManager({ sshConfigPath: configPath });
    const hosts = await manager.listHosts();
    expect(hosts).toEqual([
      { alias: "feyn", hostName: "feynman.ap.columbia.edu", user: "mcp2198" },
    ]);
  });

  it("is empty rather than throwing when there is no config", async () => {
    const manager = makeManager({ sshConfigPath: path.join(dir, "nope") });
    await expect(manager.listHosts()).resolves.toEqual([]);
  });
});

describe("connect", () => {
  it("reuses a live master without authenticating", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    // If this path ever authenticated, the fixture would refuse: `fail`
    // makes any interactive attempt an error rather than a silent success.
    setEnv("FAKE_SSH_AUTH", "fail");
    const manager = makeManager();
    const result = await manager.connect("flux");
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Connected|Already/);
    expect(phases()).toEqual(["connecting", "connected"]);
  }, 30_000);

  it("authenticates when there is no master", async () => {
    setEnv("FAKE_SSH_MASTER", "absent");
    setEnv("FAKE_SSH_AUTH", "ok");
    const manager = makeManager();
    // `absent` keeps -O check failing even after the fixture "authenticates",
    // so the post-auth verification correctly reports no usable master.
    const result = await manager.connect("feyn");
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("no-master");
    expect(phases()).toEqual(["connecting", "failed"]);
  }, 30_000);

  it("streams prompts and masks a secret one", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "prompt");
    const manager = makeManager();
    const connecting = manager.connect("flux");
    // Answer whatever the fixture asks, as the modal will.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (statuses.some((s) => s.phase === "prompting")) {
        manager.respond("hunter2");
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await connecting;
    const prompting = statuses.filter((s) => s.phase === "prompting");
    expect(prompting.length).toBeGreaterThan(0);
    expect(prompting.some((s) => s.secret === true)).toBe(true);
    expect(prompting.map((s) => s.output ?? "").join("")).toContain("password");
  }, 30_000);

  it("never echoes the user's reply back into the status stream", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "prompt");
    const manager = makeManager();
    const connecting = manager.connect("flux");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (statuses.some((s) => s.phase === "prompting")) {
        manager.respond("s3cr3t-passphrase");
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await connecting;
    // The reply goes to the pty and nowhere else. If it ever appeared here it
    // would reach the renderer, the console log and any attached screenshot.
    const everything = JSON.stringify(statuses);
    expect(everything).not.toContain("s3cr3t-passphrase");
  }, 30_000);

  it("refuses a second attempt while one is in flight", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "hang");
    const manager = makeManager({ overallTimeoutMs: 1_000 });
    const first = manager.connect("flux");
    // Give the first attempt time to reach the interactive stage.
    await new Promise((r) => setTimeout(r, 300));
    const second = await manager.connect("feyn");
    expect(second).toMatchObject({ ok: false, failure: "busy" });
    await first;
  }, 30_000);

  it("reports a rejected credential as a failure", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "fail");
    const manager = makeManager();
    const result = await manager.connect("flux");
    expect(result).toMatchObject({ ok: false, failure: "auth-failed" });
    // "Permission denied" is ssh narrating, not asking. Streaming it must not
    // put an input box in front of the user.
    expect(phases()).not.toContain("prompting");
    expect(phases().at(-1)).toBe("failed");
  }, 30_000);

  it("records which machine actually answered", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "hold");
    const manager = makeManager();
    const result = await manager.connect("flux");
    expect(result.ok).toBe(true);
    // The fixture runs `hostname` locally, so this is this machine's name —
    // what matters is that a concrete node is captured rather than the
    // load-balanced alias, which is what pins a session to one login node.
    const node = manager.getStatus().node;
    expect(typeof node).toBe("string");
    expect(node).not.toBe("flux");
    await manager.disconnect();
    expect(manager.getStatus().node).toBeNull();
  }, 30_000);

  it("rejects an empty host without touching ssh", async () => {
    const manager = makeManager({ sshPath: path.join(dir, "definitely-missing") });
    const result = await manager.connect("   ");
    // Whitespace is trimmed to nothing; the manager must not spawn anything.
    expect(result.ok).toBe(false);
  }, 30_000);
});

describe("bootstrap", () => {
  it("refuses a host PDV cannot run on, before trying to install anything", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    const bundleDir = path.join(dir, "bundles");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.json"), JSON.stringify({ bundles: [] }));
    const manager = makeManager({ appVersion: "9.9.9", bundleDir });
    const result = await manager.connect("flux");
    // The probe runs on this Mac, so it reports Darwin — which is exactly
    // the rejection a user on an unsupported host should see.
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/only run a remote session on Linux/);
  }, 30_000);

  it("connects without bootstrapping when no bundles are built", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    const manager = makeManager({ appVersion: "9.9.9" });
    // A checkout with no built bundles must still connect. Refusing would
    // block a flow that works, over a missing build artifact.
    await expect(manager.connect("flux")).resolves.toMatchObject({ ok: true });
    expect(phases()).not.toContain("preparing");
  }, 30_000);

  it("reports a clear error when the host needs components that were never built", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    fakeLinuxHost();
    const bundleDir = path.join(dir, "bundles");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.json"), JSON.stringify({ bundles: [] }));
    const manager = makeManager({ appVersion: "9.9.9", bundleDir });
    const result = await manager.connect("flux");
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("bootstrap");
    expect(result.message).toMatch(/build:server-bundle/);
    expect(phases()).toContain("preparing");
  }, 30_000);

  it("skips the install when the host already has this version", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    fakeLinuxHost();
    const fakeHome = path.join(dir, "home");
    fs.mkdirSync(path.join(fakeHome, ".pdv-server", "9.9.9"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".pdv-server", "9.9.9", ".selfcheck.json"), "{}");
    setEnv("HOME", fakeHome);
    const bundleDir = path.join(dir, "bundles");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.json"), JSON.stringify({ bundles: [] }));

    const manager = makeManager({ appVersion: "9.9.9", bundleDir });
    // The probe finds a cached verdict, so no bundle is needed even though
    // none exists — this is the second-connect path, and it must be cheap.
    await expect(manager.connect("flux")).resolves.toMatchObject({ ok: true });
  }, 30_000);
});

describe("getStatus", () => {
  it("starts idle", () => {
    expect(makeManager().getStatus()).toEqual({
      phase: "idle",
      host: null,
      attemptId: null,
    });
  });

  it("does not replay a finished conversation into a fresh renderer", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "fail");
    const manager = makeManager();
    await manager.connect("flux");
    // The transcript belongs to the attempt that produced it. Hydrating a
    // reloaded window with it would render a dead exchange as though live.
    expect(manager.getStatus().output).toBeUndefined();
    expect(manager.getStatus().phase).toBe("failed");
  }, 30_000);

  it("carries an attemptId so a stale push cannot drive current UI", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    const manager = makeManager();
    await manager.connect("flux");
    const first = manager.getStatus().attemptId;
    await manager.disconnect();
    await manager.connect("feyn");
    expect(manager.getStatus().attemptId).not.toBe(first);
  }, 30_000);
});

describe("disconnect", () => {
  it("stops a master PDV owns", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "hold");
    const manager = makeManager();
    const r = await manager.connect("feyn");
    expect(r.ok).toBe(true);
    await manager.disconnect();
    expect(manager.getStatus()).toMatchObject({ phase: "idle", host: null });
    expect(manager.control).toBeNull();
  }, 30_000);

  it("leaves a master it inherited from the user's own config alone", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    setEnv("FAKE_SSH_LOG", path.join(dir, "argv.log"));
    const manager = makeManager();
    await manager.connect("flux");
    await manager.disconnect();
    const argv = fs.readFileSync(path.join(dir, "argv.log"), "utf8");
    // PDV did not create this master; other terminals may be riding it, so
    // stopping it would be a surprising side effect of closing a session.
    expect(argv).not.toContain('"stop"');
  }, 30_000);

  it("is safe to call when never connected", async () => {
    const manager = makeManager();
    await expect(manager.disconnect()).resolves.toBeUndefined();
  });
});
