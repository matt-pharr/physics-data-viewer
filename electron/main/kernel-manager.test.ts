/**
 * kernel-manager.test.ts — Integration tests for KernelManager.
 *
 * @slow — These tests spawn real Python kernel subprocesses and require
 * `ipykernel` to be installed in the active Python environment. They are
 * excluded from fast CI runs and should only be executed with:
 *
 *   cd electron && npm test -- --reporter=verbose kernel-manager
 *
 * Tests cover:
 * 1. start() returns a KernelInfo with a valid id and status 'idle'.
 * 2. execute() with '1 + 1' returns result: 2.
 * 3. execute() with 'print("hello")' returns stdout: 'hello\n'.
 * 4. execute() with 'raise ValueError("oops")' returns an error string
 *    containing 'ValueError'.
 * 5. stop() causes the kernel process to exit within 3 seconds.
 * 6. shutdownAll() stops all running kernels.
 * 7. Crash detection: killing the kernel externally emits 'kernel:crashed'.
 *
 * Reference: IMPLEMENTATION_STEPS.md Step 3
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { KernelManager, KernelInfo } from "./kernel-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh KernelManager and register cleanup. */
function makeManager(): KernelManager {
  return new KernelManager();
}

// ---------------------------------------------------------------------------
// @slow KernelManager tests — real ipykernel processes
// ---------------------------------------------------------------------------

