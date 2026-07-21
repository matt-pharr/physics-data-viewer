/**
 * julia-feature-tour.spec.ts — Visual feature tour of the Julia backend.
 *
 * Drives every major Julia-session surface through the real app GUI and
 * captures a screenshot at each stage (dir: PDV_TOUR_SHOTS, default
 * `test-results/julia-tour/`):
 *
 *  1. Welcome screen (New Julia Project action)
 *  2. Kernel boot → Connected status
 *  3. Code-cell execution (stdout + expression results)
 *  4. Tree population across node kinds (ndarray/mapping/text/sequence/DataFrame)
 *  5. Julia error → structured traceback in the console
 *  6. Missing-package error → reactive PDVKernel.install affordance
 *  7. Namespace panel with lazy expansion
 *  8. Script params dialog (Meta.parseall extraction) → parameterized run
 *  9. Markdown note in the Write tab
 * 10. Tree ops via context menu (print, rename)
 * 11. Bundled N-pendulum-julia module import → solve run → double-click plot
 * 12. Project save → reopen in a fresh instance
 *
 * Requires a Julia env with IJulia + PDVKernel + DifferentialEquations +
 * CairoMakie. Skipped unless JULIA_PATH is set.
 */

import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { PDVApi } from "../renderer/src/types/pdv";
import { expectKernelReady } from "./helpers/kernel-status";
import { launchPDV, type LaunchedApp } from "./helpers/launch";
import { sendMenuAction } from "./helpers/menu-action";

const juliaPath = process.env.JULIA_PATH;
test.skip(!juliaPath, "JULIA_PATH not set — Julia feature tour skipped");

const SHOTS_DIR = process.env.PDV_TOUR_SHOTS ??
  path.resolve(__dirname, "..", "test-results", "julia-tour");

const JULIA_ENV = {
  JULIA_DEPOT_PATH: process.env.JULIA_DEPOT_PATH ?? `${path.join(os.homedir(), ".julia")}:`,
};

test.describe.configure({ mode: "serial" });

let launched: LaunchedApp;
let saveDir: string;

