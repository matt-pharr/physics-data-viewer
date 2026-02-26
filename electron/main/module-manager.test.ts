/**
 * module-manager.test.ts — Unit tests for ModuleManager install/list behavior.
 */

import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModuleManager } from "./module-manager";

const execFileAsync = promisify(execFile);

/**
 * Create a minimal valid module folder with `pdv-module.json`.
 *
 * @param rootDir - Directory to create the module files in.
 * @param moduleId - Manifest module id.
 * @param version - Manifest module version.
 */
async function writeModuleFixture(
  rootDir: string,
  moduleId: string,
  version = "1.0.0",
  actions: Array<{ id: string; label: string; script_path: string }> = [
    {
      id: "run",
      label: "Run",
      script_path: "scripts/run.py",
    },
  ]
): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
  const manifest = {
    schema_version: "1",
    id: moduleId,
    name: `Module ${moduleId}`,
    version,
    description: "fixture module",
    actions,
  };
  await fs.writeFile(
    path.join(rootDir, "pdv-module.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
  for (const action of actions) {
    const absScriptPath = path.join(rootDir, action.script_path);
    await fs.mkdir(path.dirname(absScriptPath), { recursive: true });
    await fs.writeFile(
      absScriptPath,
      "def run(pdv_tree: dict, **user_params) -> dict:\n    return {}\n",
      "utf8"
    );
  }
}

/**
 * Run one git command in a repository path.
 *
 * @param repositoryPath - Repository working directory.
 * @param args - Git command arguments.
 */
async function runGit(repositoryPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repositoryPath });
}

describe("ModuleManager", () => {
  let tmpDir: string;
  let pdvDir: string;
  let manager: ModuleManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-module-manager-test-"));
    pdvDir = path.join(tmpDir, ".PDV");
    await fs.mkdir(pdvDir, { recursive: true });
    manager = new ModuleManager(pdvDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("installs from local path and lists installed modules", async () => {
    const localSource = path.join(tmpDir, "local-source");
    await writeModuleFixture(localSource, "local_mod", "1.2.3");

    const result = await manager.install({
      source: {
        type: "local",
        location: localSource,
      },
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("installed");
    expect(result.module?.id).toBe("local_mod");
    expect(result.module?.version).toBe("1.2.3");
    expect(result.module?.source.location).toBe(path.resolve(localSource));

    const installed = await manager.listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.id).toBe("local_mod");
  });

  it("returns up_to_date when reinstalling unchanged local module", async () => {
    const localSource = path.join(tmpDir, "local-repeat");
    await writeModuleFixture(localSource, "repeat_mod", "2.0.0");

    const first = await manager.install({
      source: { type: "local", location: localSource },
    });
    const second = await manager.install({
      source: { type: "local", location: localSource },
    });

    expect(first.success).toBe(true);
    expect(first.status).toBe("installed");
    expect(second.success).toBe(true);
    expect(second.status).toBe("up_to_date");
  });

  it("returns update_available for duplicate install with same major and newer version", async () => {
    const localSource = path.join(tmpDir, "local-update-available");
    await writeModuleFixture(localSource, "update_mod", "1.0.0");

    const first = await manager.install({
      source: { type: "local", location: localSource },
    });
    await writeModuleFixture(localSource, "update_mod", "1.1.0");
    const second = await manager.install({
      source: { type: "local", location: localSource },
    });

    expect(first.success).toBe(true);
    expect(first.status).toBe("installed");
    expect(second.success).toBe(true);
    expect(second.status).toBe("update_available");
    expect(second.module?.version).toBe("1.1.0");

    const installed = await manager.listInstalled();
    expect(installed[0]?.version).toBe("1.0.0");
  });

  it("returns incompatible_update for duplicate install with major version change", async () => {
    const localSource = path.join(tmpDir, "local-incompatible");
    await writeModuleFixture(localSource, "incompat_mod", "1.2.0");

    const first = await manager.install({
      source: { type: "local", location: localSource },
    });
    await writeModuleFixture(localSource, "incompat_mod", "2.0.0");
    const second = await manager.install({
      source: { type: "local", location: localSource },
    });

    expect(first.success).toBe(true);
    expect(first.status).toBe("installed");
    expect(second.success).toBe(true);
    expect(second.status).toBe("incompatible_update");
  });

  it("returns error for invalid manifest schema", async () => {
    const invalidSource = path.join(tmpDir, "invalid-source");
    await fs.mkdir(invalidSource, { recursive: true });
    await fs.writeFile(
      path.join(invalidSource, "pdv-module.json"),
      JSON.stringify({
        schema_version: "1",
        id: "broken",
        name: "Broken",
        version: "0.0.1",
      }),
      "utf8"
    );

    const result = await manager.install({
      source: {
        type: "local",
        location: invalidSource,
      },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toContain('"actions" must be an array');
  });

  it("installs from a git repository source and records revision", async () => {
    const repoSource = path.join(tmpDir, "repo-source");
    await fs.mkdir(repoSource, { recursive: true });
    await runGit(repoSource, ["init"]);
    await runGit(repoSource, ["config", "user.email", "pdv-tests@example.com"]);
    await runGit(repoSource, ["config", "user.name", "PDV Tests"]);
    await writeModuleFixture(repoSource, "git_mod", "0.9.0");
    await runGit(repoSource, ["add", "."]);
    await runGit(repoSource, ["commit", "-m", "initial module"]);

    const result = await manager.install({
      source: {
        type: "github",
        location: repoSource,
      },
    });

    expect(result.success).toBe(true);
    expect(result.module?.id).toBe("git_mod");
    expect(result.module?.revision).toBeTruthy();

    const installed = await manager.listInstalled();
    expect(installed.some((entry) => entry.id === "git_mod")).toBe(true);
  });

  it("resolves canonical script bindings from manifest actions", async () => {
    const localSource = path.join(tmpDir, "binding-source");
    await writeModuleFixture(localSource, "binding_mod", "1.0.0", [
      { id: "run-a", label: "Run A", script_path: "scripts/run.py" },
      { id: "run-b", label: "Run B", script_path: "alt/run.py" },
    ]);

    await manager.install({
      source: { type: "local", location: localSource },
    });

    const bindings = await manager.resolveActionScripts("binding_mod");
    expect(bindings).toEqual([
      {
        actionId: "run-a",
        actionLabel: "Run A",
        name: "run",
        scriptPath: path.join(pdvDir, "modules", "packages", "binding_mod", "scripts", "run.py"),
      },
      {
        actionId: "run-b",
        actionLabel: "Run B",
        name: "run_1",
        scriptPath: path.join(pdvDir, "modules", "packages", "binding_mod", "alt", "run.py"),
      },
    ]);
  });
});
