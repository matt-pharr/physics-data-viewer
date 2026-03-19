/**
 * environment-detector.test.ts — Unit tests for EnvironmentDetector.
 *
 * All subprocess calls are mocked — no real Python is executed.
 *
 * Tests cover:
 * 1. detect() returns configured path when provided.
 * 2. detect() falls back to CONDA_PREFIX if no configured path.
 * 3. detect() falls back to system Python if no conda/venv.
 * 4. hasPDVKernel() returns true/false based on mock output.
 * 5. listAll() returns conda environments when conda is available.
 * 6. checkPDVInstalled() returns installed/not-installed status.
 * 7. detectEnvironments() returns system Python (always present in CI).
 *
 * Reference: ARCHITECTURE.md §5.1, §10
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EnvironmentDetector } from "./environment-detector";

// ---------------------------------------------------------------------------
// Mock child_process.execFile
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const execFileMock = vi.fn();
  return { execFileMock };
});

vi.mock("child_process", () => ({
  execFile: mocks.execFileMock,
}));

vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return {
    ...actual,
    promisify:
      (fn: unknown) =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          (fn as (...a: unknown[]) => void)(
            ...args,
            (err: unknown, stdout: string, stderr: string) => {
              if (err) reject(err);
              else resolve({ stdout, stderr });
            }
          );
        }),
  };
});

/**
 * Set up the execFile mock to succeed with the given stdout for a specific
 * first argument (the executable name/path).
 *
 * @param executable - Expected first argument to execFile.
 * @param stdout - Stdout string to resolve with.
 * @param stderr - Optional stderr string.
 */
function _mockExecSuccess(
  executable: string,
  stdout: string,
  stderr = ""
): void {
  mocks.execFileMock.mockImplementation(
    (
      cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, stdout: string, stderr: string) => void
    ) => {
      if (cmd === executable) {
        cb(null, stdout, stderr);
      } else {
        cb(new Error(`Mock: unexpected executable ${cmd}`) as never, "", "");
      }
    }
  );
}

/**
 * Set up the execFile mock so every call fails (simulates Python not found).
 */
function mockExecAlwaysFail(): void {
  mocks.execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error) => void
    ) => {
      cb(new Error("Mock: command not found"));
    }
  );
}

/**
 * Set up the execFile mock with per-command handlers.
 *
 * @param handlers - Map from executable string to {stdout, stderr} or Error.
 */