async function shot(window: Page, name: string): Promise<void> {
  await window.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

async function runInCodeCell(window: Page, code: string): Promise<void> {
  const editor = window.getByRole("textbox", { name: "Editor content" }).first();
  await editor.focus();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.press("Backspace");
  await window.keyboard.type(code);
  await window.getByRole("button", { name: "Execute" }).click();
}

// Wait until the most recent console entry reports a duration (= execution
// finished kernel-side), then return it.
function lastLog(window: Page) {
  return window.locator(".log-entry").last();
}

test.beforeAll(async () => {
  await fs.mkdir(SHOTS_DIR, { recursive: true });
  launched = await launchPDV({ preferences: { juliaPath }, env: JULIA_ENV });
  saveDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdv-julia-tour-save-"));
});

test.afterAll(async () => {
  await launched?.cleanup();
  if (saveDir) await fs.rm(saveDir, { recursive: true, force: true });
});

test("01 welcome screen offers New Julia Project", async () => {
  const { window } = launched;
  await expect(window.getByRole("button", { name: "New Julia Project" })).toBeVisible();
  await expect(window.getByRole("button", { name: "New Python Project" })).toBeVisible();
  await shot(window, "01-welcome");
});

test("02 Julia kernel boots to Connected", async () => {
  test.setTimeout(300_000);
  const { window } = launched;
  await window.getByRole("button", { name: "New Julia Project" }).click();
  // §10.6.5: the New Julia Project dialog (version + packages) - accept defaults.
  await window.getByTestId("new-julia-project-create").click();
  await expectKernelReady(window, 240_000);
  await shot(window, "02-kernel-connected");
});

test("03 code cell executes Julia", async () => {
  const { window } = launched;
  await runInCodeCell(window, 'println("Hello from Julia $(VERSION)")');
  // Full-text match: stdout must appear exactly once (regression: the
  // result used to re-apply streamed output when the chunk push lost the
  // race against the invoke resolution).
  await expect(window.locator(".log-stdout").last())
    .toHaveText(/^Hello from Julia 1\.[\d.]+\s*$/, { timeout: 30_000 });
  await runInCodeCell(window, "sum(1:100)");
  await expect(window.locator(".log-result").last()).toHaveText("5050", { timeout: 30_000 });
  await shot(window, "03-code-cell");
});

test("04 tree populates across node kinds", async () => {
  const { window } = launched;
  await runInCodeCell(window, [
    "using DataFrames;",
    'pdv_tree["data.waveform"] = [sin(2π * 5t) * exp(-t) for t in range(0, 2, length=256)];',
    'pdv_tree["data.image"] = [exp(-((x-32)^2 + (y-32)^2) / 200) for x in 1:64, y in 1:64];',
    'pdv_tree["data.table"] = DataFrame(shot=[101, 102, 103], q95=[3.1, 3.4, 2.9]);',
    'pdv_tree["config"] = Dict("mode" => "fast", "n_iter" => 40);',
    'pdv_tree["label"] = "L-mode reference scan";',
    'pdv_tree["fit.coeffs"] = (1.2, 0.4);',
    'println("seeded")',
  ].join(" "));
  await expect(window.locator(".log-stdout").last()).toContainText("seeded", { timeout: 60_000 });

  // Expand `data` and check kind previews round-tripped from the kernel.
  await expect(window.locator(".tree-row", { hasText: "data" }).first()).toBeVisible({ timeout: 15_000 });
  await window.getByRole("button", { name: "Expand data" }).click();

  await expect(window.locator(".tree-row", { hasText: "waveform" })).toBeVisible({ timeout: 15_000 });
  await expect(window.locator(".tree-row", { hasText: "waveform" })).toContainText("float64 array");
  await expect(window.locator(".tree-row", { hasText: "image" })).toContainText("64 × 64");
  await expect(window.locator(".tree-row", { hasText: "table" })).toContainText("DataFrame (3 × 2)");
  await expect(window.locator(".tree-row", { hasText: "config" })).toContainText("dict (2 keys)");
  await expect(window.locator(".tree-row", { hasText: "fit" })).toBeVisible();
  await shot(window, "04-tree-node-kinds");
});

test("05 Julia error renders a structured traceback", async () => {
  const { window } = launched;
  await runInCodeCell(window, "sqrt(-1.0)");
  await expect(window.locator(".log-error").last()).toContainText("DomainError", { timeout: 30_000 });
  await shot(window, "05-error-traceback");
});

test("06 missing package offers PDVKernel.install", async () => {
  const { window } = launched;
  await runInCodeCell(window, "using NotARealPackage123");
  await expect(window.locator(".log-error").last()).toContainText("NotARealPackage123",
    { timeout: 30_000 });
  const installBtn = window.getByRole("button", {
    name: 'Install with PDVKernel.install("NotARealPackage123")',
  });
  await expect(installBtn).toBeVisible({ timeout: 15_000 });
  await shot(window, "06-reactive-install");
});

test("07 namespace panel lists and expands Julia variables", async () => {
  const { window } = launched;
  await runInCodeCell(window, "coil_currents = [1.2e3, -0.8e3, 2.4e3]; scan = Dict(:betaN => 1.8)");
  await expect(window.locator(".log-duration").last()).toBeVisible({ timeout: 30_000 });

  await window.getByRole("button", { name: "Namespace", exact: true }).click();
  const namespaceView = window.locator(".namespace-view");
  if (!(await namespaceView.isVisible())) {
    await window.getByRole("button", { name: "Namespace", exact: true }).click();
  }
  await expect(namespaceView).toBeVisible({ timeout: 5_000 });

  const row = window.locator(".namespace-row", { hasText: /coil_currents/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("ndarray");
  const expand = window.getByRole("button", { name: "Expand coil_currents" });
  await expand.click();
  await expect(window.locator(".namespace-row", { hasText: /\[1\]/ })).toBeVisible({ timeout: 15_000 });
  await shot(window, "07-namespace");

  // Back to the tree for the following tests (title is "Tree (Cmd+B)").
  await window.getByRole("button", { name: /^Tree/ }).click();
  await expect(window.locator(".tree-row").first()).toBeVisible({ timeout: 5_000 });
});

test("08 script params dialog extracts Julia keyword params and runs", async () => {
  const { window } = launched;

  // Create via the renderer API (the dialog path is covered by julia-smoke);
  // we need the on-disk path to install a parameterized body.
  const scriptPath = await window.evaluate(async () => {
    const pdv = (window as unknown as { pdv: PDVApi }).pdv;
    const kernels = await pdv.kernels.list();
    const kernelId = kernels[0]?.id;
    if (!kernelId) throw new Error("no active kernel");
    const result = await pdv.tree.createScript(kernelId, "", "gauss_fit");
    if (!result?.success || !result.scriptPath) throw new Error(result?.error ?? "createScript failed");
    return result.scriptPath;
  });
  await expect(window.locator(".tree-row", { hasText: "gauss_fit" })).toBeVisible({ timeout: 15_000 });

  await fs.writeFile(scriptPath!, [
    "function run(pdv_tree::AbstractDict; amplitude::Float64 = 1.0, sigma::Float64 = 0.1,",
    '             label::String = "fit", verbose::Bool = false)',
    '    pdv_tree["fit.result"] = Dict("amplitude" => amplitude, "sigma" => sigma, "label" => label)',
    '    verbose && println("fit stored under fit.result")',
    '    return Dict("amplitude" => amplitude)',
    "end",
    "",
  ].join("\n"), "utf8");

  // Right-click → Run... → the ScriptDialog form is built from
  // pdv.script.params (Meta.parseall on the kernel side).
  await window.locator(".tree-row", { hasText: "gauss_fit" }).click({ button: "right" });
  await window.locator(".context-menu-item", { hasText: "Run..." }).click();
  await expect(window.getByRole("heading", { name: "Run Script" })).toBeVisible({ timeout: 10_000 });
  const dialog = window.locator(".script-dialog");
  await expect(dialog.locator(".param-input", { hasText: "amplitude" })).toBeVisible({ timeout: 15_000 });
  await expect(dialog.locator(".param-input", { hasText: "sigma" })).toBeVisible();
  await expect(dialog.locator(".param-input", { hasText: "label" })).toBeVisible();
  await expect(dialog.locator(".param-input", { hasText: "verbose" })).toBeVisible();
  await shot(window, "08-script-dialog-params");

  const ampInput = dialog.locator(".param-input", { hasText: "amplitude" }).locator("input");
  await ampInput.fill("2.5");
  await dialog.getByRole("button", { name: /^Run/ }).click();

  await expect(window.locator(".log-result").last()).toContainText("2.5", { timeout: 60_000 });
  // The script wrote fit.result — expand `fit` to see it land.
  await window.getByRole("button", { name: "Expand fit" }).click();
  await expect(window.locator(".tree-row", { hasText: "result" })).toBeVisible({ timeout: 15_000 });
  await shot(window, "08b-script-ran");
});

test("09 markdown note opens in the Write tab", async () => {
  const { window } = launched;
  await window.evaluate(async () => {
    const pdv = (window as unknown as { pdv: PDVApi }).pdv;
    const kernels = await pdv.kernels.list();
    const kernelId = kernels[0]?.id;
    if (!kernelId) throw new Error("no active kernel");
    const result = await pdv.tree.createNote(kernelId, "", "lab_notes");
    if (!result?.success) throw new Error(result?.error ?? "createNote failed");
  });
  const noteRow = window.locator(".tree-row", { hasText: "lab_notes" });
  await expect(noteRow).toBeVisible({ timeout: 15_000 });
  await noteRow.dblclick();

  // The Write tab mounts with its own Monaco editor; type some markdown.
  await expect(window.locator(".write-tab-pane")).toBeVisible({ timeout: 15_000 });
  const writeEditor = window.locator(".write-tab-pane").getByRole("textbox").first();
  await writeEditor.focus();
  await window.keyboard.type("# Julia session notes\n\nDispersion relation: $\\omega^2 = k^2 c^2$\n");
  await shot(window, "09-write-tab-note");

  // Return to the Code pane so the console is mounted for the next tests.
  await window.locator(".pane-switcher-btn", { hasText: "Code" }).click();
  await expect(window.getByRole("button", { name: "Execute" })).toBeVisible({ timeout: 5_000 });
});

test("10 tree context ops: print and rename", async () => {
  const { window } = launched;

  // Re-expand `data` — the full refetch after the script run collapses
  // expansion state (§7.1.1).
  if (!(await window.locator(".tree-row", { hasText: "waveform" }).isVisible())) {
    await window.getByRole("button", { name: "Expand data" }).click();
  }

  // Print the waveform node — the console gets the size-limited
  // "256-element Vector{Float64}: …" display form.
  await window.locator(".tree-row", { hasText: "waveform" }).click({ button: "right" });
  await window.locator(".context-menu-item", { hasText: "Print" }).click();
  await expect(window.locator(".log-stdout").last()).toContainText("256-element Vector{Float64}",
    { timeout: 30_000 });

  // Rename `label` → `title` through the RenameDialog.
  await window.locator(".tree-row", { hasText: "label" }).first().click({ button: "right" });
  await window.locator(".context-menu-item", { hasText: /^Rename/ }).click();
  await expect(window.getByRole("heading", { name: "Rename" })).toBeVisible({ timeout: 10_000 });
  const renameInput = window.locator(".modal-overlay input").first();
  await renameInput.fill("title");
  await window.locator(".modal-overlay").getByRole("button", { name: /Rename|OK|Save/ }).click();
  await expect(window.locator(".tree-row", { hasText: "title" })).toBeVisible({ timeout: 15_000 });
  await shot(window, "10-tree-ops");
});

test("11 bundled N-pendulum-julia module: import, solve, plot handler", async () => {
  test.setTimeout(420_000);
  const { window } = launched;

  // Open the Import Module dialog via the same push the File menu sends.
  await sendMenuAction(launched.app, { action: "modules:import" });
  await expect(window.getByRole("heading", { name: "Import Module" })).toBeVisible({ timeout: 10_000 });
  const dialog = window.locator(".import-module-dialog");
  const pendulumRow = dialog.getByRole("listitem").filter({ hasText: "N-Pendulum (Julia)" });
  await expect(pendulumRow).toBeVisible({ timeout: 15_000 });
  // Language filtering: the Python N-Pendulum must not be offered to a Julia session.
  await expect(dialog.getByRole("listitem").filter({ hasText: /N-Pendulum(?! \(Julia\))/ }))
    .toHaveCount(0);
  await shot(window, "11-import-dialog");

  await pendulumRow.getByRole("button", { name: "Import", exact: true }).click();
  // Import copies files, registers the module subtree, and runs
  // pdv.modules.setup (which `include`s NPendulum.jl → loads CairoMakie).
  await expect(dialog.getByText(/Imported/).first()).toBeVisible({ timeout: 120_000 });
  await dialog.locator(".close-btn").click();

  const moduleRow = window.locator(".tree-row", { hasText: "n_pendulum_julia" }).first();
  await expect(moduleRow).toBeVisible({ timeout: 15_000 });
  await shot(window, "11b-module-imported");

  // Run the solve script with a reduced workload through the code cell (the
  // exact invocation the module action path builds).
  await runInCodeCell(window,
    'PDVKernel.run_tree_script(pdv_tree, "n_pendulum_julia.scripts.solve"; ' +
    'n_links=3, t_end=6.0, n_steps=600)');
  await expect(window.locator(".log-stdout").last()).toContainText("Solved 600 time steps",
    { timeout: 300_000 });

  // Expand the module → outputs, then double-click the solution node so its
  // pdv_handle method draws the CairoMakie overview figure. The solution row
  // carries the module's pdv_preview text ("triple pendulum (600 steps, …)").
  await window.getByRole("button", { name: "Expand n_pendulum_julia" }).click();
  await expect(window.locator(".tree-row", { hasText: "outputs" }).first())
    .toBeVisible({ timeout: 15_000 });
  await window.getByRole("button", { name: "Expand outputs" }).click();
  const resultRow = window.locator(".tree-row", { hasText: "result" }).last();
  await expect(resultRow).toBeVisible({ timeout: 15_000 });
  await expect(resultRow).toContainText("pendulum", { timeout: 15_000 });
  await resultRow.dblclick();
  // The handler display()s the figure; IJulia publishes it as display_data
  // parented to the most recent execution, so it renders in the console as
  // an inline image (first CairoMakie render pays its JIT here).
  await expect(window.locator(".log-image").first()).toBeVisible({ timeout: 240_000 });
  await shot(window, "11c-module-solve-plot");
});

test("12 project save → reopen restores the Julia tree", async () => {
  test.setTimeout(420_000);
  const { window } = launched;

  await sendMenuAction(launched.app, { action: "project:save", path: saveDir });
  // project.json is the save pipeline's commit gate (§8.1) — written last,
  // so its existence is the completion signal (tree-index.json lands earlier,
  // mid-save).
  await expect.poll(async () => {
    try {
      await fs.stat(path.join(saveDir, "project.json"));
      return true;
    } catch {
      return false;
    }
  }, { timeout: 60_000 }).toBe(true);

  const manifest = JSON.parse(await fs.readFile(path.join(saveDir, "project.json"), "utf8"));
  expect(manifest.language).toBe("julia");
  await shot(window, "12-saved");

  // Fresh instance: boot a Julia session and open the saved project.
  const second = await launchPDV({ preferences: { juliaPath }, env: JULIA_ENV });
  try {
    await second.window.getByRole("button", { name: "New Julia Project" }).click();
    await second.window.getByTestId("new-julia-project-create").click();
    await expectKernelReady(second.window, 240_000);
    await second.window.evaluate(async (dir) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).pdv.project.load(dir);
    }, saveDir);

    await expect(second.window.locator(".tree-row", { hasText: "data" })).toBeVisible({ timeout: 60_000 });
    await expect(second.window.locator(".tree-row", { hasText: "n_pendulum_julia" }))
      .toBeVisible({ timeout: 15_000 });

    // Numeric data round-trips through .npy; verify from a cell.
    const editor = second.window.getByRole("textbox", { name: "Editor content" }).first();
    await editor.focus();
    await second.window.keyboard.type('length(pdv_tree["data.waveform"])');
    await second.window.getByRole("button", { name: "Execute" }).click();
    await expect(second.window.locator(".log-result").last()).toHaveText("256", { timeout: 60_000 });

    // The DataFrame node exercises Serialization's package auto-require:
    // this fresh kernel never loaded DataFrames, so the load path must
    // Base.require it (regression: node used to be silently skipped).
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await editor.focus();
    await second.window.keyboard.press(`${modifier}+a`);
    await second.window.keyboard.press("Backspace");
    await second.window.keyboard.type('size(pdv_tree["data.table"])');
    await second.window.getByRole("button", { name: "Execute" }).click();
    await expect(second.window.locator(".log-result").last()).toContainText("(3, 2)", { timeout: 60_000 });

    // The reopened tree must reproduce the checksum recorded at save time —
    // the whole-tree round-trip integrity check.
    const savedChecksum = manifest.tree_checksum as string;
    await editor.focus();
    await second.window.keyboard.press(`${modifier}+a`);
    await second.window.keyboard.press("Backspace");
    await second.window.keyboard.type(
      'println("CKSUM ", PDVKernel.tree_checksum(pdv_tree))');
    await second.window.getByRole("button", { name: "Execute" }).click();
    await expect(second.window.locator(".log-stdout").last())
      .toContainText(`CKSUM ${savedChecksum}`, { timeout: 60_000 });

    await shot(second.window, "12b-reopened");
  } finally {
    await second.cleanup();
  }
});
