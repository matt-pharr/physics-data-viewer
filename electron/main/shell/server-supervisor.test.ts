/**
 * server-supervisor.test.ts — Lifecycle tests for the pdv-server
 * supervisor against a real spawned child process.
 *
 * Uses the `__fixtures__/fake-pdv-server.cjs` protocol stub (spawned via
 * the test's own Node binary) so spawn, stdio framing, crash, and
 * signal-escalation paths are exercised for real. Electron surfaces
 * (dialog, app) are mocked; the crash dialog's Restart/Quit choices are
 * driven through the mock.
 */

import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  appExit: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    exit: electronMocks.appExit,
  },
  dialog: {
    showMessageBox: electronMocks.showMessageBox,
  },
}));

import type { BrowserWindow } from "electron";
import { LocalServerSupervisor, type LocalServerSupervisorOptions } from "./server-supervisor";

const FIXTURE = path.join(__dirname, "__fixtures__", "fake-pdv-server.cjs");
const VERSION = "1.2.3-test";

/** Supervisors created in a test, torn down afterwards. */
let supervisors: LocalServerSupervisor[] = [];

function makeSupervisor(
  overrides: Partial<LocalServerSupervisorOptions> = {}
): LocalServerSupervisor {
  const supervisor = new LocalServerSupervisor({
    version: VERSION,
    userDataDir: "/tmp/pdv-supervisor-test-userdata",
    pdvDir: "/tmp/pdv-supervisor-test-pdv",
    resourcesRoot: null,
    getWindow: () => null,
    execPath: process.execPath,
    entryPath: FIXTURE,
    entryArgs: [],
    helloTimeoutMs: 2_000,
    shutdownInvokeTimeoutMs: 500,
    sigtermTimeoutMs: 300,
    ...overrides,
  });
  supervisors.push(supervisor);
  return supervisor;
}

/** Set the fixture mode/version via env for the next spawn. */
function setFixtureEnv(mode: string, version: string = VERSION): void {
  process.env.FAKE_MODE = mode;
  process.env.FAKE_VERSION = version;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  vi.clearAllMocks();
  setFixtureEnv("normal");
});

afterEach(async () => {
  for (const supervisor of supervisors) {
    await supervisor.shutdown().catch(() => undefined);
  }
  supervisors = [];
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_VERSION;
});

