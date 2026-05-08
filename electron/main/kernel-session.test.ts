/**
 * kernel-session.test.ts — Unit tests for the bootstrap/init handshake
 * helpers in `kernel-session.ts`. Focused on the failure-path diagnostic
 * format so a black-box "Kernel failed to start" can be replaced with an
 * actionable message.
 */

import { describe, it, expect, vi } from "vitest";
import { initializeKernelSession } from "./kernel-session";
import type { KernelManager, KernelExecuteResult } from "./kernel-manager";
import type { CommRouter } from "./comm-router";
import type { QueryRouter } from "./query-router";
import type { ProjectManager } from "./project-manager";

interface FakeKernelManager {
  getKernel: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  onIopubMessage: ReturnType<typeof vi.fn>;
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