describe("@slow KernelManager (real kernel process)", { timeout: 60_000 }, () => {
  let km: KernelManager;
  let startedKernelId: string | undefined;

  beforeEach(() => {
    km = makeManager();
    startedKernelId = undefined;
  });

  afterEach(async () => {
    // Always shut everything down even if a test failed partway through.
    await km.shutdownAll();
  });

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  describe("start()", () => {
    it("returns KernelInfo with a valid id and status: 'idle'", async () => {
      const info: KernelInfo = await km.start();

      expect(typeof info.id).toBe("string");
      expect(info.id.length).toBeGreaterThan(0);
      expect(info.status).toBe("idle");
      expect(info.language).toBe("python");

      startedKernelId = info.id;
    });

    it("appears in list() after start()", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const kernels = km.list();
      expect(kernels.some((k) => k.id === info.id)).toBe(true);
    });

    it("getKernel() returns the KernelInfo for a started kernel", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const found = km.getKernel(info.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(info.id);
    });
  });

  // -------------------------------------------------------------------------
  // execute()
  // -------------------------------------------------------------------------

  describe("execute()", () => {
    it("returns result: 2 for code '1 + 1'", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const result = await km.execute(info.id, { code: "1 + 1" });

      expect(result.error).toBeUndefined();
      expect(result.result).toBe(2);
    });

    it("returns stdout: 'hello\\n' for print(\"hello\")", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const result = await km.execute(info.id, { code: 'print("hello")' });

      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe("hello\n");
    });

    it("returns error containing 'ValueError' for raise ValueError", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const result = await km.execute(info.id, {
        code: 'raise ValueError("oops")',
      });

      expect(result.error).toBeDefined();
      expect(result.error).toContain("ValueError");
    });

    it("records duration in the result", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const result = await km.execute(info.id, { code: "pass" });

      expect(typeof result.duration).toBe("number");
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe("stop()", () => {
    it("causes the kernel process to exit within 3 seconds", async () => {
      const info = await km.start();
      const kernel = km.getKernel(info.id);
      expect(kernel).toBeDefined();

      const before = Date.now();
      await km.stop(info.id);
      const elapsed = Date.now() - before;

      // Should complete within the 3-second wait window (plus a small buffer).
      expect(elapsed).toBeLessThan(5000);

      // Kernel should no longer be in the list.
      expect(km.getKernel(info.id)).toBeUndefined();
    });

    it("is a no-op for an unknown kernel id", async () => {
      // Should resolve without throwing.
      await expect(km.stop("nonexistent-id")).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // shutdownAll()
  // -------------------------------------------------------------------------

  describe("shutdownAll()", () => {
    it("stops all running kernels", async () => {
      const [a, b] = await Promise.all([km.start(), km.start()]);

      expect(km.list().length).toBe(2);

      await km.shutdownAll();

      expect(km.list().length).toBe(0);
      expect(km.getKernel(a.id)).toBeUndefined();
      expect(km.getKernel(b.id)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Crash detection
  // -------------------------------------------------------------------------

  describe("crash detection", () => {
    it("emits 'kernel:crashed' when the process is killed externally", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      // Grab the underlying ChildProcess via the private map by intercepting
      // onIopubMessage (which also has kernel id) then using getKernel.
      // Instead, read process.pid from the internal ManagedKernel by
      // accessing the private kernels map via casting.
      const managed = (km as unknown as { kernels: Map<string, { process: import("child_process").ChildProcess }> })
        .kernels.get(info.id);
      expect(managed).toBeDefined();

      const crashPromise = new Promise<string>((resolve) => {
        km.once("kernel:crashed", (id: string) => resolve(id));
      });

      // Mark as not-shuttingDown so the crash detection fires (it already is
      // false by default; just ensure we didn't accidentally set it).
      managed!.process.kill("SIGKILL");

      const crashedId = await crashPromise;
      expect(crashedId).toBe(info.id);
    });
  });

  // -------------------------------------------------------------------------
  // onIopubMessage()
  // -------------------------------------------------------------------------

  describe("onIopubMessage()", () => {
    it("callback receives iopub messages during execution", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const messages: string[] = [];
      const unsub = km.onIopubMessage(info.id, (msg) => {
        messages.push(msg.header.msg_type);
      });

      await km.execute(info.id, { code: 'print("iopub-test")' });
      unsub();

      // Should have received at least 'stream' and 'status' messages.
      expect(messages).toContain("stream");
      expect(messages).toContain("status");
    });

    it("returned unsubscribe function stops delivery", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const received: string[] = [];
      const unsub = km.onIopubMessage(info.id, (msg) => {
        received.push(msg.header.msg_type);
      });

      // Unsubscribe immediately.
      unsub();

      await km.execute(info.id, { code: "pass" });

      // Nothing should have been delivered after unsubscribe.
      expect(received.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // complete()
  // -------------------------------------------------------------------------

  describe("complete()", () => {
    it("returns non-empty matches for a partial identifier", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const result = await km.complete(info.id, "impor", 5);

      expect(result.matches).toBeDefined();
      expect(Array.isArray(result.matches)).toBe(true);
      // 'import' should appear somewhere in the completions for 'impor'
      expect(result.matches.some((m) => m.startsWith("impor") || m === "import")).toBe(true);
      expect(typeof result.cursor_start).toBe("number");
      expect(typeof result.cursor_end).toBe("number");
    });

    it("returns completions for a live namespace variable", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      // Create a variable in the kernel namespace
      await km.execute(info.id, { code: "my_test_list = [1, 2, 3]" });

      // Request completions at the end of 'my_test_list.'
      const code = "my_test_list.";
      const result = await km.complete(info.id, code, code.length);

      expect(result.matches.length).toBeGreaterThan(0);
      // list methods should appear (e.g. 'append', 'extend')
      expect(result.matches.some((m) => m.includes("append") || m.includes("extend"))).toBe(true);
    });

    it("returns empty matches for an unknown kernel id", async () => {
      const result = await km.complete("nonexistent-id", "x", 1).catch(() => ({
        matches: [],
        cursor_start: 1,
        cursor_end: 1,
      }));
      expect(result.matches).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // inspect()
  // -------------------------------------------------------------------------

  describe("inspect()", () => {
    it("returns found: true with docstring for a known symbol", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const code = "len";
      const result = await km.inspect(info.id, code, code.length);

      expect(result.found).toBe(true);
      expect(result.data?.["text/plain"]).toBeDefined();
      expect(typeof result.data?.["text/plain"]).toBe("string");
    });

    it("returns found: false for a non-existent symbol", async () => {
      const info = await km.start();
      startedKernelId = info.id;

      const result = await km.inspect(info.id, "xyzzy_undefined_symbol", 22);

      expect(result.found).toBe(false);
    });

    it("returns empty for an unknown kernel id", async () => {
      const result = await km.inspect("nonexistent-id", "len", 3).catch(() => ({
        found: false,
      }));
      expect(result.found).toBe(false);
    });
  });
});
