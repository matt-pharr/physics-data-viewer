/**
 * kernel-manager-errors.test.ts — Error-path tests for KernelManager.
 *
 * @slow — Spawns real kernel subprocesses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { KernelManager } from "./kernel-manager";

const TEST_PYTHON_EXECUTABLE =
  process.env.PYTHON_PATH ?? "/Users/pharr/miniconda3/envs/physview/bin/python";

describe("@slow KernelManager error paths", { timeout: 60_000 }, () => {
  let km: KernelManager;

  const startKernel = () =>
    km.start({
      language: "python",
      env: { PYTHON_PATH: TEST_PYTHON_EXECUTABLE },
    });

  beforeEach(() => {
    km = new KernelManager();
  });

  afterEach(async () => {
    await km.shutdownAll();
  });

  it("kernel crash -> kernel:crashed event emitted", async () => {
    const info = await startKernel();
    const managed = (
      km as unknown as {
        kernels: Map<string, { process: import("child_process").ChildProcess }>;
      }
    ).kernels.get(info.id);
    expect(managed).toBeDefined();

    const crashPromise = new Promise<string>((resolve) => {
      km.once("kernel:crashed", (id: string) => resolve(id));
    });

    managed!.process.kill("SIGKILL");
    const crashedId = await crashPromise;
    expect(crashedId).toBe(info.id);
  });

  it("kernel crash -> connection file cleaned up", async () => {
    const info = await startKernel();
    const managed = (
      km as unknown as {
        kernels: Map<
          string,
          {
            process: import("child_process").ChildProcess;
            connectionFile: string;
          }
        >;
      }
    ).kernels.get(info.id);
    expect(managed).toBeDefined();
    const connectionFile = managed!.connectionFile;

    const crashPromise = new Promise<void>((resolve) => {
      km.once("kernel:crashed", () => resolve());
    });

    managed!.process.kill("SIGKILL");
    await crashPromise;
    await km.stop(info.id);

    await expect(fs.stat(connectionFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("execute after crash -> clear error message", async () => {
    const info = await startKernel();
    const managed = (
      km as unknown as {
        kernels: Map<string, { process: import("child_process").ChildProcess }>;
      }
    ).kernels.get(info.id);
    expect(managed).toBeDefined();

    const crashPromise = new Promise<void>((resolve) => {
      km.once("kernel:crashed", () => resolve());
    });

    managed!.process.kill("SIGKILL");
    await crashPromise;

    const result = await km.execute(info.id, { code: "1 + 1" });
    expect(typeof result.error).toBe("string");
    expect((result.error ?? "").length).toBeGreaterThan(0);
  });

  it("interrupt non-existent kernel -> no-op", async () => {
    await expect(km.interrupt("missing-kernel-id")).resolves.toBeUndefined();
  });
});
