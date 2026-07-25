/**
 * server-loopback.test.ts — Integration tests of the real pdv-server over
 * real stdio.
 *
 * Bundles `server/server-main.ts` with esbuild (the same tool Step-5
 * packaging uses, `--external:zeromq`), spawns it under the test's Node
 * binary, and drives it through `RpcClient` — the exact transport the
 * Electron shell's supervisor uses. Covers the flip's process-boundary
 * guarantees: hello/version, invoke round-trips into the real wire,
 * renderer-visible error-message parity with the in-process dispatcher,
 * pending-invoke rejection when the child dies, and graceful shutdown.
 *
 * Kernel-spawning cases are gated behind `PYTHON_PATH` (like
 * `integration.test.ts`) and exercise the `PDV_ZEROMQ_PATH` override,
 * since the bundle externalizes zeromq.
 */

import { spawn, type ChildProcess } from "child_process";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildSync } from "esbuild";

import type { PDVConfig } from "./ipc";
import { INTERNAL_CHANNELS, IPC } from "./ipc";
import type { KernelInfo } from "./kernel-manager";
import { dispatchInvoke } from "./server/invoke-registry";
import { RPC_CHANNELS } from "./transport/protocol";
import { RpcClient } from "./transport/rpc-client";

const APP_VERSION = "0.0.7-loopback-test";

let workDir: string;
let bundlePath: string;

/** Children spawned in a test, killed afterwards if still alive. */
let children: ChildProcess[] = [];

interface LoopbackServer {
  child: ChildProcess;
  client: RpcClient;
  pushes: Array<{ event: string; payload: unknown }>;
}

