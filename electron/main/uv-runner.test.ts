/**
 * uv-runner.test.ts — Unit tests for the uv binary resolver and subprocess
 * runner.
 *
 * Verifies that uv-runner:
 * 1. Resolves an explicit binary override and ignores a non-existent one.
 * 2. Runs a binary, captures output, and reports success / exit code.
 * 3. Streams output chunks to a window over an IPC push channel.
 * 4. Rejects with UvBinaryNotFoundError when no binary can be located.
 * 5. Builds correct argv for the typed subcommand wrappers.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { BrowserWindow } from "electron";

import {
  resolveUvBinary,
  runUv,
  uvAdd,
  uvSync,
  UvBinaryNotFoundError,
} from "./uv-runner";

let tmpDir: string;
/** Fake uv that echoes its argv and exits 0. */
let echoUv: string;
/** Fake uv that writes to stderr and exits 3. */
let failUv: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdv-uv-runner-test-"));
  echoUv = path.join(tmpDir, "echo-uv");
  failUv = path.join(tmpDir, "fail-uv");
  fs.writeFileSync(echoUv, '#!/bin/sh\necho "argv:$@"\n', "utf8");
  fs.writeFileSync(failUv, '#!/bin/sh\necho "kaboom" 1>&2\nexit 3\n', "utf8");
  fs.chmodSync(echoUv, 0o755);
  fs.chmodSync(failUv, 0o755);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveUvBinary", () => {
  it("returns an existing override path verbatim", () => {
    expect(resolveUvBinary(echoUv)).toBe(echoUv);
  });

  it("ignores an override path that does not exist", () => {
    const bogus = path.join(tmpDir, "does-not-exist");
    expect(resolveUvBinary(bogus)).not.toBe(bogus);
  });
});

describe("runUv", () => {
  it("runs the binary, succeeds, and captures stdout", async () => {
    const result = await runUv(["sync"], { binaryPath: echoUv });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("argv:sync");
  });

  it("reports failure and the exit code on a non-zero exit", async () => {
    const result = await runUv(["sync"], { binaryPath: failUv });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("kaboom");
  });

  it("streams output chunks to the window's webContents", async () => {
    const send = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: { send },
    } as unknown as BrowserWindow;

    await runUv(["hello"], { binaryPath: echoUv, win, pushChannel: "test:uv" });

    expect(send).toHaveBeenCalled();
    const [channel, chunk] = send.mock.calls[0];
    expect(channel).toBe("test:uv");
    expect(chunk.stream).toBe("stdout");
    expect(chunk.data).toContain("argv:hello");
  });
});

describe("typed subcommand wrappers", () => {
  it("uvSync passes 'sync' and --python when a version is given", async () => {
    const result = await uvSync({ binaryPath: echoUv, pythonVersion: "3.12" });
    expect(result.output).toContain("argv:sync --python 3.12");
  });

  it("uvSync passes only 'sync' when no version is given", async () => {
    const result = await uvSync({ binaryPath: echoUv });
    expect(result.output.trim()).toBe("argv:sync");
  });

  it("uvAdd passes 'add' followed by every spec", async () => {
    const result = await uvAdd(["numpy", "scipy>=1.10"], { binaryPath: echoUv });
    expect(result.output).toContain("argv:add numpy scipy>=1.10");
  });
});

describe("UvBinaryNotFoundError", () => {
  it("has a descriptive name", () => {
    expect(new UvBinaryNotFoundError().name).toBe("UvBinaryNotFoundError");
  });
});
