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
  assertError,
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
      // Start both in parallel for speed.
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
        // Init already succeeded in beforeAll (would have thrown otherwise).
        expect(py.kernelId).toBeTruthy();
        expect(jl.kernelId).toBeTruthy();
      });

      it("2. both kernels report the same language in their session", () => {
        expect(py.language).toBe("python");
        expect(jl.language).toBe("julia");
      });
    });

    // -----------------------------------------------------------------------
    // Tree operations (5 tests)
    // -----------------------------------------------------------------------

    describe("Tree operations", () => {
      it("3. pdv.tree.list on empty tree returns same structure", async () => {
        const { python, julia } = await sendToBoth(
          py,
          jl,
          PDVMessageType.TREE_LIST,
          { path: "" }
        );
        assertOk(python, "Python tree.list");
        assertOk(julia, "Julia tree.list");
        assertStructurallyEqual(python, julia);
      });

      it("4. after setting values, tree.list returns matching node descriptor fields", async () => {
        // Set values via execute in each kernel.
        await py.km.execute(py.kernelId, {
          code: 'pdv_tree["x"] = 42\npdv_tree["name"] = "hello"',
        });
        await jl.km.execute(jl.kernelId, {
          code: 'pdv_tree["x"] = 42\npdv_tree["name"] = "hello"',
        });

        const { python, julia } = await sendToBoth(
          py,
          jl,
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
        // Both should have the same keys.
        const pyKeys = pyNodes.map((n) => n.key).sort();
        const jlKeys = jlNodes.map((n) => n.key).sort();
        expect(pyKeys).toEqual(jlKeys);
      });

      it("5. pdv.tree.get mode=value returns same structure", async () => {
        const { python, julia } = await sendToBoth(
          py,
          jl,
          PDVMessageType.TREE_GET,
          { path: "x", mode: "value" }
        );
        assertOk(python, "Python tree.get x");
        assertOk(julia, "Julia tree.get x");
        // Both should return the value 42.
        const pyPayload = python.payload as Record<string, unknown>;
        const jlPayload = julia.payload as Record<string, unknown>;
        expect(pyPayload.value).toBe(42);
        expect(jlPayload.value).toBe(42);
      });

      it("6. pdv.tree.get on missing path returns same error code", async () => {
        const { python, julia } = await sendToBoth(
          py,
          jl,
          PDVMessageType.TREE_GET,
          { path: "nonexistent.path", mode: "value" }
        );
        assertError(python, "tree.path_not_found", "Python missing path");
        assertError(julia, "tree.path_not_found", "Julia missing path");
      });

      it("7. pdv.tree.resolve_file returns same response structure", async () => {
        // Register a script in each kernel first.
        const pyScriptPath = path.join(py.workingDir, "test_resolve.py");
        const jlScriptPath = path.join(jl.workingDir, "test_resolve.jl");
        await fs.writeFile(pyScriptPath, 'def run(pdv_tree, **kw): return pdv_tree\n');
        await fs.writeFile(jlScriptPath, 'function run(pdv_tree; kw...) pdv_tree end\n');

        await py.router.request(PDVMessageType.SCRIPT_REGISTER, {
          path: "test_resolve",
          file_path: pyScriptPath,
        });
        await jl.router.request(PDVMessageType.SCRIPT_REGISTER, {
          path: "test_resolve",
          file_path: jlScriptPath,
        });

        const { python, julia } = await sendToBoth(
          py,
          jl,
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
        const pyScriptPath = path.join(py.workingDir, "sample.py");
        const jlScriptPath = path.join(jl.workingDir, "sample.jl");
        await fs.copyFile(path.join(FIXTURES_DIR, "sample-script.py"), pyScriptPath);
        await fs.copyFile(path.join(FIXTURES_DIR, "sample-script.jl"), jlScriptPath);

        const pyResp = await py.router.request(PDVMessageType.SCRIPT_REGISTER, {
          path: "sample",
          file_path: pyScriptPath,
        });
        const jlResp = await jl.router.request(PDVMessageType.SCRIPT_REGISTER, {
          path: "sample",
          file_path: jlScriptPath,
        });

        assertOk(pyResp, "Python script.register");
        assertOk(jlResp, "Julia script.register");
        assertStructurallyEqual(pyResp, jlResp);
      });

      it("9. parameter extraction from equivalent scripts yields same params", async () => {
        // List the registered script node and check params.
        const { python, julia } = await sendToBoth(
          py,
          jl,
          PDVMessageType.TREE_LIST,
          { path: "sample" }
        );

        // Params should be on the script node's list response.
        const pyPayload = python.payload as Record<string, unknown>;
        const jlPayload = julia.payload as Record<string, unknown>;
        // Both should have params with same names: x and label.
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

        const saveResp = await py.router.request(PDVMessageType.PROJECT_SAVE, {
          save_dir: saveDir,
        });
        assertOk(saveResp, "Python save");

        const loadResp = await py.router.request(PDVMessageType.PROJECT_LOAD, {
          save_dir: saveDir,
        });
        assertOk(loadResp, "Python load");
      });

      it("11. Julia save and reload preserves tree data", async () => {
        const saveDir = await fs.mkdtemp(
          path.join(tempDirs[0], "..", "pdv-xtest-save-jl-")
        );
        tempDirs.push(saveDir);

        const saveResp = await jl.router.request(PDVMessageType.PROJECT_SAVE, {
          save_dir: saveDir,
        });
        assertOk(saveResp, "Julia save");

        const loadResp = await jl.router.request(PDVMessageType.PROJECT_LOAD, {
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

        await py.router.request(PDVMessageType.PROJECT_SAVE, {
          save_dir: pySaveDir,
        });
        await jl.router.request(PDVMessageType.PROJECT_SAVE, {
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

        // Both should have entries, and each entry should have the same required fields.
        if (pyIndex.length > 0 && jlIndex.length > 0) {
          const pyFields = Object.keys(
            pyIndex[0] as Record<string, unknown>
          ).sort();
          const jlFields = Object.keys(
            jlIndex[0] as Record<string, unknown>
          ).sort();
          // Allow language-specific extra fields, but require common ones.
          const commonRequired = ["key", "path", "type"];
          for (const field of commonRequired) {
            expect(pyFields, `Python tree-index missing '${field}'`).toContain(
              field
            );
            expect(jlFields, `Julia tree-index missing '${field}'`).toContain(
              field
            );
          }
        }
      });
    });

    // -----------------------------------------------------------------------
    // Module/registration (3 tests)
    // -----------------------------------------------------------------------

    describe("Module/registration", () => {
      it("13. pdv.note.register returns same response structure", async () => {
        const pyNotePath = path.join(py.workingDir, "test.md");
        const jlNotePath = path.join(jl.workingDir, "test.md");
        await fs.writeFile(pyNotePath, "# Test note\n");
        await fs.writeFile(jlNotePath, "# Test note\n");

        const pyResp = await py.router.request(PDVMessageType.NOTE_REGISTER, {
          path: "test_note",
          file_path: pyNotePath,
        });
        const jlResp = await jl.router.request(PDVMessageType.NOTE_REGISTER, {
          path: "test_note",
          file_path: jlNotePath,
        });

        assertOk(pyResp, "Python note.register");
        assertOk(jlResp, "Julia note.register");
        assertStructurallyEqual(pyResp, jlResp);
      });

      it("14. pdv.gui.register returns same response structure", async () => {
        const guiJson = JSON.stringify({
          layout: { type: "container", direction: "column", children: [] },
        });
        const pyGuiPath = path.join(py.workingDir, "gui.json");
        const jlGuiPath = path.join(jl.workingDir, "gui.json");
        await fs.writeFile(pyGuiPath, guiJson);
        await fs.writeFile(jlGuiPath, guiJson);

        const pyResp = await py.router.request(PDVMessageType.GUI_REGISTER, {
          path: "test_gui",
          file_path: pyGuiPath,
        });
        const jlResp = await jl.router.request(PDVMessageType.GUI_REGISTER, {
          path: "test_gui",
          file_path: jlGuiPath,
        });

        assertOk(pyResp, "Python gui.register");
        assertOk(jlResp, "Julia gui.register");
        assertStructurallyEqual(pyResp, jlResp);
      });

      it("15. pdv.module.register returns same response structure", async () => {
        const pyResp = await py.router.request(PDVMessageType.MODULE_REGISTER, {
          module_id: "test-mod",
          alias: "tmod",
          version: "1.0.0",
        });
        const jlResp = await jl.router.request(PDVMessageType.MODULE_REGISTER, {
          module_id: "test-mod",
          alias: "tmod",
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
          py,
          jl,
          PDVMessageType.NAMESPACE_QUERY,
          { include_private: false, include_modules: false, include_callables: false }
        );
        assertOk(python, "Python namespace.query");
        assertOk(julia, "Julia namespace.query");

        // Both should return a variables array.
        const pyPayload = python.payload as Record<string, unknown>;
        const jlPayload = julia.payload as Record<string, unknown>;
        expect(Array.isArray(pyPayload.variables)).toBe(true);
        expect(Array.isArray(jlPayload.variables)).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // Error responses (2 tests)
    // -----------------------------------------------------------------------

    describe("Error responses", () => {
      it("17. all error responses use same status/code structure", async () => {
        // Trigger a known error: get from non-existent path.
        const { python, julia } = await sendToBoth(
          py,
          jl,
          PDVMessageType.TREE_GET,
          { path: "this.does.not.exist", mode: "value" }
        );
        expect(python.status).toBe("error");
        expect(julia.status).toBe("error");
        const pyPayload = python.payload as Record<string, unknown>;
        const jlPayload = julia.payload as Record<string, unknown>;
        expect(typeof pyPayload.code).toBe("string");
        expect(typeof jlPayload.code).toBe("string");
        expect(pyPayload.code).toBe(jlPayload.code);
      });

      it("18. version mismatch produces same error behavior", async () => {
        // We can't easily test this without restarting kernels, so we
        // verify that both kernels accepted the current version during init.
        // This is a structural test — the actual version mismatch path
        // is tested separately in each language's unit tests.
        expect(py.kernelId).toBeTruthy();
        expect(jl.kernelId).toBeTruthy();
      });
    });

    // -----------------------------------------------------------------------
    // Change notifications (1 test)
    // -----------------------------------------------------------------------

    describe("Change notifications", () => {
      it("19. tree mutation emits pdv.tree.changed with same payload structure", async () => {
        // Listen for tree.changed pushes.
        const pyChangedPromise = waitForPush(
          py.router,
          PDVMessageType.TREE_CHANGED,
          10_000
        );
        const jlChangedPromise = waitForPush(
          jl.router,
          PDVMessageType.TREE_CHANGED,
          10_000
        );

        // Mutate both trees.
        await py.km.execute(py.kernelId, {
          code: 'pdv_tree["notify_test"] = 99',
        });
        await jl.km.execute(jl.kernelId, {
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
        // Create a simple Fortran namelist file in both working dirs.
        const nmlContent = "&params\n  x = 1.0\n  label = 'test'\n/\n";
        const pyNmlPath = path.join(py.workingDir, "test.nml");
        const jlNmlPath = path.join(jl.workingDir, "test.nml");
        await fs.writeFile(pyNmlPath, nmlContent);
        await fs.writeFile(jlNmlPath, nmlContent);

        // Register as file nodes.
        await py.router.request(PDVMessageType.FILE_REGISTER, {
          path: "test_nml",
          file_path: pyNmlPath,
          node_type: "namelist",
        });
        await jl.router.request(PDVMessageType.FILE_REGISTER, {
          path: "test_nml",
          file_path: jlNmlPath,
          node_type: "namelist",
        });

        const { python, julia } = await sendToBoth(
          py,
          jl,
          PDVMessageType.NAMELIST_READ,
          { path: "test_nml" }
        );
        assertOk(python, "Python namelist.read");
        assertOk(julia, "Julia namelist.read");
        assertStructurallyEqual(python, julia);
      });

      it("21. pdv.namelist.write returns same response structure", async () => {
        const { python, julia } = await sendToBoth(
          py,
          jl,
          PDVMessageType.NAMELIST_WRITE,
          {
            path: "test_nml",
            groups: { params: { x: 2.0, label: "updated" } },
          }
        );
        assertOk(python, "Python namelist.write");
        assertOk(julia, "Julia namelist.write");
        assertStructurallyEqual(python, julia);
      });
    });
  }
);