function spawnServer(): LoopbackServer {
  const child = spawn(process.execPath, [bundlePath, "serve", "--stdio"], {
    env: {
      ...process.env,
      PDV_APP_VERSION: APP_VERSION,
      PDV_USER_DATA_DIR: path.join(workDir, "userdata"),
      PDV_PDV_DIR: path.join(workDir, "pdv"),
      // The bundle externalizes zeromq; resolve it from the repo's
      // node_modules via the kernel-manager override.
      PDV_ZEROMQ_PATH: path.join(__dirname, "..", "node_modules", "zeromq"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr?.on("data", () => {
    // Server logs ride stderr; keep the pipe drained but quiet.
  });
  if (!child.stdout || !child.stdin) {
    throw new Error("loopback spawn produced no stdio streams");
  }
  const pushes: LoopbackServer["pushes"] = [];
  const client = new RpcClient(child.stdout, child.stdin, {
    onPush: (event, payload) => pushes.push({ event, payload }),
  });
  return { child, client, pushes };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolve(code));
  });
}

beforeAll(() => {
  workDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pdv-loopback-"));
  fsSync.mkdirSync(path.join(workDir, "userdata"), { recursive: true });
  bundlePath = path.join(workDir, "pdv-server.cjs");
  buildSync({
    entryPoints: [path.join(__dirname, "server", "server-main.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["zeromq"],
    logLevel: "silent",
  });
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children = [];
});

afterAll(() => {
  fsSync.rmSync(workDir, { recursive: true, force: true });
});

describe("pdv-server over loopback stdio", () => {
  it("sends hello (seq 0) with the advertised version and answers ping", async () => {
    const { client } = spawnServer();
    const hello = await client.waitForHello(10_000);
    expect(hello.version).toBe(APP_VERSION);
    expect(hello.protocol).toBe(1);
    expect(hello.session).toBeNull();
    expect(hello.pid).toBeGreaterThan(0);

    const pong = (await client.invoke(RPC_CHANNELS.ping)) as {
      ts: number;
      seq: number;
    };
    expect(pong.seq).toBe(0);
    expect(pong.ts).toBeGreaterThan(0);
  });

  it("does not serve the renderer-facing config channels", async () => {
    // `config:*` are shell channels: the shell merges its own half (theme,
    // launchers) with the server's before answering the renderer. Shell code
    // asking the *server* for `config:get` is a real bug that once left the
    // app unable to open a window at all, so pin it against a live server.
    const { client } = spawnServer();
    await client.waitForHello(10_000);

    await expect(client.invoke(IPC.config.get)).rejects.toThrow(
      "No handler registered for 'config:get'"
    );
  });

  it("serves real wire handlers: kernels:list and the server config half", async () => {
    const { client } = spawnServer();
    await client.waitForHello(10_000);

    const kernels = (await client.invoke(IPC.kernels.list)) as KernelInfo[];
    expect(kernels).toEqual([]);

    const config = (await client.invoke(INTERNAL_CHANNELS.serverConfigGet)) as PDVConfig;
    expect(config).toMatchObject({
      showPrivateVariables: expect.any(Boolean) as boolean,
      autoRefreshNamespace: expect.any(Boolean) as boolean,
    });

    // config:set round-trips through the server's ConfigStore.
    await client.invoke(INTERNAL_CHANNELS.serverConfigSet, [{ pythonPath: "/opt/fake/python" }]);
    const updated = (await client.invoke(INTERNAL_CHANNELS.serverConfigGet)) as PDVConfig;
    expect(updated.pythonPath).toBe("/opt/fake/python");
  });

  it("preserves renderer-visible error messages exactly (parity with dispatchInvoke)", async () => {
    const { client } = spawnServer();
    await client.waitForHello(10_000);

    // The same failure produced by the in-process dispatcher, for parity.
    const local = await dispatchInvoke(
      "definitely.not.a.channel",
      { push: () => undefined },
      []
    ).then(
      () => {
        throw new Error("local dispatch unexpectedly resolved");
      },
      (err: unknown) => err as Error
    );

    const remote = await client
      .invoke("definitely.not.a.channel")
      .then(
        () => {
          throw new Error("remote invoke unexpectedly resolved");
        },
        (err: unknown) => err as Error
      );

    expect(remote.message).toBe(local.message);
    expect(remote.message).toBe(
      "No handler registered for 'definitely.not.a.channel'"
    );
    expect(remote.name).toBe(local.name);
  });

  it("rejects pending and subsequent invokes when the child is killed", async () => {
    const { client, child } = spawnServer();
    await client.waitForHello(10_000);

    // Fire the invoke and kill the child in the same tick: the request
    // cannot be answered before SIGKILL lands.
    const pending = client.invoke(IPC.kernels.list);
    child.kill("SIGKILL");
    await expect(pending).rejects.toThrow(/stream|closed|exited/);
    await expect(client.invoke(INTERNAL_CHANNELS.serverConfigGet)).rejects.toThrow(
      "RPC connection closed"
    );
  });

  it("acks pdv.rpc.shutdown and exits 0", async () => {
    const { client, child } = spawnServer();
    await client.waitForHello(10_000);
    await expect(client.invoke(RPC_CHANNELS.shutdown)).resolves.toBeUndefined();
    const code = await waitForExit(child);
    expect(code).toBe(0);
  });
});

describe.skipIf(!process.env.PYTHON_PATH)(
  "pdv-server over loopback stdio (real Python kernel)",
  () => {
    it(
      "starts a kernel through the transport with PDV_ZEROMQ_PATH resolution",
      { timeout: 120_000 },
      async () => {
        const { client } = spawnServer();
        await client.waitForHello(10_000);
        await client.invoke(INTERNAL_CHANNELS.serverConfigSet, [
          { pythonPath: process.env.PYTHON_PATH },
        ]);
        const info = (await client.invoke(IPC.kernels.start, [
          { language: "python" },
        ])) as KernelInfo;
        expect(info.id).toBeTruthy();
        expect(info.language).toBe("python");

        const kernels = (await client.invoke(IPC.kernels.list)) as KernelInfo[];
        expect(kernels.map((k) => k.id)).toContain(info.id);

        // Graceful shutdown also stops the kernel; exit 0 proves it.
        await client.invoke(RPC_CHANNELS.shutdown);
      }
    );
  }
);
