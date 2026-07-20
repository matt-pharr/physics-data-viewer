/**
 * tree-create.test.ts — Unit tests for the standalone tree-file-node helpers.
 *
 * Drives analyseModuleTarget (pure) plus allocateAndRegisterScript/Note/Lib
 * against a real temp working dir with stubbed managers, asserting that each
 * writes the backing file, issues the correct `*_REGISTER` comm payload, and
 * returns the expected tree path — including the module-placement branch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  analyseModuleTarget,
  allocateAndRegisterScript,
  allocateAndRegisterNote,
  allocateAndRegisterLib,
  type AllocateScriptDeps,
  type AllocateNoteDeps,
  type AllocateLibDeps,
} from "./tree-create";
import { PDVMessageType } from "./pdv-protocol";

describe("analyseModuleTarget", () => {
  it("returns null for a path outside any known module", () => {
    expect(analyseModuleTarget("data.raw", new Set(["toy"]))).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(analyseModuleTarget("", new Set(["toy"]))).toBeNull();
  });

  it("maps a nested in-module path to alias + relative subdir", () => {
    expect(analyseModuleTarget("toy.scripts.fit", new Set(["toy"]))).toEqual({
      moduleAlias: "toy",
      sourceRelDir: "scripts/fit",
    });
  });

  it("returns an empty subdir when the target is the module root", () => {
    expect(analyseModuleTarget("toy", new Set(["toy"]))).toEqual({
      moduleAlias: "toy",
      sourceRelDir: "",
    });
  });
});

describe("allocate + register helpers", () => {
  let workingDir: string;
  let requests: Array<{ type: string; payload: unknown }>;

  function makeDeps(overrides: Partial<AllocateScriptDeps & AllocateLibDeps> = {}) {
    const commRouter = {
      request: vi.fn(async (type: string, payload: unknown) => {
        requests.push({ type, payload });
        return { status: "ok", payload: {} };
      }),
    };
    const base = {
      kernelManager: {
        getKernel: (id: string) => (id === "k1" ? { language: "python" as const } : undefined),
      },
      commRouter,
      projectManager: {
        createWorkingDir: vi.fn(async () => workingDir),
      },
      configStore: {},
      kernelWorkingDirs: new Map<string, string>([["k1", workingDir]]),
      readConfig: () => ({ workingDirBase: workingDir }) as never,
      getKnownModuleAliases: async () => new Set<string>(["toy"]),
      sanitizeScriptName: (name: string) => `${name.trim().replace(/\s+/g, "_")}.py`,
      ensureScriptFile: vi.fn(async (p: string) => {
        await fs.writeFile(p, "def run(pdv_tree):\n    return {}\n", "utf-8");
      }),
      ensureLibFile: vi.fn(async (p: string) => {
        await fs.writeFile(p, "MAGIC = 1\n", "utf-8");
      }),
      ...overrides,
    };
    return base as unknown as AllocateScriptDeps & AllocateNoteDeps & AllocateLibDeps;
  }

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-treecreate-"));
    requests = [];
  });

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  it("allocateAndRegisterScript writes the file and registers the node", async () => {
    const deps = makeDeps();
    const result = await allocateAndRegisterScript(deps, "k1", "analysis", "fit");
    expect(result.success).toBe(true);
    expect(result.treePath).toBe("analysis.fit");

    // File exists on disk.
    await expect(fs.access(result.scriptPath!)).resolves.toBeUndefined();
    expect(result.scriptPath).toMatch(/fit\.py$/);

    // A SCRIPT_REGISTER comm was issued with the sanitized filename + node name.
    const reg = requests.find((r) => r.type === PDVMessageType.SCRIPT_REGISTER);
    expect(reg).toBeDefined();
    const payload = reg!.payload as Record<string, unknown>;
    expect(payload.parent_path).toBe("analysis");
    expect(payload.name).toBe("fit");
    expect(payload.filename).toBe("fit.py");
    expect(payload.language).toBe("python");
    // Not inside a module → no module fields.
    expect(payload.module_id).toBeUndefined();
  });

  it("allocateAndRegisterScript sets module fields when the target is in a module", async () => {
    const deps = makeDeps();
    const result = await allocateAndRegisterScript(deps, "k1", "toy.scripts", "fit");
    expect(result.treePath).toBe("toy.scripts.fit");

    const reg = requests.find((r) => r.type === PDVMessageType.SCRIPT_REGISTER)!;
    const payload = reg.payload as Record<string, unknown>;
    expect(payload.module_id).toBe("toy");
    expect(payload.source_rel_path).toBe("scripts/fit.py");
  });

  it("allocateAndRegisterScript throws when the kernel is missing", async () => {
    const deps = makeDeps();
    await expect(allocateAndRegisterScript(deps, "ghost", "", "fit")).rejects.toThrow(
      /Kernel not found/,
    );
  });

  it("allocateAndRegisterNote writes a .md file and registers it", async () => {
    const deps = makeDeps();
    const result = await allocateAndRegisterNote(deps, "k1", "", "my note");
    expect(result.treePath).toBe("my_note");
    await expect(fs.access(result.notePath!)).resolves.toBeUndefined();
    expect(result.notePath).toMatch(/my_note\.md$/);

    const reg = requests.find((r) => r.type === PDVMessageType.NOTE_REGISTER)!;
    const payload = reg.payload as Record<string, unknown>;
    expect(payload.name).toBe("my_note");
    expect(payload.filename).toBe("my_note.md");
  });

  it("allocateAndRegisterLib registers a lib node and sets up the module when in one", async () => {
    const deps = makeDeps();
    const result = await allocateAndRegisterLib(deps, "k1", "toy", "helpers");
    expect(result.treePath).toBe("toy.helpers");
    await expect(fs.access(result.libPath!)).resolves.toBeUndefined();

    const fileReg = requests.find((r) => r.type === PDVMessageType.FILE_REGISTER)!;
    const payload = fileReg.payload as Record<string, unknown>;
    expect(payload.node_type).toBe("lib");
    expect(payload.name).toBe("helpers");
    expect(payload.module_id).toBe("toy");

    // In-module lib also triggers a module-setup comm.
    expect(requests.some((r) => r.type === PDVMessageType.MODULES_SETUP)).toBe(true);
  });

  it("allocateAndRegisterLib rejects a name with no identifier characters", async () => {
    const deps = makeDeps();
    await expect(allocateAndRegisterLib(deps, "k1", "", "!!!")).rejects.toThrow(
      /at least one letter or number/,
    );
  });

  it("allocateAndRegisterLib uses the kernel language for the extension", async () => {
    // Python kernel → .py (and a user-typed .jl extension is stripped).
    const py = await allocateAndRegisterLib(makeDeps(), "k1", "", "helpers.jl");
    expect(py.libPath).toMatch(/helpers\.py$/);

    // Julia kernel → .jl (regression: libs were always created as .py).
    requests = [];
    const juliaDeps = makeDeps({
      kernelManager: {
        getKernel: (id: string) => (id === "k1" ? { language: "julia" as const } : undefined),
      },
    } as never);
    const jl = await allocateAndRegisterLib(juliaDeps, "k1", "", "helpers");
    expect(jl.libPath).toMatch(/helpers\.jl$/);
    const fileReg = requests.find((r) => r.type === PDVMessageType.FILE_REGISTER)!;
    expect((fileReg.payload as Record<string, unknown>).filename).toBe("helpers.jl");
  });

  it("creates and records a working dir on first use when none exists yet", async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-treecreate-new-"));
    try {
      const kernelWorkingDirs = new Map<string, string>(); // empty → must create
      const createWorkingDir = vi.fn(async () => created);
      const deps = makeDeps({
        kernelWorkingDirs,
        projectManager: { createWorkingDir } as never,
      });
      await allocateAndRegisterScript(deps, "k1", "", "fit");
      expect(createWorkingDir).toHaveBeenCalledOnce();
      expect(kernelWorkingDirs.get("k1")).toBe(created);
    } finally {
      await fs.rm(created, { recursive: true, force: true });
    }
  });
});
