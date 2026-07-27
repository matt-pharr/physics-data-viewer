/**
 * spawn.test.ts — Behavior contracts of the server spawn seam, plus the
 * import guard that makes it the *single* subprocess seam.
 *
 * The contract tests pin the semantics call sites rely on: `serverExecFile`
 * resolves decoded streams on success and rejects with `stdout`/`stderr`
 * attached on failure (module-manager surfaces git errors from those
 * fields), and `serverSpawn` hands back a live child whose streaming,
 * timeout, and abort behavior matches `child_process.spawn`.
 *
 * The guard test enforces the seam: no server-destined file other than
 * spawn.ts itself (and daemonize.ts, which spawns pdv-server rather than a
 * user tool) may import `child_process`. Without this, a new tool spawn
 * added anywhere in the server tree would silently bypass the future
 * remote setup-script wrapping and run without the session's environment.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SERVER_DESTINED_FILES } from "./server-files";
import { serverExecFile, serverSpawn } from "./spawn";

const MAIN_DIR = path.resolve(__dirname, "..");

describe("serverExecFile", () => {
  it("resolves with decoded stdout and stderr on exit 0", async () => {
    const { stdout, stderr } = await serverExecFile("sh", [
      "-c",
      "printf out; printf err >&2",
    ]);
    expect(stdout).toBe("out");
    expect(stderr).toBe("err");
  });

  it("rejects on non-zero exit with stdout/stderr attached to the error", async () => {
    let caught: unknown;
    try {
      await serverExecFile("sh", ["-c", "printf partial; printf oops >&2; exit 3"]);
    } catch (err) {
      caught = err;
    }
    const e = caught as { code?: number; stdout?: string; stderr?: string };
    expect(e).toBeTruthy();
    expect(e.code).toBe(3);
    expect(e.stdout).toBe("partial");
    expect(e.stderr).toBe("oops");
  });

  it("rejects when the timeout elapses", async () => {
    await expect(
      serverExecFile("sh", ["-c", "sleep 5"], { timeout: 200 })
    ).rejects.toMatchObject({ killed: true });
  });

  it("runs in the given cwd and env", async () => {
    const { stdout } = await serverExecFile("sh", ["-c", "pwd; printf %s \"$PDV_SPAWN_TEST\""], {
      cwd: path.dirname(__dirname),
      env: { ...process.env, PDV_SPAWN_TEST: "marker" },
    });
    expect(stdout).toContain(fs.realpathSync(path.dirname(__dirname)));
    expect(stdout).toContain("marker");
  });
});

describe("serverSpawn", () => {
  it("returns a child whose streams and exit code behave like child_process.spawn", async () => {
    const proc = serverSpawn("sh", ["-c", "printf hello; exit 7"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    proc.stdout?.on("data", (b: Buffer) => chunks.push(b.toString()));
    const code = await new Promise<number | null>((resolve) => {
      proc.on("close", resolve);
    });
    expect(chunks.join("")).toBe("hello");
    expect(code).toBe(7);
  });

  it("emits an error event (not a throw) when the binary does not exist", async () => {
    const proc = serverSpawn("/nonexistent/pdv-spawn-test-binary", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const err = await new Promise<Error>((resolve) => {
      proc.on("error", resolve);
    });
    expect(err.message).toContain("ENOENT");
  });

  it("kills the child when the abort signal fires", async () => {
    const controller = new AbortController();
    // sleep 30 (not 5): a failed kill must TIME OUT loudly, never pass by
    // the child exiting naturally inside the test budget.
    const proc = serverSpawn("sh", ["-c", "sleep 30"], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
    });
    proc.on("error", () => {
      /* AbortError is expected; the assertion is that the child dies. */
    });
    // Abort only after the process really exists — aborting mid-spawn raced
    // on CI Linux, where the kill landed before the pid did and the exit
    // event never fired inside the budget. `exit`, not `close`: close also
    // waits for stdio to drain through any grandchildren holding the pipes.
    await new Promise<void>((resolve) => proc.once("spawn", resolve));
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        proc.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    controller.abort();
    const { code, signal } = await exited;
    // A signal kill reports (null, SIGTERM); either way it must not be a
    // clean exit 0.
    expect(signal ?? "no-signal").toMatch(/^SIG/);
    expect(code).not.toBe(0);
  });
});

describe("spawn seam import guard", () => {
  /** Matches static imports, type-only imports, and requires of child_process. */
  const CHILD_PROCESS_IMPORT_RE =
    /(?:from\s+["'](?:node:)?child_process["'])|(?:require\(\s*["'](?:node:)?child_process["']\s*\))|(?:import\s*\(\s*["'](?:node:)?child_process["']\s*\))/;

  /**
   * Files allowed to touch child_process directly: the seam itself, and
   * daemonize.ts — which spawns the pdv-server session daemon (server
   * infrastructure, never a user tool, so setup-script wrapping must not
   * apply to it).
   */
  const ALLOWED = new Set(["server/spawn.ts", "server/daemonize.ts"]);

  it("no server-destined file imports child_process outside the seam", () => {
    const offenders = SERVER_DESTINED_FILES.filter((rel) => {
      if (ALLOWED.has(rel)) return false;
      const source = fs.readFileSync(path.join(MAIN_DIR, rel), "utf8");
      return CHILD_PROCESS_IMPORT_RE.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("the guard regex is not vacuous (matches real import forms)", () => {
    expect(CHILD_PROCESS_IMPORT_RE.test('import { spawn } from "child_process";')).toBe(true);
    expect(CHILD_PROCESS_IMPORT_RE.test('import { execFile } from "node:child_process";')).toBe(true);
    expect(CHILD_PROCESS_IMPORT_RE.test('const cp = require("child_process");')).toBe(true);
    expect(CHILD_PROCESS_IMPORT_RE.test('const cp = await import("child_process");')).toBe(true);
    expect(CHILD_PROCESS_IMPORT_RE.test('import * as path from "path";')).toBe(false);
  });
});
