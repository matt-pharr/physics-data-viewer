/**
 * integration-julia.test.ts — Cross-boundary integration tests (Julia + Electron).
 *
 * @slow — Spawns a real IJulia kernel with PDVKernel and verifies PDV comm
 * traffic over the exact JULIA_BOOTSTRAP snippet production uses. Opt-in via
 * the JULIA_PATH environment variable (see vitest.config.ts); requires a
 * Julia environment with IJulia and PDVKernel (dev-installed from
 * `pdv-julia/`) available.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { KernelManager } from "./kernel-manager";
import { CommRouter } from "./comm-router";
import { QueryRouter } from "./query-router";
import { JULIA_BOOTSTRAP } from "./kernel-session";
import {
  defaultJuliaupDir,
  listJuliaupChannels,
  probeJuliaRuntime,
  resolveJuliaShim,
} from "./julia-discovery";
import { instantiateJuliaEnvironment } from "./julia-env";
import { checkJuliaVersionForLoad, juliaupStatus } from "./juliaup-runner";
import {
  PDVMessage,
  PDVMessageType,
  generateNodeUuid,
  getAppVersion,
} from "./pdv-protocol";

const TEST_JULIA_EXECUTABLE = process.env.JULIA_PATH ?? "julia";

function waitForPush(
  router: CommRouter,
  type: string,
  timeoutMs = 60_000
): Promise<PDVMessage> {
  return new Promise<PDVMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      router.offPush(type, handler);
      reject(new Error(`Timed out waiting for push: ${type}`));
    }, timeoutMs);

    const handler = (message: PDVMessage): void => {
      clearTimeout(timer);
      router.offPush(type, handler);
      resolve(message);
    };

    router.onPush(type, handler);
  });
}

describe("@slow Cross-boundary integration (Julia + Electron)", { timeout: 300_000 }, () => {
  let km: KernelManager;
  let router: CommRouter;
  let queryRouter: QueryRouter;
  let kernelId: string;
  let readyMessage: PDVMessage | null = null;
  let initResponse: PDVMessage | null = null;
  let workingDir = "";
  const tempDirs: string[] = [];

  // Julia's first-load JIT (IJulia + PDVKernel precompilation) can take a
  // while on a cold cache; give the boot sequence generous room.
  beforeAll(async () => {
    km = new KernelManager();
    router = new CommRouter();
    queryRouter = new QueryRouter();

    const info = await km.start({
      language: "julia",
      env: { JULIA_PATH: TEST_JULIA_EXECUTABLE },
    });
    kernelId = info.id;
    expect(info.language).toBe("julia");
    router.attach(km, kernelId);

    const readyPromise = waitForPush(router, PDVMessageType.READY, 120_000);
    const bootstrapResult = await km.execute(kernelId, {
      code: JULIA_BOOTSTRAP,
      silent: true,
    });
    expect(bootstrapResult.error).toBeUndefined();
    readyMessage = await readyPromise;

    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-int-"));
    tempDirs.push(workingDir);
    initResponse = await router.request(PDVMessageType.INIT, {
      working_dir: workingDir,
      pdv_version: getAppVersion(),
      query_port: km.getQueryPort(kernelId),
    });
    queryRouter.attach(km, kernelId);
  }, 240_000);

  afterAll(async () => {
    queryRouter.detach();
    router.detach();
    await km.shutdownAll();
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  }, 30_000);

  describe("session bootstrap", () => {
    it("start kernel -> bootstrap -> pdv.ready then pdv.init.response", () => {
      expect(readyMessage).not.toBeNull();
      expect(readyMessage!.type).toBe(PDVMessageType.READY);
      expect(initResponse).not.toBeNull();
      expect(initResponse!.status).toBe("ok");
    });
  });

  describe("tree read queries", () => {
    it("pdv.tree.list returns nodes array", async () => {
      const response = await router.request(PDVMessageType.TREE_LIST, { path: "" });
      expect(response.status).toBe("ok");
      const nodes = (response.payload as { nodes?: unknown }).nodes;
      expect(Array.isArray(nodes)).toBe(true);
    });

    it("seeded scalar round-trips through pdv.tree.get", async () => {
      const seed = await km.execute(kernelId, { code: `pdv_tree["intkey"] = 42` });
      expect(seed.error).toBeUndefined();
      const response = await router.request(PDVMessageType.TREE_GET, {
        path: "intkey",
        mode: "value",
      });
      expect(response.status).toBe("ok");
      const payload = response.payload as { type?: unknown; value?: unknown };
      expect(payload.type).toBe("scalar");
      expect(String(payload.value)).toContain("42");
    });

    it("numeric arrays list as ndarray with dtype preview", async () => {
      const seed = await km.execute(kernelId, {
        code: `pdv_tree["data.wave"] = collect(range(0.0, 1.0, length=64))`,
      });
      expect(seed.error).toBeUndefined();
      const response = await router.request(PDVMessageType.TREE_LIST, { path: "data" });
      expect(response.status).toBe("ok");
      const nodes = (response.payload as { nodes: Array<Record<string, unknown>> }).nodes;
      const wave = nodes.find((n) => n.key === "wave");
      expect(wave).toBeDefined();
      expect(wave!.type).toBe("ndarray");
      expect(String(wave!.preview)).toContain("float64");
    });

    it("query channel serves pdv.tree.list", async () => {
      const response = await queryRouter.request(PDVMessageType.TREE_LIST, { path: "" });
      expect(response.status).toBe("ok");
      const nodes = (response.payload as { nodes?: unknown }).nodes;
      expect(Array.isArray(nodes)).toBe(true);
    });

    it("tree.list stays responsive while the kernel is compute-bound (#7)", async () => {
      // Seed a node, then let its tree.changed debounce flush (which also
      // rebuilds the query snapshot) land before going busy.
      const seedExec = await km.execute(kernelId, {
        code: 'pdv_tree["busyprobe"] = collect(1.0:8.0)',
      });
      expect(seedExec.error).toBeUndefined();
      await new Promise((r) => setTimeout(r, 500));

      // Kick off a pure-compute loop with no yield points (~6 s) WITHOUT
      // awaiting it, then query mid-run. The kernel spawns with
      // --threads=auto,2, so the threaded query server must answer from the
      // snapshot in milliseconds; before #7 this timed out for the whole run.
      const busyPromise = km.execute(kernelId, {
        code:
          "let acc = 0.0, t0 = time()\n" +
          "  while time() - t0 < 6\n" +
          "    for j in 1:200_000_000; acc += sin(j * 1e-9); end\n" +
          "  end\n" +
          "  acc\n" +
          "end",
      });
      await new Promise((r) => setTimeout(r, 1_000)); // ensure it's mid-burn

      const t0 = Date.now();
      const response = await queryRouter.request(PDVMessageType.TREE_LIST, { path: "" });
      const elapsed = Date.now() - t0;
      expect(response.status).toBe("ok");
      const nodes = (response.payload as { nodes?: Array<{ key?: string }> }).nodes ?? [];
      expect(nodes.some((n) => n.key === "busyprobe")).toBe(true);
      expect(elapsed).toBeLessThan(2_000);

      const busyResult = await busyPromise;
      expect(busyResult.error).toBeUndefined();
    });

    it("`@threads :static` completes while the query server is live (review B1)", async () => {
      // Regression for the PR #347 review blocker: the threaded query loop
      // used to occupy a default-pool thread without yielding, so `@threads
      // :static` — which pins one task per default thread and waits for all
      // of them — deadlocked forever. The loop now lives on the spare
      // interactive thread; a :static loop over more tasks than default
      // threads must finish promptly.
      const staticExec = await km.execute(kernelId, {
        code:
          "let n = Threads.Atomic{Int}(0)\n" +
          "  Threads.@threads :static for i in 1:2*Threads.nthreads(:default)\n" +
          "    Threads.atomic_add!(n, 1)\n" +
          "    Libc.systemsleep(0.02)\n" +
          "  end\n" +
          "  n[]\n" +
          "end",
      });
      expect(staticExec.error).toBeUndefined();

      // And the query server is genuinely alive afterwards (still threaded,
      // still answering) — not crashed or degraded by the :static run.
      const response = await queryRouter.request(PDVMessageType.TREE_LIST, { path: "" });
      expect(response.status).toBe("ok");
    }, 30_000);
  });

  describe("tree change notifications", () => {
    it("kernel-side mutation emits pdv.tree.changed", async () => {
      const changedPath = `integration.changed_${Date.now()}`;
      const pushPromise = waitForPush(router, PDVMessageType.TREE_CHANGED);
      const execResult = await km.execute(kernelId, {
        code: `pdv_tree["${changedPath}"] = 1`,
      });
      expect(execResult.error).toBeUndefined();
      const push = await pushPromise;
      const payload = push.payload as { changed_paths?: string[]; change_type?: string };
      expect(payload.change_type).toBe("batch");
      expect(payload.changed_paths).toContain(changedPath);
    });
  });

  describe("script registration and execution", () => {
    const nodeUuid = generateNodeUuid();

    it("register a Julia script, extract params, run it via run_tree_script", async () => {
      const scriptDir = path.join(workingDir, "tree", nodeUuid);
      await fs.mkdir(scriptDir, { recursive: true });
      await fs.writeFile(
        path.join(scriptDir, "compute.jl"),
        [
          "function run(pdv_tree; a::Int = 1, b::Int = 2)",
          '    pdv_tree["outputs.total"] = a + b',
          '    return Dict("sum" => a + b)',
          "end",
          "",
        ].join("\n"),
        "utf8"
      );

      const registerResponse = await router.request(PDVMessageType.SCRIPT_REGISTER, {
        parent_path: "scripts",
        name: "compute",
        uuid: nodeUuid,
        filename: "compute.jl",
        language: "julia",
      });
      expect(registerResponse.status).toBe("ok");

      const paramsResponse = await router.request(PDVMessageType.SCRIPT_PARAMS, {
        path: "scripts.compute",
      });
      expect(paramsResponse.status).toBe("ok");
      const params = (paramsResponse.payload as {
        params: Array<{ name: string; type: string; default: unknown }>;
      }).params;
      expect(params.map((p) => p.name).sort()).toEqual(["a", "b"]);
      expect(params[0].type).toBe("int");

      // The exact invocation string script:run builds for Julia kernels.
      const runResult = await km.execute(kernelId, {
        code: `PDVKernel.run_tree_script(pdv_tree, "scripts.compute"; a=20, b=22)`,
      });
      expect(runResult.error).toBeUndefined();

      const totals = await router.request(PDVMessageType.TREE_GET, {
        path: "outputs.total",
        mode: "value",
      });
      expect(totals.status).toBe("ok");
      expect(String((totals.payload as { value?: unknown }).value)).toContain("42");
    });
  });

  describe("namespace queries", () => {
    it("user variables appear in pdv.namespace.query", async () => {
      const seed = await km.execute(kernelId, {
        code: "julia_ns_probe = [1.0, 2.0, 3.0]",
      });
      expect(seed.error).toBeUndefined();
      const response = await router.request(PDVMessageType.NAMESPACE_QUERY, {});
      expect(response.status).toBe("ok");
      const variables = (response.payload as {
        variables: Record<string, { kind?: string }>;
      }).variables;
      expect(variables.julia_ns_probe).toBeDefined();
      expect(variables.julia_ns_probe.kind).toBe("ndarray");
      expect(variables.pdv_tree).toBeUndefined();
    });
  });

  describe("protected namespace", () => {
    it("reassigning pdv_tree errors instead of clobbering the tree", async () => {
      const result = await km.execute(kernelId, { code: "pdv_tree = 7" });
      expect(result.error).toBeDefined();
      // Tree still answers queries.
      const response = await router.request(PDVMessageType.TREE_LIST, { path: "" });
      expect(response.status).toBe("ok");
    });
  });

  describe("project save and load", () => {
    it("save serializes, load reconstructs, checksum survives", async () => {
      const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-save-"));
      tempDirs.push(saveDir);

      const saveResponse = await router.request(PDVMessageType.PROJECT_SAVE, {
        save_dir: saveDir,
      });
      expect(saveResponse.status).toBe("ok");
      const savePayload = saveResponse.payload as {
        node_count: number;
        checksum: string;
        aborted: boolean;
      };
      expect(savePayload.aborted).toBe(false);
      expect(savePayload.node_count).toBeGreaterThan(0);
      expect(savePayload.checksum).toHaveLength(32);
      const indexRaw = await fs.readFile(path.join(saveDir, "tree-index.json"), "utf8");
      expect(Array.isArray(JSON.parse(indexRaw))).toBe(true);

      const loadedPromise = waitForPush(router, PDVMessageType.PROJECT_LOADED);
      // Load back from the save dir. File-backed nodes resolve against the
      // kernel working dir, which still holds the script file.
      const loadResponse = await router.request(PDVMessageType.PROJECT_LOAD, {
        save_dir: saveDir,
      });
      expect(loadResponse.status).toBe("ok");
      await loadedPromise;

      const totals = await router.request(PDVMessageType.TREE_GET, {
        path: "outputs.total",
        mode: "value",
      });
      expect(totals.status).toBe("ok");
      expect(String((totals.payload as { value?: unknown }).value)).toContain("42");

      const script = await router.request(PDVMessageType.TREE_GET, {
        path: "scripts.compute",
        mode: "metadata",
      });
      expect(script.status).toBe("ok");
      expect((script.payload as { type?: unknown }).type).toBe("script");
    });
  });

  describe("pkg-mode project environment (§10.6)", () => {
    it("Pkg.instantiate runner resolves an empty project and reports the Julia version", async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-pkg-"));
      tempDirs.push(projectDir);
      await fs.writeFile(path.join(projectDir, "Project.toml"), "", "utf8");

      const result = await instantiateJuliaEnvironment(projectDir, TEST_JULIA_EXECUTABLE);

      expect(result.success).toBe(true);
      expect(result.juliaVersion).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("a kernel spawned with JULIA_PROJECT activates the project env and still loads PDVKernel", async () => {
      const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-pkgk-"));
      tempDirs.push(projectDir);
      await fs.writeFile(path.join(projectDir, "Project.toml"), "", "utf8");

      const info = await km.start({
        language: "julia",
        env: { JULIA_PATH: TEST_JULIA_EXECUTABLE, JULIA_PROJECT: projectDir },
      });
      const pkgRouter = new CommRouter();
      pkgRouter.attach(km, info.id);
      try {
        const readyPromise = waitForPush(pkgRouter, PDVMessageType.READY, 120_000);
        // Bootstrap succeeding at all proves §10.6.1: PDVKernel/IJulia resolve
        // from the default environment through the stacked LOAD_PATH even
        // though the active project is the (empty) project env.
        const boot = await km.execute(info.id, { code: JULIA_BOOTSTRAP, silent: true });
        expect(boot.error).toBeUndefined();
        await readyPromise;

        const seed = await km.execute(info.id, {
          code: `pdv_tree["active_project"] = Base.active_project()`,
        });
        expect(seed.error).toBeUndefined();
        const response = await pkgRouter.request(PDVMessageType.TREE_GET, {
          path: "active_project",
          mode: "value",
        });
        expect(response.status).toBe("ok");
        const value = String((response.payload as { value?: unknown }).value);
        // Base.active_project() is <projectDir>/Project.toml. macOS tmpdirs
        // resolve through /private; compare on the trailing segments.
        expect(value).toContain(path.join(path.basename(projectDir), "Project.toml"));
      } finally {
        pkgRouter.detach();
        await km.stop(info.id);
      }
    });
  });

  describe("julia runtime discovery (§10.7)", () => {
    it("the combined probe reports version, PDVKernel, and IJulia for the test runtime", async () => {
      const probe = await probeJuliaRuntime(TEST_JULIA_EXECUTABLE);

      expect(probe).not.toBeNull();
      expect(probe!.juliaVersion).toMatch(/^\d+\.\d+\.\d+/);
      // The integration environment dev-installs PDVKernel + IJulia (file
      // header) — the probe must see both without loading either.
      expect(probe!.pdvKernelVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(probe!.ijuliaInstalled).toBe(true);
    });

    it("juliaup discovery finds real channel binaries and the shim resolves into them", () => {
      const juliaupDir = defaultJuliaupDir();
      if (!fsSync.existsSync(path.join(juliaupDir, "juliaup.json"))) {
        return; // machine without juliaup — nothing to assert
      }
      const channels = listJuliaupChannels();
      expect(channels.length).toBeGreaterThan(0);
      expect(channels[0].isDefault).toBe(true);
      expect(fsSync.existsSync(channels[0].juliaPath)).toBe(true);
      // No channel entry is ever the julialauncher shim.
      for (const ch of channels) {
        expect(path.basename(fsSync.realpathSync(ch.juliaPath))).not.toMatch(
          /julialauncher/
        );
      }

      const shim = path.join(os.homedir(), ".juliaup", "bin", "julia");
      if (fsSync.existsSync(shim)) {
        const resolved = resolveJuliaShim(shim);
        expect(resolved).not.toBe(shim);
        expect(
          channels.some((c) => {
            try {
              return (
                fsSync.realpathSync(c.juliaPath) === fsSync.realpathSync(resolved)
              );
            } catch {
              return false;
            }
          })
        ).toBe(true);
      }
    });
  });

  describe("juliaup version management (§10.7.5)", () => {
    it("finds the real juliaup and assesses a mismatched manifest (read-only)", async () => {
      const status = juliaupStatus();
      if (!status.installed) {
        return; // machine without juliaup — nothing to assert
      }
      expect(fsSync.existsSync(status.juliaupPath!)).toBe(true);

      // A manifest resolved with an ancient minor no channel provides:
      // the check must produce the acquire-offer payload, never throw.
      const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-jv-int-"));
      try {
        await fs.writeFile(
          path.join(saveDir, "Manifest.toml"),
          'julia_version = "1.0.5"\nmanifest_format = "2.0"\n'
        );
        const check = await checkJuliaVersionForLoad(saveDir, "1.11.6");
        expect(check).toMatchObject({
          manifestVersion: "1.0.5",
          channel: "1.0",
          juliaupInstalled: true,
        });
      } finally {
        await fs.rm(saveDir, { recursive: true, force: true });
      }
    });
  });
});
