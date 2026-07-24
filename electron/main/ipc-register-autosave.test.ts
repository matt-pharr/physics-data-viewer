/**
 * ipc-register-autosave.test.ts — Unit tests for the autosave registrar's
 * recovery path.
 *
 * Focuses on `recoverUnsavedSession`'s project-environment preservation
 * (PR #347 review M2): env files (Project.toml/Manifest.toml,
 * pyproject.toml/uv.lock/.python-version) at the orphan's working-dir root
 * must be copied into the active session's working dir, and the orphan —
 * the ONLY copy of an unsaved session's environment — must never be deleted
 * while that copy failed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const ipcRegistry = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcHandle = vi.fn(
    (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  );
  const ipcRemoveHandler = vi.fn((channel: string) => handlers.delete(channel));
  return { handlers, ipcHandle, ipcRemoveHandler };
});

const moduleRuntimeMocks = vi.hoisted(() => ({
  setupProjectModuleNamespaces: vi.fn(async () => undefined),
}));

const projectFileSyncMocks = vi.hoisted(() => ({
  copyFilesForLoad: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/pdv-userdata") },
  ipcMain: {
    handle: ipcRegistry.ipcHandle,
    removeHandler: ipcRegistry.ipcRemoveHandler,
  },
}));

vi.mock("./module-runtime", () => moduleRuntimeMocks);
vi.mock("./project-file-sync", () => projectFileSyncMocks);

import { registerAutosaveIpcHandlers, type AutosaveController } from "./ipc-register-autosave";
import type { ConfigStore, PDVConfig } from "./config";
import {
  createCommRouterMock,
  createKernelManagerMock,
  createModuleManagerMock,
  createProjectManagerMock,
  resetInvokeRegistry,
} from "./test-helpers";

describe("recoverUnsavedSession environment preservation (review M2)", () => {
  let baseDir: string;
  let orphanDir: string;
  let workingDir: string;
  let controller: AutosaveController;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-recover-test-"));
    orphanDir = path.join(baseDir, "orphan");
    workingDir = path.join(baseDir, "working");
    await fs.mkdir(path.join(orphanDir, ".autosave"), { recursive: true });
    await fs.writeFile(path.join(orphanDir, ".autosave", "tree-index.json"), "[]", "utf8");
    await fs.mkdir(workingDir, { recursive: true });

    const kernelWorkingDirs = new Map<string, string>([["k1", workingDir]]);
    controller = registerAutosaveIpcHandlers({
      push: vi.fn(),
      kernelManager: createKernelManagerMock(),
      commRouter: createCommRouterMock().router,
      projectManager: createProjectManagerMock(),
      moduleManager: createModuleManagerMock(),
      configStore: {} as unknown as ConfigStore,
      kernelWorkingDirs,
      readConfig: () => ({ workingDirBase: baseDir }) as unknown as PDVConfig,
      getActiveKernelId: () => "k1",
      getActiveProjectDir: () => null,
      getPendingModuleImports: () => [],
      getPendingModuleSettings: () => ({}),
      setPendingModuleState: vi.fn(),
    });
  });

  afterEach(async () => {
    ipcRegistry.handlers.clear();
    resetInvokeRegistry();
    vi.clearAllMocks();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("copies pkg-mode env files from the orphan and then removes it", async () => {
    await fs.writeFile(path.join(orphanDir, "Project.toml"), "[deps]\n", "utf8");
    await fs.writeFile(path.join(orphanDir, "Manifest.toml"), "julia_version = \"1.11.6\"\n", "utf8");

    await controller.recoverUnsavedSession(orphanDir);

    expect(await fs.readFile(path.join(workingDir, "Project.toml"), "utf8")).toBe("[deps]\n");
    expect(await fs.readFile(path.join(workingDir, "Manifest.toml"), "utf8")).toContain(
      "julia_version",
    );
    await expect(fs.stat(orphanDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies uv-mode env files from the orphan", async () => {
    await fs.writeFile(path.join(orphanDir, "pyproject.toml"), "[project]\n", "utf8");
    await fs.writeFile(path.join(orphanDir, "uv.lock"), "version = 1\n", "utf8");

    await controller.recoverUnsavedSession(orphanDir);

    expect(await fs.readFile(path.join(workingDir, "pyproject.toml"), "utf8")).toBe("[project]\n");
    expect(await fs.readFile(path.join(workingDir, "uv.lock"), "utf8")).toBe("version = 1\n");
    await expect(fs.stat(orphanDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers shared-mode orphans (no env files) unchanged", async () => {
    await controller.recoverUnsavedSession(orphanDir);

    await expect(fs.stat(path.join(workingDir, "Project.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(orphanDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the orphan when an env-file copy fails (only copy of the env)", async () => {
    await fs.writeFile(path.join(orphanDir, "Project.toml"), "[deps]\n", "utf8");
    // Force a non-ENOENT copy failure: the destination is a directory.
    await fs.mkdir(path.join(workingDir, "Project.toml"));

    await controller.recoverUnsavedSession(orphanDir);

    // Orphan survives, so the env can still be salvaged.
    expect(await fs.readFile(path.join(orphanDir, "Project.toml"), "utf8")).toBe("[deps]\n");
  });
});
