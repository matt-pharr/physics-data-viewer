/**
 * kernel-session.test.ts — Unit tests for the bootstrap/init handshake
 * helpers in `kernel-session.ts`. Focused on the failure-path diagnostic
 * format so a black-box "Kernel failed to start" can be replaced with an
 * actionable message.
 */

import { describe, it, expect, vi } from "vitest";
import { diagnoseMissingKernelPackage, initializeKernelSession } from "./kernel-session";
import type { KernelManager, KernelExecuteResult } from "./kernel-manager";
import type { CommRouter } from "./comm-router";
import type { QueryRouter } from "./query-router";
import type { ProjectManager } from "./project-manager";

interface FakeKernelManager {
  getKernel: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  onIopubMessage: ReturnType<typeof vi.fn>;
  onProcessOutput: ReturnType<typeof vi.fn>;
  getQueryPort: ReturnType<typeof vi.fn>;
  getKernelProcessState: ReturnType<typeof vi.fn>;
}

function makeKernelManager(overrides: Partial<FakeKernelManager> = {}): FakeKernelManager {
  return {
    getKernel: vi.fn(() => ({
      id: "k1",
      name: "python3",
      language: "python",
      status: "idle",
    })),
    execute: vi.fn(async (): Promise<KernelExecuteResult> => ({})),
    onIopubMessage: vi.fn(() => () => undefined),
    onProcessOutput: vi.fn(() => () => undefined),
    getQueryPort: vi.fn(() => 0),
    getKernelProcessState: vi.fn(() => ({ exitCode: null, killed: false })),
    ...overrides,
  };
}

function makeCommRouter(): CommRouter {
  return {
    onPush: vi.fn(),
    offPush: vi.fn(),
    request: vi.fn(async () => ({})),
  } as unknown as CommRouter;
}

function makeQueryRouter(): QueryRouter {
  return { attach: vi.fn() } as unknown as QueryRouter;
}

function makeProjectManager(): ProjectManager {
  return {
    createWorkingDir: vi.fn(async () => "/tmp/pdv-fake"),
  } as unknown as ProjectManager;
}