describe("LocalServerSupervisor", () => {
  it("starts, round-trips an invoke, and preserves server error messages", async () => {
    const supervisor = makeSupervisor();
    await supervisor.start();

    await expect(supervisor.invoke("echo", [{ n: 42 }])).resolves.toEqual({
      n: 42,
    });
    // Error parity: the server's message arrives verbatim.
    await expect(supervisor.invoke("boom")).rejects.toThrow("kaboom");
  });

  it("relays the child's stderr line-buffered with the [pdv-server] prefix", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supervisor = makeSupervisor();
    await supervisor.start();
    await flush();
    expect(errorSpy.mock.calls.map((c) => c.join(" "))).toContain(
      "[pdv-server] fixture started"
    );
    errorSpy.mockRestore();
  });

  it("rejects startup on a version mismatch (after the one automatic retry)", async () => {
    setFixtureEnv("normal", "9.9.9-other");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supervisor = makeSupervisor();
    await expect(supervisor.start()).rejects.toThrow(
      `pdv-server version mismatch: shell ${VERSION}, server 9.9.9-other`
    );
    // The retry happened: the first failure was logged.
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes("failed to start, retrying once")
      )
    ).toBe(true);
    errorSpy.mockRestore();
  });

  it("rejects startup when no hello arrives", async () => {
    setFixtureEnv("no-hello");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supervisor = makeSupervisor({ helloTimeoutMs: 200 });
    await expect(supervisor.start()).rejects.toThrow(
      "hello not received within 200 ms"
    );
    errorSpy.mockRestore();
  });

  it("rejects pending invokes on a crash and quits when the user declines restart", async () => {
    setFixtureEnv("crash-after-hello");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    const supervisor = makeSupervisor();
    await supervisor.start();

    const pending = supervisor.invoke("never");
    // Whichever close wins the race (stream end vs. exit event), the
    // pending invoke must reject when the child dies.
    await expect(pending).rejects.toThrow(
      /server stream ended|pdv-server exited/
    );
    await flush();
    expect(electronMocks.showMessageBox).toHaveBeenCalled();
    expect(electronMocks.appExit).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });

  it("respawns the server and reloads the window when the user chooses Restart", async () => {
    setFixtureEnv("crash-after-hello");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const win = {
      isDestroyed: () => false,
      reload,
    } as unknown as BrowserWindow;
    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const supervisor = makeSupervisor({ getWindow: () => win });
    await supervisor.start();
    // Flip the fixture to a healthy mode before the crash fires so the
    // restart spawn (whenever the dialog resolves) comes up normally.
    setFixtureEnv("normal");

    await supervisor.invoke("never").catch(() => undefined);
    await vi.waitFor(() => expect(reload).toHaveBeenCalled(), {
      timeout: 3_000,
    });
    await expect(supervisor.invoke("echo", ["ok"])).resolves.toBe("ok");
    expect(electronMocks.appExit).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("shuts down gracefully via pdv.rpc.shutdown", async () => {
    const supervisor = makeSupervisor();
    await supervisor.start();
    await supervisor.shutdown();
    await expect(supervisor.invoke("echo", ["x"])).rejects.toThrow(
      "pdv-server is not running"
    );
  });

  it("escalates to SIGKILL when the server ignores shutdown and SIGTERM", async () => {
    setFixtureEnv("ignore-shutdown");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const supervisor = makeSupervisor();
    await supervisor.start();
    await supervisor.shutdown();
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some((w) => w.includes("escalating pdv-server shutdown to SIGTERM"))
    ).toBe(true);
    expect(
      warnings.some((w) => w.includes("escalating pdv-server shutdown to SIGKILL"))
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it("routes a reverse-RPC confirm through the bridge dialog and answers it", async () => {
    setFixtureEnv("confirm");
    const confirm = vi.fn(async () => 0);
    const supervisor = makeSupervisor();
    await supervisor.start();
    supervisor.setBridgeHandlers({
      onPush: vi.fn(),
      confirm,
      closeChildWindows: vi.fn(),
    });

    await vi.waitFor(async () => {
      expect(await supervisor.invoke("lastConfirm")).toEqual({
        requestId: "c1",
        response: 0,
      });
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Overwrite?" })
    );
  });

  it("answers reverse-RPC confirm requests with the cancel choice when no bridge is attached", async () => {
    setFixtureEnv("confirm");
    const supervisor = makeSupervisor();
    await supervisor.start();
    // No bridge: there is no window to ask, so the supervisor must answer
    // with the request's own cancelId rather than leaving the server's
    // confirm promise parked forever.
    await vi.waitFor(async () => {
      expect(await supervisor.invoke("lastConfirm")).toEqual({
        requestId: "c1",
        response: 1,
      });
    });
  });

  it("falls back to the cancel choice when the confirm dialog throws", async () => {
    setFixtureEnv("confirm");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supervisor = makeSupervisor();
    await supervisor.start();
    supervisor.setBridgeHandlers({
      onPush: vi.fn(),
      confirm: vi.fn(async () => {
        throw new Error("window destroyed");
      }),
      closeChildWindows: vi.fn(),
    });

    await vi.waitFor(async () => {
      expect(await supervisor.invoke("lastConfirm")).toEqual({
        requestId: "c1",
        response: 1,
      });
    });
    errorSpy.mockRestore();
  });

  it("kills a child that failed its handshake instead of orphaning it", async () => {
    // The no-hello fixture stays alive. Before the fix, disposeChild() only
    // dropped the reference: the server kept running, finished wiring, bound
    // the MCP port and created a working dir, and the retry spawned a second
    // one alongside it.
    setFixtureEnv("no-hello");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supervisor = makeSupervisor({ helloTimeoutMs: 200 });
    await expect(supervisor.start()).rejects.toThrow("hello not received");

    const pids = errorSpy.mock.calls
      .map((c) => /\[pdv-server\] fixture pid (\d+)/.exec(c.join(" "))?.[1])
      .filter((pid): pid is string => Boolean(pid))
      .map(Number);
    errorSpy.mockRestore();
    expect(pids.length).toBeGreaterThan(0);

    for (const pid of pids) {
      await vi.waitFor(() => {
        // ESRCH: no such process — the child was reaped.
        expect(() => process.kill(pid, 0)).toThrow();
      });
    }
  });

  it("keeps serving after a failed first attempt: the dead child cannot tear down the live one", async () => {
    // A superseded child's exit event must not touch the current
    // generation's state. Without the guard, its exit closed the *live*
    // client and flipped the supervisor to "stopped".
    setFixtureEnv("no-hello");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supervisor = makeSupervisor({ helloTimeoutMs: 200 });
    const started = supervisor.start();
    // Attempt 1 already spawned with the no-hello env; flip before its
    // deadline expires so the immediate retry spawns a healthy child.
    await new Promise((resolve) => setTimeout(resolve, 100));
    setFixtureEnv("normal");
    await started;

    // Give the killed child's exit event time to land after the retry is up.
    await flush();
    await expect(supervisor.invoke("echo", ["ok"])).resolves.toBe("ok");
    expect(electronMocks.showMessageBox).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
