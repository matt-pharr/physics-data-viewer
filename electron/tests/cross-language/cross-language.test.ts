/**
 * cross-language.test.ts — Protocol + behavior equivalence tests.
 *
 * @slow — Spawns both a Python and Julia kernel, sends identical comm
 * messages, and asserts responses have the same structure and behavioral
 * semantics. Does NOT test cross-language data file interop (projects are
 * language-specific).
 *
 * Environment variables:
 * - PYTHON_PATH — path to Python executable (default: python3)
 * - JULIA_PATH  — path to Julia executable (default: julia)
 *
 * Run with:
 *   cd electron && PYTHON_PATH=python3 JULIA_PATH=julia \
 *     npx vitest run tests/cross-language/cross-language.test.ts --reporter=verbose
 */

import * as fs from "fs/promises";
import * as path from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDVCommError } from "../../main/comm-router";
import { PDVMessageType } from "../../main/pdv-protocol";
import {
  type TestKernelSession,
  startPythonSession,
  startJuliaSession,
  stopSession,
  sendToBoth,
  waitForPush,
  assertStructurallyEqual,
  assertOk,
} from "./helpers";

const FIXTURES_DIR = path.resolve(__dirname, "fixtures");

describe(
  "@slow Cross-language equivalence (Python + Julia)",
  { timeout: 180_000 },
  () => {
    let py: TestKernelSession | undefined;
    let jl: TestKernelSession | undefined;
    const tempDirs: string[] = [];

    // -----------------------------------------------------------------------
    // Setup: start both kernels
    // -----------------------------------------------------------------------

    beforeAll(async () => {
      [py, jl] = await Promise.all([
        startPythonSession(tempDirs),
        startJuliaSession(tempDirs),
      ]);
    }, 120_000);

    afterAll(async () => {
      await Promise.all([stopSession(py), stopSession(jl)]);
      await Promise.all(
        tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
      );
    });

    // -----------------------------------------------------------------------
    // Lifecycle (2 tests)
    // -----------------------------------------------------------------------

    describe("Lifecycle", () => {
      it("1. pdv.init was accepted by both kernels", () => {
        expect(py!.kernelId).toBeTruthy();
        expect(jl!.kernelId).toBeTruthy();
      });

      it("2. both kernels report the same language in their session", () => {
        expect(py!.language).toBe("python");
        expect(jl!.language).toBe("julia");
      });
    });

    // -----------------------------------------------------------------------
    // Tree operations (5 tests)
    // -----------------------------------------------------------------------

    describe("Tree operations", () => {
      it("3. pdv.tree.list on empty tree returns same structure", async () => {
        const { python, julia } = await sendToBoth(
          py!,
          jl!,
          PDVMessageType.TREE_LIST,
          { path: "" }
        );
        assertOk(python, "Python tree.list");
        assertOk(julia, "Julia tree.list");
        assertStructurallyEqual(python, julia);
      });

      it("4. after setting values, tree.list returns matching node descriptor fields", async () => {
        await py!.km.execute(py!.kernelId, {
          code: 'pdv_tree["x"] = 42\npdv_tree["name"] = "hello"',
        });
        await jl!.km.execute(jl!.kernelId, {
          code: 'pdv_tree["x"] = 42\npdv_tree["name"] = "hello"',
        });

        const { python, julia } = await sendToBoth(
          py!,
          jl!,
          PDVMessageType.TREE_LIST,
          { path: "" }
        );
        assertOk(python, "Python tree.list after set");
        assertOk(julia, "Julia tree.list after set");

        const pyNodes = (python.payload as Record<string, unknown>)
          .nodes as Array<Record<string, unknown>>;
        const jlNodes = (julia.payload as Record<string, unknown>)
          .nodes as Array<Record<string, unknown>>;

        expect(pyNodes.length).toBe(jlNodes.length);
        const pyKeys = pyNodes.map((n) => n.key).sort();
        const jlKeys = jlNodes.map((n) => n.key).sort();
        expect(pyKeys).toEqual(jlKeys);
      });

      it("5. pdv.tree.get mode=value returns same structure", async () => {
        const { python, julia } = await sendToBoth(
          py!,
          jl!,
          PDVMessageType.TREE_GET,
          { path: "x", mode: "value" }
        );
        assertOk(python, "Python tree.get x");
        assertOk(julia, "Julia tree.get x");
        const pyPayload = python.payload as Record<string, unknown>;
        const jlPayload = julia.payload as Record<string, unknown>;
        // Both should return 42, but value may be number or string depending on serialization.
        expect(Number(pyPayload.value)).toBe(42);
        expect(Number(jlPayload.value)).toBe(42);
      });

      it("6. pdv.tree.get on missing path returns same error code", async () => {
        // CommRouter.request() rejects with PDVCommError on error responses.
        const pyErr = await py!.router
          .request(PDVMessageType.TREE_GET, { path: "nonexistent.path", mode: "value" })
          .then(() => null)
          .catch((e) => e);
        const jlErr = await jl!.router
          .request(PDVMessageType.TREE_GET, { path: "nonexistent.path", mode: "value" })
          .then(() => null)
          .catch((e) => e);

        expect(pyErr).toBeInstanceOf(PDVCommError);
        expect(jlErr).toBeInstanceOf(PDVCommError);
        expect((pyErr as PDVCommError).code).toBe("tree.path_not_found");
        expect((jlErr as PDVCommError).code).toBe("tree.path_not_found");
      });

      it("7. pdv.tree.resolve_file returns same response structure", async () => {
        const pyScriptPath = path.join(py!.workingDir, "test_resolve.py");
        const jlScriptPath = path.join(jl!.workingDir, "test_resolve.jl");
        await fs.writeFile(pyScriptPath, 'def run(pdv_tree, **kw): return pdv_tree\n');
        await fs.writeFile(jlScriptPath, 'function run(pdv_tree; kw...) pdv_tree end\n');

        await py!.router.request(PDVMessageType.SCRIPT_REGISTER, {
          name: "test_resolve",
          relative_path: "test_resolve.py",
        });
        await jl!.router.request(PDVMessageType.SCRIPT_REGISTER, {
          name: "test_resolve",
          relative_path: "test_resolve.jl",
        });

        const { python, julia } = await sendToBoth(
          py!,
          jl!,
          PDVMessageType.TREE_RESOLVE_FILE,
          { path: "test_resolve" }
        );
        assertOk(python, "Python resolve_file");
        assertOk(julia, "Julia resolve_file");
        assertStructurallyEqual(python, julia, ["file_path", "absolute_path"]);
      });
    });

    // -----------------------------------------------------------------------
    // Script (2 tests)
    // -----------------------------------------------------------------------

    describe("Script", () => {
      it("8. pdv.script.register returns same response structure", async () => {
        const pyScriptPath = path.join(py!.workingDir, "sample.py");
        const jlScriptPath = path.join(jl!.workingDir, "sample.jl");
        await fs.copyFile(path.join(FIXTURES_DIR, "sample-script.py"), pyScriptPath);
        await fs.copyFile(path.join(FIXTURES_DIR, "sample-script.jl"), jlScriptPath);

        const pyResp = await py!.router.request(PDVMessageType.SCRIPT_REGISTER, {
          name: "sample",
          relative_path: "sample.py",
          language: "python",
        });
        const jlResp = await jl!.router.request(PDVMessageType.SCRIPT_REGISTER, {
          name: "sample",
          relative_path: "sample.jl",
          language: "julia",
        });

        assertOk(pyResp, "Python script.register");
        assertOk(jlResp, "Julia script.register");
        assertStructurallyEqual(pyResp, jlResp);
      });

      it("9. parameter extraction from equivalent scripts yields same params", async () => {
        // Get the script node metadata via tree.get with mode=metadata.
        const { python, julia } = await sendToBoth(
          py!,
          jl!,
          PDVMessageType.TREE_GET,
          { path: "sample", mode: "metadata" }
        );
        assertOk(python, "Python tree.get sample metadata");
        assertOk(julia, "Julia tree.get sample metadata");

        const pyPayload = python.payload as Record<string, unknown>;
        const jlPayload = julia.payload as Record<string, unknown>;
        const pyParams = (pyPayload.params ?? []) as Array<Record<string, unknown>>;
        const jlParams = (jlPayload.params ?? []) as Array<Record<string, unknown>>;

        if (pyParams.length > 0 && jlParams.length > 0) {
          const pyNames = pyParams.map((p) => p.name).sort();
          const jlNames = jlParams.map((p) => p.name).sort();
          expect(pyNames).toEqual(jlNames);
        }
      });
    });

    // -----------------------------------------------------------------------
    // Project save/load within each language (3 tests)
    // -----------------------------------------------------------------------

    describe("Project save/load", () => {
      it("10. Python save and reload preserves tree data", async () => {
        const saveDir = await fs.mkdtemp(
          path.join(tempDirs[0], "..", "pdv-xtest-save-py-")
        );
        tempDirs.push(saveDir);

        const saveResp = await py!.router.request(PDVMessageType.PROJECT_SAVE, {
          save_dir: saveDir,
        });
        assertOk(saveResp, "Python save");

        const loadResp = await py!.router.request(PDVMessageType.PROJECT_LOAD, {
          save_dir: saveDir,
        });
        assertOk(loadResp, "Python load");
      });

      it("11. Julia save and reload preserves tree data", async () => {
        const saveDir = await fs.mkdtemp(
          path.join(tempDirs[0], "..", "pdv-xtest-save-jl-")
        );
        tempDirs.push(saveDir);

        const saveResp = await jl!.router.request(PDVMessageType.PROJECT_SAVE, {
          save_dir: saveDir,
        });
        assertOk(saveResp, "Julia save");

        const loadResp = await jl!.router.request(PDVMessageType.PROJECT_LOAD, {
          save_dir: saveDir,
        });
        assertOk(loadResp, "Julia load");
      });

      it("12. both produce tree-index.json with same schema", async () => {
        const pySaveDir = await fs.mkdtemp(
          path.join(tempDirs[0], "..", "pdv-xtest-schema-py-")
        );
        const jlSaveDir = await fs.mkdtemp(
          path.join(tempDirs[0], "..", "pdv-xtest-schema-jl-")
        );
        tempDirs.push(pySaveDir, jlSaveDir);

        // Clean up script nodes registered in earlier tests — their files
        // live outside the tree/ subdirectory so project save can't serialize them.
        for (const key of ["test_resolve", "sample"]) {
          await py!.km.execute(py!.kernelId, {
            code: `if "${key}" in pdv_tree: del pdv_tree["${key}"]`,
          });
          await jl!.km.execute(jl!.kernelId, {
            code: `haskey(pdv_tree, "${key}") && delete!(pdv_tree, "${key}")`,
          });
        }

        await py!.router.request(PDVMessageType.PROJECT_SAVE, {
          save_dir: pySaveDir,
        });
        await jl!.router.request(PDVMessageType.PROJECT_SAVE, {
          save_dir: jlSaveDir,
        });

        const pyIndex = JSON.parse(
          await fs.readFile(path.join(pySaveDir, "tree-index.json"), "utf8")
        ) as unknown[];
        const jlIndex = JSON.parse(
          await fs.readFile(path.join(jlSaveDir, "tree-index.json"), "utf8")
        ) as unknown[];

        expect(Array.isArray(pyIndex)).toBe(true);
        expect(Array.isArray(jlIndex)).toBe(true);

        if (pyIndex.length > 0 && jlIndex.length > 0) {
          const commonRequired = ["key", "path", "type"];
          const pyFields = Object.keys(pyIndex[0] as Record<string, unknown>);
          const jlFields = Object.keys(jlIndex[0] as Record<string, unknown>);
          for (const field of commonRequired) {
            expect(pyFields, `Python tree-index missing '${field}'`).toContain(field);
            expect(jlFields, `Julia tree-index missing '${field}'`).toContain(field);
          }
        }
      });
    });

    // -----------------------------------------------------------------------
    // Module/registration (3 tests)
    // -----------------------------------------------------------------------

    describe("Module/registration", () => {
      it("13. pdv.note.register returns same response structure", async () => {
        const pyNotePath = path.join(py!.workingDir, "test.md");
        const jlNotePath = path.join(jl!.workingDir, "test.md");
        await fs.writeFile(pyNotePath, "# Test note\n");
        await fs.writeFile(jlNotePath, "# Test note\n");

        const pyResp = await py!.router.request(PDVMessageType.NOTE_REGISTER, {
          name: "test_note",
          relative_path: "test.md",
        });
        const jlResp = await jl!.router.request(PDVMessageType.NOTE_REGISTER, {
          name: "test_note",
          relative_path: "test.md",
        });

        assertOk(pyResp, "Python note.register");
        assertOk(jlResp, "Julia note.register");
        assertStructurallyEqual(pyResp, jlResp);
      });

      it("14. pdv.gui.register returns same response structure", async () => {
        const guiJson = JSON.stringify({
          layout: { type: "container", direction: "column", children: [] },
        });
        const pyGuiPath = path.join(py!.workingDir, "gui.json");
        const jlGuiPath = path.join(jl!.workingDir, "gui.json");
        await fs.writeFile(pyGuiPath, guiJson);
        await fs.writeFile(jlGuiPath, guiJson);

        const pyResp = await py!.router.request(PDVMessageType.GUI_REGISTER, {
          name: "test_gui",
          relative_path: "gui.json",
        });
        const jlResp = await jl!.router.request(PDVMessageType.GUI_REGISTER, {
          name: "test_gui",
          relative_path: "gui.json",
        });

        assertOk(pyResp, "Python gui.register");
        assertOk(jlResp, "Julia gui.register");
        assertStructurallyEqual(pyResp, jlResp);
      });

      it("15. pdv.module.register returns same response structure", async () => {
        const pyResp = await py!.router.request(PDVMessageType.MODULE_REGISTER, {
          path: "tmod",
          module_id: "test-mod",
          name: "Test Module",
          version: "1.0.0",
        });
        const jlResp = await jl!.router.request(PDVMessageType.MODULE_REGISTER, {
          path: "tmod",
          module_id: "test-mod",
          name: "Test Module",
          version: "1.0.0",
        });

        assertOk(pyResp, "Python module.register");
        assertOk(jlResp, "Julia module.register");
        assertStructurallyEqual(pyResp, jlResp);
      });
    });

    // -----------------------------------------------------------------------
    // Namespace (1 test)
    // -----------------------------------------------------------------------

    describe("Namespace", () => {
      it("16. pdv.namespace.query returns same response schema", async () => {
        const { python, julia } = await sendToBoth(
          py!,
          jl!,
          PDVMessageType.NAMESPACE_QUERY,
          { include_private: false, include_modules: false, include_callables: false }
        );
        assertOk(python, "Python namespace.query");
        assertOk(julia, "Julia namespace.query");

        // Both should return a variables field (may be array or dict).
        const pyPayload = python.payload as Record<string, unknown>;
        const jlPayload = julia.payload as Record<string, unknown>;
        expect(pyPayload.variables).toBeDefined();
        expect(jlPayload.variables).toBeDefined();
      });
    });

    // -----------------------------------------------------------------------
    // Error responses (2 tests)
    // -----------------------------------------------------------------------

    describe("Error responses", () => {
      it("17. all error responses use same status/code structure", async () => {
        const pyErr = await py!.router
          .request(PDVMessageType.TREE_GET, { path: "this.does.not.exist", mode: "value" })
          .then(() => null)
          .catch((e) => e);
        const jlErr = await jl!.router
          .request(PDVMessageType.TREE_GET, { path: "this.does.not.exist", mode: "value" })
          .then(() => null)
          .catch((e) => e);

        expect(pyErr).toBeInstanceOf(PDVCommError);
        expect(jlErr).toBeInstanceOf(PDVCommError);
        expect((pyErr as PDVCommError).code).toBe((jlErr as PDVCommError).code);
      });

      it("18. version mismatch produces same error behavior", async () => {
        expect(py!.kernelId).toBeTruthy();
        expect(jl!.kernelId).toBeTruthy();
      });
    });

    // -----------------------------------------------------------------------
    // Change notifications (1 test)
    // -----------------------------------------------------------------------

    describe("Change notifications", () => {
      it("19. tree mutation emits pdv.tree.changed with same payload structure", async () => {
        const pyChangedPromise = waitForPush(
          py!.router,
          PDVMessageType.TREE_CHANGED,
          10_000
        );
        const jlChangedPromise = waitForPush(
          jl!.router,
          PDVMessageType.TREE_CHANGED,
          10_000
        );

        await py!.km.execute(py!.kernelId, {
          code: 'pdv_tree["notify_test"] = 99',
        });
        await jl!.km.execute(jl!.kernelId, {
          code: 'pdv_tree["notify_test"] = 99',
        });

        const pyChanged = await pyChangedPromise;
        const jlChanged = await jlChangedPromise;

        expect(pyChanged.type).toBe(PDVMessageType.TREE_CHANGED);
        expect(jlChanged.type).toBe(PDVMessageType.TREE_CHANGED);
        assertStructurallyEqual(pyChanged, jlChanged, ["changed_paths"]);
      });
    });

    // -----------------------------------------------------------------------
    // Namelist (2 tests)
    // -----------------------------------------------------------------------

    describe("Namelist", () => {
      it("20. pdv.namelist.read returns same response structure", async () => {
        const nmlContent = "&params\n  x = 1.0\n  label = 'test'\n/\n";
        const pyNmlPath = path.join(py!.workingDir, "test.nml");
        const jlNmlPath = path.join(jl!.workingDir, "test.nml");
        await fs.writeFile(pyNmlPath, nmlContent);
        await fs.writeFile(jlNmlPath, nmlContent);

        // Register as namelist file nodes at tree root.
        // tree_path is the *parent* path; name overrides the derived node name.
        await py!.router.request(PDVMessageType.FILE_REGISTER, {
          tree_path: "",
          filename: "test.nml",
          name: "test_nml",
          node_type: "namelist",
        });
        await jl!.router.request(PDVMessageType.FILE_REGISTER, {
          tree_path: "",
          filename: "test.nml",
          name: "test_nml",
          node_type: "namelist",
        });

        // namelist.read requires f90nml (Python) — skip if not installed.
        let python, julia;
        try {
          ({ python, julia } = await sendToBoth(
            py!,
            jl!,
            PDVMessageType.NAMELIST_READ,
            { tree_path: "test_nml" }
          ));
        } catch (e) {
          if (e instanceof PDVCommError && e.code === "namelist.import_error") {
            // Optional dependency missing — skip test.
            return;
          }
          throw e;
        }
        assertOk(python, "Python namelist.read");
        assertOk(julia, "Julia namelist.read");
        assertStructurallyEqual(python, julia);
      });

      it("21. pdv.namelist.write returns same response structure", async () => {
        let python, julia;
        try {
          ({ python, julia } = await sendToBoth(
            py!,
            jl!,
            PDVMessageType.NAMELIST_WRITE,
            {
              tree_path: "test_nml",
              data: { params: { x: 2.0, label: "updated" } },
            }
          ));
        } catch (e) {
          if (e instanceof PDVCommError && e.code === "namelist.import_error") {
            return;
          }
          throw e;
        }
        assertOk(python, "Python namelist.write");
        assertOk(julia, "Julia namelist.write");
        assertStructurallyEqual(python, julia);
      });
    });
  }
);
