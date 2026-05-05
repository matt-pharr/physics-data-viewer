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
 * Reference: ARCHITECTURE.md §2
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
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

describe("@slow KernelManager (real kernel process)", { timeout: 90_000 }, () => {
  let km: KernelManager;
  beforeEach(() => {
    km = makeManager();
  });

  // Bump the hook timeout to 30s (up from vitest's 10s default) because
  // real-kernel shutdown can hang briefly while zmq sockets close on a
  // busy CI runner. Test timeout is already 90s via the describe options.
  afterEach(async () => {
    // Always shut everything down even if a test failed partway through.
    await km.shutdownAll();
  }, 30_000);

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


    });

    it("appears in list() after start()", async () => {
      const info = await km.start();


      const kernels = km.list();
      expect(kernels.some((k) => k.id === info.id)).toBe(true);
    });

    it("getKernel() returns the KernelInfo for a started kernel", async () => {
      const info = await km.start();


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


      const result = await km.execute(info.id, { code: "1 + 1" });

      expect(result.error).toBeUndefined();
      expect(result.result).toBe(2);
    });

    it("returns stdout: 'hello\\n' for print(\"hello\")", async () => {
      const info = await km.start();


      const result = await km.execute(info.id, { code: 'print("hello")' });

      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe("hello\n");
    });

    it("returns error containing 'ValueError' for raise ValueError", async () => {
      const info = await km.start();


      const result = await km.execute(info.id, {
        code: 'raise ValueError("oops")',
      });

      expect(result.error).toBeDefined();
      expect(result.error).toContain("ValueError");
    });

    it("preserves traceback details and parsed location metadata", async () => {
      const info = await km.start();


      const result = await km.execute(info.id, {
        code: 'raise ValueError("oops")',
        origin: { kind: "code-cell", label: "Tab 1", tabId: 1 },
      });

      expect(result.error).toContain('Code cell "Tab 1"');
      expect(result.errorDetails).toBeDefined();
      expect(result.errorDetails?.name).toBe("ValueError");
      expect(result.errorDetails?.traceback.length).toBeGreaterThan(0);
      expect(result.errorDetails?.location?.line).toBeGreaterThanOrEqual(1);
    });

    it("extracts syntax-error column metadata when caret info is present", async () => {
      const info = await km.start();


      const result = await km.execute(info.id, {
        code: "x =",
        origin: { kind: "code-cell", label: "Tab 2", tabId: 2 },
      });

      expect(result.error).toContain("SyntaxError");
      expect(result.errorDetails?.location?.line).toBe(1);
      expect(result.errorDetails?.location?.column).toBeGreaterThanOrEqual(1);
    });

    it("accounts for leading blank lines in code-cell location", async () => {
      const info = await km.start();


      const result = await km.execute(info.id, {
        code: "\n\nraise ValueError('oops')",
        origin: { kind: "code-cell", label: "Tab 1", tabId: 1 },
      });

      expect(result.error).toContain("line 3");
      expect(result.errorDetails?.location?.line).toBe(3);
    });

    it("records duration in the result", async () => {
      const info = await km.start();


      const result = await km.execute(info.id, { code: "pass" });

      expect(typeof result.duration).toBe("number");
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // complete() / inspect()
  // -------------------------------------------------------------------------

  describe("complete() / inspect()", () => {
    it("can send a shell request and receive kernel_info_reply", async () => {
      const info = await km.start();


      const managed = (km as unknown as {
        kernels: Map<string, unknown>;
      }).kernels.get(info.id);
      expect(managed).toBeDefined();

      const reply = await (
        km as unknown as {
          sendShellRequest: (
            kernel: unknown,
            msgType: string,
            content: Record<string, unknown>
          ) => Promise<{ header: { msg_type: string } }>;
        }
      ).sendShellRequest(managed, "kernel_info_request", {});

      expect(reply.header.msg_type).toBe("kernel_info_reply");
    });

    it("returns completion matches for os.path.* symbols", async () => {
      const info = await km.start();

      await km.execute(info.id, { code: "import os" });

      const result = await km.complete(info.id, "os.path.", 8);

      expect(result.matches).toContain("join");
      expect(result.cursor_start).toBeGreaterThanOrEqual(0);
      expect(result.cursor_end).toBeGreaterThanOrEqual(result.cursor_start);
    });

    it("supports concurrent completion requests without socket errors", async () => {
      const info = await km.start();

      await km.execute(info.id, { code: "import os" });

      const [a, b] = await Promise.all([
        km.complete(info.id, "os.path.", 8),
        km.complete(info.id, "os.path.", 8),
      ]);

      expect(Array.isArray(a.matches)).toBe(true);
      expect(Array.isArray(b.matches)).toBe(true);
    });

    it("returns an empty completion list for missing variables", async () => {
      const info = await km.start();


      const result = await km.complete(info.id, "nonexistent_var.", 16);

      expect(result.matches).toEqual([]);
    });

    it("returns inspect docs for os.path.join", async () => {
      const info = await km.start();

      await km.execute(info.id, { code: "import os" });

      const result = await km.inspect(info.id, "os.path.join", 12);

      expect(result.found).toBe(true);
      expect(result.data?.["text/plain"]).toMatch(/join/i);
    });

    it("returns found=false for inspect misses", async () => {
      const info = await km.start();


      const result = await km.inspect(info.id, "nonexistent_symbol", 10);

      expect(result.found).toBe(false);
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
});