function mockExecPerCommand(
  handlers: Record<string, { stdout: string; stderr?: string } | Error>
): void {
  mocks.execFileMock.mockImplementation(
    (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const result = handlers[cmd];
      if (!result) {
        cb(new Error(`Mock: unexpected executable ${cmd}`));
        return;
      }
      if (result instanceof Error) {
        cb(result);
      } else {
        cb(null, result.stdout, result.stderr ?? "");
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EnvironmentDetector", () => {
  beforeEach(() => {
    EnvironmentDetector.clearCache();
    vi.clearAllMocks();
    // Remove env vars that might bleed between tests.
    delete process.env.CONDA_PREFIX;
    delete process.env.VIRTUAL_ENV;
  });

  describe("detect()", () => {
    it("uses configuredPath when provided", async () => {
      mockExecPerCommand({
        "/usr/local/bin/my-python": { stdout: "Python 3.11.0\n" },
      });

      const env = await EnvironmentDetector.detect("/usr/local/bin/my-python");

      expect(env.kind).toBe("configured");
      expect(env.pythonPath).toBe("/usr/local/bin/my-python");
      expect(env.pythonVersion).toContain("3.11");
    });

    it("falls back to CONDA_PREFIX", async () => {
      process.env.CONDA_PREFIX = "/opt/conda/envs/myenv";
      const condaPython =
        process.platform === "win32"
          ? "/opt/conda/envs/myenv/python.exe"
          : "/opt/conda/envs/myenv/bin/python";

      mockExecPerCommand({
        [condaPython]: { stdout: "Python 3.10.4\n" },
        conda: {
          stdout: JSON.stringify({ envs: ["/opt/conda/envs/myenv"] }),
        },
      });

      const env = await EnvironmentDetector.detect();

      expect(env.kind).toBe("conda");
      expect(env.pythonPath).toBe(condaPython);
    });

    it("falls back to system python when no env vars set", async () => {
      mockExecPerCommand({
        python3: { stdout: "Python 3.9.7\n" },
        conda: { stdout: JSON.stringify({ envs: [] }) },
      });

      const env = await EnvironmentDetector.detect();

      expect(env.kind).toBe("system");
      expect(env.pythonPath).toBe("python3");
    });

    it("throws if no Python is found anywhere", async () => {
      mockExecAlwaysFail();

      await expect(EnvironmentDetector.detect()).rejects.toThrow(
        /no python/i
      );
    });
  });

  describe("checkPDVInstalled()", () => {
    it("returns { installed: true } when pdv_kernel is installed", async () => {
      mockExecPerCommand({
        "/usr/bin/python3": { stdout: "1.0.0\n" },
      });

      const status =
        await EnvironmentDetector.checkPDVInstalled("/usr/bin/python3");

      expect(status.installed).toBe(true);
      expect(status.version).toBe("1.0.0");
      expect(status.compatible).toBe(true);
    });

    it("returns { installed: false } when pdv_kernel is absent", async () => {
      mockExecAlwaysFail();

      const status =
        await EnvironmentDetector.checkPDVInstalled("/nonexistent/python");

      expect(status.installed).toBe(false);
      expect(status.version).toBeNull();
      expect(status.compatible).toBe(false);
    });
  });

  describe("hasPDVKernel()", () => {
    it("returns true when pdv_kernel is installed", async () => {
      mockExecPerCommand({
        "/usr/bin/python3": { stdout: "1.2.3\n" },
      });

      const result = await EnvironmentDetector.hasPDVKernel("/usr/bin/python3");
      expect(result).toBe(true);
    });

    it("returns false when pdv_kernel is absent", async () => {
      mockExecAlwaysFail();

      const result = await EnvironmentDetector.hasPDVKernel("/bad/python");
      expect(result).toBe(false);
    });
  });

  describe("listAll()", () => {
    it("includes system python in result", async () => {
      mockExecPerCommand({
        python3: { stdout: "Python 3.9.7\n" },
        conda: { stdout: JSON.stringify({ envs: [] }) },
      });

      const all = await EnvironmentDetector.listAll();

      expect(all.length).toBeGreaterThan(0);
      const sys = all.find((e) => e.kind === "system");
      expect(sys).toBeDefined();
      expect(sys!.pythonPath).toBe("python3");
    });
  });

  describe("detectEnvironments()", () => {
    it("returns array with at least the system Python", async () => {
      // This mirrors the CI assertion for environment detection.
      mockExecPerCommand({
        python3: { stdout: "Python 3.9.7\n" },
        conda: { stdout: JSON.stringify({ envs: [] }) },
      });

      const envs = await EnvironmentDetector.detectEnvironments();

      expect(Array.isArray(envs)).toBe(true);
      expect(envs.length).toBeGreaterThan(0);
    });
  });

  describe("clearCache()", () => {
    it("forces re-detection on next call", async () => {
      mockExecPerCommand({
        python3: { stdout: "Python 3.9.7\n" },
        conda: { stdout: JSON.stringify({ envs: [] }) },
      });

      const first = await EnvironmentDetector.listAll();
      expect(mocks.execFileMock).toHaveBeenCalled();

      vi.clearAllMocks();
      // Second call — should use cache, no new execFile calls.
      const second = await EnvironmentDetector.listAll();
      expect(mocks.execFileMock).not.toHaveBeenCalled();
      expect(second).toEqual(first);

      // After clearCache, re-detection runs again.
      EnvironmentDetector.clearCache();
      mockExecPerCommand({
        python3: { stdout: "Python 3.9.7\n" },
        conda: { stdout: JSON.stringify({ envs: [] }) },
      });
      await EnvironmentDetector.listAll();
      expect(mocks.execFileMock).toHaveBeenCalled();
    });
  });
});
