/**
 * self-check.test.ts — bundle self-verification, and the zeromq ABI guard
 * that decides which Node a remote host may run.
 *
 * The ABI test is the valuable one. PDV does not compile zeromq for the
 * remote host; it ships the prebuilt addons already vendored in the npm
 * package, and those exist only for specific Node ABIs. A zeromq upgrade
 * that quietly drops the pinned ABI — or drops arm64, which has always had
 * the thinnest coverage — would produce a bundle that installs cleanly and
 * then fails to start a kernel on a cluster. Catching that here makes it a
 * red CI run instead of a 2am debugging session on someone else's machine.
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { runSelfCheck } from "./self-check";

const ELECTRON_ROOT = path.resolve(__dirname, "..", "..");
const ZEROMQ_LINUX = path.join(ELECTRON_ROOT, "node_modules", "zeromq", "build", "linux");

const saved = process.env.PDV_ZEROMQ_PATH;

afterEach(() => {
  if (saved === undefined) delete process.env.PDV_ZEROMQ_PATH;
  else process.env.PDV_ZEROMQ_PATH = saved;
});

describe("runSelfCheck", () => {
  it("reports the runtime identity a remote install has to match", async () => {
    const report = await runSelfCheck();
    expect(report.pdv).toBe("self-check");
    expect(report.node).toBe(process.versions.node);
    expect(report.abi).toBe(process.versions.modules);
    expect(report.platform).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
  });

  it("verifies scratch space is writable", async () => {
    const report = await runSelfCheck();
    const step = report.steps.find((s) => s.name === "tempdir");
    expect(step?.ok).toBe(true);
  });

  it("binds a real zeromq socket rather than just importing the module", async () => {
    const report = await runSelfCheck();
    const step = report.steps.find((s) => s.name === "zeromq");
    expect(step?.ok).toBe(true);
    // The endpoint proves the addon was dlopen'd and the OS accepted a bind.
    // Merely requiring zeromq would pass even with a broken native binary,
    // because the addon resolves lazily.
    expect(step?.detail).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
  });

  it("fails with an explanation when the addon cannot be loaded", async () => {
    process.env.PDV_ZEROMQ_PATH = path.join(ELECTRON_ROOT, "no-such-zeromq");
    const report = await runSelfCheck();
    expect(report.ok).toBe(false);
    const step = report.steps.find((s) => s.name === "zeromq");
    expect(step?.ok).toBe(false);
    expect(step?.detail).toBeTruthy();
  });

  it("never throws, so a broken host still yields a verdict", async () => {
    process.env.PDV_ZEROMQ_PATH = "/dev/null/nope";
    await expect(runSelfCheck()).resolves.toMatchObject({ ok: false });
  });
});

describe("vendored zeromq prebuilds for remote hosts", () => {
  const { remoteNodeAbi } = JSON.parse(
    fs.readFileSync(path.join(ELECTRON_ROOT, "package.json"), "utf8"),
  ) as { remoteNodeAbi?: string };

  it("pins an ABI in package.json", () => {
    // The pinned ABI is what decides which Node the remote bundle carries.
    // ABI 127 is Node 22.
    expect(remoteNodeAbi).toBeTruthy();
  });

  it.each(["x64", "arm64"])(
    "ships a linux-%s glibc addon at the pinned ABI",
    (arch) => {
      const dir = path.join(ZEROMQ_LINUX, arch, "node", `glibc-${remoteNodeAbi}-Release`);
      // If this fails after a zeromq bump, do not just change the number:
      // check which ABIs the new version ships for BOTH arches, since arm64
      // has historically had only one, and pin the Node major that matches.
      expect(fs.existsSync(dir), `missing ${path.relative(ELECTRON_ROOT, dir)}`).toBe(true);
    },
  );

  it("ships musl builds too, so Alpine-based hosts are servable", () => {
    const dir = path.join(ZEROMQ_LINUX, "x64", "node", `musl-${remoteNodeAbi}-Release`);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
