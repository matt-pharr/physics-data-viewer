/**
 * session-router.test.ts — Routing and bridge-handoff tests for the
 * swappable server handle.
 *
 * Runs against two real spawned `__fixtures__/fake-pdv-server.cjs`
 * children rather than in-process stubs, so the handoff is proven through
 * an actual transport: the fixture's `whoami` channel identifies which
 * server answered an invoke, and `emitPush` proves which one a push came
 * from. Electron surfaces are mocked exactly as in the supervisor's suite.
 */

import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import type { BridgeHandlers } from "./server-supervisor";
import { LocalServerSupervisor } from "./server-supervisor";
import { SessionRouter } from "./session-router";

const FIXTURE = path.join(__dirname, "__fixtures__", "fake-pdv-server.cjs");
const VERSION = "1.2.3-test";

/** Supervisors created in a test, shut down afterwards. */
let supervisors: LocalServerSupervisor[] = [];

/** Spawn and start one fixture-backed supervisor. */
async function startSupervisor(): Promise<LocalServerSupervisor> {
  process.env.FAKE_VERSION = VERSION;
  const supervisor = new LocalServerSupervisor({
    version: VERSION,
    userDataDir: "/tmp/pdv-session-router-test-userdata",
    pdvDir: "/tmp/pdv-session-router-test-pdv",
    resourcesRoot: null,
    getWindow: () => null,
    execPath: process.execPath,
    entryPath: FIXTURE,
    entryArgs: [],
    helloTimeoutMs: 2_000,
    shutdownInvokeTimeoutMs: 500,
    sigtermTimeoutMs: 300,
  });
  supervisors.push(supervisor);
  await supervisor.start();
  return supervisor;
}

/** Ask a handle which process answered. */
async function pidOf(handle: {
  invoke(channel: string, args?: unknown[]): Promise<unknown>;
}): Promise<number> {
  const who = (await handle.invoke("whoami")) as { pid: number };
  return who.pid;
}

/** A bridge whose pushes are recorded for assertions. */
function makeBridge(): { handlers: BridgeHandlers; pushes: string[][] } {
  const pushes: string[][] = [];
  return {
    pushes,
    handlers: {
      onPush: (channel, payload) => {
        pushes.push([channel, String(payload)]);
      },
      confirm: async () => 0,
      closeChildWindows: () => {
        /* not exercised here */
      },
    },
  };
}

afterEach(async () => {
  const toStop = supervisors;
  supervisors = [];
  await Promise.all(toStop.map((s) => s.shutdown().catch(() => undefined)));
  delete process.env.FAKE_VERSION;
  vi.clearAllMocks();
});

describe("SessionRouter", () => {
  it("routes invokes to the active handle, and to the new one after a swap", async () => {
    const first = await startSupervisor();
    const second = await startSupervisor();
    const router = new SessionRouter(first);

    expect(await pidOf(router)).toBe(await pidOf(first));

    const previous = router.swap(second);

    expect(previous).toBe(first);
    expect(await pidOf(router)).toBe(await pidOf(second));
  });

  it("moves bridge handlers onto the incoming handle so pushes follow the session", async () => {
    const first = await startSupervisor();
    const second = await startSupervisor();
    const router = new SessionRouter(first);
    const bridge = makeBridge();
    router.setBridgeHandlers(bridge.handlers);

    await router.invoke("emitPush", ["evt", "from-first"]);
    router.swap(second);
    await router.invoke("emitPush", ["evt", "from-second"]);

    expect(bridge.pushes).toEqual([
      ["evt", "from-first"],
      ["evt", "from-second"],
    ]);
  });

  it("detaches the outgoing handle, so its pushes no longer reach the bridge", async () => {
    const first = await startSupervisor();
    const second = await startSupervisor();
    const router = new SessionRouter(first);
    const bridge = makeBridge();
    router.setBridgeHandlers(bridge.handlers);

    router.swap(second);
    // Talk to the outgoing server directly — it is still running, but the
    // router detached it, so nothing it emits may reach the live window.
    await first.invoke("emitPush", ["evt", "orphaned"]);
    await router.invoke("emitPush", ["evt", "current"]);

    expect(bridge.pushes).toEqual([["evt", "current"]]);
  });

  it("carries a later setBridgeHandlers onto whichever handle is active", async () => {
    const first = await startSupervisor();
    const second = await startSupervisor();
    const router = new SessionRouter(first);
    router.swap(second);

    const bridge = makeBridge();
    router.setBridgeHandlers(bridge.handlers);
    await router.invoke("emitPush", ["evt", "after-swap-wiring"]);

    expect(bridge.pushes).toEqual([["evt", "after-swap-wiring"]]);
  });

  it("leaves the incoming handle unbridged when the window is gone", async () => {
    const first = await startSupervisor();
    const second = await startSupervisor();
    const router = new SessionRouter(first);
    const bridge = makeBridge();
    router.setBridgeHandlers(bridge.handlers);
    router.clearBridgeHandlers();

    router.swap(second);
    await router.invoke("emitPush", ["evt", "no-window"]);

    expect(bridge.pushes).toEqual([]);
  });

  it("treats a swap to the already-active handle as a no-op", async () => {
    const first = await startSupervisor();
    const router = new SessionRouter(first);
    const bridge = makeBridge();
    router.setBridgeHandlers(bridge.handlers);

    expect(router.swap(first)).toBeNull();

    // The no-op must not have detached the bridge from the live handle.
    await router.invoke("emitPush", ["evt", "still-wired"]);
    expect(bridge.pushes).toEqual([["evt", "still-wired"]]);
  });

  it("does not settle in-flight invokes at swap time; the outgoing shutdown does", async () => {
    const first = await startSupervisor();
    const second = await startSupervisor();
    const router = new SessionRouter(first);

    // "never" is answered by no fixture mode, so this stays pending.
    const pending = router.invoke("never");
    const settledEarly = vi.fn();
    void pending.then(settledEarly, settledEarly);

    router.swap(second);
    await router.invoke("echo", ["fence"]);
    expect(settledEarly).not.toHaveBeenCalled();

    // The caller owns the outgoing handle's shutdown, and that is what
    // rejects its pending work. The exact reason is whichever close wins the
    // race between the child's stdout ending and the supervisor disposing
    // it, so match the class of reason rather than one wording.
    await first.shutdown();
    await expect(pending).rejects.toThrow(/stream ended|disposed|exited/);
  });

  it("reports the active handle's kind", async () => {
    const first = await startSupervisor();
    const router = new SessionRouter(first);

    expect(router.kind).toBe("local");
    expect(router.active).toBe(first);
  });
});
