/**
 * remote-connection.test.ts — Connection state machine.
 *
 * The behaviour worth protecting here is *not prompting when a connection
 * already exists*. On a host whose keys sit behind an agent, every new
 * ControlMaster costs the user an approval tap, so a manager that reconnects
 * instead of reusing turns a working feature into a nagging one. Several
 * tests below exist purely to pin that ordering.
 */

import * as crypto from "crypto";
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
  shimUname("Linux", "x86_64");
}

/**
 * Make the probe see an operating system PDV cannot serve.
 *
 * Shimmed rather than relying on the test runner's own OS: an assertion that
 * only holds on a developer's Mac passes locally and fails in CI, which is
 * exactly what happened the first time this was written.
 */
function fakeUnsupportedHost(): void {
  shimUname("Darwin", "arm64");
}

/** Shadow `uname` on PATH so the probe script sees a chosen host. */
function shimUname(sys: string, machine: string): void {
  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in\n  -m) echo ${machine} ;;\n  *) echo ${sys} ;;\nesac\n`,
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

describe("session-node pinning", () => {
  /** The `-N -M` (master-establishing) invocations from the fixture's log. */
  function masterInvocations(logPath: string): string[][] {
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args.includes("-N") && args.includes("-M"));
  }

  it("pins a PDV-created master to the recorded session node", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "hold");
    const logPath = path.join(dir, "ssh-args.log");
    setEnv("FAKE_SSH_LOG", logPath);
    const manager = makeManager({
      sessionNodeFor: (host: string) => (host === "flux" ? "flux-login1.pppl.gov" : null),
    });

    const result = await manager.connect("flux");
    expect(result.ok).toBe(true);
    const masters = masterInvocations(logPath);
    expect(masters).toHaveLength(1);
    expect(masters[0]).toContain("HostName=flux-login1.pppl.gov");
    await manager.disconnect();
  }, 30_000);

  it("rebuilds PDV's own master when the Forward X11 toggle changed", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "hold");
    const logPath = path.join(dir, "ssh-args.log");
    setEnv("FAKE_SSH_LOG", logPath);
    let x11 = false;
    const manager = makeManager({ forwardX11For: () => x11 });

    expect((await manager.connect("feyn")).ok).toBe(true);
    expect(masterInvocations(logPath)).toHaveLength(1);
    expect(masterInvocations(logPath)[0]).not.toContain("ForwardX11");

    // Unchanged toggle → the live master is reused, no second establish.
    expect((await manager.connect("feyn")).ok).toBe(true);
    expect(masterInvocations(logPath)).toHaveLength(1);

    // Toggle flipped → the old master (no forwarding) must be torn down
    // and a fresh one established WITH the flag, or the settings copy
    // ("applies to the next session") silently lies.
    x11 = true;
    const result = await manager.connect("feyn");
    expect(result.ok).toBe(true);
    const masters = masterInvocations(logPath);
    expect(masters).toHaveLength(2);
    expect(masters[1]).toContain("ForwardX11=yes");
    await manager.disconnect();
  }, 30_000);

  it("does not pin when nothing is recorded", async () => {
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "hold");
    const logPath = path.join(dir, "ssh-args.log");
    setEnv("FAKE_SSH_LOG", logPath);
    const manager = makeManager({ sessionNodeFor: () => null });

    const result = await manager.connect("flux");
    expect(result.ok).toBe(true);
    const masters = masterInvocations(logPath);
    expect(masters).toHaveLength(1);
    expect(masters[0].join(" ")).not.toContain("HostName=");
    await manager.disconnect();
  }, 30_000);

  it("falls back to the bare alias when the pinned node is unreachable", async () => {
    // The pin must be best-effort: a login node that was rebooted or
    // drained must not brick the whole alias. Both attempts fail here (the
    // fixture cannot succeed selectively), which still proves the retry —
    // one pinned master attempt, then one unpinned.
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "unreachable");
    const logPath = path.join(dir, "ssh-args.log");
    setEnv("FAKE_SSH_LOG", logPath);
    const manager = makeManager({
      sessionNodeFor: () => "flux-login1.pppl.gov",
    });

    const result = await manager.connect("flux");
    expect(result.ok).toBe(false);
    const masters = masterInvocations(logPath);
    expect(masters).toHaveLength(2);
    expect(masters[0]).toContain("HostName=flux-login1.pppl.gov");
    expect(masters[1].join(" ")).not.toContain("HostName=");
    // The user is told why a second attempt is happening.
    const narration = statuses.map((s) => s.output ?? "").join("");
    expect(narration).toContain("flux-login1.pppl.gov");
    expect(narration).toContain("trying flux directly");
  }, 30_000);

  it("does NOT fall back after a credential failure — no surprise second prompt", async () => {
    // A mistyped password or a denied Duo push means the NODE was fine;
    // retrying against the alias would fire a second interactive auth
    // attempt (a second Duo push) the user never asked for, under a
    // "could not reach the node" narration that would be false.
    setEnv("FAKE_SSH_MASTER", "stateful");
    setEnv("FAKE_SSH_AUTH", "fail");
    const logPath = path.join(dir, "ssh-args.log");
    setEnv("FAKE_SSH_LOG", logPath);
    const manager = makeManager({
      sessionNodeFor: () => "flux-login1.pppl.gov",
    });

    const result = await manager.connect("flux");
    expect(result).toMatchObject({ ok: false, failure: "auth-failed" });
    const masters = masterInvocations(logPath);
    expect(masters).toHaveLength(1);
    expect(masters[0]).toContain("HostName=flux-login1.pppl.gov");
  }, 30_000);
});

describe("bootstrap", () => {
  it("refuses a host PDV cannot run on, before trying to install anything", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    fakeUnsupportedHost();
    const bundleDir = path.join(dir, "bundles");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.json"), JSON.stringify({ bundles: [] }));
    const manager = makeManager({ appVersion: "9.9.9", bundleDir });
    const result = await manager.connect("flux");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/only run a remote session on Linux/);
  }, 30_000);

  it("connects without bootstrapping when no bundles are built", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    fakeLinuxHost();
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

  it("skips the install when the host already has this exact bundle", async () => {
    setEnv("FAKE_SSH_MASTER", "alive");
    fakeLinuxHost();
    const fakeHome = path.join(dir, "home");
    fs.mkdirSync(path.join(fakeHome, ".pdv-server", "9.9.9"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".pdv-server", "9.9.9", ".selfcheck.json"), "{}");
    setEnv("HOME", fakeHome);
    const bundleDir = path.join(dir, "bundles");
    fs.mkdirSync(bundleDir, { recursive: true });
    // A bundle must exist and its sha must match what the host recorded:
    // matching on the version alone would keep a stale rebuild in place.
    const tarball = path.join(bundleDir, "pdv-server-linux-x64.tar.gz");
    fs.writeFileSync(tarball, "bundle-bytes");
    const sha = crypto.createHash("sha256").update("bundle-bytes").digest("hex");
    fs.writeFileSync(path.join(fakeHome, ".pdv-server", "9.9.9", ".bundle-id"), sha);
    fs.writeFileSync(
      path.join(bundleDir, "index.json"),
      JSON.stringify({
        bundles: [{ arch: "x64", file: "pdv-server-linux-x64.tar.gz", sha256: sha }],
      }),
    );

    const manager = makeManager({ appVersion: "9.9.9", bundleDir });
    // The probe finds a matching verdict, so nothing is uploaded — this is
    // the second-connect path, and it must be cheap.
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
