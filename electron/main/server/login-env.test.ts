/**
 * login-env.test.ts — Login-environment capture and application.
 *
 * The capture tests run REAL login shells: what this module exists for is
 * the gap between a computed environment and what a shell actually produces
 * (profile chatter, multi-line values, exported functions), and a mocked
 * shell cannot exercise any of that. The apply tests pin the protection
 * contract: a user profile must never override the daemon's own `PDV_*`
 * state.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyLoginEnv,
  captureLoginEnv,
  parseNulEnv,
} from "./login-env";

const itUnix = it.skipIf(process.platform === "win32");

describe("parseNulEnv", () => {
  it("parses NUL-separated pairs", () => {
    expect(parseNulEnv("A=1\0B=two\0")).toEqual({ A: "1", B: "two" });
  });

  it("preserves values containing newlines and equals signs", () => {
    const raw = "FUNC=() {\n  echo hi\n}\0URL=a=b=c\0";
    expect(parseNulEnv(raw)).toEqual({
      FUNC: "() {\n  echo hi\n}",
      URL: "a=b=c",
    });
  });

  it("skips empty and malformed entries", () => {
    expect(parseNulEnv("\0=nokey\0PLAIN\0OK=yes\0")).toEqual({ OK: "yes" });
  });
});

describe("captureLoginEnv", () => {
  let tempDir: string | null = null;
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  itUnix("captures the login shell's environment", async () => {
    const captured = await captureLoginEnv();
    expect(captured).not.toBeNull();
    // PATH is the one variable every shell must end up with.
    expect(captured?.env.PATH).toBeTruthy();
    expect(captured?.setupScriptSourced).toBe(false);
  });

  itUnix("sources the setup script and reports evidence of it", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-login-env-"));
    const script = path.join(tempDir, "setup.sh");
    fs.writeFileSync(script, "export LOGIN_ENV_TEST_MARKER='from setup'\n");
    const captured = await captureLoginEnv({ setupScriptPath: script });
    expect(captured?.env.LOGIN_ENV_TEST_MARKER).toBe("from setup");
    expect(captured?.setupScriptSourced).toBe(true);
    // The evidence sentinel and the capture's own plumbing never leak into
    // the returned map.
    expect(captured?.env.PDV_SETUP_SOURCED).toBeUndefined();
    expect(captured?.env.PDV_SETUP_SCRIPT).toBeUndefined();
    expect(captured?.env.PDV_ENV_OUT).toBeUndefined();
  });

  itUnix("survives a setup script that fails and discards its output", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-login-env-"));
    const script = path.join(tempDir, "setup.sh");
    fs.writeFileSync(
      script,
      "echo '9.99 chatter that must not corrupt anything'\n" +
        "export LOGIN_ENV_TEST_MARKER=survived\n" +
        "this-command-does-not-exist\n",
    );
    const captured = await captureLoginEnv({ setupScriptPath: script });
    // The failing line does not abort the capture, and the marker before it
    // was still exported.
    expect(captured?.env.LOGIN_ENV_TEST_MARKER).toBe("survived");
    expect(captured?.setupScriptSourced).toBe(true);
  });

  itUnix("ignores a missing setup script and does not claim it sourced one", async () => {
    const captured = await captureLoginEnv({
      setupScriptPath: "/nonexistent/pdv-setup-test.sh",
    });
    expect(captured).not.toBeNull();
    expect(captured?.setupScriptSourced).toBe(false);
  });

  itUnix("returns null when the shell hangs past the budget", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-login-env-"));
    const slowShell = path.join(tempDir, "slow-shell");
    fs.writeFileSync(slowShell, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const env = await captureLoginEnv({ shellPath: slowShell, timeoutMs: 200 });
    expect(env).toBeNull();
  });

  itUnix("returns null when the shell is missing", async () => {
    const env = await captureLoginEnv({
      shellPath: "/nonexistent/pdv-no-such-bash",
    });
    expect(env).toBeNull();
  });
});

describe("applyLoginEnv", () => {
  const TOUCHED = [
    "PDV_LOGIN_APPLY_A",
    "PDV_APPLY_PROTECTED_TEST",
    "LOGIN_APPLY_PLAIN",
    "ELECTRON_RUN_AS_NODE",
  ] as const;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of TOUCHED) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  const save = (): void => {
    for (const key of TOUCHED) saved.set(key, process.env[key]);
  };

  it("adds and changes plain variables, counting only real changes", () => {
    save();
    delete process.env.LOGIN_APPLY_PLAIN;
    const changed = applyLoginEnv({ LOGIN_APPLY_PLAIN: "v" });
    expect(process.env.LOGIN_APPLY_PLAIN).toBe("v");
    expect(changed).toBe(1);
    // Applying the same value again changes nothing.
    expect(applyLoginEnv({ LOGIN_APPLY_PLAIN: "v" })).toBe(0);
  });

  it("never lets a capture override PDV_* or ELECTRON_RUN_AS_NODE", () => {
    save();
    process.env.PDV_APPLY_PROTECTED_TEST = "daemon-truth";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    const changed = applyLoginEnv({
      PDV_APPLY_PROTECTED_TEST: "profile-lie",
      ELECTRON_RUN_AS_NODE: "0",
    });
    expect(changed).toBe(0);
    expect(process.env.PDV_APPLY_PROTECTED_TEST).toBe("daemon-truth");
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("leaves variables absent from the capture untouched", () => {
    save();
    process.env.LOGIN_APPLY_PLAIN = "keep-me";
    applyLoginEnv({ PDV_LOGIN_APPLY_A: "x" });
    expect(process.env.LOGIN_APPLY_PLAIN).toBe("keep-me");
  });
});