describe("initializeKernelSession diagnostics", () => {
  it("bootstrap-step failure produces an enriched, multi-line error", async () => {
    const km = makeKernelManager({
      execute: vi.fn(async () => ({ error: "Kernel not found: ghost" })),
    });
    const commRouter = makeCommRouter();
    const queryRouter = makeQueryRouter();
    const projectManager = makeProjectManager();

    await expect(
      initializeKernelSession(
        km as unknown as KernelManager,
        commRouter,
        queryRouter,
        projectManager,
        "ghost",
        new Map()
      )
    ).rejects.toThrow(
      /Kernel handshake failed at step 'bootstrap': Kernel not found: ghost/
    );
  });

  it("error message includes process state, kernel status, and last iopub msg_type", async () => {
    let lastListener: ((msg: { header: { msg_type: string } }) => void) | null = null;
    const km = makeKernelManager({
      onIopubMessage: vi.fn((_id, cb) => {
        lastListener = cb as (msg: { header: { msg_type: string } }) => void;
        return () => undefined;
      }),
      execute: vi.fn(async () => {
        // Simulate that an iopub status message arrived during bootstrap
        // before the failure was reported.
        lastListener?.({ header: { msg_type: "status" } });
        return { error: "boom" };
      }),
      getKernelProcessState: vi.fn(() => ({ exitCode: 1, killed: false })),
      getKernel: vi.fn(() => ({
        id: "k1",
        name: "python3",
        language: "python",
        status: "dead",
      })),
    });

    let caught: Error | null = null;
    try {
      await initializeKernelSession(
        km as unknown as KernelManager,
        makeCommRouter(),
        makeQueryRouter(),
        makeProjectManager(),
        "k1",
        new Map()
      );
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBeNull();
    const msg = caught!.message;
    expect(msg).toMatch(/^Kernel handshake failed at step 'bootstrap': boom/);
    expect(msg).toContain("process: exitCode=1 killed=false");
    expect(msg).toContain("kernel status: dead");
    expect(msg).toContain("last iopub msg_type: status");
  });

  it("disposes the iopub diagnostic listener whether or not the handshake fails", async () => {
    const dispose = vi.fn();
    const km = makeKernelManager({
      onIopubMessage: vi.fn(() => dispose),
      execute: vi.fn(async () => ({ error: "boom" })),
    });

    await expect(
      initializeKernelSession(
        km as unknown as KernelManager,
        makeCommRouter(),
        makeQueryRouter(),
        makeProjectManager(),
        "k1",
        new Map()
      )
    ).rejects.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("diagnoseMissingKernelPackage", () => {
  it("reads a missing pdv out of the bootstrap traceback", () => {
    const traceback =
      "Traceback (most recent call last):\n" +
      '  File "<string>", line 3, in <module>\n' +
      "ModuleNotFoundError: No module named 'pdv'\n";
    expect(diagnoseMissingKernelPackage(traceback, "python")).toBe("pdv");
  });

  it("reads a missing ipykernel out of the interpreter's dying words", () => {
    // A bare system python dies at spawn, unquoted form.
    expect(
      diagnoseMissingKernelPackage(
        "/usr/bin/python3: No module named ipykernel_launcher\n",
        "python",
      ),
    ).toBe("ipykernel_launcher");
  });

  it("reads a missing PDVKernel out of Julia's package error", () => {
    expect(
      diagnoseMissingKernelPackage(
        "ERROR: ArgumentError: Package PDVKernel not found in current path.\n",
        "julia",
      ),
    ).toBe("PDVKernel");
  });

  it("never blames the environment for a user-package ImportError", () => {
    // numpy missing is a package problem, not "this interpreter cannot
    // host PDV" — the headline must not fire.
    expect(
      diagnoseMissingKernelPackage(
        "ModuleNotFoundError: No module named 'numpy'\n",
        "python",
      ),
    ).toBeNull();
    // 'commonmark' must not match the 'comm' pattern.
    expect(
      diagnoseMissingKernelPackage(
        "ModuleNotFoundError: No module named 'commonmark'\n",
        "python",
      ),
    ).toBeNull();
  });
});

describe("boot-output tail in handshake failures", () => {
  it("a ready timeout carries the bootstrap traceback and the plain-language headline", async () => {
    // The exact feyn shape: the interpreter exists and boots ipykernel, but
    // `import pdv` fails inside the SILENT bootstrap execute — ipykernel
    // publishes no iopub error for silent executions, so without the tail
    // the user sees only an opaque pdv.ready timeout.
    vi.useFakeTimers();
    try {
      const outputListeners: Array<
        (stream: "stdout" | "stderr", data: string) => void
      > = [];
      const km = makeKernelManager({
        onProcessOutput: vi.fn((_id, cb) => {
          outputListeners.push(
            cb as (stream: "stdout" | "stderr", data: string) => void
          );
          return () => undefined;
        }),
      });
      const pending = initializeKernelSession(
        km as unknown as KernelManager,
        makeCommRouter(),
        makeQueryRouter(),
        makeProjectManager(),
        "k1",
        new Map()
      );
      const assertion = expect(pending).rejects.toThrow(
        /missing 'pdv'[\s\S]*boot output \(tail\):[\s\S]*No module named 'pdv'/
      );
      outputListeners[0]?.(
        "stderr",
        "Traceback (most recent call last):\nModuleNotFoundError: No module named 'pdv'\n",
      );
      await vi.advanceTimersByTimeAsync(60_200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the tail block when the kernel said nothing", async () => {
    vi.useFakeTimers();
    try {
      const pending = initializeKernelSession(
        makeKernelManager() as unknown as KernelManager,
        makeCommRouter(),
        makeQueryRouter(),
        makeProjectManager(),
        "k1",
        new Map()
      );
      const assertion = pending.catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(60_200);
      const msg = await assertion;
      expect(msg).toContain("no kernel activity for 60 s");
      expect(msg).not.toContain("boot output (tail)");
      expect(msg).not.toContain("cannot run PDV sessions");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("activity-based ready deadline (§10.8)", () => {
  /**
   * Comm router whose pdv.ready never arrives, so the ready wait is governed
   * entirely by its timers.
   */
  function makeSilentCommRouter(): CommRouter {
    return {
      onPush: vi.fn(),
      offPush: vi.fn(),
      request: vi.fn(async () => ({})),
    } as unknown as CommRouter;
  }

  it("times out after the idle allowance when the kernel is silent", async () => {
    vi.useFakeTimers();
    try {
      const km = makeKernelManager();
      const pending = initializeKernelSession(
        km as unknown as KernelManager,
        makeSilentCommRouter(),
        makeQueryRouter(),
        makeProjectManager(),
        "k1",
        new Map()
      );
      const assertion = expect(pending).rejects.toThrow(
        /no kernel activity for 60 s/
      );
      await vi.advanceTimersByTimeAsync(60_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a wedged bootstrap execute is unwound by the ready deadline (second review)", async () => {
    vi.useFakeTimers();
    try {
      const km = makeKernelManager({
        // Alive-but-silent `using PDVKernel` (e.g. stuck on another
        // process's precompile pidfile lock): the execute never settles.
        // Without racing it against the ready deadline this await hung
        // forever under the start lock.
        execute: vi.fn(() => new Promise<KernelExecuteResult>(() => undefined)),
      });
      const pending = initializeKernelSession(
        km as unknown as KernelManager,
        makeSilentCommRouter(),
        makeQueryRouter(),
        makeProjectManager(),
        "k1",
        new Map()
      );
      const assertion = expect(pending).rejects.toThrow(
        /failed at step 'bootstrap': .*no kernel activity for 60 s/
      );
      await vi.advanceTimersByTimeAsync(60_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("kernel activity (iopub streams / process output) extends the idle deadline up to the cap", async () => {
    vi.useFakeTimers();
    try {
      type IopubMsg = {
        header: { msg_type: string };
        content?: { text?: string };
      };
      const iopubListeners: Array<(msg: IopubMsg) => void> = [];
      const km = makeKernelManager({
        onIopubMessage: vi.fn((_id, cb) => {
          iopubListeners.push(cb as (msg: IopubMsg) => void);
          return () => undefined;
        }),
      });
      const bootOutput: string[] = [];
      const pending = initializeKernelSession(
        km as unknown as KernelManager,
        makeSilentCommRouter(),
        makeQueryRouter(),
        makeProjectManager(),
        "k1",
        new Map(),
        undefined,
        undefined,
        undefined,
        (text) => bootOutput.push(text)
      );
      const assertion = expect(pending).rejects.toThrow(
        /still absent after 300 s/
      );

      // Emit stream traffic every 50 s — each one inside the 60 s idle
      // allowance, so the wait must survive far past 60 s and fail only at
      // the 300 s hard cap.
      for (let i = 0; i < 7; i++) {
        await vi.advanceTimersByTimeAsync(50_000);
        iopubListeners[0]?.({
          header: { msg_type: "stream" },
          content: { text: `Precompiling chunk ${i}\n` },
        });
      }
      await assertion;
      // The stream text was forwarded to the boot-output sink.
      expect(bootOutput.join("")).toContain("Precompiling chunk 0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("process output resets the idle deadline and reaches the boot-output sink", async () => {
    vi.useFakeTimers();
    try {
      const outputListeners: Array<
        (stream: "stdout" | "stderr", data: string) => void
      > = [];
      const km = makeKernelManager({
        onProcessOutput: vi.fn((_id, cb) => {
          outputListeners.push(
            cb as (stream: "stdout" | "stderr", data: string) => void
          );
          return () => undefined;
        }),
      });
      const bootOutput: string[] = [];
      const pending = initializeKernelSession(
        km as unknown as KernelManager,
        makeSilentCommRouter(),
        makeQueryRouter(),
        makeProjectManager(),
        "k1",
        new Map(),
        undefined,
        undefined,
        undefined,
        (text) => bootOutput.push(text)
      );
      const assertion = expect(pending).rejects.toThrow(
        /no kernel activity for 60 s/
      );

      // One burst of process output at t=10 s pushes the idle deadline to
      // t=70 s; silence after that fails at the idle allowance, proving the
      // reset happened (a flat deadline would have fired at t=60 s).
      await vi.advanceTimersByTimeAsync(10_000);
      outputListeners[0]?.("stderr", "Precompiling IJulia...\n");
      await vi.advanceTimersByTimeAsync(60_100);
      await assertion;
      expect(bootOutput.join("")).toContain("Precompiling IJulia");
    } finally {
      vi.useRealTimers();
    }
  });
});
