/**
 * kernel-manager-errors.test.ts — Error-path tests for KernelManager.
 *
 * @slow — Spawns real kernel subprocesses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import { KernelManager } from "./kernel-manager";

const TEST_PYTHON_EXECUTABLE = process.env.PYTHON_PATH ?? "python3";

describe("@slow KernelManager error paths", { timeout: 90_000 }, () => {
  let km: KernelManager;

  const startKernel = () =>
    km.start({
      language: "python",
      env: { PYTHON_PATH: TEST_PYTHON_EXECUTABLE },
    });

  beforeEach(() => {
    km = new KernelManager();
  });

  // Bump the hook timeout to 30s (up from vitest's 10s default) because
  // real-kernel shutdown can hang briefly while zmq sockets close on a
  // busy CI runner. Test timeout is already 90s via the describe options.
  afterEach(async () => {
    await km.shutdownAll();
  }, 30_000);

  it("interpreter that exits at startup -> start() rejects immediately", async () => {
    // The ready-wait's idle allowance is deliberately generous (180 s) so a
    // healthy kernel can import silently from a cold-NFS venv; a process
    // that EXITS must therefore fail the wait at once rather than riding
    // out the timer. Shim prints a traceback-ish line and dies like a
    // broken interpreter does.
    const os = await import("os");
    const path = await import("path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-dead-python-"));
    const shim = path.join(dir, "python3");
    await fs.writeFile(shim, "#!/bin/sh\necho boom >&2\nexit 3\n", {
      mode: 0o755,
    });

    const started = Date.now();
    await expect(
      km.start({ language: "python", env: { PYTHON_PATH: shim } })
    ).rejects.toThrow(/exited during startup/);
    // Well under the 180 s idle allowance — exit is what rejected us.
    expect(Date.now() - started).toBeLessThan(20_000);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("ready-wait rejects when the process is already dead at entry", async () => {
    // The CI-caught ordering: the kernel process exits BEFORE
    // waitForKernelReady even runs (slow runner), so the exit event fired
    // pre-registration and only the exitCode check can see it. This used
    // to reject through done() while idleTimer was still in its temporal
    // dead zone ("Cannot access 'idleTimer' before initialization").
    const { EventEmitter } = await import("events");
    const proc = Object.assign(new EventEmitter(), { exitCode: 3 });
    const fake = {
      info: { id: "dead-at-entry" },
      sessionId: "s",
      process: proc,
      shellSocket: { send: async () => {} },
      connectionInfo: { key: "k" },
      shellQueue: Promise.resolve(),
    };
    const wait = (
      km as unknown as {
        waitForKernelReady(m: unknown, a: number, b: number): Promise<void>;
      }
    ).waitForKernelReady(fake, 60_000, 120_000);
    await expect(wait).rejects.toThrow(/exited during startup \(exit code 3\)/);
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
