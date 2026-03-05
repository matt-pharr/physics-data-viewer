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
  actions: Array<{ id: string; label: string; script_path: string; tab?: string; inputs?: string[] }> = [
    {
      id: "run",
      label: "Run",
      script_path: "scripts/run.py",
    },
  ],
  extraManifestFields: Record<string, unknown> = {}
): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
  const manifest = {
    schema_version: "1",
    id: moduleId,
    name: `Module ${moduleId}`,
    version,
    description: "fixture module",
    actions,
    ...extraManifestFields,
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
    expect(second.currentVersion).toBe("2.0.0");
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
    expect(second.currentVersion).toBe("1.0.0");

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
    expect(second.currentVersion).toBe("1.2.0");
    expect(second.module?.version).toBe("2.0.0");
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

  it("returns error for action inputs with invalid Python identifiers", async () => {
    const invalidSource = path.join(tmpDir, "invalid-action-input-id");
    await writeModuleFixture(invalidSource, "broken-input-id", "0.0.1", [
      {
        id: "run",
        label: "Run",
        script_path: "scripts/run.py",
        inputs: ["valid_name", "invalid-name"],
      },
    ]);

    const result = await manager.install({
      source: {
        type: "local",
        location: invalidSource,
      },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    expect(result.error).toContain("actions[0].inputs[1] must be a valid Python identifier");
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
      { id: "run-a", label: "Run A", script_path: "scripts/run.py", tab: "General" },
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
        actionTab: "General",
      },
      {
        actionId: "run-b",
        actionLabel: "Run B",
        name: "run_1",
        scriptPath: path.join(pdvDir, "modules", "packages", "binding_mod", "alt", "run.py"),
      },
    ]);
  });

  it("evaluates compatibility and dependency warnings", async () => {
    const localSource = path.join(tmpDir, "health-source");
    await writeModuleFixture(
      localSource,
      "health_mod",
      "1.0.0",
      [{ id: "run", label: "Run", script_path: "scripts/run.py" }],
      {
        compatibility: {
          pdv_min: "2.0.0",
          python_min: "3.12.0",
        },
        dependencies: [{ name: "numpy", version: ">=1.26" }],
      }
    );
    await manager.install({
      source: { type: "local", location: localSource },
    });

    const warnings = await manager.evaluateHealth("health_mod", {
      pdvVersion: "1.0.0",
      pythonVersion: "Python 3.11.6",
    });

    expect(warnings.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "pdv_version_incompatible",
        "python_version_incompatible",
        "dependency_unverified",
      ])
    );
  });

  it("reports missing action script as a warning", async () => {
    const localSource = path.join(tmpDir, "missing-script-source");
    await writeModuleFixture(localSource, "missing_script_mod", "1.0.0");
    await manager.install({
      source: { type: "local", location: localSource },
    });

    const installedScriptPath = path.join(
      pdvDir,
      "modules",
      "packages",
      "missing_script_mod",
      "scripts",
      "run.py"
    );
    await fs.rm(installedScriptPath, { force: true });

    const warnings = await manager.evaluateHealth("missing_script_mod", {
      pdvVersion: "1.0.0",
      pythonVersion: "3.11.0",
    });

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_action_script" }),
      ])
    );
  });

  it("parses rich module input descriptors for GUI controls", async () => {
    const localSource = path.join(tmpDir, "rich-input-source");
    await writeModuleFixture(
      localSource,
      "rich_input_mod",
      "1.0.0",
      [{ id: "run", label: "Run", script_path: "scripts/run.py" }],
      {
        inputs: [
          {
            id: "solver",
            label: "Solver",
            control: "dropdown",
            options: [
              { label: "RK4", value: "rk4" },
              { label: "Euler", value: "euler" },
            ],
            options_tree_path: "results.run_outputs",
            default: "rk4",
            tab: "General",
            tooltip: "Integration method",
          },
          {
            id: "steps",
            label: "Steps",
            control: "slider",
            min: 10,
            max: 2000,
            step: 10,
            default: 200,
            section: "Numerics",
            section_collapsed: true,
          },
          {
            id: "use_gpu",
            label: "Use GPU",
            control: "checkbox",
            default: false,
            visible_if: { input_id: "solver", equals: "rk4" },
          },
          {
            id: "input_file",
            label: "Input File",
            control: "file",
            file_mode: "file",
          },
        ],
      }
    );
    await manager.install({
      source: { type: "local", location: localSource },
    });

    const inputs = await manager.getModuleInputs("rich_input_mod");
    expect(inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "solver",
          control: "dropdown",
          options: [
            { label: "RK4", value: "rk4" },
            { label: "Euler", value: "euler" },
          ],
          optionsTreePath: "results.run_outputs",
          default: "rk4",
          tab: "General",
          tooltip: "Integration method",
        }),
        expect.objectContaining({
          id: "steps",
          control: "slider",
          min: 10,
          max: 2000,
          step: 10,
          default: 200,
          section: "Numerics",
          sectionCollapsed: true,
        }),
        expect.objectContaining({
          id: "use_gpu",
          control: "checkbox",
          default: false,
          visibleIf: { inputId: "solver", equals: "rk4" },
        }),
        expect.objectContaining({
          id: "input_file",
          control: "file",
          fileMode: "file",
        }),
      ])
    );
  });
});
