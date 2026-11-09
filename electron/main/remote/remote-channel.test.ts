/**
 * remote-channel.test.ts — argv contract of the session attach channel.
 *
 * Uses the repo's runtime-written `#!/bin/sh` stub pattern (see
 * juliaup-runner.test.ts): the fake ssh records its argv to a file, so the
 * assertions see exactly what a real ssh would have been handed.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { openSessionChannel } from "./remote-channel";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** Write a fake ssh that dumps its argv (one per line) and exits. */
function fakeSsh(dir: string): { sshPath: string; argvPath: string } {
  const argvPath = path.join(dir, "argv.txt");
  const sshPath = path.join(dir, "fake-ssh");
  fs.writeFileSync(
    sshPath,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argvPath}"\n`,
    { mode: 0o755 },
  );
  return { sshPath, argvPath };
}

async function argvOf(argvPath: string): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(argvPath)) {
      const text = fs.readFileSync(argvPath, "utf8");
      if (text.length > 0) return text.trimEnd().split("\n");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("fake ssh never wrote its argv");
}

describe("openSessionChannel argv", () => {
  it("adds -o ForwardX11=yes before the destination only when asked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-chan-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { sshPath, argvPath } = fakeSsh(dir);

    const channel = openSessionChannel({
      control: { host: "feyn", controlPath: "/tmp/ctl" },
      sessionId: "s-1",
      serverCommand: "$HOME/.pdv-server/0.2.0/pdv-server.sh",
      forwardX11: true,
      sshPath,
    });
    cleanups.push(channel.dispose);

    const argv = await argvOf(argvPath);
    const x11 = argv.indexOf("ForwardX11=yes");
    expect(x11).toBeGreaterThan(0);
    expect(argv[x11 - 1]).toBe("-o");
    expect(x11).toBeLessThan(argv.indexOf("feyn"));
  });

  it("omits ForwardX11 entirely by default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-chan-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { sshPath, argvPath } = fakeSsh(dir);

    const channel = openSessionChannel({
      control: { host: "feyn", controlPath: "/tmp/ctl" },
      sessionId: "s-1",
      serverCommand: "pdv-server",
      sshPath,
    });
    cleanups.push(channel.dispose);

    const argv = await argvOf(argvPath);
    expect(argv.join(" ")).not.toContain("ForwardX11");
  });
});
